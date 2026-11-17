// session.js / api.js 逻辑单测：@system.fetch 用可编程桩模拟服务器与断网，不依赖真机。
import './register.mjs'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// 动态导入：register.mjs 先执行注册解析钩子，@system.* 桩与无扩展名导入才生效
const { sSet, getJSON, setJSON } = await import('../src/js/store')
const { redeem, putData } = await import('../src/js/api')
const {
  round2, uid, todayISO, nameOf,
  buildPlanCache, todayRoutineId, buildSession, totals, toWorkout,
  pushWorkout, queueOrPush, flushPending, markQueueDone
} = await import('../src/js/session')

beforeEach(() => {
  globalThis.__velaStore = new Map()
  globalThis.__velaFetch = undefined
})

function planState(over = {}) {
  return {
    unit: 'kg', restSec: 90,
    routines: [
      { id: 'r1', name: '推日', ex: [
        { id: '0001', sets: 3, reps: 10, weight: 20 },
        { id: '0007', sets: 2, sec: 45, mode: 'time' }
      ] },
      { id: 'r2', name: '腿日', ex: [{ id: '0003', sets: 4, reps: 8, weight: 60 }] }
    ],
    week: { 1: 'r1' }, dayPlan: {}, queue: { ids: ['r2'], startsOn: '2026-10-01' },
    customEx: [{ id: 'c9', n: '自建动作' }],
    exWeights: { '0005': { w: 12 } },
    workouts: [
      { id: 'w_old', d: '2026-10-20', entries: [{ id: '0001', sets: [{ w: 25, r: 8, done: true }, { w: 25, r: 8, done: false }] }] },
      { id: 'w_new', d: '2026-10-30', entries: [{ id: '0001', sets: [{ w: 22.5, r: 10, done: true }, { w: 24, r: 9, done: true }] }] }
    ],
    ...over
  }
}

test('基础工具：round2 / uid / todayISO', () => {
  assert.equal(round2(22.456), 22.46)
  assert.equal(round2('x'), 0)
  assert.match(uid(), /^[\w]+$/)
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(nameOf('0001'), '0001') // names.js 为空表时用 id 兜底
})

test('buildPlanCache：weight 字段、last 沿用、自建名、队列', () => {
  const c = buildPlanCache(planState())
  assert.equal(c.unit, 'kg')
  assert.equal(c.restSec, 90)
  assert.equal(c.routines.length, 2)
  assert.equal(c.routines[0].ex[0].w, 20)        // 服务器字段是 weight，不是 w
  assert.equal(c.routines[0].ex[1].sec, 45)
  assert.equal(c.routines[1].ex[0].w, 60)
  // last：最新一次训练里最重的完成组（旧的 25 不覆盖新的 24×9）
  assert.deepEqual(c.last['0001'], { w: 24, r: 9 })
  // exWeights 兜底
  assert.deepEqual(c.last['0005'], { w: 12, r: 0 })
  assert.deepEqual(c.customNames, { c9: '自建动作' })
  assert.deepEqual(c.queue, { ids: ['r2'], startsOn: '2026-10-01' })
  assert.deepEqual(c.queueDoneIds, []) // 档案里的旧训练没带 routineId/名称匹配，不算完成
})

test('buildPlanCache：空档案不炸', () => {
  const c = buildPlanCache({})
  assert.deepEqual(c.routines, [])
  assert.deepEqual(c.last, {})
})

