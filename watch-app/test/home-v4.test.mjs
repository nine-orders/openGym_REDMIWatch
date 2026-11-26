import './register.mjs'
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
const { getJSON, sSet } = await import('../src/js/store.js')
const { flushPending, queueOrPush } = await import('../src/js/session.js')
const { enqueue, flush, forgetRev, loadState, syncSnapshot } = await import('../src/js/hub.js')
const { pendingText, readPending } = await import('../src/js/home-sync.js')

beforeEach(() => {
  globalThis.__velaStore = new Map()
  globalThis.__velaFetch = undefined
  forgetRev()
})

test('电脑训练先持久化，部分补传后只保留失败场次，其他档案不接收', async () => {
  const original = { host: '10.0.0.1:8080', token: 'original', owner: 'original' }
  const different = { ...original, token: 'other', owner: 'other' }
  for (const id of ['a', 'b']) await queueOrPush({ id, entries: [] }, original, false)
  let attempts = 0
  globalThis.__velaFetch = async r => {
    assert.equal(r.header.Authorization, 'Bearer original')
    if (r.method === 'GET') return { code: 200, data: { state: { workouts: [] }, rev: 8 } }
    assert.equal((await getJSON('pending', [])).length, 2 - attempts)
    attempts++
    return attempts === 1 ? { code: 200, data: { ok: true } } : { code: 503 }
  }
  await flushPending(different)
  assert.equal(attempts, 0)
  await assert.rejects(() => flushPending(original))
  assert.deepEqual((await getJSON('pending', [])).map(w => w.id), ['b'])
})

test('手机只移除本次批次明确确认的事件，保留部分成功的场次与收件提示', async () => {
  const connection = { host: '10.0.0.2', token: '12345678', owner: 'phone-a' }
  for (const [id, wid] of [['a1', 'a'], ['a2', 'a'], ['b1', 'b']]) {
    await enqueue({ id, type: 'setDone', wid }, connection, { name: wid, groups: 4 })
  }
  globalThis.__velaFetch = async r => {
    const { events } = JSON.parse(r.data)
    assert.equal(events[0].owner, undefined)
    assert.equal(events[0].training, undefined)
    return { code: 200, data: { ok: true, acked: ['a1', 'b1', 'not-sent'] } }
  }
  assert.equal(await flush({ ...connection, owner: 'phone-b' }), false)
  assert.equal((await getJSON('hubQueue', [])).length, 3)
  assert.equal(await flush(connection), false)
  assert.deepEqual((await getJSON('hubQueue', [])).map(e => e.id), ['a2'])
  assert.equal(await getJSON('hubReceived', false), true)
})

test('换手机后没有新快照时不沿用另一台手机的会话', async () => {
  await sSet('hubHost', '10.0.0.2')
  await sSet('hubToken', '12345678')
  const snap = { v: 1, active: { id: 'old', cur: 0, entries: [] } }
  globalThis.__velaFetch = async () => ({ code: 200, data: { ok: true, rev: 1, snapshot: snap } })
  await syncSnapshot()
  assert.equal((await loadState()).workout.id, 'old')
  globalThis.__velaFetch = async () => ({ code: 200, data: { ok: true, rev: 0, snapshot: null } })
  const switched = await syncSnapshot({ host: '10.0.0.3', token: '87654321', owner: 'phone-b' })
  assert.equal(switched.state, null)
})

test('15 场各 18 组离线落盘，进程重启后经 HTTP 补传，丢回执后按 ID 去重', async t => {
  const saved = []
  let dropReply = true
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer profile-test')
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET') return res.end(JSON.stringify({ state: { workouts: saved }, rev: saved.length }))
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const { state, baseRev } = JSON.parse(Buffer.concat(chunks))
    assert.equal(baseRev, saved.length)
    saved.push(state.workouts.at(-1))
    if (saved.length === 8 && dropReply) { dropReply = false; req.socket.destroy(); return }
    res.end(JSON.stringify({ ok: true, rev: saved.length }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const target = { host: '127.0.0.1:' + server.address().port, token: 'profile-test', owner: 'profile-test' }
  const here = new URL('.', import.meta.url)
  const memory = new URL('./.gen/home-v4-pending-fixture.json', here)
  await mkdir(new URL('./.gen', here), { recursive: true })
  const original = Array.from({ length: 15 }, (_, i) => ({
    id: 'w-' + i, start: 1732233600000 + i * 86400000, name: '离线训练 ' + i,
    entries: [{ id: '0001', sets: Array.from({ length: 18 }, (_, j) => ({ w: 20 + j, r: 10, done: true })) }]
  }))
  for (const w of original) await queueOrPush(w, target, false)
  assert.equal((await readPending()).count, 15)
  await writeFile(memory, JSON.stringify([...globalThis.__velaStore]))
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import './register.mjs'
    import { readFile, writeFile } from 'node:fs/promises'
    import assert from 'node:assert/strict'
    const { flushPending } = await import('../src/js/session.js')
    const { readPending } = await import('../src/js/home-sync.js')
    const fixture = new URL('./.gen/home-v4-pending-fixture.json', import.meta.url)
    globalThis.__velaStore = new Map(JSON.parse(await readFile(fixture, 'utf8')))
    globalThis.__velaFetch = async o => {
      const response = await fetch(o.url, { method: o.method, headers: o.header, body: o.data })
      return { code: response.status, data: await response.text() }
    }
    const target = ${JSON.stringify(target)}
    assert.equal((await readPending()).count, 15)
    await assert.rejects(() => flushPending(target))
    assert.equal((await readPending()).count, 8)
    assert.equal(await flushPending(target), true)
    await writeFile(fixture, JSON.stringify([...globalThis.__velaStore]))
  `], { cwd: here, stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  child.stderr.on('data', data => { errors += data })
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  assert.equal(exit, 0, errors)
  assert.deepEqual(saved.map(({ prs, ...w }) => w), original)
  const persisted = new Map(JSON.parse(await readFile(memory, 'utf8')))
  assert.deepEqual(JSON.parse(persisted.get('pending')), [])
})

test('待同步按训练 ID 合并，单侧只计一组，手机收件不显示已入历史', async () => {
  const connection = { host: '10.0.0.2', token: '12345678', owner: 'phone-a' }
  for (const [id, side] of [['l', 'L'], ['r', 'R']]) {
    await enqueue({ id, type: 'setDone', wid: 'a', exId: '0001', entryIdx: 0, setIdx: 0, side }, connection)
  }
  const info = await readPending()
  assert.equal(info.count, 1)
  assert.equal(info.rows[0].pendingGroups, 1)
  assert.equal(pendingText(info), '1 场训练待同步')
  globalThis.__velaFetch = async () => ({ code: 200, data: { ok: true, acked: ['l', 'r'] } })
  await flush(connection)
  assert.match(pendingText(await readPending()), /手机已接收.*历史/)
})
