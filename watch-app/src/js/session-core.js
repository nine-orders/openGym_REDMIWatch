// 会话状态机（S5）：Apple Watch 版 SessionCore.swift（src/frontend/ios/App/WatchCore/
// Sources/WatchCore/SessionCore.swift + Model.swift）的逐条移植。手表 v2 与 Apple Watch
// 版语义完全对齐，语义冲突时一律以 Swift 为准。平台无关零依赖纯 JS：不 import 任何
// 其它 watch 模块（@system.* / store / names / api 都不碰），S3/S4 的 hub 语义与 v2
// 复用都靠这一点；需要的小工具（深拷贝、sideUp、isTimed、showFlags 等）就地实现。
//
// 同步逐案（对应 SessionCore.swift 文件头，手机侧是 lib/watch-sync.js）：
//   手机先开局、手表后打开 → applySnapshot 从快照接上正在跑的训练
//   手表中途被杀重启       → 状态每次变更后整体落盘恢复，最新快照盖上来，
//                            本端未经确认的记组（pending）保住
//   手机锁屏/杀掉/断蓝牙   → 手表独立跑，每个 tick/start/finish 是一条事件，按 id
//                            幂等上报（重发由调用方负责，core 只产出事件）
//   快照早于本端记组       → pending 留着，直到快照显示该组在记组时刻或之后已完成
//   两端都改过同一组       → at 晚的获胜（本端在 applySnapshot，手机端在训练页 handler）
//   手表上结束、手机没听到 → 会话立即离场（finishedHere），旧快照不许把它复活
//   手机上结束、手表没听到 → 快照里没有它就结束；期间记的组照发，手机补写进已存训练
//   手表上开局、手机没听到 → startedHere 记着，快照里没有它不算结束
//
// 核心类型字段约定（全部是普通 JS 对象，字段名沿用 Swift 命名，Swift 的 nil/缺省 =
// undefined 或缺键，可无失真地 JSON 往返）：
//   SessionState   { workout: ActiveWorkout|null, ready: Ready|null, settings: {},
//                    unit: 'kg', restSec: 90, startedHere: string|null,
//                    finishedHere: string[], pending: { [key]: PendingTick },
//                    entryIndex: number, skipped: string[]|null }
//   PendingTick    { at: number, w?, r?, sec? }   —— 本端记的组，等快照确认
//   Snapshot       { v, unit?, restSec?, active?: ActiveWorkout|null, ready?,
//                    settings?, healthGone?: string[] }   —— 手机下发
//   ActiveWorkout  { id?, name, unit, cur, restSec, rest?, entries: Entry[], start? }
//   Entry          { id, name, mode: 'reps'|'time'|'cardio', restSec?, last?,
//                    sets: SetRow[], bodyweight?, perSide?, group?, best?: BestSet,
//                    assisted?, step? }
//   SetRow         { w?, r?, sec?, done, warmup, at?,
//                    sides?: { L: SideRow, R: SideRow } }  —— done 指两侧都完成
//   SideRow        { w?, r?, done }
//   BestSet        { w?, r?, sec? }
//   ReadySession   { routineIds: string[], name, entries: Entry[] }
//   Event          { id, type, ... } —— 可选字段只在有值时出现（w=0 会带上）
//   WorkoutSummary { name, unit, duration?|null, sets, volume, prs: string[],
//                    endedOnPhone }
// 值语义：入参一律不被修改，返回新对象（Swift struct 拷贝的对应物）；需要改动的地方
// 先用 clone() 拷贝（状态数据全部来自 JSON 快照，此法最简单且不与调用方共享引用）。

// JSON 深拷贝
const clone = v => JSON.parse(JSON.stringify(v))

// 空白会话状态（SessionState() 的默认构造）
export function newState() {
  return {
    workout: null, ready: null, settings: {},
    unit: 'kg', restSec: 90,
    startedHere: null, finishedHere: [], pending: {},
    entryIndex: 0, skipped: null
  }
}

// —— Model.swift 的派生标记（Swift 计算属性 → 小函数） ——

// Entry：'time' = 计时（每组记 sec 的 hold），'cardio' = 有氧（数值在手机端记）
export const isTimed = e => e.mode === 'time'
export const isCardio = e => e.mode === 'cardio'
export const isBodyweight = e => e.bodyweight === true

