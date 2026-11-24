// v2 手表↔手机 hub 协议层（S4）。契约冻结在 docs/watch-v2/s3-android-hub.md：
//   GET  /watch/ping      → { ok, rev, time }
//   GET  /watch/snapshot  → { ok, rev, snapshot: 对象|null }
//   POST /watch/events    → { ok, acked: [id...] }   acked = 手机已持久收到（非已应用）
// 核心语义：
//   - 事件先入本地持久化队列（队列是事件的最后一份拷贝），POST 后按 acked 的 id 删队；
//     响应丢了就原样重发（同 id 重 POST，手机按 id 去重、照样 ack），收到 ack 才删。
//   - snapshot:null = 手机进程刚重启、页面还没发过快照——保持本地状态，不得据此清会话。
//   - rev 每次 sendSnapshot +1；rev 严格单调，相同或更旧的 rev 跳过解析（应用存活期内
//     记忆；手机重启后 rev 从 0 重爬，由 snapshot:null 重置记忆，极窄撞值下一轮自愈）。
//   - 快照盖到 session-core 的 SessionState 上（applySnapshot），本端未确认的记组/
//     开局/结束由 core 保护；记组/开局/结束产出的事件交本模块入队上报。
// 离线静默重试：flush 在每次入队后、页面轮询和打开应用时各试一次，失败保留队列。
import { hubCall } from './api'
import { getJSON, setJSON } from './store'
import { newState, applySnapshot, tick, start, finish, sideUp, isExpired } from './session-core'

const STATE_KEY = 'hubState'
const QUEUE_KEY = 'hubQueue'
const FLUSH_BATCH = 100
const LEGACY_QUEUE_MAX = 200
export const QUEUE_MAX = 600

let lastRev = -1   // 应用存活期内的 rev 去重；-1 = 还没拉过快照

// —— v2.1 能力协商（fork 参考的协商矩阵，这里只有一项）：ping 响应里的 proto 数字。
// 旧手机（无该字段）按 1；手表只对支持的版本发对应事件（休息事件）。旧手机收到未知
// 事件本来就会安全丢弃（applyEvents 的"无意义也照 ack"），不协商只是白占队列。
let phoneProto = 0   // 0 = 还没探到（按不支持处理）

export async function protoPing() {
  const r = await ping()
  phoneProto = Number(r && r.proto) || 1
  return r
}

export function phoneSupports(n) {
  return phoneProto >= n
}

// 测试口：清掉协商记忆
export function forgetProto() { phoneProto = 0 }

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

// 测试口：清掉 rev 记忆（每个用例独立拉快照）
export function forgetRev() { lastRev = -1 }

export function loadState() {
  return getJSON(STATE_KEY, null)
}

export function saveState(s) {
  return setJSON(STATE_KEY, s)
}

export function ping() {
  return hubCall('GET', '/watch/ping', null)
}

// 拉快照并盖到本地状态上。返回 { state, rev, snapshot, changed }。snapshot:null（手机
// 进程刚重启）按契约保持本地状态原样并重置 rev 记忆；rev 须严格单调（HTTP 拉取下手机
// 只会回最新快照，旧 rev 一律当迟到包跳过——否则手机端结束后迟到的旧快照会复活会话；
// 手机重启后 rev 从 0 重爬，先收到 snapshot:null 重置记忆，极窄的撞值自愈于下一轮）。
export async function syncSnapshot() {
  const res = await hubCall('GET', '/watch/snapshot', null)
  if (!res || res.ok !== true) throw new Error('快照响应异常')
  const rev = typeof res.rev === 'number' ? res.rev : 0
  const snap = res.snapshot
  if (!snap || typeof snap !== 'object') {
    lastRev = -1                       // 手机还没发过快照，下次照常解析
    return { state: await loadState(), rev: rev, snapshot: null, changed: false }
  }
  if (rev <= lastRev) return { state: await loadState(), rev: rev, snapshot: snap, changed: false }
  const prev = await loadState()
  const next = applySnapshot(prev || newState(), snap)
  await saveState(next)
  lastRev = rev
  return { state: next, rev: rev, snapshot: snap, changed: true }
}

