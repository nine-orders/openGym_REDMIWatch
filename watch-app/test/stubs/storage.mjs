// @system.storage 桩：进程内 Map（globalThis.__velaStore），值一律按字符串存取（与真机一致）。
// 每次调用动态读全局，测试里重建 Map 即可整体重置。
const mem = () => (globalThis.__velaStore = globalThis.__velaStore || new Map())

export default {
  get(o) { try { const m = mem(); o.success && o.success(m.has(o.key) ? m.get(o.key) : o.default) } catch (e) { } },
  set(o) { try { mem().set(o.key, String(o.value)); o.success && o.success(true) } catch (e) { o.fail && o.fail(e) } },
  delete(o) { try { mem().delete(o.key); o.success && o.success(true) } catch (e) { o.fail && o.fail(e) } }
}