// SetRow：单侧组下一个该练的一侧（先 L 后 R），两侧都完成返回 null
export function sideUp(row) {
  if (!row.sides) return null
  if (!row.sides.L.done) return 'L'
  if (!row.sides.R.done) return 'R'
  return null
}

// WatchShow 的默认值口径（Swift showClip…/restRing）：每个字段缺省 = 下面的默认
export function showFlags(show) {
  const s = show || {}
  return {
    showClip: s.clip != null ? s.clip : true,
    showHr: s.hr != null ? s.hr : true,
    showLast: s.last != null ? s.last : true,
    showElapsed: s.elapsed != null ? s.elapsed : false,
    showKcal: s.kcal != null ? s.kcal : false,
    showNext: s.next != null ? s.next : true,
    restRing: s.rest !== 'plain'
  }
}

// "exerciseId#setIndex"（单侧再拼 "#L"/"#R"）—— pending / skipped 的字典键
export function key(exId, si, side) {
  return side ? exId + '#' + si + '#' + side : exId + '#' + si
}

// 手机快照盖到手表现有状态上。ready/unit/restSec/settings 照抄快照（restSec 仅在 >0 时
// 生效）；本端记的组在手机确认前不被旧快照冲掉；本端开局未经确认的会话不被快照结束；
// 手机已结束的会话（finishedHere）不会被旧快照复活。
export function applySnapshot(s0, snap) {
  const s = { ...s0, pending: { ...s0.pending } }
  s.ready = snap.ready != null ? snap.ready : null
  if (snap.unit != null) s.unit = snap.unit
  if (snap.restSec != null && snap.restSec > 0) s.restSec = snap.restSec
  if (snap.settings != null) s.settings = snap.settings

  // 本端自开、手机还没回报在跑的训练
  const unconfirmed = s.workout != null && s.workout.id != null && s.workout.id === s.startedHere
  const next0 = snap.active
  const gone = next0 && next0.id != null && s.finishedHere.indexOf(next0.id) >= 0
  if (!next0 || gone) {
    // 手机上没有进行中的训练（或它还没听到本端的结束）
    if (unconfirmed) return s
    s.workout = null
    s.pending = {}
    return s
  }
  const next = clone(next0)
  const same = next.id != null && s.workout != null && next.id === s.workout.id
  if (next.id != null && next.id === s.startedHere) s.startedHere = null
  if (!same && unconfirmed) {
    // 手机在跑另一个训练，而本端自开的还没被确认：各留各的
    return s
  }
  if (!same) {
    // 另一场训练（或本端见到的第一场）：位置跟手机，旧的记账清空
    s.pending = {}
    s.skipped = null
    s.entryIndex = next.cur
  }
  // 本端已记、手机还没显示的组获胜；两边都改过的组，时间晚的获胜
  for (let ei = 0; ei < next.entries.length; ei++) {
    const e = next.entries[ei]
    for (let si = 0; si < e.sets.length; si++) {
      const row = e.sets[si]
      const p = s.pending[key(e.id, si)]
      if (p) {
        if (row.done && (row.at == null || row.at >= p.at)) {
          delete s.pending[key(e.id, si)]    // 手机已经有了（或它自己后来又改过）
        } else {
          e.sets[si] = { ...row, done: true, at: p.at }
          if (p.w != null) e.sets[si].w = p.w
          if (p.r != null) e.sets[si].r = p.r
          if (p.sec != null) e.sets[si].sec = p.sec
        }
      }
      // 单侧组：每侧独立按同样的规则走一遍
      const sidesArr = ['L', 'R']
      for (let i = 0; i < sidesArr.length; i++) {
        const side = sidesArr[i]
        const ps = s.pending[key(e.id, si, side)]
        if (!ps) continue
        const have = e.sets[si]
        if (have.sides && have.sides[side] && have.sides[side].done === true && (row.at == null || row.at >= ps.at)) {
          delete s.pending[key(e.id, si, side)]
        } else if (have.sides) {
          e.sets[si] = markSide(have, side, ps.w, ps.r, ps.at)
        } else {
          delete s.pending[key(e.id, si, side)]   // 手机端已经不是单侧组了
        }
      }
    }
  }
  const idx = s.entryIndex != null ? s.entryIndex : 0
  s.entryIndex = Math.min(Math.max(0, idx), next.entries.length)   // 最后一页是"结束"
  s.workout = next
  return s
}

