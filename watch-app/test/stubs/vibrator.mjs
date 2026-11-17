// @system.vibrator 桩：记录震动模式供断言。
export default {
  vibrate(o) { (globalThis.__buzzes = globalThis.__buzzes || []).push((o && o.mode) || 'short') }
}
