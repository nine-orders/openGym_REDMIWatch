// @system.interconnect 桩（S8 2A）。行为与真机通道同构：
//   - diagnosis({success,fail})：success 返回 { status }——测试经 globalThis.__icDiag 控制，
//     默认 1001（手机 App 未安装，与无手机的模拟器/单元环境一致）。
//   - send({data,success,fail})：data 为对象（ic.js 发的 {id,method,path,body}）；把解析后的
//     请求压进 globalThis.__icSent 供用例核对；success 仅表示送达。应答由用例经
//     globalThis.__icReply = async msg => ({id,status,body}) 提供，桩以 onmessage 交回——
//     与真实链路（手机 App 收请求、经 MessageApi 回包）同构。未设 __icReply = 不应答 →
//     ic.js 按超时拒绝（用 globalThis.__icTimeout 缩短）。
const conn = {
  onmessage: null,
  onopen: null,
  onclose: null,
  onerror: null,
  diagnosis(opts) {
    Promise.resolve().then(() => {
      if (opts.success) opts.success({ status: globalThis.__icDiag === undefined ? 1001 : globalThis.__icDiag })
      else if (opts.fail) opts.fail('bad args', 200)
    })
  },
  getReadyState(opts) {
    Promise.resolve().then(() => {
      const up = globalThis.__icDiag === 0
      if (opts.success) opts.success({ status: up ? 1 : 2 })
    })
  },
  getApkStatus() {
    return globalThis.__icDiag === 0 ? 1 : 2
  },
  send(opts) {
    try {
      const parsed = typeof opts.data === 'string' ? JSON.parse(opts.data) : opts.data
      ;(globalThis.__icSent = globalThis.__icSent || []).push(parsed)
      if (opts.success) opts.success({})
      const reply = globalThis.__icReply
      if (reply) {
        Promise.resolve().then(() => reply(parsed)).then(
          r => { if (conn.onmessage) conn.onmessage({ data: JSON.stringify(r) }) },
          e => { if (opts.fail) opts.fail(String((e && e.message) || e), 1000) }
        )
      }
    } catch (e) {
      if (opts.fail) opts.fail('bad send', 1000)
    }
  }
}

export default {
  instance() {
    return conn
  }
}