// S4 协议层测试：hub.js（快照同步 / 事件队列 / ack 删队 / 会话胶水）对着假 hub
// （fake-hub.mjs，按 S3 契约实现）跑通一轮完整训练。分两段：
//   单元段——用 __velaFetch 桩精确控制响应，打队列语义（只删 acked、失败保留、去重）；
//   集成段——真 TCP 上手表源码原样走 配对 ping → 快照接上/开局 → 记组（中途断网）→
//   结束 → 手机队列逐条对账，重发无害、按 id 去重、ack 语义与契约逐条对应。
// 集成用例各自独立：beforeEach 清存储，用例开头自备快照与队列断言基线。
import './register.mjs'
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { sSet, getJSON, setJSON } = await import('../src/js/store')
const { ping, syncSnapshot, enqueue, flush, loadState, saveState, recordSet, begin, end, forgetRev, emitEvent, protoPing, phoneSupports, forgetProto, QUEUE_MAX, expireIfStale } = await import('../src/js/hub')
const { startFakeHub } = await import('./fake-hub.mjs')

beforeEach(async () => {
  globalThis.__velaStore = new Map()
  globalThis.__velaFetch = undefined
  forgetRev()
  // 队列语义的单元用例也要过 hubCall 的基址检查（不真连，走 __velaFetch 桩）
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', 'stub-token')
})

// —— 快照构造（形状对齐手机端 lib/watch-sync.js buildSnapshot/buildReady 的输出） ——

function entryOf(id, name, sets, over = {}) {
  return { id, name, mode: 'reps', sets, ...over }
}
function setOf(w, r, done = false) {
  return { w, r, done, warmup: false }
}
function readySnapshot() {
  return {
    v: 1, unit: 'kg', restSec: 90,
    active: null,
    ready: {
      today: {
        routineIds: ['r1'], name: '推日训练',
        entries: [
          entryOf('0001', '卧推', [setOf(40, 10), setOf(40, 10), setOf(40, 10)], { restSec: 60 }),
          entryOf('0002', '划船', [setOf(30, 12), setOf(30, 12)])
        ]
      },
      others: [{ routineIds: ['r2'], name: '腿日', entries: [entryOf('0003', '深蹲', [setOf(60, 8)])] }]
    }
  }
}
function activeSnapshot(wid, doneSpec) {
  const sets1 = [setOf(40, 10), setOf(40, 10), setOf(40, 10)]
  if (doneSpec) doneSpec.forEach(([i, w, r]) => { sets1[i] = { w, r, done: true, warmup: false, at: Date.now() + 10 } })
  return {
    v: 1, unit: 'kg', restSec: 90, ready: null,
    active: {
      id: wid, name: '推日训练', unit: 'kg', cur: 0, restSec: 90, start: Date.now() - 60000,
      entries: [
        entryOf('0001', '卧推', sets1, { restSec: 60 }),
        entryOf('0002', '划船', [setOf(30, 12), setOf(30, 12)])
      ]
    }
  }
}

// —— 单元段：事件队列语义（不发真网络） ——

test('enqueue：事件必须带字符串 id；同 id 不重复入队', async () => {
  assert.equal(await enqueue({ type: 'setDone' }), false)
  assert.equal(await enqueue({ id: '', type: 'setDone' }), false)
  assert.equal(await enqueue({ id: 'e1', type: 'setDone' }), true)
  assert.equal(await enqueue({ id: 'e1', type: 'setDone' }), false)
  assert.deepEqual((await getJSON('hubQueue', [])).map(x => x.id), ['e1'])
})

