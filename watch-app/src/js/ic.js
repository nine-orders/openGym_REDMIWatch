// S8 2A：手表↔手机系统通道（@system.interconnect）传输层。
// 本模块只做「发请求/收应答」，hub 协议语义（rev 严格单调、事件队列串行化、按 id 去重、
// ack）一行不动、全部保留在 hub.js——这里只是把同一批请求从 HTTP 换到系统通道。
// 通道由系统按「rpk 包名 + 签名 == 手机 App」自动建立（官方开发注意事项）；不用关心
// 建立/销毁，注册回调收状态变化。错误码（官方文档）：1001=手机 App 未安装。
// 手机对端应答形状与 HTTP 响应一一对应：{ id, status, body }（body 为对象或 JSON 串）。
import IC from '@system.interconnect'

// hubHost 的标记值：免输入系统配对（不是真实地址，HTTP 链路永远不解析它）
export const IC_HOST = 'interconnect'
export const IC_UNAVAILABLE = -1

const TIMEOUT = (typeof globalThis !== 'undefined' && globalThis.__icTimeout !== undefined)
  ? globalThis.__icTimeout   // 测试口：加快无应答用例（真机恒为 10000）
  : 10000

let conn = null
let reqSeq = 0
const pending = new Map()   // id -> { resolve, reject, timer }
let lastStatus = null       // diagnosis 结果缓存 { status, at }（0=OK）

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function ensure() {
  if (conn) return conn
  let channel
  // The older working build handled Vela's default-export wrapper on device.
  const candidates = IC && IC.default && IC.default !== IC ? [IC, IC.default] : [IC]
  for (const mod of candidates) {
    if (!mod || typeof mod.instance !== 'function') continue
    try { channel = mod.instance() } catch (e) {
      if (isUnavailableMethod(e)) continue
      throw e
    }
    if (channel && typeof channel.send === 'function') break
    channel = null
  }
  if (!channel) return null
  channel.onmessage = res => deliver(res)
  channel.onopen = () => { /* 状态由 diagnosis/getReadyState 读，这里无需动作 */ }
  channel.onclose = () => { lastStatus = null; failAll('系统通道已断开', 1006) }
  channel.onerror = res => { lastStatus = null; failAll('系统通道错误', res && res.code) }
  conn = channel
  return conn
}

function isUnavailableMethod(e) {
  return !!(e && /not a function/i.test(String(e.message || '')))
}

// 对端应答：{ id, status, body }。id 对不上就丢（不相干消息）。
function deliver(res) {
  let msg = null
  try {
    const s = res && typeof res.data === 'string' ? res.data : (typeof res === 'string' ? res : '')
    if (!s) return
    msg = JSON.parse(s)
  } catch (e) { return }
  if (!msg || typeof msg.id !== 'string') return
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  clearTimeout(p.timer)
  const code = typeof msg.status === 'number' ? msg.status : 200
  let body = msg.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch (e) { body = null }
  }
  if (code >= 200 && code < 300) {
    if (!body || typeof body !== 'object') {
      p.reject(icError('系统通道响应不是有效 JSON', 502))
    } else p.resolve(body)
  } else {
    const err = new Error((body && body.error) ? body.error : ('HTTP ' + code))
    err.code = code
    p.reject(err)
  }
}

function icError(reason, code) {
  const err = new Error(reason)
  if (typeof code === 'number') err.code = code
  return err
}

function failAll(reason, code) {
  const err = icError(reason, code)
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err) }
  pending.clear()
}

// 诊断通道并把结果带时间戳缓存。成功回调里给 status：
//   0=OK 链接成功 / 204=CONNECT_TIMEOUT / 1001=APP_UNINSTALLED 对端未安装 / 1000=OTHERS
export function probeIc() {
  return new Promise((resolve, reject) => {
    let finished = false
    const timer = setTimeout(() => done(204), TIMEOUT)
    function done(status) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      lastStatus = { status, at: Date.now() }
      resolve(lastStatus)
    }
    function fail(error) {
      if (finished) return
      finished = true
      lastStatus = null
      clearTimeout(timer)
      reject(error)
    }
    try {
      const c = ensure()
      if (!c) { done(IC_UNAVAILABLE); return }
      if (typeof c.diagnosis === 'function') {
        try {
          c.diagnosis({
            timeout: TIMEOUT,
            success: data => done(data && typeof data.status === 'number' ? data.status : 1000),
            fail: (data, code) => fail(icError('系统通道诊断失败', code))
          })
          return
        } catch (e) {
          if (finished || !isUnavailableMethod(e)) throw e
        }
      }
      // Restore the older firmware fallback chain. A ready status only
      // indicates a candidate link; the page still requires the hub ping.
      function readApkState(fallback) {
        if (finished) return
        if (typeof c.getApkStatus !== 'function') { done(fallback); return }
        try { done(c.getApkStatus() === 1 ? 0 : 1006) } catch (e) {
          if (isUnavailableMethod(e)) done(fallback)
          else fail(e)
        }
      }
      if (typeof c.getReadyState === 'function') {
        try {
          c.getReadyState({
            success: data => done(data && data.status === 1 ? 0 : 1006),
            fail: (data, code) => {
              if (code === 1001 || code === 1006) done(code)
              else readApkState(typeof code === 'number' && code !== 0 ? code : 1000)
            }
          })
          return
        } catch (e) {
          if (!isUnavailableMethod(e)) throw e
        }
      }
      readApkState(IC_UNAVAILABLE)
    } catch (e) { fail(e) }
  })
}

// 通道是否已知可用：诊断过 OK 且未过期（2 分钟）；供状态展示用，不做硬门禁。
export function icUp() {
  return !!(lastStatus && lastStatus.status === 0 && Date.now() - lastStatus.at < 120000)
}

// 通道上发一个 hub 请求：2xx 解析 body（兼容对端回对象或 JSON 串），非 2xx 抛 err.code
// ——与 api.js request() 的解析/错误语义一致，调用方（hub.js）感受不到差别。
// 任何失败都 throw，由 hubCall 决定回退；超时按 TIMEOUT。
export function icCall(method, path, body) {
  const c = ensure()
  if (!c) throw new Error('系统通道不可用')
  const id = makeId()
  reqSeq += 1
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(icError('系统通道应答超时', 204))
    }, TIMEOUT)
    pending.set(id, { resolve, reject, timer })
    try {
      c.send({
        data: { id: id, method: method, path: path, body: body == null ? null : body },
        success: () => { /* 送达即等应答（onmessage） */ },
        fail: (data, code) => {
          clearTimeout(timer)
          pending.delete(id)
          reject(icError('系统通道发送失败 ' + code, code))
        }
      })
    } catch (e) {
      clearTimeout(timer)
      pending.delete(id)
      reject(e)
    }
  })
}
