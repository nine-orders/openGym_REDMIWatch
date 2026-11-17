// session-core.js 单测：SessionCore.swift 的 Swift 测试逐条翻写，一一对应。
// 用例名里括号内是 Swift 原名。来源三个文件（ios/App/WatchCore/Tests/WatchCoreTests/）：
//   SessionCoreTests.swift 9 条 / SetTypesTests.swift 10 条 /
//   SettingsAndWeighInTests.swift 2 条 / HealthDeleteTests.swift 3 条 = 24 条；
//   另有标注「补充」的用例，覆盖 Swift 测试没碰到的分支，不许合并删减那 24 条。
// 本文件零桩：session-core.js 无任何平台依赖，直接导入即可。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  newState, key, applySnapshot, markSide, tick, skip, isSkipped, next,
  healthToDelete, healthDeleted, healthDeletedEvent, weighIn,
  restAdjustEvent, restSkipEvent,
  start, finish, setIndex, progress, summary, beatsBest,
  sideUp, isTimed, isCardio, isBodyweight, showFlags,
  isExpired, SESSION_EXPIRY_MS
} from '../src/js/session-core.js'

// —— Swift 测试助手的对应物（字段缺省与 Swift/Codable 编码一致：nil 即缺键） ——

const row = (w, r, o) => {
  const v = o || {}
  const x = { done: v.done === true, warmup: v.warmup === true }
  if (w != null) x.w = w
  if (r != null) x.r = r
  if (v.sec != null) x.sec = v.sec
  if (v.at != null) x.at = v.at
  if (v.sides) x.sides = v.sides
  return x
}

const sideRow = (w, r) => {
  const x = row(w, r * 2)
  x.sides = { L: { w: w, r: r, done: false }, R: { w: w, r: r, done: false } }
  return x
}

const entry = (id, name, sets, o) => {
  const v = o || {}
  const e = { id: id, name: name, mode: v.mode || 'reps', sets: sets }
  if (v.restSec != null) e.restSec = v.restSec
  if (v.last != null) e.last = v.last
  if (v.bodyweight != null) e.bodyweight = v.bodyweight
  if (v.perSide != null) e.perSide = v.perSide
  if (v.group != null) e.group = v.group
  if (v.best != null) e.best = v.best
  if (v.assisted != null) e.assisted = v.assisted
  if (v.step != null) e.step = v.step
  return e
}

// SessionCoreTests.workout(_:sets:cur:)：推日两动作
const workout = (id, sets, cur) => ({
  id: id, name: 'Push', unit: 'kg', cur: cur || 0, restSec: 90,
  entries: [entry('0025', 'Bench Press', sets), entry('0426', 'Overhead Press', [row(40, 8)])]
})

const snap = w => ({ v: 1, unit: 'kg', restSec: 90, active: w, ready: null, settings: null })

// SetTypesTests.state(_:start:)：混装训练（默认 start=0）
const state = (entries, start) => applySnapshot(newState(), {
  v: 1, unit: 'kg', restSec: 90, ready: null, settings: null,
  active: { id: 'w1', name: 'Mixed', unit: 'kg', cur: 0, restSec: 90, entries: entries, start: start === undefined ? 0 : start }
})

// —— SessionCoreTests.swift（9 条） ——

test('快照：第一次打开就接上手机正在跑的训练（testPicksUpAWorkoutRunningOnThePhoneWhenFirstOpened）', () => {
  const s = applySnapshot(newState(), snap(workout('p1', [row(60, 8, { done: true, at: 1 }), row(60, 8)], 1)))
  assert.equal(s.workout.id, 'p1')
  assert.equal(s.entryIndex, 1)
  assert.equal(setIndex(s, 0), 1)
})