// 单侧完成：行自身的数值跟随两侧汇总（对齐手机端 syncSideAggregate——次数相加、
// 重量取较重、两侧都完成才算整组完成）。纯函数，不改入参行。
export function markSide(row0, side, w, r, at) {
  if (!row0.sides) return row0
  const sides = { L: { ...row0.sides.L }, R: { ...row0.sides.R } }
  const one = sides[side]
  one.done = true
  if (w != null) one.w = w
  if (r != null) one.r = r
  return {
    ...row0,
    sides: sides,
    done: sides.L.done === true && sides.R.done === true,
    r: (sides.L.r != null ? sides.L.r : 0) + (sides.R.r != null ? sides.R.r : 0),
    w: Math.max(sides.L.w != null ? sides.L.w : 0, sides.R.w != null ? sides.R.w : 0),
    at: Math.max(row0.at != null ? row0.at : 0, at)
  }
}

// 本端记一组：状态里该组变为已完成（单侧组只完成一侧），并产出待发事件。
// o = { side, w, r, sec, at, id, hr }：side 记单侧组的一侧；sec 是计时组的秒数；
// 有氧组不带数值；at 是毫秒时间戳，晚记的获胜。返回 [新状态, 事件]（越界返回 [原状态, null]）。
export function tick(s0, ei, si, o) {
  const workout = s0.workout
  if (!workout || ei < 0 || ei >= workout.entries.length) return [s0, null]
  const e0 = workout.entries[ei]
  if (si < 0 || si >= e0.sets.length) return [s0, null]
  const opts = o || {}
  const s = { ...s0, pending: { ...s0.pending } }
  const w = clone(workout)
  const e = w.entries[ei]
  const oneSide = opts.side != null && e.sets[si].sides ? opts.side : null
  if (oneSide != null) {
    e.sets[si] = markSide(e.sets[si], oneSide, opts.w, opts.r, opts.at)
  } else {
    const row = e.sets[si]
    row.done = true
    if (opts.w != null) row.w = opts.w
    if (opts.r != null) row.r = opts.r
    if (opts.sec != null) row.sec = opts.sec
    row.at = opts.at
  }
  s.workout = w
  const p = { at: opts.at }
  if (opts.w != null) p.w = opts.w
  if (opts.r != null) p.r = opts.r
  if (opts.sec != null) p.sec = opts.sec
  s.pending[key(e.id, si, oneSide)] = p
  const event = {
    id: opts.id, type: 'setDone', wid: w.id != null ? w.id : '',
    exId: e.id, entryIdx: ei, setIdx: si, at: opts.at
  }
  if (opts.w != null) event.w = opts.w
  if (opts.r != null) event.r = opts.r
  if (opts.sec != null) event.sec = opts.sec
  if (oneSide != null) event.side = oneSide
  if (opts.hr != null) event.hr = opts.hr
  return [s, event]
}

// 跳过一组：不算完成，下一组顶上来（点它的圆点可找回）。键去重后排序，稳定可序列化。
export function skip(s0, ei, si) {
  const w = s0.workout
  if (!w || ei < 0 || ei >= w.entries.length) return s0
  if (si < 0 || si >= w.entries[ei].sets.length) return s0
  const k = key(w.entries[ei].id, si)
  const out = (s0.skipped || []).slice()
  if (out.indexOf(k) < 0) out.push(k)
  out.sort()
  return { ...s0, skipped: out }
}

export function isSkipped(s, exId, si) {
  return s.skipped ? s.skipped.indexOf(key(exId, si)) >= 0 : false
}

