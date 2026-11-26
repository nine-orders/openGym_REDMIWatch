// openGym HTTP 客户端（两条链路共用一套传输层）。
// v1 直连 PC：鉴权用网页端 Settings → 配对生成的 8 位码换来的 Bearer token（90 天有效），
//   走 /api/*，整档 GET/PUT。
// v2 手机 hub（docs/watch-v2/s3-android-hub.md 契约）：hubCall 走手机 IP:8765（配对页
//   复用，host 填手机 IP），token 是手机 hub 首启生成、通知栏展示的 8 位数字，走 /watch/*。
// Vela @system.fetch 的 data 传对象会被按表单编码，发 JSON 必须手动 stringify 并声明
// Content-Type（官方文档明确），响应统一按 text 取回自行解析。
import fetch from '@system.fetch'
import { sGet } from './store'
import { icCall, IC_HOST } from './ic'

async function request(base, method, path, body, token, timeout) {
  const header = { 'Content-Type': 'application/json' }
  if (token) header.Authorization = 'Bearer ' + token
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const done = (fn, value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      fn(value)
    }
    if (timeout) timer = setTimeout(() => {
      const error = new Error('HTTP 请求超时')
      error.code = 204
      done(reject, error)
    }, timeout)
    try { fetch.fetch({
      url: base + path,
      method: method,
      header: header,
      data: body == null ? undefined : JSON.stringify(body),
      responseType: 'text',
      success: r => {
        let d = null
        try {
          d = (r.data == null || r.data === '') ? null
            : (typeof r.data === 'string' ? JSON.parse(r.data) : r.data)
        } catch (e) { d = null }
        if (r.code >= 200 && r.code < 300) { done(resolve, d) }
        else {
          const err = new Error((d && d.error) ? d.error : ('HTTP ' + r.code))
          err.code = r.code
          done(reject, err)
        }
      },
      fail: (m, c) => done(reject, new Error('网络失败 ' + (m || c || '')))
    }) } catch (e) { done(reject, e) }
  })
}

export async function call(method, path, body, noAuth, connection) {
  const host = connection ? connection.host : await sGet('host', '')
  if (!host) throw new Error('未配置服务器地址')
  const token = noAuth ? '' : (connection ? connection.token : await sGet('token', ''))
  return request('http://' + host, method, path, body, token, 10000)
}

// v2 手机 hub 链路（契约错误码 401/400/404/405 由 request 统一透出）。
// S8 2A：hubHost === 'interconnect'（免输入系统配对标记）→ 走 @system.interconnect 通道，
// 同一契约同一批请求，只是换底层传输；其余（手动配对/回退/模拟器假 hub）照走 HTTP。
export async function hubCall(method, path, body, connection) {
  const host = connection ? connection.host : await sGet('hubHost', '')
  if (host === IC_HOST) return icCall(method, path, body)
  if (!host || host === ':8765') throw new Error('未配置手机地址')
  const address = host.replace(/^http:\/\//, '')
  const base = 'http://' + (address.indexOf(':') >= 0 ? address : address + ':8765')
  const token = connection ? connection.token : await sGet('hubToken', '')
  // Vela fetch is not guaranteed to return a callback on an unreachable endpoint.
  const timeout = (typeof globalThis !== 'undefined' && globalThis.__hubHttpTimeout) || 10000
  return request(base, method, path, body, token, timeout)
}

export const redeem = (code, connection) => call('POST', '/api/pair/redeem', { code: code }, true, connection)
export const getData = connection => call('GET', '/api/data', null, false, connection)
export const putData = (payload, connection) => call('PUT', '/api/data', payload, false, connection)
export const activity = (payload, connection) => call('POST', '/api/activity', payload, false, connection)
