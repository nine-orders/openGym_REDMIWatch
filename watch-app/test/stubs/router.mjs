// @system.router 桩：记录跳转目标与参数供断言；params 只在真传了才记录。
export default {
  push(o) {
    const rec = { way: 'push', uri: o && o.uri }
    if (o && o.params) rec.params = o.params
    ;(globalThis.__routes = globalThis.__routes || []).push(rec)
  },
  replace(o) {
    const rec = { way: 'replace', uri: o && o.uri }
    if (o && o.params) rec.params = o.params
    ;(globalThis.__routes = globalThis.__routes || []).push(rec)
  },
  back() { (globalThis.__routes = globalThis.__routes || []).push({ way: 'back' }) }
}