test('flush：只删 acked 的 id；响应丢失/网络失败队列原样保留', async () => {
  await setJSON('hubQueue', [{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  globalThis.__velaFetch = async () => ({ code: 200, data: { ok: true, acked: ['a', 'c'] } })
  assert.equal(await flush(), false)
  assert.deepEqual((await getJSON('hubQueue', [])).map(x => x.id), ['b'])

  globalThis.__velaFetch = async () => { throw new Error('connection refused') }
  assert.equal(await flush(), false)
  assert.deepEqual((await getJSON('hubQueue', [])).map(x => x.id), ['b'])

  globalThis.__velaFetch = async () => ({ code: 200, data: { ok: true, acked: ['b'] } })
  assert.equal(await flush(), true)
  assert.deepEqual(await getJSON('hubQueue', []), [])
})

test('flush：空队列直接 true 不发包；HTTP 错误静默保留队列', async () => {
  let calls = 0
  globalThis.__velaFetch = async () => { calls++; return { code: 200, data: { ok: true, acked: [] } } }
  assert.equal(await flush(), true)
  assert.equal(calls, 0)
  await enqueue({ id: 'x', type: 'finish' })
  globalThis.__velaFetch = async () => ({ code: 401, data: { ok: false, error: 'unauthorized' } })
  assert.equal(await flush(), false)
  assert.equal((await getJSON('hubQueue', [])).length, 1)
})

// —— v2.1 边界表（docs/watch-v2/s9）：队列上限、压缩、拒绝溢出 ——

test('边界表：触顶先压缩——同键 setDone 留 at 最晚一条，其余类型不丢', async () => {
  const now = Date.now()
  const q = [
    { id: 's', type: 'start', wid: 'w', at: now },
    ...Array.from({ length: 150 }, (_, i) => ({ id: 'k' + i, type: 'setDone', wid: 'w', exId: '0001', entryIdx: 0, setIdx: 0, at: now + i })),
    { id: 'f', type: 'finish', wid: 'w', at: now + 500 },
    ...Array.from({ length: 50 }, (_, i) => ({ id: 'o' + i, type: 'setDone', wid: 'w', exId: 'e' + i, entryIdx: 0, setIdx: 0, at: now })),
  ]
  await setJSON('hubQueue', q)                        // 202 条存量（超限遗留场景）
  assert.equal(await enqueue({ id: 'k150', type: 'setDone', wid: 'w', exId: '0001', entryIdx: 0, setIdx: 0, at: now + 150 }), true)
  const out = await getJSON('hubQueue', [])
  const same = out.filter(x => x.exId === '0001')     // 同键压缩成 1 条：at 最晚的胜
  assert.equal(same.length, 1)
  assert.equal(same[0].id, 'k150')
  assert.ok(out.some(x => x.id === 's'), 'start 永不压缩')
  assert.ok(out.some(x => x.id === 'f'), 'finish 永不压缩')
  assert.equal(out.filter(x => x.exId === 'e0').length, 1)
})

test('边界表：压缩后仍超限才拒绝入队；拒绝时队列原样保留', async () => {
  const uniq = i => ({ id: 'u' + i, type: 'setDone', wid: 'w', exId: 'e' + i, entryIdx: 0, setIdx: 0, at: Date.now() })
  await setJSON('hubQueue', Array.from({ length: QUEUE_MAX }, (_, i) => uniq(i)))
  assert.equal(await enqueue({ id: 'ux', type: 'setDone', wid: 'w', exId: 'zz', entryIdx: 0, setIdx: 0, at: Date.now() }), false)
  const q = await getJSON('hubQueue', [])
  assert.equal(q.length, QUEUE_MAX)
  assert.ok(!q.some(x => x.id === 'ux'))
})

test('emitEvent：入队 + 触发上报（ack 后删队）；空事件 false 不发包', async () => {
  let posts = 0
  globalThis.__velaFetch = async () => { posts++; return { code: 200, data: { ok: true, acked: ['r1'] } } }
  assert.equal(await emitEvent({ id: 'r1', type: 'restAdjust', wid: 'w', at: 1, add: 30 }), true)
  await flush()                        // emitEvent 的 flush 是尽力而为的 fire-and-forget（同 recordSet），这里显式等它
  assert.deepEqual(await getJSON('hubQueue', []), [])
  assert.ok(posts >= 1, '至少上报一次；并发 flush 可能重复 POST，手机按 id 去重无害')
  assert.equal(await emitEvent(null), false)
})

test('能力协商：ping 无 proto 字段按 1（旧手机）；proto:2 门控休息事件', async () => {
  globalThis.__velaFetch = async () => ({ code: 200, data: { ok: true, rev: 0, time: 1 } })   // 旧手机
  await protoPing()
  assert.equal(phoneSupports(1), true)
  assert.equal(phoneSupports(2), false)
  forgetProto()
  globalThis.__velaFetch = async () => ({ code: 200, data: { ok: true, rev: 0, time: 1, proto: 2 } })
  await protoPing()
  assert.equal(phoneSupports(2), true)
  forgetProto()
})

// —— 集成段：真 TCP，对着假 hub 跑一轮完整训练 ——

let hub
before(async () => { hub = await startFakeHub({ token: '13572468' }) })
after(async () => { await hub.close() })

function wireRealFetch() {
  globalThis.__velaFetch = async opts => {
    const r = await fetch(opts.url, { method: opts.method, headers: opts.header || {}, body: opts.data })
    const text = await r.text()
    let d
    try { d = text === '' ? null : JSON.parse(text) } catch { d = text }
    return { code: r.status, data: d }
  }
}

async function pair() {
  await sSet('hubHost', '127.0.0.1:' + hub.port)
  await sSet('hubToken', '13572468')
  wireRealFetch()
}
function resetHubQueue() {
  hub.state.queue.length = 0
  hub.state.ackLog.length = 0
}

test('集成：错误 token 被拒（401 unauthorized），错误码可读', async () => {
  await sSet('hubHost', '127.0.0.1:' + hub.port)
  await sSet('hubToken', '99999999')
  wireRealFetch()
  await assert.rejects(() => ping(), e => e.code === 401 && e.message === 'unauthorized')
  await assert.rejects(() => syncSnapshot(), e => e.code === 401)
})

test('集成：snapshot:null（手机进程刚重启）保持本地状态，不清会话', async () => {
  await pair()
  await saveState({ workout: { id: 'w_keep' }, pending: { a: { at: 1 } } })
  const r = await syncSnapshot()
  assert.equal(r.snapshot, null)
  assert.equal(r.changed, false)
  const st = await loadState()
  assert.equal(st.workout.id, 'w_keep')
})

test('集成：ping + 快照种子（ready.today）→ 开局 → start 事件按 ack 删队，重发无害', async () => {
  await pair()
  assert.equal((await ping()).ok, true)
  resetHubQueue()

  hub.setSnapshot(readySnapshot())                    // 手机页面尚未开局：ready 就绪
  const r1 = await syncSnapshot()
  assert.equal(r1.changed, true)
  assert.equal(r1.state.ready.today.name, '推日训练')
  assert.equal(r1.state.workout, null)

  const s = await begin(r1.state.ready.today)
  assert.ok(s.workout.id)
  assert.equal(s.startedHere, s.workout.id)
  assert.equal((await getJSON('hubQueue', [])).length, 1)
  assert.equal((await getJSON('hubQueue', []))[0].type, 'start')
  assert.equal((await getJSON('hubQueue', []))[0].wid, s.workout.id)

  assert.equal(await flush(), true)                   // 手机持久收到 → 本地队列清空
  assert.deepEqual((await getJSON('hubQueue', [])), [])
  assert.equal(hub.state.queue.length, 1)
  assert.deepEqual(hub.state.ackLog[0], [hub.state.queue[0].id])

  // 重发无害：同 id 重 POST，手机不重复入队，acked 照给（契约第 2 条）
  const ev = hub.state.queue[0]
  await enqueue(ev)
  assert.equal(await flush(), true)
  assert.equal(hub.state.queue.length, 1)
})

test('集成：完整一轮训练——开局、确认、记组、断网留队、恢复补投、rev 去重、结束', async () => {
  await pair()
  resetHubQueue()
  hub.setSnapshot(readySnapshot())
  const s0 = await begin((await syncSnapshot()).state.ready.today)
  const wid = s0.workout.id
  await flush()
  assert.deepEqual(hub.state.queue.map(x => x.type), ['start'])

  // 手机确认开局：快照带同一 wid → 手表接上，startedHere 清空
  hub.setSnapshot(activeSnapshot(wid))
  const rc = await syncSnapshot()
  assert.equal(rc.state.workout.id, wid)
  assert.equal(rc.state.startedHere, null)

  // 第 1 组：在线记 → 事件直发；快照确认后 pending 清掉
  const s1 = await recordSet(0, 0, { w: 42.5, r: 10 })
  assert.equal(s1.workout.entries[0].sets[0].done, true)
  assert.ok(s1.pending['0001#0'], 'pending 等快照确认')
  await flush()
  hub.setSnapshot(activeSnapshot(wid, [[0, 42.5, 10]]))
  const r1 = await syncSnapshot()
  assert.deepEqual(r1.state.pending, {})
  assert.equal(r1.state.workout.entries[0].sets[0].done, true)

  // 第 2 组：断网记 → 事件留队列；拉不到快照、发不出上报（调用方静默重试）
  globalThis.__velaFetch = undefined
  const s2 = await recordSet(0, 1, { w: 45, r: 8 })
  assert.equal(s2.workout.entries[0].sets[1].done, true)
  assert.equal((await getJSON('hubQueue', [])).length, 1)
  await assert.rejects(() => syncSnapshot())
  assert.equal(await flush(), false)
  assert.equal((await getJSON('hubQueue', [])).length, 1)

  // 恢复网络：补投成功；此后同 rev 跳过重复解析
  wireRealFetch()
  assert.equal(await flush(), true)
  assert.deepEqual((await getJSON('hubQueue', [])), [])
  hub.setSnapshot(activeSnapshot(wid, [[0, 42.5, 10], [1, 45, 8]]))   // 手机确认第 2 组
  const r2 = await syncSnapshot()
  assert.equal(r2.changed, true)
  assert.deepEqual(r2.state.pending, {})
  assert.equal(r2.state.workout.entries[0].sets[1].done, true)
  const r3 = await syncSnapshot()
  assert.equal(r3.changed, false)

  // 结束：finish 事件上报，手机队列逐条对账
  const fin = await end()
  assert.equal(fin.state.workout, null)
  assert.ok(fin.state.finishedHere.includes(wid))
  assert.equal(await flush(), true)
  assert.deepEqual(hub.state.queue.map(x => x.type), ['start', 'setDone', 'setDone', 'finish'])
  const ev1 = hub.state.queue[1]
  assert.equal(ev1.wid, wid)
  assert.equal(ev1.exId, '0001')
  assert.equal(ev1.entryIdx, 0)
  assert.equal(ev1.setIdx, 0)
  assert.equal(ev1.w, 42.5)
  assert.equal(ev1.r, 10)
  const ev2 = hub.state.queue[2]
  assert.equal(ev2.setIdx, 1)
  assert.equal(ev2.w, 45)
  assert.equal(ev2.r, 8)
  const evf = hub.state.queue[3]
  assert.equal(evf.wid, wid)
})

test('集成：手机端结束（快照无 active）→ 手表一起结束；迟到旧 rev 快照整体跳过', async () => {
  await pair()
  resetHubQueue()
  hub.setSnapshot(readySnapshot())
  const r = await syncSnapshot()
  const s = await begin(r.state.ready.today)
  const wid = s.workout.id
  await flush()

  hub.setSnapshot(activeSnapshot(wid))                 // 手机确认开局（否则自开未确认的会话不许被清）
  await syncSnapshot()

  hub.setSnapshot({ v: 1, unit: 'kg', restSec: 90, active: null, ready: null })   // 手机上结束了
  const r2 = await syncSnapshot()
  assert.equal(r2.state.workout, null)

  const revBefore = hub.state.rev
  hub.state.snapshot = activeSnapshot(wid)             // 迟到的旧快照（rev 不增）——拉取流按 rev 单调跳过
  const r3 = await syncSnapshot()
  assert.equal(r3.changed, false)
  assert.equal(hub.state.rev, revBefore)
  assert.equal(r3.state.workout, null)
})

test('集成：畸形事件（无 id）手机永不 acked；坏 JSON/形状错 400', async () => {
  wireRealFetch()
  const post = async payload => {
    const r = await fetch('http://127.0.0.1:' + hub.port + '/watch/events', {
      method: 'POST', headers: { Authorization: 'Bearer 13572468', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return { code: r.status, body: await r.json() }
  }
  let r = await post({ events: [{ type: 'setDone' }, { id: 'ok1', type: 'setDone' }] })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.acked, ['ok1'])              // 畸形的跳过，其余照常
  r = await post({ events: 'nope' })
  assert.equal(r.code, 400)
  assert.equal(r.body.error, 'bad_request')
  const raw = await fetch('http://127.0.0.1:' + hub.port + '/watch/events', {
    method: 'POST', headers: { Authorization: 'Bearer 13572468' }, body: '{broken'
  })
  assert.equal(raw.status, 400)
  assert.equal((await raw.json()).error, 'bad_json')
})

test('集成：单侧组自动轮流 L→R，两侧完成才算整组', async () => {
  await pair()
  hub.setSnapshot({
    v: 1, unit: 'kg', restSec: 90, active: null, ready: {
      today: {
        routineIds: ['r9'], name: '单侧日',
        entries: [{ id: '0099', name: '保加利亚分腿蹲', mode: 'reps', perSide: true, sets: [{ w: 20, r: 10, done: false, warmup: false, sides: { L: { w: 20, r: 10, done: false }, R: { w: 20, r: 10, done: false } } }] }]
      }, others: []
    }
  })
  const r = await syncSnapshot()
  const s = await begin(r.state.ready.today)
  assert.equal(s.workout.entries[0].sets[0].done, false)

  const s1 = await recordSet(0, 0, { w: 22.5, r: 10 })   // 第一侧
  assert.equal(s1.workout.entries[0].sets[0].done, false)
  assert.equal(s1.workout.entries[0].sets[0].sides.L.done, true)
  const s2 = await recordSet(0, 0, { w: 22.5, r: 10 })   // 第二侧
  assert.equal(s2.workout.entries[0].sets[0].done, true)
  assert.equal(s2.workout.entries[0].sets[0].sides.R.done, true)
  await flush()
  const sideEvs = hub.state.queue.filter(x => x.type === 'setDone' && x.exId === '0099')
  assert.deepEqual(sideEvs.map(x => x.side), ['L', 'R'])
})

// —— S8 2A：interconnect 系统通道段——hubCall 只换底层，契约与队列语义逐条不动 ——
// 通道桩（test/stubs/interconnect.mjs）：__icDiag 控制诊断结果、__icReply 充当手机对端、
// __icSent 记录发出去的请求。hubHost='interconnect' 时整个 hub.js 原样跑在通道上。

async function icPair() {
  await sSet('hubHost', 'interconnect')
  await sSet('hubToken', 'interconnect')
  globalThis.__icDiag = 0
  globalThis.__icTimeout = 60
  globalThis.__icSent = []
}

function cleanIc() {
  globalThis.__icDiag = undefined
  globalThis.__icTimeout = undefined
  globalThis.__icReply = undefined
  globalThis.__icSent = undefined
}

test('S8 ic：ping/快照/事件全走系统通道（HTTP 桩不碰）；事件按 ack 删队、同 id 重发无害', async () => {
  await icPair()
  globalThis.__velaFetch = async () => { throw new Error('不应走 HTTP') }
  globalThis.__icReply = async m => {
    if (m.path === '/watch/ping') return { id: m.id, status: 200, body: { ok: true, rev: 1, time: 1 } }
    if (m.path === '/watch/snapshot') {
      return { id: m.id, status: 200, body: { ok: true, rev: 1, snapshot: readySnapshot() } }
    }
    if (m.path === '/watch/events') return { id: m.id, status: 200, body: { ok: true, acked: m.body.events.map(e => e.id) } }
    return { id: m.id, status: 404, body: { ok: false, error: 'not_found' } }
  }
  assert.equal((await ping()).ok, true)
  const r = await syncSnapshot()
  assert.equal(r.changed, true)
  assert.equal(r.state.ready.today.name, '推日训练')

  await enqueue({ id: 'ic1', type: 'setDone', wid: 'w', exId: '0001', entryIdx: 0, setIdx: 0, w: 40, r: 10 })
  assert.equal(await flush(), true)
  assert.deepEqual(await getJSON('hubQueue', []), [])
  await enqueue({ id: 'ic1', type: 'setDone', wid: 'w', exId: '0001', entryIdx: 0, setIdx: 0, w: 40, r: 10 })
  assert.equal(await flush(), true)                 // 同 id 重发：通道上两发，本地队列干净
  assert.deepEqual(await getJSON('hubQueue', []), [])

  assert.deepEqual(globalThis.__icSent.map(x => x.path),
    ['/watch/ping', '/watch/snapshot', '/watch/events', '/watch/events'])
  assert.deepEqual(globalThis.__icSent.map(x => x.body), [null, null,
    { events: [{ id: 'ic1', type: 'setDone', wid: 'w', exId: '0001', entryIdx: 0, setIdx: 0, w: 40, r: 10 }] },
    { events: [{ id: 'ic1', type: 'setDone', wid: 'w', exId: '0001', entryIdx: 0, setIdx: 0, w: 40, r: 10 }] }])
  cleanIc()
})

test('S8 ic：非 2xx 透传错误码（401）；对端不应答按超时拒绝、队列原样保留', async () => {
  await icPair()
  globalThis.__icReply = async m => ({ id: m.id, status: 401, body: { ok: false, error: 'unauthorized' } })
  await assert.rejects(() => ping(), e => e.code === 401 && e.message === 'unauthorized')

  globalThis.__icReply = undefined                 // 手机失联：只发不应答 → 超时
  await enqueue({ id: 'ic2', type: 'finish', wid: 'w' })
  assert.equal(await flush(), false)
  assert.deepEqual((await getJSON('hubQueue', [])).map(x => x.id), ['ic2'])
  cleanIc()
})

// —— S10 会话过期（docs/watch-v2/s10）——

test('S10 过期：超 6 小时的本地会话自动离场——wid 进 finishedHere，finish 事件入队补投', async () => {
  await pair()
  resetHubQueue()
  hub.setSnapshot(readySnapshot())
  const s = await begin((await syncSnapshot()).state.ready.today)
  const wid = s.workout.id
  await flush()                                     // start 事件先投出去
  resetHubQueue()
  const st = await loadState()
  st.workout.start = Date.now() - 7 * 3600e3        // 把开局拨回 7 小时前
  await saveState(st)

  const out = await expireIfStale()
  assert.ok(out && out.workout === null, '会话清场')
  assert.ok(out.finishedHere.includes(wid), 'wid 进 tombstone，旧快照不许复活')
  const q = await getJSON('hubQueue', [])
  assert.equal(q.length, 1)
  assert.equal(q[0].type, 'finish')
  assert.equal(q[0].wid, wid)
  assert.equal(await flush(), true)
  assert.deepEqual(hub.state.queue.map(x => x.type), ['finish'])

  // 过期后旧快照（手机还没处理 finish）不许把会话复活
  hub.setSnapshot(activeSnapshot(wid))
  const r = await syncSnapshot()
  assert.equal(r.state.workout, null)
})

test('S10 过期：未过期/刚开的会话与无状态都不动', async () => {
  await pair()
  hub.setSnapshot(readySnapshot())
  const s = await begin((await syncSnapshot()).state.ready.today)
  const wid = s.workout.id
  await flush()                                      // start 事件投出去，队列清空
  assert.equal(await expireIfStale(), null)          // 刚开：不判过期
  const st = await loadState()
  assert.equal(st.workout.id, wid)
  assert.equal((await getJSON('hubQueue', [])).length, 0)

  await saveState(null)                              // 无状态
  assert.equal(await expireIfStale(), null)
  assert.deepEqual(await getJSON('hubQueue', []), [])
})
