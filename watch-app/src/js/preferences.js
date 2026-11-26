import { getJSON, setJSON } from './store'

export const REST_OPTIONS = [null, 0, 30, 45, 60, 90, 120, 180, 300]

export async function getPreferences() {
  const saved = await getJSON('trainingPreferences', {}) || {}
  return {
    restSec: REST_OPTIONS.includes(saved.restSec) ? saved.restSec : null,
    vibrate: saved.vibrate !== false
  }
}

export async function savePreferences(prefs) {
  if (!await setJSON('trainingPreferences', prefs)) throw new Error('设置未能保存，请重试')
}