test('todayRoutineId：日计划 > 队列 > 周计划，rest 跳过，周计划容忍数组', () => {
  const today = todayISO()
  const dow = String(new Date().getDay())
  assert.equal(todayRoutineId(buildPlanCache(planState({ dayPlan: { [today]: 'r2' } }))), 'r2')
  assert.equal(todayRoutineId(buildPlanCache(planState({ dayPlan: { [today]: 'rest' } }))), '')
  // week[wd] 在前端是 string[]（history.js:477），标量是旧数据形态：两种都要能读
  assert.equal(todayRoutineId(buildPlanCache(planState({ week: { [dow]: ['r1'] }, queue: null }))), 'r1')
  assert.equal(todayRoutineId(buildPlanCache(planState({ week: { [dow]: ['r1', 'r2'] }, queue: null }))), 'r1')
  assert.equal(todayRoutineId(buildPlanCache(planState({ week: { [dow]: ['', 'r1'] }, queue: null }))), 'r1')
  // 队列优先于周计划（对齐服务端 effectiveRoutineIds：队列日它排在周计划前面）
  assert.equal(todayRoutineId(buildPlanCache(planState({ week: { [dow]: 'r1' } }))), 'r2')
  assert.equal(todayRoutineId(buildPlanCache(planState({ week: { [dow]: ['r1'] } }))), 'r2')
  // 轮换主路径：指向第一个「未完成」会话——练完 r1 指向 r2（DONE RULE 见下方专项用例）
  assert.equal(todayRoutineId(buildPlanCache(planState({
    queue: { ids: ['r1', 'r2'], startsOn: '2026-10-01' },
    workouts: [{ id: 'w1', d: today, start: Date.now(), routineId: 'r1', name: '推日', entries: [] }]
  }))), 'r2')
  // 队列全部完成 → 落到周计划
  assert.equal(todayRoutineId(buildPlanCache(planState({
    queue: { ids: ['r1'], startsOn: '2026-10-01' },
    workouts: [{ id: 'w1', d: today, start: Date.now(), routineId: 'r1', name: '推日', entries: [] }],
    week: { [dow]: 'r1' }
  }))), 'r1')
  // 轮换还没开始（startsOn 在未来）→ 队列不接管。week 显式清空：默认夹具的周一只排
  // r1，这行原来在周一跑会兜底到周计划返回 'r1'（2026-11-02 实测踩中，日期相关缺陷）
  assert.equal(todayRoutineId(buildPlanCache(planState({
    queue: { ids: ['r2'], startsOn: '2099-01-01' }, week: {}
  }))), '')
  // 悬空 id（动作单已删）按服务端语义跳过，落到下一层
  assert.equal(todayRoutineId(buildPlanCache(planState({ dayPlan: { [today]: 'gone' }, week: { [dow]: 'r1' } }))), 'r2')
  assert.equal(todayRoutineId(buildPlanCache(planState({ queue: { ids: ['gone'], startsOn: '2026-10-01' }, week: { [dow]: 'r1' } }))), 'r1')
  assert.equal(todayRoutineId(buildPlanCache(planState({ week: {}, queue: null }))), '')
})

test('buildPlanCache：队列 DONE RULE——start/日期/名称三路判定，strict 收紧，坏形状容错', () => {
  const since = Date.parse('2026-10-01T00:00:00')
  const mk = (workouts, queueOver = {}) => buildPlanCache(planState({
    queue: { ids: ['r1', 'r2'], since, startsOn: '2026-10-01', ...queueOver },
    workouts
  }))
  // start >= since：主路径，训练携带 routineId
  assert.deepEqual(mk([{ id: 'w1', start: since + 1, routineId: 'r1', entries: [] }]).queueDoneIds, ['r1'])
  // 合并会话：routineIds 数组 + 名称 'A + B'
  assert.deepEqual(mk([{ id: 'w2', start: since + 1, routineIds: ['r1', 'r2'], name: '推日 + 腿日', entries: [] }]).queueDoneIds, ['r1', 'r2'])
  // 非 strict 的名称兜底：训练携带 routineId 但没有 start 时间戳时，改用
  // 训练日 >= startsOn + 训练名含动作单名判定（id 关联始终是前置条件）
  assert.deepEqual(mk([{ id: 'w3', d: '2026-10-05', routineId: 'r2', name: '腿日', entries: [] }]).queueDoneIds, ['r2'])
  assert.deepEqual(mk([{ id: 'w3b', d: '2026-10-05', routineId: 'r2', name: '别的课', entries: [] }]).queueDoneIds, [])
  // strict：名称兜底关闭
  assert.deepEqual(mk([{ id: 'w3', d: '2026-10-05', routineId: 'r2', name: '腿日', entries: [] }], { strict: true }).queueDoneIds, [])
  // 日期边界：start 早于 since 不算；训练日早于 startsOn 的名称兜底不算
  assert.deepEqual(mk([{ id: 'w4', start: since - 1, routineId: 'r1', entries: [] }]).queueDoneIds, [])
  assert.deepEqual(mk([{ id: 'w5', d: '2026-09-30', routineId: 'r1', name: '推日', entries: [] }]).queueDoneIds, [])
  // 坏形状队列读成"没有队列"（queueOf 容错）
  assert.deepEqual(buildPlanCache(planState({ queue: { nope: 1 } })).queueDoneIds, [])
  assert.deepEqual(buildPlanCache(planState({ queue: { ids: ['gone2', 'gone2'] } })).queue, null)
})