test('记组留到快照确认，两边都改时晚的获胜（testATickStaysUntilTheSnapshotShowsItAndTheLaterTickWins）', () => {
  let s = applySnapshot(newState(), snap(workout('p1', [row(60, 8), row(60, 8)])))
  const [t, event] = tick(s, 0, 0, { w: 62.5, r: 7, at: 1000, id: 'e1' })
  s = t
  assert.equal(event.type, 'setDone')
  assert.equal(event.wid, 'p1')
  // 旧快照（手机还没应用到这次记组）：tick 留着
  s = applySnapshot(s, snap(workout('p1', [row(60, 8), row(60, 8)])))
  assert.deepEqual(s.workout.entries[0].sets[0], row(62.5, 7, { done: true, at: 1000 }))
  assert.ok(s.pending['0025#0'])
  // 手机自己更早改过这一组：本端更晚的 tick 仍获胜
  s = applySnapshot(s, snap(workout('p1', [row(55, 5, { done: true, at: 500 }), row(60, 8)])))
  assert.equal(s.workout.entries[0].sets[0].w, 62.5)
  // 手机已应用：确认，不再 pending
  s = applySnapshot(s, snap(workout('p1', [row(62.5, 7, { done: true, at: 1000 }), row(60, 8)])))
  assert.equal(s.pending['0025#0'], undefined)
  // 手机上更晚的改动获胜
  s = tick(s, 0, 1, { w: 60, r: 8, at: 2000, id: 'e2' })[0]
  s = applySnapshot(s, snap(workout('p1', [row(62.5, 7, { done: true, at: 1000 }), row(65, 6, { done: true, at: 3000 })])))
  assert.equal(s.workout.entries[0].sets[1].w, 65)
  assert.equal(s.pending['0025#1'], undefined)
})

test('重启恢复会话，未确认的 tick 保住（testRelaunchRestoresTheSessionWithItsUnconfirmedTicks）', () => {
  let s = applySnapshot(newState(), snap(workout('p1', [row(60, 8), row(60, 8)])))
  s = tick(s, 0, 0, { w: 60, r: 8, at: 1000, id: 'e1' })[0]
  const saved = JSON.parse(JSON.stringify(s))
  assert.deepEqual(saved, s)   // 序列化往返无损（Swift Codable round-trip）
  // 手上的最新上下文还是旧快照：tick 活下来
  let back = applySnapshot(saved, snap(workout('p1', [row(60, 8), row(60, 8)])))
  assert.ok(back.workout.entries[0].sets[0].done)
})

test('手表上结束就保持结束，哪怕手机还没听到（testFinishedOnTheWatchStaysFinishedThoughThePhoneHasNotHeard）', () => {
  let s = applySnapshot(newState(), snap(workout('p1', [row(60, 8)])))
  const [f, event] = finish(s, 5000, 'f1')
  s = f
  assert.equal(event.type, 'finish')
  assert.equal(s.workout, null)
  s = applySnapshot(s, snap(workout('p1', [row(60, 8)])))
  assert.equal(s.workout, null, '手机还没应用结束的旧快照不会让它复活')
  s = applySnapshot(s, snap(workout('p2', [row(60, 8)])))
  assert.equal(s.workout.id, 'p2', '下一场训练照常显示')
})

test('手机上结束就让本端也结束（testFinishedOnThePhoneEndsItHere）', () => {
  let s = applySnapshot(newState(), snap(workout('p1', [row(60, 8)])))
  s = applySnapshot(s, snap(null))
  assert.equal(s.workout, null)
  assert.deepEqual(s.pending, {})
})

test('手表上开的会话保持到手机确认（testStartedOnTheWatchStaysUntilThePhoneHasIt）', () => {
  const ready = { routineIds: ['r1'], name: 'Push', entries: workout('x', [row(60, 8)]).entries }
  const [s0, event] = start(newState(), ready, 'watch-1', 100, 's1')
  let s = s0
  assert.equal(event.type, 'start')
  assert.equal(event.wid, 'watch-1')
  s = tick(s, 0, 0, { w: 60, r: 8, at: 200, id: 'e1' })[0]
  s = applySnapshot(s, snap(null))
  assert.equal(s.workout.id, 'watch-1', '手机还没听说过它')
  s = applySnapshot(s, snap(workout('phone-other', [row(1, 1)])))
  assert.equal(s.workout.id, 'watch-1', '手机上的另一场训练顶不掉它')
  s = applySnapshot(s, snap(workout('watch-1', [row(60, 8), row(40, 8)])))
  assert.equal(s.startedHere, null, '手机在跑它了')
  assert.ok(s.workout.entries[0].sets[0].done, '带着确认前记的组')
})

