import { getData } from './api'
import { connectionOwner, readConnection } from './connections'
import { flush, loadCachedState, phoneBatchFilter, QUEUE_MAX, syncSnapshot } from './hub'
import { todayISO } from './plan-choices'
import { buildPlanCache, computerCanSend, flushPending } from './session'
import { getJSON, readQueue, setJSON } from './store'

function dateOf(time) {
  return Number.isFinite(time) && time > 0 ? todayISO(new Date(time)) : ''
}

export async function readPending() {
  const [computer, phone, state, received, phoneConnection] = await Promise.all([
    readQueue('pending'), readQueue('hubQueue'), loadCachedState(), getJSON('hubReceived', false), readConnection('hub')
  ])
  const rows = computer.filter(Boolean).map(w => ({
    key: 'pc-' + w.id,
    name: w.name || '独立训练',
    date: dateOf(w.start) || w.d || '日期未知',
    groups: (w.entries || []).reduce((sum, e) => sum + (e.sets || []).length, 0),
    status: w.source === 'phone-plan' ? '仅存手表 · 手机暂不支持导入' : w.owner === null ? '仅存手表 · 原电脑未能确认' : '待发送至原电脑'
  }))
  const sessions = new Map()
  let ungrouped = 0
  for (const event of phone.filter(Boolean)) {
    if (!event.wid) { ungrouped++; continue }
    const owner = event.owner === undefined ? connectionOwner(phoneConnection) : event.owner
    const key = JSON.stringify([owner, event.wid])
    let item = sessions.get(key)
    if (!item) {
      item = { key: 'phone-' + sessions.size, name: '手机训练', start: 0, firstEvent: 0, groups: null, sets: new Set(), legacyStart: false, owner }
      sessions.set(key, item)
    }
    const details = event.training || (state && state.workout && state.workout.id === event.wid ? state.workout : {})
    item.name = details.name || item.name
    item.start = details.start || (event.type === 'start' ? event.at : 0) || item.start
    if (event.at && (!item.firstEvent || event.at < item.firstEvent)) item.firstEvent = event.at
    if (typeof details.groups === 'number') item.groups = Math.max(item.groups || 0, details.groups)
    if (event.type === 'setDone') item.sets.add(JSON.stringify([event.exId, event.entryIdx, event.setIdx]))
    if (event.type === 'start') item.legacyStart = true
  }
  for (const item of sessions.values()) {
    rows.push({ key: item.key, name: item.name,
      date: dateOf(item.start) || (item.firstEvent ? dateOf(item.firstEvent) + ' 记录' : '日期未知'),
      groups: item.groups, pendingGroups: item.sets.size,
      status: item.owner === null ? '原手机未能确认' : item.legacyStart ? '旧训练 · 等待手机确认会话' : '待原手机接收' })
  }
  rows.sort((a, b) => b.date.localeCompare(a.date))
  return { rows, count: rows.length, phoneEvents: phone.length, ungrouped, received,
    nearLimit: phone.length >= Math.floor(QUEUE_MAX * 0.9), computer, phone }
}

export function pendingText(info, phase, total) {
  if (!info) return '暂无法读取同步记录'
  if (phase === 'sending') return '正在同步 ' + Math.max(0, total - info.count) + '/' + total + ' 场'
  if (info.nearLimit) return '本地存储即将满 · ' + info.count + ' 场待同步'
  if (phase === 'failed') return (info.count ? info.count + ' 场待同步 · ' : '') + '同步失败，点此重试'
  if (info.count) return info.count + ' 场训练待同步'
  if (info.ungrouped) return '有旧同步记录待处理'
  if (info.received) return '手机已接收 · 历史请在手机确认'
  return '已全部同步'
}

export async function refreshConnection(device) {
  const { mode, connection } = device
  if (mode === 'hub') {
    const result = await syncSnapshot(connection)
    return { live: result.snapshot, unknown: !result.snapshot }
  }
  const response = await getData(connection)
  const state = response && response.state
  if (!response || !Object.prototype.hasOwnProperty.call(response, 'state') ||
      (state === null ? typeof response.rev !== 'number' : !state || typeof state !== 'object' || Array.isArray(state))) {
    throw new Error('电脑回应异常')
  }
  const fresh = state ? buildPlanCache(state) : null
  if (fresh && fresh.routines.length && connectionOwner(await readConnection('direct')) === connectionOwner(connection)) {
    await setJSON('plan', { ...fresh, owner: connectionOwner(connection) })
  }
  return { live: null, unknown: false }
}

export function canSendPending(info, device, liveWid) {
  if (!device.connection) return false
  return device.mode === 'hub'
    ? phoneBatchFilter(info.phone, device.connection, true, liveWid).length > 0
    : info.computer.some(w => w && computerCanSend(w, device.connection))
}

export async function sendPending(device, onProgress, liveWid) {
  const { mode, connection } = device
  if (mode === 'hub') return flush(connection, onProgress, true, liveWid)
  return flushPending(connection, onProgress, true)
}

export function connectionFailure(error) {
  const code = error && error.code
  if (code === 1006 || /网络失败|系统通道不可用|系统通道发送失败/.test(String(error && error.message))) return 'offline'
  return 'error'
}