test('buildSession：沿用上次实际值，计时动作按秒', () => {
  const plan = buildPlanCache(planState())
  const s = buildSession(plan, 'r1')
  assert.equal(s.name, '推日')
  assert.equal(s.unit, 'kg')
  assert.equal(s.restSec, 90)
  assert.equal(s.entries[0].sets.length, 3)
  assert.equal(s.entries[0].sets[0].w, 24)   // 上次实际最重组
  assert.equal(s.entries[0].sets[0].r, 9)
  assert.equal(s.entries[0].sets.every(x => x.done === false && x.ts === 0), true)
  assert.equal(s.entries[1].mode, 'sec')
  assert.equal(s.entries[1].sets[0].r, 45)
  assert.equal(s.entries[1].sets[0].w, 0)    // 无历史 → 自重
  // 计划里不存在的 id 回落到第一个动作单
  assert.equal(buildSession(plan, 'nope').routineId, 'r1')
  // 动作单专属 restSec（rs）进 plan cache 并落到 entry，休息页才能按动作配休息时长
  assert.equal(plan.routines[0].ex[0].rs, undefined)
  const r3 = buildPlanCache(planState({ routines: [{ id: 'r3', name: '配休息', ex: [{ id: '0001', sets: 2, reps: 8, weight: 30, restSec: 60 }] }] }))
  assert.equal(r3.routines[0].ex[0].rs, 60)
  assert.equal(buildSession(r3, 'r3').entries[0].rs, 60)
  // 自建动作名
  const c2 = buildPlanCache(planState({ routines: [{ id: 'r9', name: '自', ex: [{ id: 'c9', sets: 3, reps: 12, weight: 10 }] }] }))
  assert.equal(buildSession(c2, 'r9').entries[0].name, '自建动作')
})

test('totals / toWorkout：只算完成组，空动作剔除', () => {
  const plan = buildPlanCache(planState({ workouts: [] }))
  const s = buildSession(plan, 'r1')
  s.entries[0].sets[0].done = true; s.entries[0].sets[0].w = 20; s.entries[0].sets[0].r = 10; s.entries[0].sets[0].ts = 123
  const t = totals(s)
  assert.deepEqual(t, { done: 1, total: 5, vol: 200 })
  const w = toWorkout(s)
  assert.equal(w.entries.length, 1)
  assert.equal(w.entries[0].topW, 20)
  assert.deepEqual(w.entries[0].sets, [{ w: 20, r: 10, done: true, ts: 123 }])
  assert.ok(w.id && w.d && w.start && w.end && w._ts)
})

// —— 服务器交互（桩模拟） ——

function mockServer(steps) {
  const calls = []
  let i = 0
  globalThis.__velaFetch = async opts => {
    calls.push(opts)
    const step = steps[Math.min(i++, steps.length - 1)]
    return typeof step === 'function' ? step(opts) : step
  }
  return calls
}

const doneSession = () => {
  const plan = buildPlanCache(planState({ workouts: [] }))
  const s = buildSession(plan, 'r1')
  s.entries[0].sets.forEach(x => { x.done = true; x.w = 20; x.r = 10; x.ts = 1 })
  s.entries[1].sets[0].done = true; s.entries[1].sets[0].r = 45; s.entries[1].sets[0].ts = 2
  return s
}

test('pushWorkout：成功路径，baseRev 与体重/PR 组装正确', async () => {
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'tok')
  const calls = mockServer([
    { code: 200, data: { state: { workouts: [], bodyweight: [{ d: 'x', w: 80 }] }, rev: 3 } },
    { code: 200, data: { ok: true, rev: 4 } }
  ])
  const w = toWorkout(doneSession())
  assert.equal(await pushWorkout(w), true)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].url.endsWith('/api/data'))
  const body = JSON.parse(calls[1].data)
  assert.equal(body.baseRev, 3)
  assert.equal(body.state.workouts[0].id, w.id)
  assert.equal(body.state.workouts[0].bw, 80)
  // 空历史：一切有重量的动作都是 PR（0001），计时自重（0007）topW=0 不算
  assert.deepEqual(body.state.workouts[0].prs, ['0001'])
  assert.equal(body.state._ts > 0, true)
})

