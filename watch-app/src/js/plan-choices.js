export const HUB_STATE_KEY = 'hubState'

export function todayISO(d = new Date()) {
  const p = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
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

// The phone can send a combined session for today alongside individual routines.
export function readyChoices(state) {
  const ready = state && state.ready
  if (!ready) return []
  const choices = []
  const ids = new Set()
  const add = (session, today) => {
    if (!session || !Array.isArray(session.routineIds) || !session.routineIds.length ||
        !Array.isArray(session.entries) || !session.entries.length) return
    const id = JSON.stringify(session.routineIds)
    if (ids.has(id)) return
    ids.add(id)
    choices.push({ id, session, today })
  }
  add(ready.today, true)
  for (const session of Array.isArray(ready.others) ? ready.others : []) add(session, false)
  return choices
}