// 队列的读-改-写全部经一条串行链（onChain），杜绝交错丢更新：recordSet/begin/end 各自
// fire-and-forget 地触发 flush，入队与删队若不串行，迟到的旧 rest 会覆盖掉期间新入队的
// 事件（实测丢过）。网络 POST 放在链外（链内等网可能无限期堵住入队）：每轮「链内读批次
// → 链外 POST → 链内重读现值、只减 acked 的 id、无变化不落盘」。并发触发的多个 flush
// 循环只会在链内段上排队，删队永远基于最新队列，迟到写无害（无变化不落盘）。
let qChain = Promise.resolve(true)
function onChain(fn) {
  const run = () => Promise.resolve().then(fn)
  const p = qChain.then(run, run)
  qChain = p.then(() => true, () => false)
  return p
}

export function enqueue(event) {
  if (!event || typeof event.id !== 'string' || !event.id) return Promise.resolve(false)
  return onChain(() => _enqueue(event))
}

function _enqueue(event) {
  return getJSON(QUEUE_KEY, []).then(q => {
    if (q.some(x => x && x.id === event.id)) return false
    let next = q.concat([event])
    if (next.length > QUEUE_MAX) next = _compact(next)
    if (next.length > QUEUE_MAX) return false   // 压缩后仍超限：拒绝这条（本地状态已落盘）
    return setJSON(QUEUE_KEY, next)
  })
}

// 队列压缩（v2.1，fork 参考的 compaction）：同一场训练同一组同一侧的 setDone 只留 at
// 最晚的一条——手机端 patchSet 本就按 at 新者胜（ifNewer），丢旧条目无语义差。其余事件
// 类型（start/finish/weighIn/healthDeleted/restAdjust/restSkip）语义各自独立，永不压缩。
function _compact(q) {
  const keep = new Array(q.length).fill(true)
  const latest = new Map()
  for (let i = 0; i < q.length; i++) {
    const ev = q[i]
    if (!ev || ev.type !== 'setDone') continue
    const k = [ev.wid, ev.exId, ev.entryIdx, ev.setIdx, ev.side].join('|')
    const j = latest.get(k)
    if (j == null) latest.set(k, i)
    else if ((ev.at || 0) >= (q[j].at || 0)) { keep[j] = false; latest.set(k, i) }
    else keep[i] = false
  }
  return q.filter((_, i) => keep[i])
}

// 上报待发事件：一批 POST，按 acked 的 id 删队（畸形/未 ack 的留下次）。返回队列是否已空。
// 网络失败/响应异常一律静默保留队列，由调用方择机重试；一轮删队无进展（对端回不认识的
// id）即停，不死循环。
export function flush() {
  return _flushLoop()
}

async function _flushLoop() {
  let largeQueueSupported = false
  while (true) {
    const q = await onChain(() => getJSON(QUEUE_KEY, []))
    if (!q.length) return true
    let res = null
    try {
      // 旧手机收件箱满时会淘汰历史事件但仍返回 ack，积压超出旧手表上限时先确认接收能力。
      if (q.length > LEGACY_QUEUE_MAX && !largeQueueSupported) {
        await protoPing()
        if (!phoneSupports(3)) return false
        largeQueueSupported = true
      }
      res = await hubCall('POST', '/watch/events', { events: q.slice(0, FLUSH_BATCH) })
    } catch (e) {
      return false
    }
    if (!res || res.ok !== true || !Array.isArray(res.acked)) return false
    const acked = res.acked.filter(x => typeof x === 'string')
    const r = await onChain(() => _remove(acked))
    if (r.left === 0) return true          // 本轮或并行的另一轮已清空
    if (!r.changed) return false           // 一条都没删掉（对端回不认识的 id），留下次
  }
}