test('pushWorkout：409 冲突自动带新文档重试', async () => {
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'tok')
  const calls = mockServer([
    { code: 200, data: { state: { workouts: [] }, rev: 1 } },
    { code: 409, data: { error: 'conflict', rev: 2 } },
    { code: 200, data: { state: { workouts: [{ id: 'w_other' }] }, rev: 2 } },
    { code: 200, data: { ok: true } }
  ])
  const w = toWorkout(doneSession())
  assert.equal(await pushWorkout(w), true)
  assert.equal(calls.length, 4)
  assert.equal(JSON.parse(calls[3].data).baseRev, 2)
})

test('pushWorkout：连续冲突 3 轮后报错', async () => {
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'tok')
  let n = 0
  mockServer([
    opts => opts.method === 'PUT'
      ? { code: 409, data: { error: 'conflict', rev: ++n } }
      : { code: 200, data: { state: { workouts: [] }, rev: 1 } }
  ])
  await assert.rejects(() => pushWorkout(toWorkout(doneSession())), /版本冲突/)
})

test('pushWorkout：空档案给出明确提示；已同步过直接返回', async () => {
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'tok')
  mockServer([{ code: 200, data: { state: null, rev: 0 } }])
  await assert.rejects(() => pushWorkout(toWorkout(doneSession())), /档案为空/)

  const w = toWorkout(doneSession())
  mockServer([
    { code: 200, data: { state: { workouts: [{ id: w.id }] }, rev: 5 } }
  ])
  assert.equal(await pushWorkout(w), true) // 去重：不再 PUT
})

test('api：HTTP 400 的错误码与文案透传；未配对给出明确提示', async () => {
  await sSet('host', '127.0.0.1:8080')
  mockServer([{ code: 400, data: { error: 'invalid or expired code' } }])
  await assert.rejects(() => redeem('BADCODE1'), e => e.code === 400 && /invalid or expired/.test(e.message))
  globalThis.__velaStore.delete('host')
  await assert.rejects(() => redeem('BADCODE1'), /未配置服务器地址/)
})

test('queueOrPush + flushPending：断网入队，恢复后补投', async () => {
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'tok')
  const w = toWorkout(doneSession())
  const r = await queueOrPush(w)                 // __velaFetch 未注入 = 断网
  assert.equal(r.synced, false)
  assert.ok(/网络失败/.test(r.error))
  assert.equal((await getJSON('pending', [])).length, 1)
  const calls = mockServer([
    { code: 200, data: { state: { workouts: [] }, rev: 1 } },
    { code: 200, data: { ok: true } }
  ])
  assert.equal(await flushPending(), true)
  assert.equal(calls.length, 2)
  assert.equal((await getJSON('pending', [])).length, 0)
})

test('markQueueDone：推送成功后就地推进本地轮换（离线补投走 flushPending 同样生效）', async () => {
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'tok')
  await setJSON('plan', buildPlanCache(planState({
    queue: { ids: ['r1', 'r2'], startsOn: '2026-10-01' }, workouts: []
  })))
  mockServer([
    { code: 200, data: { state: { workouts: [] }, rev: 1 } },
    { code: 200, data: { ok: true } }
  ])
  const w = toWorkout(doneSession())             // routineId = r1
  assert.equal((await queueOrPush(w)).synced, true)
  assert.deepEqual((await getJSON('plan', null)).queueDoneIds, ['r1'])
  // 直接调用 / 重复推送不产生重复记录
  await markQueueDone(w.routineId)
  assert.deepEqual((await getJSON('plan', null)).queueDoneIds, ['r1'])
  // 不在队列里的动作单不写入
  await markQueueDone('r9')
  assert.deepEqual((await getJSON('plan', null)).queueDoneIds, ['r1'])
  // 无 plan 缓存时静默不炸
  await setJSON('plan', null)
  await markQueueDone(w.routineId)
})

test('putData：JSON 序列化 + Bearer 头', async () => {
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'tok123')
  const calls = mockServer([{ code: 200, data: { ok: true } }])
  await putData({ state: { workouts: [] }, baseRev: 7 })
  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].header.Authorization, 'Bearer tok123')
  assert.deepEqual(JSON.parse(calls[0].data), { state: { workouts: [] }, baseRev: 7 })
})