test('手机换了一场训练就干净开局（testAnotherWorkoutOnThePhoneStartsClean）', () => {
  let s = applySnapshot(newState(), snap(workout('p1', [row(60, 8)])))
  s = tick(s, 0, 0, { w: 60, r: 8, at: 1, id: 'e1' })[0]
  s = applySnapshot(s, snap(workout('p2', [row(70, 5)], 1)))
  assert.equal(s.workout.id, 'p2')
  assert.equal(s.workout.entries[0].sets[0].done, false, '旧 tick 绝不落到另一场训练上')
  assert.equal(s.entryIndex, 1)
})

test('进度只数工作组（testProgressCountsWorkSetsOnly）', () => {
  const w = workout('p1', [row(60, 8, { done: true, at: 1 }), row(60, 8)])
  w.entries[0].sets.unshift({ w: 20, r: 10, done: true, warmup: true, at: 1 })
  const s = applySnapshot(newState(), snap(w))
  assert.equal(progress(s).done, 1)
  assert.equal(progress(s).total, 3)
})

test('快照带未知字段、缺可选字段也能读（testReadsASnapshotWithFieldsItDoesNotKnowAndWithoutOptionalOnes）', () => {
  const json = '{"v":1,"future":true,"active":{"id":"p1","name":"Push","unit":"kg","cur":0,"restSec":90,"entries":[{"id":"0025","name":"Bench","mode":"reps","sets":[{"w":60,"r":8,"done":false,"warmup":false,"hr":{"avg":1}}]}]}}'
  const s = applySnapshot(newState(), JSON.parse(json))
  assert.equal(s.workout.entries[0].sets.length, 1)
})

// —— SetTypesTests.swift（10 条） ——

test('计时组带秒数记（testAHoldIsTickedWithItsSeconds）', () => {
  const s0 = state([entry('plank', 'Plank', [row(null, null, { sec: 45 }), row(null, null, { sec: 45 })], { mode: 'time' })])
  assert.ok(isTimed(s0.workout.entries[0]))
  const [s, ev] = tick(s0, 0, 0, { w: null, r: null, sec: 38, at: 10, id: 'h1' })
  assert.equal(s.workout.entries[0].sets[0].sec, 38)
  assert.equal(ev.sec, 38)
  assert.equal(ev.w, undefined)
  assert.equal(ev.r, undefined)
  // 旧快照保住本端的秒数，直到手机确认
  const back = applySnapshot(s, { v: 1, unit: 'kg', restSec: 90, active: s0.workout, ready: null, settings: null })
  assert.equal(back.workout.entries[0].sets[0].sec, 38)
  assert.equal(setIndex(back, 0), 1)
})

test('自重动作只算外加重量（testBodyweightCountsOnlyTheAddedWeight）', () => {
  const s0 = state([entry('pullup', 'Pull-up', [row(0, 10), row(5, 8)], { bodyweight: true })])
  assert.ok(isBodyweight(s0.workout.entries[0]))
  let s = tick(s0, 0, 0, { w: 0, r: 10, at: 1, id: 'a' })[0]
  s = tick(s, 0, 1, { w: 5, r: 8, at: 2, id: 'b' })[0]
  const sum = summary(s.workout, 60000)
  assert.equal(sum.sets, 2)
  assert.equal(sum.volume, 40)
})

test('单侧组一次只练一侧（testAPerSideSetIsDoneOneSideAtATime）', () => {
  const e = entry('split', 'Split squat', [sideRow(20, 8), sideRow(20, 8)], { perSide: true })
  let s = state([e, entry('calf', 'Calf raise', [row(40, 12)])])
  assert.equal(sideUp(s.workout.entries[0].sets[0]), 'L')
  const [s1, ev] = tick(s, 0, 0, { side: 'L', w: 20, r: 8, at: 5, id: 'l' })
  assert.equal(ev.side, 'L')
  assert.equal(s1.workout.entries[0].sets[0].done, false, '单侧不算整组')
  assert.equal(sideUp(s1.workout.entries[0].sets[0]), 'R')
  // 接着练另一侧：同一动作，中间不休息
  const n = next(s1, 0, 0)
  assert.equal(n.entry, 0)
  assert.equal(n.rest, false)
  s = tick(s1, 0, 0, { side: 'R', w: 20, r: 7, at: 6, id: 'r' })[0]
  const row0 = s.workout.entries[0].sets[0]
  assert.ok(row0.done)
  assert.equal(row0.r, 15)
  assert.equal(setIndex(s, 0), 1)
  // 旧快照保住本端练过的两侧
  const back = applySnapshot(s, { v: 1, unit: 'kg', restSec: 90, active: state([e]).workout, ready: null, settings: null })
  assert.equal(back.workout.entries[0].sets[0].sides.R.r, 7)
  assert.ok(back.workout.entries[0].sets[0].done)
  // 手机也有它们了：确认
  const phone = state([e]).workout
  phone.entries[0].sets[0] = row0
  const confirmed = applySnapshot(back, { v: 1, unit: 'kg', restSec: 90, active: phone, ready: null, settings: null })
  assert.equal(confirmed.pending['split#0#L'], undefined)
  assert.equal(confirmed.pending['split#0#R'], undefined)
  assert.equal(summary(s.workout, 1).volume, 300)   // 20×8 + 20×7
})