// 串行段内：重读现值 → 删掉 acked 的 id → 落盘。返回 { changed, left }（left = 剩余条数）。
function _remove(acked) {
  return getJSON(QUEUE_KEY, []).then(q => {
    const rest = q.filter(x => !acked.includes(x.id))
    const changed = rest.length !== q.length
    const write = changed ? setJSON(QUEUE_KEY, rest) : Promise.resolve(true)
    return write.then(() => ({ changed: changed, left: rest.length }))
  })
}

// —— 会话胶水：core 产出 [新状态, 事件]，这里负责存状态 + 事件入队 + 尽力上报 ——

// 记一组。o = { w, r, sec, hr }；单侧组不传 side 时按 sideUp 自动轮流（S4 页面无 L/R
// 按钮，两侧各点一次）。越界返回原状态。
export async function recordSet(ei, si, o) {
  const s = await loadState()
  if (!s || !s.workout) return s
  const opts = { at: Date.now(), id: uid() }
  if (o) {
    if (o.w != null) opts.w = o.w
    if (o.r != null) opts.r = o.r
    if (o.sec != null) opts.sec = o.sec
    if (o.hr != null) opts.hr = o.hr
    if (o.side != null) opts.side = o.side
  }
  if (!opts.side && s.workout.entries[ei] && s.workout.entries[ei].sets[si]) {
    const up = sideUp(s.workout.entries[ei].sets[si])
    if (up) opts.side = up
  }
  const next = tick(s, ei, si, opts)
  if (next[1]) await enqueue(next[1])
  await saveState(next[0])
  flush().catch(() => { })
  return next[0]
}

// 手表开一场就绪会话（state.ready.today / others 之一，字段由手机 buildReady 造好）。
export async function begin(session) {
  const s = (await loadState()) || newState()
  const wid = uid()
  const next = start(s, session, wid, Date.now(), uid())
  await enqueue(next[1])
  await saveState(next[0])
  flush().catch(() => { })
  return next[0]
}

// 结束会话：清场 + finish 事件入队（手机端负责真正落库训练）。返回 { state, event }。
export async function end() {
  const s = await loadState()
  if (!s) return { state: s, event: null }
  const next = finish(s, Date.now(), uid())
  if (next[1]) await enqueue(next[1])
  await saveState(next[0])
  flush().catch(() => { })
  return { state: next[0], event: next[1] }
}

// 本端放弃跟踪（v1「丢弃本次」的 v2 对应物）：已经记出去的组手机照收，手机端训练继续，
// 由用户回手机上结束；本端只清场并记住 wid（旧快照不许把它复活），不发 finish 事件。
export async function abandon() {
  const s = await loadState()
  if (!s) return s
  const next = finish(s, Date.now(), uid())
  await saveState(next[0])
  return next[0]
}

// 休息事件胶水（v2.1）：休息是页面本地的短时状态，不走 session-core，只入队 + 尽力上报。
// 离线时事件留在队列里，下次 flush 补投（同 start/finish 的兜底）。
export async function emitEvent(ev) {
  if (!ev) return false
  const ok = await enqueue(ev)
  flush().catch(() => { })
  return ok
}

// 会话过期（S10，docs/watch-v2/s10）：本地会话超过 6 小时（从 workout.start 起算）即自动
// 离场——wid 进 finishedHere tombstone（旧快照不许复活），finish 事件照常入队：手机端收到
// 后走自己的结束流程落库，把已记的组收进历史（fork 的 "close event is queued for
// reconnection"）。只由会话页打开时调用；页面开着（正在用）不查，正在练的会话不过期。
// 无事发生返回 null，过期返回新状态。
export async function expireIfStale(now = Date.now()) {
  const s = await loadState()
  if (!isExpired(s, now)) return null
  const [next, ev] = finish(s, now, uid())
  if (ev) await enqueue(ev)     // 事件先持久化，再落状态（与 recordSet/begin/end 同序）
  await saveState(next)
  flush().catch(() => { })
  return next
}