// 一组记完后的去处：返回 { entry: 页码, rest: 是否先休息 }。
//   单侧组还有一侧没练 → 原动作，不休息（接着练另一侧）
//   超级组             → 轮到组内下一个动作；一轮的最后才休息
//   其它               → 本动作还有组就继续本动作，否则下一个还有组的动作；
//                        全部完了是"结束"页（entry = entries.length）
export function next(s, ei, si) {
  const w = s.workout
  if (!w || ei < 0 || ei >= w.entries.length) return { entry: s.entryIndex, rest: false }
  const count = w.entries.length
  const sets = w.entries[ei].sets
  if (si >= 0 && si < sets.length && sideUp(sets[si])) return { entry: ei, rest: false }
  const open = n => setIndex(s, n) != null
  const g = w.entries[ei].group
  if (g != null) {
    let lo = ei
    let hi = ei
    while (lo > 0 && w.entries[lo - 1].group === g) lo--
    while (hi + 1 < count && w.entries[hi + 1].group === g) hi++
    if (hi > lo) {
      const members = []
      for (let i = lo; i <= hi; i++) members.push(i)
      const inTurn = members.filter(n => n > ei).concat(members.filter(n => n <= ei))
      for (let i = 0; i < inTurn.length; i++) {
        if (open(inTurn[i])) return { entry: inTurn[i], rest: inTurn[i] <= ei }
      }
      for (let n = hi + 1; n < count; n++) if (open(n)) return { entry: n, rest: true }
      for (let n = 0; n < lo; n++) if (open(n)) return { entry: n, rest: true }
      return { entry: count, rest: true }
    }
  }
  if (open(ei)) return { entry: ei, rest: true }
  for (let n = ei + 1; n < count; n++) if (open(n)) return { entry: n, rest: true }
  for (let n = 0; n < ei; n++) if (open(n)) return { entry: n, rest: true }
  return { entry: count, rest: true }
}

// 手机点名的已删训练里，本端还没撤下的那些（done：已撤，或查明本端没有副本）。
// 只认训练 id（"opengym-w-" 前缀）；v2 手表无 Health 写入，此组函数给 hub 侧对账复用。
export function healthToDelete(gone, done) {
  const seen = done || []
  const list = gone || []
  const out = []
  for (let i = 0; i < list.length; i++) {
    const id = list[i]
    if (typeof id === 'string' && id.indexOf('opengym-w-') === 0 && seen.indexOf(id) < 0 && out.indexOf(id) < 0) out.push(id)
  }
  return out
}

// 已撤列表加入这些 id，保留最新 300 条（手机最多点名最近 60 条删除，几百条绰绰有余）
export function healthDeleted(done, ids) {
  const add = ids || []
  const out = (done || []).filter(id => add.indexOf(id) < 0)
  return out.concat(add).slice(-300)
}

// 撤完告知手机，让它停止重发这些点名
export function healthDeletedEvent(ids, id) {
  return ids && ids.length ? { id: id, type: 'healthDeleted', ids: ids } : null
}

// 本端开训前的称重，供手机端体重列表。>0 且 <700 才有效；保留 1 位小数
// （Swift .rounded() 对正数与 Math.round 同为四舍五入，guard 保证 w > 0）
export function weighIn(w, at, id) {
  if (!(w > 0) || !(w < 700)) return null
  return { id: id, type: 'weighIn', w: Math.round(w * 10) / 10, at: at }
}

// 休息事件（v2.1，docs/watch-v2/s9）：手表上的 +30 秒 / 跳过休息发给手机，让两端计时器
// 同步。休息是页面本地的短时状态，事件不改 SessionState——只对「手机端同一场训练的休息
// 计时器正在走」有意义；新鲜度守卫在手机端（过期即弃，fork 参考的过期编辑保护）。
// addSec > 0 才有效；返回 null 表示没有要发的。
export function restAdjustEvent(wid, addSec, at, id) {
  if (!(addSec > 0)) return null
  return { id: id, type: 'restAdjust', wid: wid != null ? wid : '', at: at, add: Math.round(addSec) }
}

export function restSkipEvent(wid, at, id) {
  return { id: id, type: 'restSkip', wid: wid != null ? wid : '', at: at }
}

// 本端开一场就绪会话（可带刚称的体重）。会话先由手表记着，等手机回报在跑。
export function start(s0, session, wid, at, id, bw) {
  const s = { ...s0, pending: {} }
  s.workout = {
    id: wid, name: session.name, unit: s.unit, cur: 0, restSec: s.restSec,
    entries: clone(session.entries), start: at
  }
  s.startedHere = wid
  s.skipped = null
  s.entryIndex = 0
  const event = { id: id, type: 'start', routineIds: session.routineIds, wid: wid, at: at }
  if (bw != null && bw > 0) event.bw = Math.round(bw * 10) / 10
  return [s, event]
}