test('热身组不算工作组（testWarmUpsAreNotWorkSets）', () => {
  let s = state([entry('bench', 'Bench', [row(40, 10, { warmup: true }), row(60, 8)])])
  assert.equal(progress(s).total, 1)
  s = tick(s, 0, 0, { w: 40, r: 10, at: 1, id: 'w' })[0]
  assert.equal(progress(s).done, 0)
  assert.equal(summary(s.workout, 1).volume, 0)
  assert.equal(setIndex(s, 0), 1)
})

test('超级组轮着做，一轮完了才休息（testASupersetGoesInTurnsAndRestsAfterTheRound）', () => {
  const s0 = state([
    entry('curl', 'Curl', [row(12, 10), row(12, 10)], { group: 'a' }),
    entry('push', 'Pushdown', [row(20, 12), row(20, 12)], { group: 'a' }),
    entry('raise', 'Lateral raise', [row(8, 15)])
  ])
  let s = tick(s0, 0, 0, { w: 12, r: 10, at: 1, id: '1' })[0]
  let n = next(s, 0, 0)
  assert.equal(n.entry, 1, '轮到搭档')
  assert.equal(n.rest, false, '一轮之内不休息')
  s = tick(s, 1, 0, { w: 20, r: 12, at: 2, id: '2' })[0]
  n = next(s, 1, 0)
  assert.equal(n.entry, 0, '回到第一个进入下一轮')
  assert.equal(n.rest, true, '一轮结束才休息')
  s = tick(s, 0, 1, { w: 12, r: 10, at: 3, id: '3' })[0]
  s = tick(s, 1, 1, { w: 20, r: 12, at: 4, id: '4' })[0]
  n = next(s, 1, 1)
  assert.equal(n.entry, 2, '超级组做完：下一个动作')
  s = tick(s, 2, 0, { w: 8, r: 15, at: 5, id: '5' })[0]
  assert.equal(next(s, 2, 0).entry, 3, '全做完：结束页')
})

test('跳过的组是被绕开不是被完成（testASkippedSetIsPassedOverNotDone）', () => {
  let s = state([entry('bench', 'Bench', [row(60, 8), row(60, 8), row(60, 8)])])
  s = skip(s, 0, 0)
  assert.equal(setIndex(s, 0), 1)
  assert.equal(s.workout.entries[0].sets[0].done, false)
  // 手动点名，它就回来
  assert.equal(setIndex(s, 0, 0), 0)
  // 新的一场训练把它忘了
  const other = { id: 'w2', name: 'Other', unit: 'kg', cur: 0, restSec: 90, entries: s.workout.entries }
  const s2 = applySnapshot(s, { v: 1, unit: 'kg', restSec: 90, active: other, ready: null, settings: null })
  assert.equal(s2.skipped, null)
  assert.equal(summary(s.workout, 1).sets, 0)
})

test('有氧组不带数值地记（testCardioIsTickedWithoutNumbers）', () => {
  const s0 = state([entry('run', 'Treadmill', [row(null, null)], { mode: 'cardio' })])
  const [s, ev] = tick(s0, 0, 0, { w: null, r: null, at: 1, id: 'c' })
  assert.ok(s.workout.entries[0].sets[0].done)
  assert.equal(ev.w, undefined)
  assert.equal(ev.r, undefined)
})

