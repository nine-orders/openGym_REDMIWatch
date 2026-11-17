// @system.fetch 桩：测试通过 globalThis.__velaFetch = async opts => ({ code, data })
// 注入行为；未注入时所有请求按"无网络"失败（与真机断网路径一致）。
export default {
  fetch(opts) {
    const impl = globalThis.__velaFetch
    if (!impl) {
      if (opts.fail) opts.fail('无网络', 0, 'connection')
      return
    }
    Promise.resolve()
      .then(() => impl(opts))
      .then(
        r => { if (opts.success) opts.success(r) },
        e => { if (opts.fail) opts.fail(String((e && e.message) || e), 0, 'connection') }
      )
  }
}
