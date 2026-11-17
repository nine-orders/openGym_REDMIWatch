// 会话构建、进度计算与回写同步。手表端不复刻 openGym 前端的渐进加重引擎
// （lib/session-start.js 的处方逻辑），而是采用 openGym 自带的 startFrom:'last' 语义：
// 组数×次数按模板，重量/次数沿用该动作上一次训练的实际值，找不到再用模板值。
// 结束时组装标准 Workout 文档追加进 /api/data 整档状态——服务端对"不盖戳的写入者"
// 有字段级保护（只会追加、不会删掉它没见过的字段），所以这种只追加的提交是安全的。
import NAMES from './names.js'
import { getData, putData, activity } from './api'
import { getJSON, setJSON } from './store'

export const round2 = n => Math.round((Number(n) || 0) * 100) / 100
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

export function todayISO() {
  const d = new Date()
  const p = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export const nameOf = id => (NAMES && NAMES[id]) || (typeof id === 'string' && id ? id : '?')

// —— 教练队列（轮换）的 DONE RULE，逐字对齐前端 lib/queue.js ——
// 一个队列场次算完成：存在一场训练携带该 routineId（w.routineIds 数组或 w.routineId），
// 且 (w.start >= q.since)；非 strict 时训练日 >= startsOn 且训练名含动作单名也算
// （合并会话的 name 形如 'A + B'，按 ' + ' 切分比对）。未结束的会话（网页端 S.active、
// 手表未推送的 active）都不在 workouts 里，天然不计。
const routineIdsOf = w => (Array.isArray(w.routineIds) ? w.routineIds : (w.routineId ? [w.routineId] : []))
const nameParts = w => String(w.name || '').split(' + ')
const isoOf = d => {
  const p = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// 容错读取：整档同步是 last-writer-wins，坏形状读成"没有队列"而不是炸掉。已删动作单
// 的场次被丢弃（不可能再开局/落库），缺 startsOn 时用 since（毫秒）换算成本地日期。
function queueOf(state) {
  const q = state && state.queue
  if (!q || typeof q !== 'object' || !Array.isArray(q.ids)) return null
  const routines = Array.isArray(state.routines) ? state.routines : []
  const ids = q.ids.filter((id, i) => q.ids.indexOf(id) === i && routines.some(r => r.id === id))
  if (!ids.length) return null
  return { ...q, ids, startsOn: typeof q.startsOn === 'string' ? q.startsOn : isoOf(new Date(q.since || 0)) }
}

function countsFor(state, q, w, id) {
  return routineIdsOf(w).includes(id)
    && ((w.start != null ? w.start : 0) >= q.since
      || (q.strict !== true && String(w.d || '') >= q.startsOn
        && nameParts(w).includes(((state.routines || []).find(r => r.id === id) || {}).name)))
}

// 把整档状态压缩成手表需要的计划缓存（体积小、手表可离线开局）
export function buildPlanCache(state) {
  const out = {
    unit: state.unit || 'kg',
    restSec: state.restSec || 90,
    routines: [],
    week: state.week || {},
    dayPlan: state.dayPlan || {},
    queue: null,
    queueDoneIds: [],
    customNames: {},
    last: {}
  }
  const src = Array.isArray(state.routines) ? state.routines : []
  src.forEach(r => {
    if (!r || !r.id) return
    out.routines.push({
      id: r.id,
      name: r.name || '未命名',
      ex: (Array.isArray(r.ex) ? r.ex : []).map(e => ({
        id: e.id, sets: e.sets, reps: e.reps, repsMin: e.repsMin, sec: e.sec, w: e.weight, rs: e.restSec
      }))
    })
  })
  ;(Array.isArray(state.customEx) ? state.customEx : []).forEach(c => {
    if (c && c.id && c.n) out.customNames[c.id] = c.n
  })
  // 上次实际值：从最新到最旧扫历史，每个动作取第一次出现的最重组
  const ws = Array.isArray(state.workouts) ? state.workouts : []
  for (let i = ws.length - 1; i >= 0; i--) {
    const entries = (ws[i] && Array.isArray(ws[i].entries)) ? ws[i].entries : []
    for (let j = 0; j < entries.length; j++) {
      const en = entries[j]
      if (!en || !en.id || out.last[en.id]) continue
      const sets = Array.isArray(en.sets) ? en.sets.filter(x => x && x.done) : []
      if (!sets.length) continue
      const top = sets.reduce((a, b) => ((b.w || 0) > (a.w || 0) ? b : a), sets[0])
      out.last[en.id] = { w: top.w || 0, r: top.r || 0 }
    }
  }
  const exw = state.exWeights || {}
  Object.keys(exw).forEach(id => {
    if (!out.last[id] && exw[id] && typeof exw[id].w === 'number') out.last[id] = { w: exw[id].w, r: 0 }
  })
  const q = queueOf(state)
  if (q) {
    out.queue = { ids: q.ids, startsOn: q.startsOn }
    const ws = Array.isArray(state.workouts) ? state.workouts : []
    out.queueDoneIds = q.ids.filter(id => ws.some(w => countsFor(state, q, w, id)))
  }
  return out
}

// 今天该练哪个动作单。优先级对齐服务端 effectiveRoutineIds（前端 lib/history.js:477）：
// dayPlan 覆盖 > 教练队列 > 周计划。队列的语义是「第一个未完成的会话」（queueRemaining[0]），
// 完成判定按 DONE RULE 在 buildPlanCache 构建时算好（queueDoneIds），推送成功后就地追加；
// 轮换还没开始（startsOn 在未来）时队列不接管，与 queueNext 只应答一天的语义一致。
// week[wd] 在前端是 string[]（一天可排多个），这里容忍标量与数组两种形态；dayPlan/队列里
// 指向不存在动作单的悬空 id 按服务端语义跳过、落到下一层，而不是开局报错。
export function todayRoutineId(plan) {
  const t = todayISO()
  const dp = plan.dayPlan || {}
  const wk = plan.week || {}
  const dow = '' + new Date().getDay()
  const has = id => id && (plan.routines || []).some(r => r.id === id)
  if (dp[t] === 'rest') return ''
  if (has(dp[t])) return dp[t]
  const q = (plan.queue && Array.isArray(plan.queue.ids)) ? plan.queue.ids : []
  const startsOn = (plan.queue && plan.queue.startsOn) || ''
  if (q.length && (!startsOn || t >= startsOn)) {
    const done = Array.isArray(plan.queueDoneIds) ? plan.queueDoneIds : []
    const remaining = q.filter(id => has(id) && !done.includes(id))
    if (remaining.length) return remaining[0]
  }
  return [].concat(wk[dow] || []).filter(has)[0] || ''
}

// 从计划缓存构建一次训练会话（沿用上次模式）
export function buildSession(plan, routineId) {
  const r = plan.routines.find(x => x.id === routineId) || plan.routines[0]
  if (!r) return null
  const entries = r.ex.map(cfg => {
    const last = (plan.last && plan.last[cfg.id]) || {}
    const sec = cfg.sec || null
    const setsN = Math.max(1, Math.round(cfg.sets || 3))
    const w = (last.w != null && last.w > 0) ? last.w : (cfg.w || 0)
    const reps = sec ? sec : (last.r > 0 ? last.r : (cfg.reps || cfg.repsMin || 10))
    const sets = []
    for (let i = 0; i < setsN; i++) {
      sets.push({ w: round2(w), r: sec ? Math.round(sec) : Math.round(reps), done: false, ts: 0 })
    }
    return {
      id: cfg.id,
      name: (plan.customNames && plan.customNames[cfg.id]) || nameOf(cfg.id),
      mode: sec ? 'sec' : 'reps',
      rs: cfg.rs,
      sets: sets
    }
  })
  return {
    id: uid(),
    routineId: r.id,
    name: r.name,
    unit: plan.unit || 'kg',
    start: Date.now(),
    restSec: plan.restSec || 90,
    entries: entries
  }
}

export function totals(s) {
  let done = 0, total = 0, vol = 0
  s.entries.forEach(en => {
    en.sets.forEach(x => {
      total++
      if (x.done) { done++; vol += (x.w || 0) * (x.r || 0) }
    })
  })
  return { done: done, total: total, vol: Math.round(vol) }
}

// 会话 → 标准 Workout 文档（与 openGym 前端提交的结构一致，analytics/progression 直接可读）
export function toWorkout(s) {
  const t = totals(s)
  const entries = []
  s.entries.forEach(en => {
    const done = en.sets.filter(x => x.done)
    if (!done.length) return
    const topW = done.reduce((a, b) => (b.w || 0) > a ? b.w : a, 0)
    entries.push({
      id: en.id,
      topW: topW || null,
      sets: done.map(x => ({ w: x.w || 0, r: x.r || 0, done: true, ts: x.ts }))
    })
  })
  return {
    id: s.id,
    d: todayISO(),
    start: s.start,
    end: Date.now(),
    routineId: s.routineId,
    name: s.name,
    vol: t.vol,
    entries: entries,
    _ts: Date.now()
  }
}

// 基于全历史算 PR：某动作本次最重组超过历史任何一次 topW
function prsOf(w, workouts) {
  const out = []
  w.entries.forEach(en => {
    const top = en.topW || 0
    if (!top) return
    let prev = 0
    ;(workouts || []).forEach(h => {
      if (!h || !Array.isArray(h.entries)) return
      h.entries.forEach(x => {
        if (x && x.id === en.id && typeof x.topW === 'number' && x.topW > prev) prev = x.topW
      })
    })
    if (top > prev) out.push(en.id)
  })
  return out
}

// 提交：GET 整档 → 追加 → 带 baseRev PUT，409 冲突则带新文档重试（最多 3 轮）
export async function pushWorkout(w) {
  for (let i = 0; i < 3; i++) {
    const res = await getData()
    let state = res && res.state
    if (!state || typeof state !== 'object') {
      throw new Error('档案为空：请先在网页端登录 openGym 并让它完成一次同步')
    }
    if (!Array.isArray(state.workouts)) state.workouts = []
    if (state.workouts.some(x => x && x.id === w.id)) return true // 已同步过（待发队列重放时）
    try { w.prs = prsOf(w, state.workouts) } catch (e) { w.prs = [] }
    if (!w.bw && Array.isArray(state.bodyweight) && state.bodyweight.length) {
      const b = state.bodyweight[state.bodyweight.length - 1]
      if (b && b.w) w.bw = b.w
    }
    state.workouts.push(w)
    state._ts = Date.now()
    try {
      await putData({ state: state, baseRev: res.rev })
      return true
    } catch (e) {
      if (e.code === 409) continue
      throw e
    }
  }
  throw new Error('版本冲突，重试 3 次未成功')
}

// 推送成功后把该会话就地记入本地队列完成列表（离线补投同样适用）。网页端或其它端
// 记的训练不经过这里——由打开应用时的静默刷新拉全量重算兜底。
export async function markQueueDone(routineId) {
  if (!routineId) return
  const plan = await getJSON('plan', null)
  const ids = plan && plan.queue && plan.queue.ids
  if (!Array.isArray(ids) || !ids.includes(routineId)) return
  const done = Array.isArray(plan.queueDoneIds) ? plan.queueDoneIds : []
  if (!done.includes(routineId)) {
    plan.queueDoneIds = done.concat([routineId])
    await setJSON('plan', plan)
  }
}

// 优先即时同步；失败则进待发队列，下次打开应用或网络恢复时补投
export async function queueOrPush(w) {
  try {
    await pushWorkout(w)
    await markQueueDone(w.routineId)
    return { synced: true }
  } catch (e) {
    const q = await getJSON('pending', [])
    if (!q.some(x => x && x.id === w.id)) q.push(w)
    await setJSON('pending', q)
    return { synced: false, error: e.message }
  }
}

export async function flushPending() {
  const q = await getJSON('pending', [])
  while (q.length) {
    await pushWorkout(q[0])
    await markQueueDone(q[0].routineId)
    q.shift()
    await setJSON('pending', q)
  }
  return true
}

// 训练中实时心跳：电脑端 openGym 管理面板可看到"正在训练"（70 秒无心跳自动消失）。
// 返回 promise 供测试/调用方等待，页面侧照旧发射后不管。
export function heartbeat(s, done, total, exIdx) {
  if (!s) return Promise.resolve()
  return activity({
    active: true,
    name: s.name,
    exIdx: exIdx || 0,
    exTotal: s.entries.length,
    setsDone: done,
    setsTotal: total,
    startedAt: s.start
  }).catch(() => { })
}

export const heartbeatEnd = () => activity({ active: false, reason: 'closed' }).catch(() => { })