test('总结：时长、体量与纪录（testTheSummaryCountsTimeVolumeAndRecords）', () => {
  const bench = entry('bench', 'Bench', [row(40, 10, { warmup: true }), row(80, 5), row(80, 6)], { best: { w: 80, r: 5 } })
  const row1 = entry('row', 'Row', [row(60, 8)], { best: { w: 70, r: 8 } })
  const assist = entry('dip', 'Assisted dip', [row(20, 8)], { best: { w: 25, r: 8 }, assisted: true })
  const plank = entry('plank', 'Plank', [row(null, null, { sec: 60 })], { mode: 'time', best: { sec: 50 } })
  const fresh = entry('new', 'New thing', [row(100, 1)])
  let s = state([bench, row1, assist, plank, fresh], 1000)
  ;[[0, 0], [0, 1], [0, 2], [1, 0], [2, 0], [3, 0], [4, 0]].forEach(c => {
    const r = s.workout.entries[c[0]].sets[c[1]]
    s = tick(s, c[0], c[1], { w: r.w, r: r.r, sec: r.sec, at: 2, id: '' + c[0] + c[1] })[0]
  })
  const sum = summary(s.workout, 1000 + 45 * 60000)
  assert.equal(sum.duration, 45 * 60)
  assert.equal(sum.sets, 6, '热身组不计')
  const expected = 400 + 480 + 480 + 160 + 100   // 80×5, 80×6, 60×8, 20×8, 100×1
  assert.equal(sum.volume, expected)
  assert.deepEqual(sum.prs, ['Bench', 'Assisted dip', 'Plank'], '同重更多次、辅助更轻、撑更久；没历史没 PR')
  assert.equal(sum.endedOnPhone, false)
})

test('旧手机缺新字段也能读，新字段也认得（testAnOlderPhoneWithoutTheNewFieldsStillReads）', () => {
  const older = JSON.parse('{"v":1,"active":{"id":"w","name":"A","unit":"kg","cur":0,"restSec":90,"entries":[{"id":"x","name":"X","mode":"reps","sets":[{"w":1,"r":2,"done":false,"warmup":false}]}]}}')
  assert.equal(older.active.start, undefined)
  assert.equal(older.active.entries[0].group, undefined)
  assert.equal(older.active.entries[0].sets[0].sides, undefined)
  const newer = JSON.parse('{"v":1,"active":{"id":"w","name":"A","unit":"kg","cur":0,"restSec":90,"start":5,"entries":[{"id":"x","name":"X","mode":"reps","perSide":true,"group":"g","best":{"w":10,"r":5},"sets":[{"w":1,"r":2,"done":false,"warmup":false,"sides":{"L":{"w":1,"r":1,"done":true},"R":{"w":1,"r":1,"done":false}}}]}]}}')
  assert.equal(sideUp(newer.active.entries[0].sets[0]), 'R')
  assert.equal(newer.active.start, 5)
})

test('上个版本存的状态还能读（testAStateSavedByTheLastBuildStillLoads）', () => {
  const saved = JSON.parse('{"settings":{},"unit":"kg","restSec":90,"finishedHere":[],"pending":{"x#0":{"w":1,"r":2,"at":3}},"entryIndex":0}')
  assert.equal(saved.skipped, undefined)   // 新字段缺省（Swift nil ↔ JS 缺键）
  assert.equal(saved.pending['x#0'].sec, undefined)
})

// —— SettingsAndWeighInTests.swift（2 条） ——

test('称重事件发出，且能搭在开局事件上（testTheWeighInGoesOutAndRidesOnTheStart）', () => {
  const ev = weighIn(81.44, 5, 'b')
  assert.equal(ev.type, 'weighIn')
  assert.equal(ev.w, 81.4)
  assert.equal(weighIn(0, 5, 'x'), null)
  const ready = { routineIds: ['r'], name: 'Push', entries: [] }
  const r1 = start(newState(), ready, 'watch-1', 5, 's', 81.44)
  assert.equal(r1[1].bw, 81.4)
  const r2 = start(newState(), ready, 'watch-2', 5, 's2')
  assert.equal(r2[1].bw, undefined)
})

