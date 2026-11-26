// 本地键值存储与震动反馈的薄封装。
// Vela @system.storage 只有回调形式，这里统一包成 Promise；JSON 读写失败一律回退默认值，
// 手表端任何存储故障都不应打断训练。
import storage from '@system.storage'

let vibrator = null
try { vibrator = require('@system.vibrator') } catch (e) { /* 设备不支持时静默 */ }

export function buzz(mode) {
  try { vibrator && vibrator.vibrate({ mode: mode || 'short' }) } catch (e) { }
}

export function sGet(key, def) {
  return new Promise(res => {
    try {
      storage.get({
        key: key,
        default: def,
        success: v => res(v),
        fail: () => res(def)
      })
    } catch (e) { res(def) }
  })
}

export function sSet(key, val) {
  return new Promise(res => {
    try {
      storage.set({ key: key, value: val, success: () => res(true), fail: () => res(false) })
    } catch (e) { res(false) }
  })
}

export async function getJSON(key, def) {
  const s = await sGet(key, '')
  if (!s) return def
  try { return JSON.parse(s) } catch (e) { return def }
}

export function setJSON(key, val) {
  return sSet(key, JSON.stringify(val))
}

export async function readQueue(key) {
  const raw = await new Promise((resolve, reject) => {
    storage.get({ key, default: '[]', success: resolve, fail: reject })
  })
  const entries = raw === '' ? [] : JSON.parse(raw)
  if (!Array.isArray(entries)) throw new Error('无法读取本地同步记录')
  return entries
}