// 本端结束会话：立即清场（旧快照不许把它复活），wid 进 finishedHere（保留最近 5 场）。
export function finish(s0, at, id) {
  const w = s0.workout
  if (!w) return [s0, null]
  const s = { ...s0, pending: {} }
  s.workout = null
  s.skipped = null
  s.startedHere = null
  if (w.id != null) s.finishedHere = (s0.finishedHere || []).concat([w.id]).slice(-5)
  return [s, { id: id, type: 'finish', wid: w.id != null ? w.id : '', at: at }]
}

// —— S10 会话过期（fork 参考：未保存的本地会话 6 小时过期） ——
// 锚点是 workout.start（开局毫秒），手机确认的会话与手表自开的都适用；无 start 无法
// 判断就不判。过期动作本身复用 finish()（wid 进 finishedHere tombstone + finish 事件），
// 由 hub.expireIfStale 在会话页打开时触发——页面开着（正在用）不查，正在练的会话不过期。
export const SESSION_EXPIRY_MS = 6 * 3600e3

export function isExpired(s, now) {
  return !!(s && s.workout && s.workout.start != null && now - s.workout.start > SESSION_EXPIRY_MS)
}

// 本动作下一个该做的组：手动点选的优先（未完成的才算），否则第一个未完成且未跳过的
export function setIndex(s, ei, picked) {
  const w = s.workout
  if (!w || ei < 0 || ei >= w.entries.length) return null
  const sets = w.entries[ei].sets
  if (picked != null && picked >= 0 && picked < sets.length && !sets[picked].done) return picked
  const exId = w.entries[ei].id
  for (let i = 0; i < sets.length; i++) {
    if (!sets[i].done && !isSkipped(s, exId, i)) return i
  }
  return null
}

// 完成组数 / 总组数（表冠圆环用）：热身组不计
export function progress(s) {
  const w = s.workout
  if (!w) return { done: 0, total: 0 }
  let done = 0
  let total = 0
  w.entries.forEach(e => {
    e.sets.forEach(row => {
      if (row.warmup) return
      total++
      if (row.done) done++
    })
  })
  return { done: done, total: total }
}

// 训练总结（结束页，或手机端结束时）：时长（秒）、组数、体量、PR 动作名。
// 组数与体量都排除热身组；单侧组两侧各算体量、两侧都完成才算一组；计时/有氧不计体量。
export function summary(w, end, startedAt, endedOnPhone) {
  let sets = 0
  let volume = 0
  const prs = []
  w.entries.forEach(e => {
    const work = e.sets.filter(row => !row.warmup)
    work.forEach(row => {
      if (row.sides) {
        ;[row.sides.L, row.sides.R].forEach(one => {
          if (one.done) volume += (one.w != null ? one.w : 0) * (one.r != null ? one.r : 0)
        })
        if (row.done) sets++
      } else if (row.done) {
        sets++
        if (!isTimed(e) && !isCardio(e)) volume += (row.w != null ? row.w : 0) * (row.r != null ? row.r : 0)
      }
    })
    if (e.best != null && beatsBest(e, work.filter(row => row.done), e.best)) prs.push(e.name)
  })
  const from = w.start != null ? w.start : (startedAt != null ? startedAt : null)
  return {
    name: w.name, unit: w.unit,
    duration: from != null ? Math.max(0, (end - from) / 1000) : null,
    sets: sets, volume: volume, prs: prs,
    endedOnPhone: endedOnPhone === true
  }
}

// 本次是否破了该动作的历史最佳（没历史就没 PR），逐字对齐 Swift：
//   更重；同重更多次；辅助动作反向（重量更小 = 更好）；计时组比秒。
export function beatsBest(e, done, best) {
  if (isTimed(e)) {
    const b = best.sec
    if (b == null || !(b > 0)) return false
    return done.some(row => (row.sec != null ? row.sec : 0) > b)
  }
  if (isCardio(e)) return false
  const bw = best.w
  const br = best.r
  if (bw == null || br == null || !(bw > 0 || br > 0)) return false
  const assisted = e.assisted === true
  return done.some(row => {
    const w = row.w != null ? row.w : 0
    const r = row.r != null ? row.r : 0
    if (w !== bw) return w > 0 && (assisted ? w < bw : w > bw)
    return r > br
  })
}