test('设置读新旧两种形态（testTheSettingsReadWithAndWithoutTheNewFields）', () => {
  const json = '{"v":1,"settings":{"health":true,"lang":"pt-BR","weighIn":false,"lastBw":80.5,"show":{"clip":false,"elapsed":true,"rest":"plain"}},"active":{"id":"w","name":"A","unit":"kg","cur":0,"restSec":90,"entries":[{"id":"x","name":"X","mode":"reps","step":1.25,"sets":[]}]}}'
  const s = applySnapshot(newState(), JSON.parse(json))
  assert.equal(s.settings.lang, 'pt-BR')
  assert.equal(s.settings.weighIn, false)
  assert.equal(s.settings.lastBw, 80.5)
  const show = showFlags(s.settings.show)
  assert.equal(show.showClip, false)
  assert.equal(show.showHr, true)
  assert.equal(show.showElapsed, true)
  assert.equal(show.restRing, false)
  assert.equal(s.workout.entries[0].step, 1.25)
  const old = applySnapshot(newState(), JSON.parse('{"v":1,"settings":{"health":false}}'))
  const d = showFlags(old.settings.show)
  assert.ok(d.showClip && d.showHr && d.showLast && d.showNext && d.restRing)
  assert.ok(!(d.showElapsed || d.showKcal))
  assert.equal(old.settings.lang, undefined)
})

// —— HealthDeleteTests.swift（3 条） ——

test('只认训练 id、没撤过的、每条一次（testOnlyWorkoutIdsNotDoneYetOnceEach）', () => {
  const todo = healthToDelete(['opengym-w-a', 'opengym-bw-2026-10-01', 'opengym-w-b', 'opengym-w-a'], ['opengym-w-b'])
  assert.deepEqual(todo, ['opengym-w-a'])
  assert.deepEqual(healthToDelete(null, []), [])
})

test('已撤列表有界，重复处理无事发生（testDoneIsKeptBoundedAndANewRoundIsANoOp）', () => {
  let done = healthDeleted([], ['opengym-w-a'])
  done = healthDeleted(done, ['opengym-w-a'])
  assert.deepEqual(done, ['opengym-w-a'])
  assert.deepEqual(healthToDelete(['opengym-w-a'], done), [])
  const many = []
  for (let i = 0; i < 400; i++) many.push('opengym-w-' + i)
  assert.equal(healthDeleted([], many).length, 300)
  const ev = healthDeletedEvent(['opengym-w-a'], 'e')
  assert.equal(ev.type, 'healthDeleted')
  assert.equal(healthDeletedEvent([], 'e'), null)
})

test('快照带已删列表能读（testASnapshotWithTheListReads）', () => {
  const parsed = JSON.parse('{"v":1,"healthGone":["opengym-w-x"]}')
  assert.deepEqual(parsed.healthGone, ['opengym-w-x'])
})

// —— 补充：Swift 测试没碰到的分支 ——

test('补充 tick：越界安全返回原状态与 null 事件，原状态不被修改', () => {
  const s0 = newState()
  assert.deepEqual(tick(s0, 0, 0, { at: 1, id: 'x' }), [s0, null])
  const s1 = state([entry('a', 'A', [row(10, 5)])])
  assert.equal(tick(s1, 1, 0, { at: 1, id: 'x' })[1], null)
  assert.equal(tick(s1, 0, 5, { at: 1, id: 'x' })[1], null)
  const before = JSON.stringify(s1)
  tick(s1, 0, 0, { w: 12, r: 5, at: 9, id: 'y' })
  assert.equal(JSON.stringify(s1), before)
})

test('补充 finish：没有训练时无事发生；finishedHere 只留最近 5 场', () => {
  const [, ev] = finish(newState(), 1, 'f')
  assert.equal(ev, null)
  let s0 = newState()
  for (let i = 0; i < 7; i++) {
    s0 = applySnapshot(s0, snap(workout('p' + i, [row(60, 8)])))
    s0 = finish(s0, i, 'f' + i)[0]
  }
  assert.deepEqual(s0.finishedHere, ['p2', 'p3', 'p4', 'p5', 'p6'])
})

test('补充 weighIn：700 上界与负数无效，一位小数舍入', () => {
  assert.equal(weighIn(700, 1, 'x'), null)
  assert.equal(weighIn(-3, 1, 'x'), null)
  assert.equal(weighIn(699.99, 1, 'x').w, 700)
})

