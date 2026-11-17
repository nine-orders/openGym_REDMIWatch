// 假 hub：S3 契约（docs/watch-v2/s3-android-hub.md「契约 v1」）的 node 参照实现，
// 语义与 watch-app/hub/javatest/WatchHubTest.java 打过的契约全表一致：
//   - 一请求一连接，响应 Connection: close，Content-Type application/json; charset=utf-8
//   - 除 GET/POST /spike 外全部要求 Bearer token，不匹配 → 401 {"ok":false,"error":"unauthorized"}
//   - POST /watch/events 按 id 去重入队，acked = 无字符串 id 之外的收到的 id；坏 JSON 400
//     bad_json；形状错 400 bad_request；未知路径 404 not_found；已知路径错方法 405
//     method_not_allowed
// 供 hub.test.mjs（PC 集成测试）与模拟器实测（真 TCP）使用。
import http from 'node:http'

export function startFakeHub({ token = '12345678', port = 0, host = '127.0.0.1' } = {}) {
  const state = {
    snapshot: null,     // 手机页面最后一次 sendSnapshot 的快照（null = 进程刚重启没发过）
    rev: 0,             // 每次 setSnapshot +1
    queue: [],          // 手机侧事件队列：按 id 去重追加、无淘汰（真机 500 条上限）
    ackLog: [],         // 每次 POST acked 的 id（断言用）
    calls: []           // { method, path, auth, bodyLen } 请求流水
  }

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Connection': 'close',
      'Content-Length': Buffer.byteLength(body)
    })
    res.end(body)
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const auth = req.headers.authorization || ''
      state.calls.push({ method: req.method, path: req.url, auth, bodyLen: raw.length })
      const ok = auth === 'Bearer ' + token
      if (req.url === '/spike') {
        return send(res, 200, { ok: true, server: 'hub', method: req.method, path: req.url, bodyLen: raw.length, ua: req.headers['user-agent'] || '' })
      }
      if (!ok) return send(res, 401, { ok: false, error: 'unauthorized' })
      if (req.url === '/watch/ping') {
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method_not_allowed' })
        return send(res, 200, { ok: true, server: 'hub', rev: state.rev, time: Date.now(), proto: 2 })
      }
      if (req.url === '/watch/snapshot') {
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method_not_allowed' })
        return send(res, 200, { ok: true, rev: state.rev, snapshot: state.snapshot })
      }
      if (req.url === '/watch/events') {
        if (req.method === 'GET') return send(res, 200, { ok: true, queued: state.queue })
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' })
        let body = null
        try { body = JSON.parse(raw.toString('utf8') || 'null') } catch (e) { body = undefined }
        if (body === undefined) return send(res, 400, { ok: false, error: 'bad_json' })
        if (!body || typeof body !== 'object' || !Array.isArray(body.events)) {
          return send(res, 400, { ok: false, error: 'bad_request' })
        }
        const acked = []
        for (const ev of body.events) {
          if (!ev || typeof ev.id !== 'string' || !ev.id) continue   // 畸形事件跳过，永不 acked
          if (!state.queue.some(x => x && x.id === ev.id)) state.queue.push(ev)
          acked.push(ev.id)
        }
        state.ackLog.push(acked)
        return send(res, 200, { ok: true, acked: acked })
      }
      return send(res, 404, { ok: false, error: 'not_found' })
    })
  })

  const api = {
    port: 0,
    state: state,
    setSnapshot(snap) { state.snapshot = snap; state.rev++ },
    close() { return new Promise(res => server.close(() => res())) }
  }
  return new Promise(resolve => {
    server.listen(port, host, () => {
      api.port = server.address().port
      resolve(api)
    })
  })
}
