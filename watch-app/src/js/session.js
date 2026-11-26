// 会话构建、进度计算与回写同步。手表端不复刻 openGym 前端的渐进加重引擎
// （lib/session-start.js 的处方逻辑），而是采用 openGym 自带的 startFrom:'last' 语义：
// 组数×次数按模板，重量/次数沿用该动作上一次训练的实际值，找不到再用模板值。
// 结束时组装标准 Workout 文档追加进 /api/data 整档状态——服务端对"不盖戳的写入者"
// 有字段级保护（只会追加、不会删掉它没见过的字段），所以这种只追加的提交是安全的。
import NAMES from './names.js'
import { getData, putData, activity } from './api'
import { getJSON, readQueue, setJSON } from './store'
import { connectionOwner, readConnection, readDevice } from './connections'
import { todayISO } from './plan-choices'

export { todayISO, todayRoutineId } from './plan-choices'

export const round2 = n => Math.round((Number(n) || 0) * 100) / 100
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

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

export function buildCachedPhoneSession(cache, ready) {
  return {
    id: uid(), name: ready.name || '手机动作单', unit: cache.unit || 'kg', start: Date.now(),
    restSec: cache.restSec == null ? 90 : cache.restSec, source: 'phone-plan', owner: null,
    entries: ready.entries.filter(e => Array.isArray(e.sets) && e.sets.length).map(e => ({
      id: e.id, name: e.name || nameOf(e.id), mode: e.mode === 'time' ? 'sec' : 'reps', rs: e.restSec,
      sets: e.sets.map(row => ({ w: row.w || 0, r: e.mode === 'time' ? (row.sec || 0) : (row.r || 0),
        done: false, ts: 0 }))
    }))
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
    d: todayISO(new Date(s.start)),
    start: s.start,
    end: Date.now(),
    routineId: s.routineId,
    name: s.name,
    ...(s.owner !== undefined ? { owner: s.owner } : {}),
    ...(s.source ? { source: s.source } : {}),
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
export async function pushWorkout(w, connection) {
  for (let i = 0; i < 3; i++) {
    const res = await getData(connection)
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
      const ack = await putData({ state: state, baseRev: res.rev }, connection)
      if (!ack || ack.ok !== true) throw new Error('电脑未确认保存')
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
export async function markQueueDone(routineId, connection) {
  if (!routineId) return
  const plan = await getJSON('plan', null)
  const ids = plan && plan.queue && plan.queue.ids
  if (!Array.isArray(ids) || !ids.includes(routineId) ||
      (connection && plan.owner !== undefined && plan.owner !== connectionOwner(connection))) return
  const done = Array.isArray(plan.queueDoneIds) ? plan.queueDoneIds : []
  if (!done.includes(routineId)) {
    plan.queueDoneIds = done.concat([routineId])
    await setJSON('plan', plan)
  }
}

let pendingWrites = Promise.resolve()
let pendingFlushes = Promise.resolve()

function withPending(fn) {
  const task = pendingWrites.then(async () => fn(await readQueue('pending')))
  pendingWrites = task.catch(() => {})
  return task
}

async function writePending(q) {
  if (!await setJSON('pending', q)) throw new Error('手表存储写入失败，请保留当前训练后重试')
}

export function bindPendingComputer(owner) {
  return withPending(async q => {
    if (q.some(w => w && w.owner === undefined)) {
      await writePending(q.map(w => w && w.owner === undefined ? { ...w, owner } : w))
    }
    const active = await getJSON('active', null)
    if (active && active.owner === undefined && !await setJSON('active', { ...active, owner })) {
      throw new Error('手表存储写入失败，请稍后重试')
    }
  })
}

export const computerCanSend = (w, connection) => !!connection &&
  (w.owner === undefined || (w.owner != null && w.owner === connectionOwner(connection)))

// The persisted entry is the source of truth, including after a lost reply or app exit.
export async function queueOrPush(w, connection, send = true, onSaved) {
  if (connection === undefined) connection = await readConnection('direct')
  const { owner = connectionOwner(connection), ...workout } = w
  await withPending(q => {
    if (!q.some(x => x && x.id === w.id)) return writePending(q.concat([{ ...workout, owner }]))
  })
  if (onSaved) await onSaved()
  if (!send || !computerCanSend({ owner }, connection)) {
    return { synced: false, error: !owner ? '已保存在手表' : '等待原电脑连接' }
  }
  try {
    await flushPending(connection)
    return { synced: !(await readQueue('pending')).some(x => x && x.id === w.id) }
  } catch (e) {
    const synced = !(await readQueue('pending')).some(x => x && x.id === w.id)
    return { synced, error: synced ? '' : e.message }
  }
}

export function flushPending(connection, onProgress, selectedOnly = false) {
  const task = pendingFlushes.then(async () => {
    const target = connection === undefined ? await readConnection('direct') : connection
    const q = await readQueue('pending')
    for (const w of q) {
      if (!w || !computerCanSend(w, target)) continue
      if (selectedOnly) {
        const device = await readDevice()
        if (device.mode !== 'direct' || connectionOwner(device.connection) !== connectionOwner(target)) break
      }
      const { owner, ...workout } = w
      await pushWorkout(workout, target)
      await withPending(current => writePending(current.filter(x => x && x.id !== w.id)))
      await markQueueDone(w.routineId, target)
      if (onProgress) await onProgress()
    }
    return !(await readQueue('pending')).length
  })
  pendingFlushes = task.catch(() => {})
  return task
}

async function activeComputer(s) {
  const device = await readDevice()
  if (device.mode === 'direct' && computerCanSend(s, device.connection)) return device.connection
  // Existing session callers without credentials can keep using the PC HTTP path.
  if (device.mode === 'direct' && !device.connection && s.owner === undefined) return readConnection('direct')
  return null
}

export async function heartbeat(s, done, total, exIdx) {
  if (!s) return
  const connection = await activeComputer(s)
  if (!connection) return
  return activity({
    active: true,
    name: s.name,
    exIdx: exIdx || 0,
    exTotal: s.entries.length,
    setsDone: done,
    setsTotal: total,
    startedAt: s.start
  }, connection).catch(() => { })
}

export async function heartbeatEnd(s) {
  const connection = s ? await activeComputer(s) : await readConnection('direct')
  if (connection) return activity({ active: false, reason: 'closed' }, connection).catch(() => { })
}