test('补充 next：entry 越界返回 (entryIndex, false)', () => {
  const s = state([entry('a', 'A', [row(10, 5)])])
  s.entryIndex = 2
  assert.deepEqual(next(s, 5, 0), { entry: 2, rest: false })
  assert.deepEqual(next(s, -1, 0), { entry: 2, rest: false })
})

test('补充 skip / isSkipped：越界原样返回；重复 skip 不产生重复键', () => {
  let s = state([entry('a', 'A', [row(10, 5)])])
  assert.equal(skip(s, 3, 0), s)
  s = skip(s, 0, 0)
  assert.ok(isSkipped(s, 'a', 0))
  assert.ok(!isSkipped(s, 'a', 1))
  assert.ok(!isSkipped(s, 'b', 0))
  s = skip(s, 0, 0)
  assert.deepEqual(s.skipped, ['a#0'])
})

test('补充 setIndex：picked 越界或已完成时回落第一个未完成', () => {
  let s = state([entry('a', 'A', [row(10, 5), row(10, 5)])])
  assert.equal(setIndex(s, 0, 5), 0)      // picked 越界
  s = tick(s, 0, 0, { w: 10, r: 5, at: 1, id: 'x' })[0]
  assert.equal(setIndex(s, 0, 0), 1)      // picked 已完成 → 下一个
  assert.equal(setIndex(s, 0, 1), 1)
  s = tick(s, 0, 1, { w: 10, r: 5, at: 2, id: 'y' })[0]
  assert.equal(setIndex(s, 0), null)      // 全完
})

test('补充 beatsBest：有氧、空 best、计时无历史秒数；辅助动作同重比次数', () => {
  assert.equal(beatsBest(entry('run', 'Run', [], { mode: 'cardio' }), [row(1, 1)], {}), false)
  assert.equal(beatsBest(entry('a', 'A', []), [row(80, 5)], {}), false)                    // best 全空
  assert.equal(beatsBest(entry('p', 'P', [], { mode: 'time' }), [row(null, null, { sec: 40 })], { sec: null }), false)
  assert.equal(beatsBest(entry('p', 'P', [], { mode: 'time' }), [row(null, null, { sec: 60 })], { sec: 50 }), true)
  const assist = entry('d', 'Dip', [], { assisted: true })
  assert.equal(beatsBest(assist, [row(25, 9)], { w: 25, r: 8 }), true)   // 同重更多次
  assert.equal(beatsBest(assist, [row(25, 7)], { w: 25, r: 8 }), false)
  assert.equal(beatsBest(assist, [row(30, 1)], { w: 25, r: 8 }), false)  // 更重不是更好
  assert.equal(beatsBest(entry('b', 'B', []), [row(80, 9)], { w: 80, r: 8 }), true)
  assert.equal(beatsBest(entry('b', 'B', []), [row(80, 7)], { w: 80, r: 8 }), false)
  assert.equal(beatsBest(entry('b', 'B', []), [row(85, 1)], { w: 80, r: 8 }), true)
})

test('补充 applySnapshot：restSec<=0 与缺 unit 不覆盖旧值；entryIndex 夹到 entries.length', () => {
  let s = applySnapshot(newState(), { v: 1, unit: 'kg', restSec: 120, active: null, ready: null, settings: null })
  assert.equal(s.restSec, 120)
  s = applySnapshot(s, { v: 1, restSec: 0, active: null, ready: null, settings: null })
  assert.equal(s.unit, 'kg')
  assert.equal(s.restSec, 120)
  const w1 = workout('p1', [row(60, 8)])
  const s2 = applySnapshot(newState(), { v: 1, unit: 'kg', restSec: 90, active: { ...w1, cur: 9, entries: w1.entries.slice(0, 1) }, ready: null, settings: null })
  assert.equal(s2.entryIndex, 1)   // cur 越界夹到 entries.length（最后一页是结束）
})

test('补充 applySnapshot：手机端不再是单侧组时，单侧 pending 丢弃', () => {
  let s = state([entry('split', 'Split squat', [sideRow(20, 8)], { perSide: true })])
  s = tick(s, 0, 0, { side: 'L', w: 20, r: 8, at: 5, id: 'l' })[0]
  const plain = state([entry('split', 'Split squat', [row(20, 16)])]).workout
  const s2 = applySnapshot(s, { v: 1, unit: 'kg', restSec: 90, active: plain, ready: null, settings: null })
  assert.equal(s2.pending['split#0#L'], undefined)
  assert.equal(s2.workout.entries[0].sets[0].done, false)   // 单侧记账不落到普通组上
})

test('补充 summary：start 缺失用 startedAt 兜底，都缺则 duration=null；endedOnPhone 透传', () => {
  const w = { id: 'w1', name: 'Mixed', unit: 'kg', cur: 0, restSec: 90, entries: [entry('a', 'A', [row(10, 5)])] }
  w.entries[0].sets[0].done = true
  assert.equal(summary(w, 60000, 0).duration, 60)
  assert.equal(summary(w, 60000, null).duration, null)
  assert.equal(summary(w, 60000, 0, true).endedOnPhone, true)
})

test('补充 markSide：不改入参行，非记组一侧的原值保留', () => {
  const row0 = sideRow(20, 8)
  const out = markSide(row0, 'L', 22, 9, 5)
  assert.ok(out.sides !== row0.sides && out.sides.L !== row0.sides.L)   // 新行是新对象
  assert.equal(out.sides.L.done, true)
  assert.equal(out.sides.R.done, false)
  assert.equal(row0.sides.L.done, false) // 原行不动
  assert.equal(out.done, false)          // 单侧不算整组
  assert.equal(out.r, 17)                // 9 + 8
  assert.equal(out.w, 22)                // max(22, 20)
  assert.equal(out.at, 5)
})

// —— v2.1 休息事件构造器（docs/watch-v2/s9）：形状对齐手机端 applyEvents 的读取 ——

test('补充 restAdjustEvent：add>0 才产出；add 取整；wid 缺省空串', () => {
  assert.deepEqual(restAdjustEvent('w1', 30, 1234, 'r1'), { id: 'r1', type: 'restAdjust', wid: 'w1', at: 1234, add: 30 })
  assert.deepEqual(restAdjustEvent('w1', 30.4, 1234, 'r2').add, 30)      // 取整
  assert.deepEqual(restAdjustEvent(null, 15, 1234, 'r3'), { id: 'r3', type: 'restAdjust', wid: '', at: 1234, add: 15 })
  assert.equal(restAdjustEvent('w1', 0, 1234, 'r4'), null)               // 无效加秒不发
  assert.equal(restAdjustEvent('w1', -5, 1234, 'r5'), null)
})

test('补充 restSkipEvent：形状对齐；wid 缺省空串', () => {
  assert.deepEqual(restSkipEvent('w1', 1234, 's1'), { id: 's1', type: 'restSkip', wid: 'w1', at: 1234 })
  assert.deepEqual(restSkipEvent(null, 1234, 's2'), { id: 's2', type: 'restSkip', wid: '', at: 1234 })
})

// —— S10 会话过期（docs/watch-v2/s10） ——

test('补充 isExpired：从 workout.start 起算 6 小时；整点不判、超 1ms 判；无 start/无会话不判', () => {
  const t0 = 1700000000000
  assert.equal(SESSION_EXPIRY_MS, 6 * 3600e3)
  const withStart = start => {
    const s = state([entry('a', 'A', [row(10, 5)])])
    s.workout.start = start
    return s
  }
  assert.equal(isExpired(withStart(t0 - 6 * 3600e3), t0), false)       // 恰好 6 小时：不判
  assert.equal(isExpired(withStart(t0 - 6 * 3600e3 - 1), t0), true)    // 超过 1ms 即过期
  assert.equal(isExpired(withStart(t0 - 7 * 3600e3), t0), true)
  assert.equal(isExpired(withStart(t0 - 3600e3), t0), false)           // 1 小时：正常训练
  assert.equal(isExpired(withStart(null), t0), false)                  // 无 start 无法判断
  assert.equal(isExpired(state([entry('a', 'A', [row(10, 5)])], null), t0), false)  // start=null
  const bare = state([entry('a', 'A', [row(10, 5)])], null)
  bare.workout = null
  assert.equal(isExpired(bare, t0), false)                             // 没有会话
  assert.equal(isExpired(null, t0), false)                             // 无状态
})
