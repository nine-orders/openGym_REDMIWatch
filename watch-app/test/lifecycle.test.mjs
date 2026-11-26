// 页面生命周期回归测试：pages.test.mjs 只做静态检查、从不执行 onInit——这里用
// test/stubs/ 实例化组件，真实调用 onInit/onShow/事件处理并断言状态。覆盖 v1 审查的
// Bug 1（onInit 调 firstUndoneAfter(-1,-1) 抛 TypeError，页面永远停在"载入中"）与
// Bug 3（index 的粘性 startRid 覆盖"今天该练的"），以及训练主流程的页面级行为。
import './register.mjs'
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', 'src')

// 与 pages.test.mjs 相同的方式把 .ux 的 script 生成到 .gen/ 下再导入
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'))
const PAGES = Object.entries(manifest.router.pages).map(([key, page]) => [key, page.component])
const comps = {}
for (const [key, file] of PAGES) {
  const raw = fs.readFileSync(path.join(SRC, key, file + '.ux'), 'utf8')
  const sm = /<script>([\s\S]*?)<\/script>/.exec(raw)
  const genDir = path.join(HERE, '.gen', key)
  fs.mkdirSync(genDir, { recursive: true })
  fs.writeFileSync(path.join(genDir, file + '.mjs'), sm[1].replace(/\.\.\/\.\.\/js\//g, '../../../../src/js/'))
  comps[file] = (await import('./.gen/' + key + '/' + file + '.mjs')).default
}

const { sGet, sSet, getJSON, setJSON } = await import('../src/js/store')
const { buildPlanCache, todayISO } = await import('../src/js/session')
const { forgetRev, loadState } = await import('../src/js/hub')
const homePages = []
afterEach(() => {
  for (const p of homePages.splice(0)) if (p.onHide) p.onHide()
})

beforeEach(() => {
  globalThis.__velaStore = new Map()
  globalThis.__velaFetch = undefined
  globalThis.__routes = []
  globalThis.__buzzes = []
  forgetRev()   // hub.js 的 rev 去重记忆跨用例清零（存储已被重置，快照须重新解析）
})

// 快应用页面实例：方法留在原型上，data 深拷贝到实例，路由参数注入为实例属性
function mount(comp, params = {}) {
  const inst = Object.create(comp)
  Object.assign(inst, JSON.parse(JSON.stringify(comp.data || {})), params)
  if (comp === comps.index) homePages.push(inst)
  return inst
}

function planState(over = {}) {
  return {
    unit: 'kg', restSec: 90,
    routines: [
      { id: 'r1', name: '推日', ex: [{ id: '0001', sets: 3, reps: 10, weight: 20, restSec: 60 }] },
      { id: 'r2', name: '腿日', ex: [{ id: '0003', sets: 4, reps: 8, weight: 60 }] }
    ],
    week: {}, dayPlan: {}, queue: { ids: ['r1'] }, customEx: [], exWeights: {}, workouts: [],
    ...over
  }
}

async function seedPlan(over = {}) {
  const plan = buildPlanCache(planState(over))
  await setJSON('plan', plan)
  return plan
}

// ---------- session 页 ----------

test('session onInit：无 active 时从 (-1,-1) 找首个未完成组——不再 TypeError 卡"载入中"（Bug 1）', async () => {
  await seedPlan()
  const p = mount(comps.session)
  await p.onInit()
  assert.equal(p.ready, true)
  assert.equal(p.err, '')
  assert.equal(p.phase, 'train')
  assert.equal(p.exI, 0)
  assert.equal(p.setI, 0)
  assert.equal(p.curName, '0001')
  const stored = await getJSON('active', null)
  assert.equal(stored.routineId, 'r1') // 队列第一项 = 今天该练的
})

test('session onInit：路由参数 rid 优先于粘性 startRid（Bug 3 手表侧）', async () => {
  await seedPlan()
  await setJSON('startRid', 'r1') // 之前手动挑选留下的粘性值
  const p = mount(comps.session, { rid: 'r2' })
  await p.onInit()
  assert.equal(p.s.routineId, 'r2')
  assert.equal(p.s.name, '腿日')
})

test('session onInit：无路由参数时回落到粘性 startRid（选动作单页的路径）', async () => {
  await seedPlan()
  await setJSON('startRid', 'r2')
  const p = mount(comps.session)
  await p.onInit()
  assert.equal(p.s.routineId, 'r2')
})

test('session onInit：续训恢复到首个未完成组（先扫本动作剩余组，再往后找）', async () => {
  await seedPlan()
  const active = {
    id: 's1', routineId: 'r1', name: '推日', unit: 'kg', start: Date.now() - 600000, restSec: 90,
    entries: [{
      id: '0001', name: '0001', mode: 'reps', rs: 60,
      sets: [{ w: 20, r: 10, done: true, ts: 1 }, { w: 20, r: 10, done: true, ts: 2 }, { w: 20, r: 10, done: false, ts: 0 }]
    }]
  }
  await setJSON('active', active)
  const p = mount(comps.session)
  await p.onInit()
  assert.equal(p.exI, 0)
  assert.equal(p.setI, 2) // 前两组已完成，恢复到第三组
  assert.equal(p.dots, '● ● ◐')
})

test('session onInit：无计划给出可读错误而不是白屏', async () => {
  const p = mount(comps.session)
  await p.onInit()
  assert.equal(p.ready, true)
  assert.match(p.err, /无可用计划/)
})

test('session 主流程：完成一组 → 休息倒计时用动作专属 rs（Bug 4）→ 跳过休息 → 翻页不越界', async () => {
  await seedPlan()
  const p = mount(comps.session)
  await p.onInit()
  p.onShow()
  assert.ok(p.timer, 'onShow 应启动计时器')
  p.onHide()
  assert.equal(p.timer, null, 'onHide 应停止计时器')

  p.dispW = 22.5
  p.dispR = 8
  await p.doneTap()
  assert.equal(p.s.entries[0].sets[0].done, true)
  assert.deepEqual(p.s.entries[0].sets[0], { w: 22.5, r: 8, done: true, ts: p.s.entries[0].sets[0].ts })
  assert.equal(p.phase, 'rest')
  assert.equal(p.restTotal, 60) // 动作单配的 restSec=60，不是全局 90（Bug 4 回归）
  assert.equal(p.nextName, '0001')
  assert.equal(p.nextSetTxt, '20 kg × 10') // 下一组回到计划值

  p.restSkip()
  assert.equal(p.phase, 'train')
  assert.deepEqual([p.exI, p.setI], [0, 1])

  p.prevEx(); assert.equal(p.exI, 0) // 已在第一个动作，不越界
  p.nextEx(); assert.deepEqual([p.exI, p.setI], [0, 1]) // 只有一个动作，不越界
  const stored = await getJSON('active', null)
  assert.equal(stored.entries[0].sets[0].done, true) // 完成组实时落盘
})

test('session 结束与保存：总结页数据正确，断网保存进待发队列（saveState=2），恢复后重试成功', async () => {
  await sSet('host', '127.0.0.1:8080')
  await seedPlan()
  const p = mount(comps.session)
  await p.onInit()
  await p.doneTap()
  p.endTap()
  assert.equal(p.phase, 'summary')
  assert.equal(p.sumSets, 1)
  assert.equal(p.sumVol, 20 * 10)
  assert.deepEqual(p.sumList, ['0001  20×10次 ×1组'])

  await p.saveTap()
  assert.equal(p.saveState, 2)
  assert.match(p.syncMsg, /网络失败/)
  assert.equal((await getJSON('pending', [])).length, 1)
  assert.equal(await getJSON('active', null), null) // 已出总结，本地会话清掉

  // 重试路径：恢复网络后保存成功
  await seedPlan()
  const p2 = mount(comps.session)
  await p2.onInit()
  await p2.doneTap(); p2.endTap()
  globalThis.__velaFetch = async opts => (
    opts.method === 'PUT' ? { code: 200, data: { ok: true } } : { code: 200, data: { state: { workouts: [] }, rev: 1 } }
  )
  await p2.saveTap()
  assert.equal(p2.saveState, 1)
  assert.ok(globalThis.__buzzes.includes('long'))
})

test('session 丢弃：quitTap 两次确认，清 active 回主页', async () => {
  await seedPlan()
  const p = mount(comps.session)
  await p.onInit()
  p.quitTap()
  assert.equal(p.confirmQuit, true)
  assert.notEqual(await getJSON('active', null), null)
  p.quitTap()
  assert.equal(await getJSON('active', null), null)
  assert.deepEqual(globalThis.__routes, [{ way: 'replace', uri: '/pages/index' }])
})

test('手表存储写满时拒绝确认保存，进行中的记录仍可重试', async () => {
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'original')
  await seedPlan()
  const p = mount(comps.session, { rid: 'r1' })
  await p.onInit()
  await p.doneTap()
  p.endTap()
  const storage = globalThis.__velaStore
  const write = storage.set.bind(storage)
  storage.set = (key, val) => {
    if (key === 'pending') throw new Error('full')
    return write(key, val)
  }
  await p.saveTap()
  assert.match(p.syncMsg, /存储写入失败/)
  assert.equal((await getJSON('active', null)).entries[0].sets[0].done, true)
  assert.deepEqual(await getJSON('pending', []), [])
})

// ---------- index 页 ----------

test('首页区分电脑离线和未配对，保留真实待同步场数', async () => {
  const p = mount(comps.index)
  await p.onShow()
  assert.equal(p.deviceLabel, '未配对')
  await sSet('host', '192.168.1.10:8080')
  await sSet('token', 'tok')
  await p.onShow()
  assert.equal(p.deviceLabel, '电脑离线 · 已保存连接')
  assert.equal(p.pendingLabel, '已全部同步')
  await setJSON('pending', [{ id: 'p1', entries: [] }])
  await p.onShow()
  assert.match(p.pendingLabel, /1 场待同步/)
})

test('index startTap：电脑有今日安排也先打开选单，不自动开练', async () => {
  await seedPlan()
  await setJSON('startRid', 'r2') // 两天前手动挑过腿日，粘着
  const p = mount(comps.index)
  await p.startTap()
  assert.deepEqual(globalThis.__routes, [{ way: 'push', uri: '/pages/pick', params: { mode: 'independent' } }])
  assert.equal(await getJSON('active', null), null)
  assert.equal(await getJSON('startRid', ''), 'r2')
})

test('index startTap：rest 日落到选动作单页；有未结束会话时直接续训', async () => {
  const today = todayISO()
  await seedPlan({ dayPlan: { [today]: 'rest' }, queue: null })
  const p = mount(comps.index)
  await p.startTap()
  assert.deepEqual(globalThis.__routes, [{ way: 'push', uri: '/pages/pick', params: { mode: 'independent' } }])

  await seedPlan()
  const active = {
    id: 's1', routineId: 'r1', name: '推日', unit: 'kg', start: Date.now(), restSec: 90,
    entries: [{ id: '0001', name: '0001', mode: 'reps', rs: 60, sets: [{ w: 20, r: 10, done: false, ts: 0 }] }]
  }
  await setJSON('active', active)
  const p2 = mount(comps.index)
  await p2.onShow() // 真实页面里 active 由 onShow 填充
  assert.equal(p2.independentActive, true)
  await p2.startTap()
  assert.deepEqual(globalThis.__routes.slice(1), [{ way: 'push', uri: '/pages/session' }]) // 续训不传 rid
})

test('index startTap：本地无计划仍打开选单，显示空态', async () => {
  const p = mount(comps.index)
  await p.startTap()
  assert.deepEqual(globalThis.__routes, [{ way: 'push', uri: '/pages/pick', params: { mode: 'independent' } }])
})

test('index onShow：已配对时后台静默刷新计划缓存——网页端练完胸，手表指向肩', async () => {
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'tok')
  await seedPlan() // 本地旧缓存：队列两项都未完成
  const since = Date.now() - 86400000
  const state = planState()
  state.queue = { ids: ['r1', 'r2'], since, startsOn: '2026-10-01' }
  state.workouts = [{ id: 'w1', d: todayISO(), start: since + 1000, routineId: 'r1', name: '推日', entries: [] }]
  globalThis.__velaFetch = async () => ({ code: 200, data: { state, rev: 9 } })

  const p = mount(comps.index)
  await p.onShow()
  assert.ok(p._refresh, 'onShow 应发起静默刷新')
  await p._refresh
  const fresh = await getJSON('plan', null)
  assert.deepEqual(fresh.queueDoneIds, ['r1'])   // 网页端练完的胸日已按 DONE RULE 计入
  const pick = mount(comps.pick, { mode: 'independent' })
  await pick.onShow()
  assert.equal(pick.todayRid, 'r2')
})

test('index onShow：断网时刷新失败静默，沿用本地缓存', async () => {
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'tok')
  await seedPlan()
  const before = await getJSON('plan', null)
  const p = mount(comps.index)
  await p.onShow()
  await p._refresh                                // __velaFetch 未注入 = 断网
  assert.deepEqual(await getJSON('plan', null), before)
  assert.match(p.deviceLabel, /电脑离线/)
})

// ---------- pick 页 ----------

test('pick：onShow 列出动作单并标今日；pick 持久化 startRid 并进 session（手动挑选才持久化）', async () => {
  await seedPlan()
  const p = mount(comps.pick)
  await p.onShow()
  assert.deepEqual(p.routines, [
    { id: 'r1', name: '推日', exN: 1, origin: '' },
    { id: 'r2', name: '腿日', exN: 1, origin: '' }
  ])
  assert.equal(p.todayRid, 'r1') // 队列第一项标「今日」

  await p.pick(1)
  assert.equal(await getJSON('startRid', ''), 'r2') // 持久化的是手动挑的腿日
  assert.deepEqual(globalThis.__routes, [{ way: 'replace', uri: '/pages/session', params: { rid: 'r2' } }])
  const s = mount(comps.session, globalThis.__routes[0].params)
  await s.onInit()
  assert.equal(s.s.routineId, 'r2')
})

test('pick：空计划显示空态提示', async () => {
  await setJSON('plan', buildPlanCache({}))
  const p = mount(comps.pick)
  await p.onShow()
  assert.deepEqual(p.routines, [])
  assert.equal(p.todayRid, '')
})

// ---------- 手表配对 ----------

test('pair 电脑配对：先检查 IP，再进入配对码步骤，返回修改 IP 时保留配对码', async () => {
  const p = mount(comps.pair)
  await p.onShow()
  await p.selectDevice('direct')
  p.host = '192.168.1.300'
  p.nextTap()
  assert.equal(p.stage, 'host')
  assert.match(p.msg, /IP/)
  p.host = '192.168.1.10'
  p.nextTap()
  assert.equal(p.stage, 'code')
  p.code = 'ABCD2345'
  p.backTap()
  assert.equal(p.stage, 'host')
  assert.equal(p.host, '192.168.1.10')
  p.nextTap()
  assert.equal(p.code, 'ABCD2345')
})

test('pair 手机自动连接不可用：保留原电脑模式并提供可编辑的手动入口', async () => {
  await sSet('pairMode', 'direct')
  globalThis.__icDiag = 1001
  try {
    const p = mount(comps.pair)
    await p.onShow()
    await p.selectDevice('hub')
    assert.equal(p.stage, 'phone')
    assert.equal(p.autoTitle, '没找到手机 openGym')
    assert.match(p.autoHelp, /配套安卓版/)
    p.manualTap()
    assert.equal(p.stage, 'host')
    assert.equal(p.host, '')
    assert.equal(await sGet('pairMode', ''), 'direct')
  } finally {
    globalThis.__icDiag = undefined
  }
})

test('pair 手动配对失败：已有连接和离线动作单可继续使用', async () => {
  await sSet('pairMode', 'direct')
  await sSet('host', '192.168.1.10:8080')
  await sSet('token', 'old-pc-token')
  await sSet('hubHost', '192.168.1.20')
  await sSet('hubToken', '12345678')
  await seedPlan()
  const plan = await sGet('plan', '')
  globalThis.__velaFetch = async opts => opts.url.endsWith('/api/pair/redeem')
    ? { code: 400, data: { error: 'code_expired' } }
    : { code: 401, data: { error: 'unauthorized' } }
  const p = mount(comps.pair)
  p.host = '192.168.1.30'
  p.code = 'ABCD2345'
  await p.pairTap()
  assert.equal(await sGet('host', ''), '192.168.1.10:8080')
  assert.equal(await sGet('token', ''), 'old-pc-token')
  assert.equal(await sGet('plan', ''), plan)
  p.pairMode = 'hub'
  p.code = '13572468'
  await p.pairTap()
  assert.equal(await sGet('hubHost', ''), '192.168.1.20')
  assert.equal(await sGet('hubToken', ''), '12345678')
  assert.equal(await sGet('pairMode', ''), 'direct')
})

test('pair 手动连接手机：沿用 IP，两个步骤各用对应的数字键盘', async () => {
  await sSet('hubHost', 'http://192.168.1.20')
  await sSet('hubToken', '12345678')
  const p = mount(comps.pair)
  await p.onShow()
  await p.selectDevice('hub')
  await p.startPairing()
  p.manualTap()
  assert.equal(p.host, '192.168.1.20')
  assert.deepEqual(p.rows.flat(), '123456789.0:'.split(''))
  p.nextTap()
  assert.equal(p.stage, 'code')
  assert.deepEqual(p.rows.flat(), '1234567890'.split(''))
  p.tapChar(0, 0)
  assert.equal(p.code, '1')
  p.tapBack()
  assert.equal(p.code, '')
})

test('pair pairTap：缺 host / 配对码不是 8 位数字先本地校验，不发请求', async () => {
  const p = mount(comps.pair)
  p.pairMode = 'hub'
  await p.pairTap()
  assert.match(p.msg, /IP/)
  p.host = '192.168.1.20'
  p.code = 'ABC'
  await p.pairTap()
  assert.match(p.msg, /8 位数字/)
  assert.equal(p.busy, false)
  assert.equal(globalThis.__velaFetch, undefined)
})

test('pair 手动连接手机：验证并下载计划后保存连接，点返回首页才离开', async () => {
  globalThis.__velaFetch = async opts => {
    if (opts.url.endsWith('/watch/ping')) return { code: 200, data: { ok: true, server: 'hub', rev: 1, time: 1 } }
    if (opts.url.endsWith('/watch/snapshot')) {
      return { code: 200, data: { ok: true, rev: 1, snapshot: { v: 1, unit: 'kg', restSec: 90, active: null, ready: { today: { name: '推日' }, others: [{ name: '腿日' }] } } } }
    }
    return { code: 404, data: { ok: false, error: 'not_found' } }
  }
  const p = mount(comps.pair)
  p.pairMode = 'hub'
  p.host = '192.168.1.20'
  p.code = '13572468'
  await p.pairTap()
  assert.equal(p.stage, 'success')
  assert.match(p.msg, /共 2 套/)
  const { sGet } = await import('../src/js/store')
  assert.equal(await sGet('hubToken', ''), '13572468')
  assert.equal(await sGet('hubHost', ''), '192.168.1.20')
  const st = await getJSON('hubState', null)
  assert.equal(st.ready.today.name, '推日')      // 快照已种子进本地状态
  assert.deepEqual(globalThis.__routes, [])
  p.backTap()
  assert.deepEqual(globalThis.__routes, [{ way: 'back' }])
})

test('pair pairTap：ping 失败（token 错）→ token 清掉不算配对', async () => {
  globalThis.__velaFetch = async () => ({ code: 401, data: { ok: false, error: 'unauthorized' } })
  const p = mount(comps.pair)
  p.pairMode = 'hub'
  p.host = '192.168.1.20'
  p.code = '13572468'
  await p.pairTap()
  assert.match(p.msg, /配对码无效/)
  const { sGet } = await import('../src/js/store')
  assert.equal(await sGet('hubToken', ''), '')
})

test('pair spikeTap：跳转传输诊断页', async () => {
  const p = mount(comps.pair)
  p.spikeTap()
  assert.deepEqual(globalThis.__routes, [{ way: 'push', uri: '/pages/spike' }])
})

test('pair 浏览设备选项时保持当前连接，确认才切换到另一台已配对设备', async () => {
  await sSet('pairMode', 'direct')
  await sSet('hubHost', '192.168.1.20')
  await sSet('hubToken', '12345678')
  const p = mount(comps.pair)
  await p.onShow()
  assert.equal(p.stage, 'device')
  await p.selectDevice('hub')
  assert.equal(p.stage, 'saved')
  p.backTap()
  assert.equal(p.stage, 'device')
  assert.equal(await sGet('pairMode', ''), 'direct')
  await p.selectDevice('hub')
  await p.useSavedTap()
  assert.equal(await sGet('pairMode', ''), 'hub')
  assert.deepEqual(globalThis.__routes, [{ way: 'back' }])
})

test('pair 电脑已配对：使用已保存 IP 和端口，可重新配对', async () => {
  await sSet('host', '192.168.1.10:8080')
  await sSet('token', 'tok')
  const p = mount(comps.pair)
  await p.onShow()
  await p.selectDevice('direct')
  assert.equal(p.stage, 'saved')
  assert.equal(p.host, '192.168.1.10:8080')
  p.startPairing()
  p.nextTap()
  assert.equal(p.stage, 'code')
  assert.deepEqual(p.rows.flat(), 'ABCDEFGHJKLM'.split(''))
  p.tapChar(0, 0)
  p.selectCodePage(1)
  assert.deepEqual(p.rows.flat(), 'NPQRSTUVWXYZ'.split(''))
  p.tapChar(0, 0)
  p.selectCodePage(2)
  assert.deepEqual(p.rows.flat(), '23456789'.split(''))
  p.tapChar(0, 0)
  assert.equal(p.code, 'AN2')
})

test('pair 输入 IP：常见网段一次填入，数字键继续补完整 IP', async () => {
  const p = mount(comps.pair)
  await p.selectDevice('direct')
  p.usePrefix('192.168.')
  p.tapChar(0, 0)
  p.tapChar(3, 0)
  p.tapChar(0, 1)
  assert.equal(p.host, '192.168.1.2')
  p.nextTap()
  assert.equal(p.stage, 'code')
})

test('pair 电脑配对成功：默认 :8080，缓存动作单并显示结果', async () => {
  const state = planState()
  globalThis.__velaFetch = async opts => {
    if (opts.url.endsWith('/api/pair/redeem')) {
      assert.equal(opts.method, 'POST')
      assert.equal(opts.data, '{"code":"ABCD2345"}')
      return { code: 200, data: { token: 'tok-90d' } }
    }
    if (opts.url.endsWith('/api/data')) {
      assert.equal(opts.header.Authorization, 'Bearer tok-90d')
      return { code: 200, data: { state, rev: 2 } }
    }
    return { code: 404, data: { ok: false } }
  }
  const p = mount(comps.pair)
  await p.onShow()
  p.pairMode = 'direct'
  p.host = '192.168.1.10'
  p.code = 'ABCD2345'
  await p.pairTap()
  assert.equal(p.stage, 'success')
  assert.match(p.msg, /共 2 套/)
  assert.equal(await sGet('host', ''), '192.168.1.10:8080')
  assert.equal(await sGet('token', ''), 'tok-90d')
  const plan = await getJSON('plan', null)
  assert.equal(plan.routines.length, 2)
  assert.equal(plan.queue.ids[0], 'r1')
  p.backTap()
  assert.deepEqual(globalThis.__routes, [{ way: 'back' }])
})

test('pair 电脑一次性码验证后断线：重试只下载动作单，不再次消费配对码', async () => {
  let exchanged = false
  let offline = true
  globalThis.__velaFetch = async opts => {
    if (opts.url.endsWith('/api/pair/redeem')) {
      if (exchanged) return { code: 400, data: { error: 'invalid or expired code' } }
      exchanged = true
      return { code: 200, data: { token: 'new-token' } }
    }
    if (offline) throw new Error('断线')
    assert.equal(opts.header.Authorization, 'Bearer new-token')
    return { code: 200, data: { state: planState(), rev: 2 } }
  }
  const p = mount(comps.pair)
  await p.onShow()
  await p.selectDevice('direct')
  p.host = '192.168.1.10'
  p.nextTap()
  p.code = 'ABCD2345'
  await p.pairTap()
  assert.equal(p.stage, 'code')
  assert.equal(await sGet('token', ''), '')
  offline = false
  await p.pairTap()
  assert.equal(p.stage, 'success')
  assert.equal(await sGet('token', ''), 'new-token')
})

test('pair 直连 pairTap：redeem 失败 → token 清掉不算配对', async () => {
  globalThis.__velaFetch = async () => ({ code: 400, data: { error: 'code_expired' } })
  const p = mount(comps.pair)
  await p.onShow()
  p.pairMode = 'direct'
  p.host = '192.168.1.10'
  p.code = 'ABCD2345'
  await p.pairTap()
  assert.match(p.msg, /配对码已过期/)
  assert.equal(await sGet('token', ''), '')
})

test('index onShow：pairMode 显式 direct 时忽略 hub 凭证，按直连显示', async () => {
  await sSet('hubHost', '192.168.1.20')   // hub 凭证在，但显式选了直连
  await sSet('hubToken', '13572468')
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'tok')
  await sSet('pairMode', 'direct')
  await seedPlan()
  const p = mount(comps.index)
  await p.onShow()
  assert.match(p.deviceLabel, /电脑离线/)
  assert.equal(p.phoneLabel, '切换至手机连接')
  await p.phoneTap()
  assert.deepEqual(globalThis.__routes, [{ way: 'push', uri: '/pages/pair', params: { focus: 'hub' } }])
})

test('解除电脑配对保留缓存和原档案待发记录，连接新档案后不会上传旧记录', async () => {
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'original')
  await sSet('pairMode', 'direct')
  await seedPlan()
  await setJSON('pending', [{ id: 'old', name: '旧记录', entries: [] }])
  const pair = mount(comps.pair)
  await pair.selectDevice('direct')
  await pair.unpairTap()
  await pair.unpairTap()
  assert.equal(await sGet('pairMode', ''), 'offline')
  assert.equal(await sGet('token', ''), '')
  assert.equal((await getJSON('plan', null)).routines.length, 2)
  const original = await getJSON('pending', [])
  assert.equal(original.length, 1)
  assert.ok(original[0].owner)
  await sSet('host', '127.0.0.1:8080')
  await sSet('token', 'other')
  await sSet('pairMode', 'direct')
  globalThis.__velaFetch = async opts => {
    assert.equal(opts.method, 'GET')
    return { code: 200, data: { state: planState(), rev: 1 } }
  }
  await mount(comps.index).onShow()
  assert.deepEqual(await getJSON('pending', []), original)
})

// ---------- pair/index（S8 2A：免输入系统配对 interconnect） ----------

test('pair 手机入口直接开始自动连接，等手机回应和读取动作单时显示不同进度', async () => {
  globalThis.__icDiag = 0
  globalThis.__icSent = []
  const waits = {}
  globalThis.__icReply = m => new Promise(resolve => {
    waits[m.path] = body => resolve({ id: m.id, status: 200, body })
  })
  try {
    const p = mount(comps.pair)
    await p.onShow()
    const pending = p.selectDevice('hub')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(p.stage, 'phone')
    assert.equal(p.busy, true)
    assert.equal(p.autoStep, 2)
    assert.match(p.autoTitle, /手机 openGym 回应/)
    waits['/watch/ping']({ ok: true, rev: 1, time: 1 })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(p.autoStep, 3)
    assert.match(p.autoTitle, /读取动作单/)
    waits['/watch/snapshot']({ ok: true, rev: 1, snapshot: { v: 1, unit: 'kg', restSec: 90, active: null, ready: { today: { name: '推日训练' }, others: [{ name: '腿日' }] } } })
    await pending
    assert.equal(p.stage, 'success')
    assert.equal(p.successMethod, '通过小米系统通道连接手机')
    assert.equal(await sGet('hubHost', ''), 'interconnect')
    assert.equal(await sGet('hubToken', ''), 'interconnect')
    assert.equal((await getJSON('hubState', null)).ready.today.name, '推日训练')
  } finally {
    globalThis.__icDiag = undefined
    globalThis.__icReply = undefined
    globalThis.__icSent = undefined
  }
})

test('pair autoTap：旧手动配对仍可重试自动，探测成功但手机未回应时保留原配置', async () => {
  await sSet('pairMode', 'hub')
  await sSet('hubHost', '192.168.1.22')
  await sSet('hubToken', '12345678')
  globalThis.__icDiag = 0
  globalThis.__icReply = async m => ({ id: m.id, status: 200, body: { ok: false } })
  try {
    const p = mount(comps.pair)
    p.pairMode = 'hub'
    await p.autoTap()
    assert.equal(p.autoStep, 2)
    assert.equal(p.autoTitle, '手机 App 回应异常')
    assert.equal(await sGet('hubHost', ''), '192.168.1.22')
    assert.equal(await sGet('hubToken', ''), '12345678')
  } finally {
    globalThis.__icDiag = undefined
    globalThis.__icReply = undefined
  }
})

test('pair 手机动作单响应错误：报告已连通的手机与失败步骤', async () => {
  globalThis.__icDiag = 0
  globalThis.__icReply = async m => ({
    id: m.id, status: m.path === '/watch/snapshot' ? 503 : 200, body: { ok: true }
  })
  try {
    const p = mount(comps.pair)
    await p.selectDevice('hub')
    assert.equal(p.autoStep, 3)
    assert.equal(p.autoTitle, '读取动作单失败')
    assert.match(p.autoHelp, /手机已回应/)
    assert.equal(await sGet('hubHost', ''), '')
  } finally {
    globalThis.__icDiag = undefined
    globalThis.__icReply = undefined
  }
})

test('pair autoTap：旧手动配对切换自动，拿到手机计划才保留系统通道', async () => {
  await sSet('pairMode', 'hub')
  await sSet('hubHost', '192.168.1.22')
  await sSet('hubToken', '12345678')
  globalThis.__icDiag = 0
  globalThis.__icReply = async m => m.path === '/watch/snapshot'
    ? { id: m.id, status: 200, body: { ok: true, rev: 11, snapshot: { v: 1, unit: 'kg', restSec: 90, active: null, ready: { today: { name: '测试计划' }, others: [] } } } }
    : { id: m.id, status: 200, body: { ok: true, proto: 3 } }
  try {
    const p = mount(comps.pair)
    p.pairMode = 'hub'
    await p.autoTap()
    assert.equal(p.stage, 'success')
    assert.equal(await sGet('hubHost', ''), 'interconnect')
    const st = await getJSON('hubState', null)
    assert.equal(st.ready.today.name, '测试计划')
  } finally {
    globalThis.__icDiag = undefined
    globalThis.__icReply = undefined
  }
})

test('首页系统通道收到有效快照后才显示手机已连接', async () => {
  await sSet('hubHost', 'interconnect')
  await sSet('hubToken', 'interconnect')
  globalThis.__icDiag = 0
  globalThis.__icTimeout = 60
  globalThis.__icReply = async m => m.path === '/watch/snapshot'
    ? { id: m.id, status: 200, body: { ok: true, rev: 2, snapshot: { v: 1, unit: 'kg', restSec: 90, active: null, ready: { today: { name: '推日训练' }, others: [] } } } }
    : { id: m.id, status: 200, body: { ok: true, acked: ((m.body && m.body.events) || []).map(e => e.id) } }
  const p = mount(comps.index)
  await p.onShow()
  assert.equal(p.deviceLabel, '手机已连接')
  assert.equal(p.phoneLabel, '等待手机开始训练')
  globalThis.__icDiag = undefined
  globalThis.__icTimeout = undefined
  globalThis.__icReply = undefined
})

// ---------- spike 页（S2 传输诊断） ----------

test('spike onShow：电脑 IP 不能默认充当手机 IP；手机配对提供正确默认值', async () => {
  await sSet('host', 'http://192.168.1.10:8080')
  const p = mount(comps.spike)
  await p.onShow()
  assert.equal(p.host, '192.168.1.10:8080')
  assert.equal(p.tgt, '')
  assert.equal(p.PORT, 8765)
  await sSet('hubHost', '192.168.1.20:8765')
  await p.onShow()
  assert.equal(p.tgt, '192.168.1.20')

  await sSet('spikeHost', '192.168.1.23')
  const p2 = mount(comps.spike)
  await p2.onShow()
  assert.equal(p2.tgt, '192.168.1.23') // 手机 spike 应用独立记忆，不改配对 host
})

test('spike editTap/tapDone：键盘编辑手机 IP 并持久化到 spikeHost（不动配对 host）', async () => {
  await sSet('host', '192.168.1.10:8080')
  const { sGet } = await import('../src/js/store')
  const p = mount(comps.spike)
  await p.onShow()
  p.editTap()
  assert.equal(p.edit, true)
  assert.equal(p.rows.length, 2) // '1234567890.:' 按 6 个一行
  p.tapClearIp() // 键盘与 pair 页一致：从当前值追加编辑，先清空再输入
  for (const ch of '192.168.1.23') {
    const flat = p.rows.flat()
    const i = flat.indexOf(ch)
    p.tapChar(Math.floor(i / 6), i % 6)
  }
  assert.equal(p.tgt, '192.168.1.23')
  await p.tapDone()
  assert.equal(p.edit, false)
  assert.equal(await sGet('spikeHost', ''), '192.168.1.23')
  p.tapBack()
  assert.equal(p.tgt, '192.168.1.2')
  await p.tapDone()
  assert.equal(await sGet('spikeHost', ''), '192.168.1.2')
})

test('spike getTap：GET 发到手机 spike 服务，HTTP 200 记为通', async () => {
  await sSet('hubHost', '192.168.1.10:8765')
  const seen = []
  globalThis.__velaFetch = async opts => {
    seen.push(opts)
    return { code: 200, data: '{"ok":true,"n":1}' }
  }
  const p = mount(comps.spike)
  await p.onShow()
  await p.getTap()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'GET')
  assert.match(seen[0].url, /^http:\/\/192\.168\.1\.10:8765\/spike\?t=\d+$/)
  assert.equal(seen[0].responseType, 'text')
  assert.match(p.lines[0], /^GET ✓ 200 \d+ms \{"ok":true,"n":1\}$/)
  assert.equal(p.busy, false)
  assert.deepEqual(globalThis.__buzzes, ['long'])
})

test('spike getTap：spikeHost 优先于配对 host', async () => {
  await sSet('host', '192.168.1.10:8080')
  await sSet('spikeHost', '192.168.1.23')
  const seen = []
  globalThis.__velaFetch = async opts => { seen.push(opts); return { code: 200, data: '{}' } }
  const p = mount(comps.spike)
  await p.onShow()
  await p.getTap()
  assert.match(seen[0].url, /^http:\/\/192\.168\.1\.23:8765\//)
})

test('spike postTap：JSON 手动 stringify + Content-Type 头（Vela 表单编码坑）', async () => {
  await sSet('hubHost', '192.168.1.10')
  const seen = []
  globalThis.__velaFetch = async opts => {
    seen.push(opts)
    return { code: 200, data: '{"echoLen":29}' }
  }
  const p = mount(comps.spike)
  await p.onShow()
  await p.postTap()
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].url, 'http://192.168.1.10:8765/spike')
  assert.deepEqual(seen[0].header, { 'Content-Type': 'application/json' })
  assert.equal(typeof seen[0].data, 'string')
  assert.equal(JSON.parse(seen[0].data).type, 'spike.ping')
  assert.match(p.lines[0], /^POST ✓ 200/)
})

test('spike seqTap：连发 3 次按序记录各自耗时', async () => {
  await sSet('hubHost', '192.168.1.10')
  let n = 0
  globalThis.__velaFetch = async () => ({ code: 200, data: 'ok' + (++n) })
  const p = mount(comps.spike)
  await p.onShow()
  await p.seqTap()
  assert.equal(n, 3)
  assert.match(p.lines[0], /^×3 \d+ms \/ \d+ms \/ \d+ms$/)
})

test('spike 失败路径：网络失败记 ✗ 不炸页面，短震动；HTTP 5xx 也是"通"', async () => {
  await sSet('hubHost', '192.168.1.10')
  let mode = 'fail'
  globalThis.__velaFetch = async () => {
    if (mode === 'fail') throw new Error('connection refused')
    return { code: 500, data: 'oops' }
  }
  const p = mount(comps.spike)
  await p.onShow()
  await p.getTap()
  assert.match(p.lines[0], /^GET ✗ \d+ms 网络失败 connection refused$/)
  assert.equal(p.busy, false)
  assert.ok(globalThis.__buzzes.includes('short'))

  mode = '500'
  await p.getTap()
  assert.match(p.lines[0], /^GET ✓ 500 \d+ms oops$/)
})

test('spike pcTap：对照请求走配对服务器原样 host（带端口、根路径）', async () => {
  await sSet('host', '192.168.1.10:8080')
  const seen = []
  globalThis.__velaFetch = async opts => { seen.push(opts); return { code: 200, data: '<html>' } }
  const p = mount(comps.spike)
  await p.onShow()
  await p.pcTap()
  assert.equal(seen[0].url, 'http://192.168.1.10:8080/')
  assert.match(p.lines[0], /^PC对照 ✓ 200/)
})

test('spike 未配置 host：不发包给可读提示', async () => {
  const p = mount(comps.spike)
  await p.onShow()
  await p.getTap()
  assert.match(p.msg, /先点目标行/)
  assert.equal(globalThis.__velaFetch, undefined) // 没有任何请求发出
  assert.deepEqual(p.lines, [])
})

test('spike 自动配对：GET/POST 诊断走系统通道而非电脑或手机 HTTP', async () => {
  await sSet('host', '192.168.1.10:8080')
  await sSet('hubHost', 'interconnect')
  const calls = []
  globalThis.__icReply = async m => {
    calls.push(m)
    return { id: m.id, status: 200, body: { ok: true, method: m.method } }
  }
  globalThis.__velaFetch = async () => { throw new Error('should not use HTTP') }
  try {
    const p = mount(comps.spike)
    await p.onShow()
    await p.getTap()
    await p.postTap()
    assert.deepEqual(calls.map(m => [m.method, m.path]), [['GET', '/spike'], ['POST', '/spike']])
    assert.match(p.lines[0], /系统 POST ✓/)
  } finally { delete globalThis.__icReply }
})

test('spike 尚未配对也能直接诊断系统通道', async () => {
  globalThis.__icReply = async m => ({ id: m.id, status: 200, body: '{"ok":true}' })
  try {
    const p = mount(comps.spike)
    await p.onShow()
    p.systemTap()
    await p.getTap()
    assert.match(p.lines[0], /系统 GET ✓/)
  } finally { delete globalThis.__icReply }
})

// ---------- index 页（S4：hub 模式） ----------

function hubFetch(active, ready, rev, noAck) {
  return async opts => {
    if (opts.url.endsWith('/watch/snapshot')) {
      return { code: 200, data: { ok: true, rev: rev || 1, snapshot: { v: 1, unit: 'kg', restSec: 90, active: active || null, ready: ready || null } } }
    }
    if (noAck) return { code: 200, data: { ok: true, acked: [] } }   // 事件上报不被确认（留队）
    let acked = []
    try { acked = (JSON.parse(opts.data).events || []).map(e => e.id) } catch (e) { }
    return { code: 200, data: { ok: true, acked: acked } }
  }
}

test('手机有今日安排也只更新首页状态，独立训练入口打开本地选单', async () => {
  await sSet('hubHost', '192.168.1.20')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch(null, { today: { name: '推日训练' }, others: [] }, 3)
  const p = mount(comps.index)
  await p.onShow()
  assert.equal(p.deviceLabel, '手机已连接')
  assert.equal(p.phoneLabel, '等待手机开始训练')
  assert.deepEqual(globalThis.__routes, [])
  await p.startTap()
  assert.deepEqual(globalThis.__routes, [{ way: 'push', uri: '/pages/pick', params: { mode: 'independent' } }])
})

test('手机断网时首页显示同步异常，本地动作单仍可独立训练', async () => {
  await sSet('hubHost', '192.168.1.20')
  await sSet('hubToken', '13572468')
  await setJSON('hubState', { workout: null, ready: { today: READY_TODAY } })
  const p = mount(comps.index)
  await p.onShow() // __velaFetch 未注入 = 断网
  assert.match(p.deviceLabel, /手机离线/)
  assert.match(p.phoneLabel, /同步异常/)
  const pick = mount(comps.pick, { mode: 'independent' })
  await pick.onShow()
  assert.equal(pick.routines[0].name, READY_TODAY.name)
})

// ---------- session2 页（S4：v2 hub 协议会话） ----------

const ACTIVE = {
  id: 'w1', name: '推日训练', unit: 'kg', cur: 0, restSec: 90, start: Date.now() - 120000,
  entries: [
    { id: '0001', name: '卧推', mode: 'reps', restSec: 60, sets: [
      { w: 40, r: 10, done: true, warmup: false, at: 1 },
      { w: 40, r: 10, done: true, warmup: false, at: 2 },
      { w: 40, r: 10, done: false, warmup: false }
    ] },
    { id: '0002', name: '划船', mode: 'reps', restSec: 90, sets: [{ w: 30, r: 12, done: false, warmup: false }] }
  ]
}
const READY_TODAY = { routineIds: ['r1'], name: '推日训练', entries: [
  { id: '0001', name: '卧推', mode: 'reps', restSec: 60, sets: [{ w: 40, r: 10, done: false, warmup: false }] }
] }

test('pick 手机：离线列出今日和其他动作单，明确点选后只开启选中的计划', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const legs = { ...READY_TODAY, routineIds: ['r2'], name: '腿日' }
  await setJSON('hubState', { workout: null, unit: 'kg', restSec: 90, ready: { today: READY_TODAY, others: [legs] } })
  const p = mount(comps.pick, { mode: 'hub' })
  await p.onShow()
  assert.deepEqual(p.routines.map(r => r.name), ['推日训练', '腿日'])
  assert.equal(p.todayRid, p.routines[0].id)
  assert.deepEqual(await getJSON('hubQueue', []), [])
  await p.pick(1)
  const route = globalThis.__routes[0]
  assert.equal(route.way, 'replace')
  assert.equal(route.uri, '/pages/session2')
  const session = mount(comps.session2, route.params)
  await session.onInit()
  assert.equal(session.state.workout.name, '腿日')
  assert.deepEqual((await getJSON('hubQueue', [])).map(e => e.routineIds), [['r2']])
})

test('手机已有训练仍留在首页；主动同步时手机已结束，就等待且不自动开今日计划', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch({ ...ACTIVE, start: Date.now() }, { today: READY_TODAY }, 1)
  const index = mount(comps.index)
  await index.onShow()
  assert.equal(index.phoneLabel, '手机训练中')
  assert.equal(index.independentActive, false)
  assert.deepEqual(globalThis.__routes, [])
  await index.phoneTap()
  const route = globalThis.__routes[0]
  assert.equal(route.uri, '/pages/session2')
  globalThis.__velaFetch = hubFetch(null, { today: READY_TODAY }, 2)
  const session = mount(comps.session2, route.params)
  await session.onInit()
  assert.equal(session.phase, 'waiting')
  assert.match(session.phoneNotice, /等待手机开始/)
  assert.deepEqual(await getJSON('hubQueue', []), [])
})

test('index 停留首页时自动发现手机开练、结束；离开首页即停止轮询', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  let calls = 0
  let active = null
  globalThis.__velaFetch = opts => hubFetch(active, { today: READY_TODAY }, ++calls)(opts)
  const p = mount(comps.index)
  await p.onShow()
  assert.equal(p.phoneLabel, '等待手机开始训练')
  active = { ...ACTIVE, start: Date.now() }
  t.mock.timers.tick(10000)
  await new Promise(setImmediate)
  assert.equal(p.phoneLabel, '手机训练中')
  assert.deepEqual(globalThis.__routes, [])
  active = null
  t.mock.timers.tick(10000)
  await new Promise(setImmediate)
  assert.equal(p.phoneLabel, '等待手机开始训练')
  p.onHide()
  const count = calls
  t.mock.timers.tick(60000)
  await new Promise(setImmediate)
  assert.equal(calls, count)
})

test('主动等待后加入无动作单的手机训练，换场不自动跟入新训练', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  await seedPlan()
  const independent = mount(comps.session, { rid: 'r1' })
  await independent.onInit()
  await independent.doneTap()
  const before = await getJSON('active', null)
  globalThis.__velaFetch = hubFetch(null, null, 1, true)
  const page = mount(comps.session2, { follow: '1' })
  await page.onInit()
  assert.equal(page.phase, 'waiting')
  const free = { ...ACTIVE, name: '自由训练', rest: { total: 75, at: Date.now(), endsAt: Date.now() + 45000 } }
  globalThis.__velaFetch = hubFetch(free, null, 2, true)
  await page.retryPhone()
  assert.equal(page.wid, 'w1')
  assert.equal(page.phase, 'rest')
  assert.equal(page.restTotal, 75)
  page.restSkip()
  await page.doneTap()
  assert.ok((await getJSON('hubQueue', [])).some(e => e.type === 'setDone' && e.wid === 'w1'))
  globalThis.__velaFetch = hubFetch({ ...free, id: 'w2' }, null, 3, true)
  await page.retryPhone()
  assert.equal(page.phase, 'summary')
  assert.equal(page.wid, 'w1')
  assert.equal(page.endedOnPhone, true)
  await page.saveTap()
  assert.ok((await getJSON('hubQueue', [])).every(e => e.wid === 'w1' && e.type !== 'finish'))
  assert.deepEqual(await getJSON('active', null), before)
})

test('重开同步页可在断线时恢复已主动加入的会话，重连换场不串记', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch(ACTIVE, null, 1)
  const p = mount(comps.session2, { follow: '1' })
  await p.onInit()
  globalThis.__velaFetch = undefined
  const revived = mount(comps.session2, { follow: '1' })
  await revived.onInit()
  assert.equal(revived.wid, 'w1')
  assert.match(revived.phoneNotice, /同步异常/)
  await revived.doneTap()
  assert.equal((await getJSON('hubQueue', []))[0].wid, 'w1')
  globalThis.__velaFetch = hubFetch({ ...ACTIVE, id: 'other' }, null, 2)
  await revived.pollOnce()
  assert.equal(revived.wid, 'w1')
  assert.equal(revived.phase, 'summary')
})

test('默认休息与振动设置落盘，独立训练生效，手机训练保留手机休息时间', async () => {
  const settings = mount(comps.settings)
  await settings.onShow()
  await settings.chooseRest(settings.options.findIndex(o => o.label === '45 秒'))
  await settings.toggleVibration()
  const reopened = mount(comps.settings)
  await reopened.onShow()
  assert.equal(reopened.restSec, 45)
  assert.equal(reopened.vibrate, false)
  await seedPlan()
  const independent = mount(comps.session, { rid: 'r2' })
  await independent.onInit()
  await independent.doneTap()
  assert.equal(independent.restTotal, 45)
  independent.restEndAt = Date.now() - 1
  independent.tickRest()
  assert.ok(!globalThis.__buzzes.includes('long'))
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch({ ...ACTIVE, rest: { total: 110, endsAt: Date.now() + 60000 } }, null, 1)
  const phone = mount(comps.session2, { follow: '1' })
  await phone.onInit()
  assert.equal(phone.restTotal, 110)
  phone.restEndAt = Date.now() - 1
  phone.tickRest()
  assert.ok(!globalThis.__buzzes.includes('long'))
})

test('独立训练可选手机缓存动作单，保存后不混入手机活动会话', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch(ACTIVE, { today: READY_TODAY }, 1)
  const home = mount(comps.index)
  await home.onShow()
  const pick = mount(comps.pick, { mode: 'independent' })
  await pick.onShow()
  await pick.pick(0)
  const page = mount(comps.session, globalThis.__routes.at(-1).params)
  await page.onInit()
  await page.doneTap()
  await page.saveTap()
  assert.match(page.syncMsg, /已保存在手表/)
  assert.equal((await loadState()).workout.id, 'w1')
  assert.deepEqual(await getJSON('hubQueue', []), [])
  const details = mount(comps.pending)
  await details.onShow()
  assert.match(details.summary, /1 场/)
  assert.match(details.rows[0].status, /仅存手表/)
})

test('session2 onInit：接上手机正在跑的训练并定位到首个未完成组', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch(ACTIVE, null, 7)
  const p = mount(comps.session2)
  await p.onInit()
  assert.equal(p.ready, true)
  assert.equal(p.err, '')
  assert.equal(p.phase, 'train')
  assert.equal(p.wid, 'w1')
  assert.deepEqual([p.exI, p.setI], [0, 2])
  assert.equal(p.curName, '卧推')
  assert.equal(p.dotList.map(d => d.ch).join(' '), '● ● ◉')  // 圆点逐个可点（S6）：当前组 ◉
})

test('session2 onInit：无进行中会话、有 ready.today → 自动开局，start 事件入队（上报被拒就留队）', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = async opts => {
    if (opts.url.endsWith('/watch/snapshot')) return { code: 200, data: { ok: true, rev: 1, snapshot: { v: 1, unit: 'kg', restSec: 90, active: null, ready: { today: READY_TODAY, others: [] } } } }
    return { code: 401, data: { ok: false, error: 'unauthorized' } }   // 事件上报失败
  }
  const p = mount(comps.session2)
  await p.onInit()
  assert.equal(p.phase, 'train')
  assert.ok(p.wid, '手表自开一场，wid 已定')
  const q = await getJSON('hubQueue', [])
  assert.equal(q.length, 1)
  assert.equal(q[0].type, 'start')
  assert.equal(q[0].wid, p.wid)
})

test('session2 onInit：断网且本地无会话 → 可读错误；本地有会话 → 恢复继续', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const p = mount(comps.session2)
  await p.onInit() // __velaFetch 未注入 = 断网
  assert.match(p.err, /连不上手机/)

  const local = { workout: JSON.parse(JSON.stringify(ACTIVE)), pending: {}, unit: 'kg', restSec: 90, startedHere: null, finishedHere: [], entryIndex: 0, skipped: null, settings: {} }
  local.workout.start = Date.now() - 60000
  await setJSON('hubState', local)
  const p2 = mount(comps.session2)
  await p2.onInit()
  assert.equal(p2.err, '')
  assert.equal(p2.wid, 'w1')
  assert.deepEqual([p2.exI, p2.setI], [0, 2])
})

test('session2 onInit：无今日有 others → 列表挑选，startOther 开局', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch(null, { today: null, others: [{ routineIds: ['r2'], name: '腿日', entries: [{ id: '0003', name: '深蹲', mode: 'reps', restSec: 90, sets: [{ w: 60, r: 8, done: false, warmup: false }] }] }] }, 2)
  const p = mount(comps.session2)
  await p.onInit()
  assert.equal(p.phase, 'others')
  assert.deepEqual(p.others, [{ name: '腿日' }])
  await p.startOther(0)
  assert.equal(p.phase, 'train')
  assert.equal(p.state.workout.name, '腿日')
  assert.equal(p.curName, '深蹲')
})

test('session2 主流程：完成一组 → 休息用动作 restSec → 跳过 → 下一组；事件留队待发', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch(JSON.parse(JSON.stringify(ACTIVE)), null, 7, true)
  const p = mount(comps.session2)
  await p.onInit()
  p.onShow()
  assert.ok(p.timer, 'onShow 应启动计时器')
  p.onHide()
  assert.equal(p.timer, null, 'onHide 应停表')

  p.dispW = 42.5
  p.dispR = 8
  await p.doneTap()
  assert.equal(p.state.workout.entries[0].sets[2].done, true)
  assert.deepEqual(p.state.workout.entries[0].sets[2], { w: 42.5, r: 8, done: true, warmup: false, at: p.state.workout.entries[0].sets[2].at })
  assert.equal(p.phase, 'rest')
  assert.equal(p.restTotal, 90)                       // 休息属于下一组（划船 restSec=90）
  assert.equal(p.nextName, '划船')
  const q = await getJSON('hubQueue', [])
  assert.equal(q.length, 1)
  assert.equal(q[0].type, 'setDone')
  assert.equal(q[0].w, 42.5)

  p.restSkip()
  assert.equal(p.phase, 'train')
  assert.deepEqual([p.exI, p.setI], [1, 0])
  assert.equal(p.curName, '划船')
})

test('session2 单侧组：两连点自动 L→R，两侧完成才进下一处', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const active = { id: 'w2', name: '单侧日', unit: 'kg', cur: 0, restSec: 90, start: Date.now(), entries: [
    { id: '0099', name: '保加利亚分腿蹲', mode: 'reps', restSec: 90, perSide: true, sets: [
      { w: 20, r: 10, done: false, warmup: false, sides: { L: { w: 20, r: 10, done: false }, R: { w: 20, r: 10, done: false } } }
    ] }
  ] }
  globalThis.__velaFetch = hubFetch(active, null, 4, true)
  const p = mount(comps.session2)
  await p.onInit()
  await p.doneTap()
  assert.equal(p.state.workout.entries[0].sets[0].sides.L.done, true)
  assert.equal(p.phase, 'train')                      // 还有一侧，不休息
  await new Promise(r => setTimeout(r, 750))          // 完成键 700ms 防抖（S6），连点算一次
  await p.doneTap()
  assert.equal(p.state.workout.entries[0].sets[0].done, true)
  const q = await getJSON('hubQueue', [])
  assert.deepEqual(q.filter(x => x.type === 'setDone').map(x => x.side), ['L', 'R'])
})

test('session2 结束与同步：endTap → 总结 → saveTap 发 finish；断网 saveState=2 恢复后重试成功', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch(JSON.parse(JSON.stringify(ACTIVE)), null, 7)
  const p = mount(comps.session2)
  await p.onInit()
  p.dispW = 42.5
  p.dispR = 8
  await p.doneTap()
  p.endTap()
  assert.equal(p.phase, 'summary')
  assert.equal(p.sumSets, 3)
  assert.equal(p.sumVol, 40 * 10 * 2 + 42.5 * 8)
  assert.deepEqual(p.sumList, ['卧推  42.5×8次 ×3组'])

  await p.saveTap()                                    // hubFetch 事件分支返回 ok → flush 成功
  assert.equal(p.saveState, 1)
  assert.deepEqual(await getJSON('hubQueue', []), [])
  assert.equal((await loadState()).workout, null)      // finish 已清场

  // 断网重试路径：finish 事件留在队列，恢复后 saveTap 再按即补投成功
  await setJSON('hubState', { workout: JSON.parse(JSON.stringify(ACTIVE)), pending: {}, unit: 'kg', restSec: 90, startedHere: null, finishedHere: [], entryIndex: 0, skipped: null, settings: {} })
  globalThis.__velaFetch = undefined
  const p2 = mount(comps.session2)
  await p2.onInit()                                    // 断网走本地恢复
  await p2.doneTap()
  p2.endTap()
  await p2.saveTap()
  assert.equal(p2.saveState, 2)
  assert.match(p2.syncMsg, /连不上/)
  globalThis.__velaFetch = hubFetch(null, null, 9)
  await p2.saveTap()
  assert.equal(p2.saveState, 1)
})

test('session2 丢弃：quitTap 两次确认 → 本地清场、不发 finish 事件', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch(JSON.parse(JSON.stringify(ACTIVE)), null, 7)
  const p = mount(comps.session2)
  await p.onInit()
  p.quitTap()
  assert.equal(p.confirmQuit, true)
  await p.quitTap()
  const st = await loadState()
  assert.equal(st.workout, null)
  assert.ok(st.finishedHere.includes('w1'))
  assert.deepEqual(globalThis.__routes, [{ way: 'replace', uri: '/pages/index' }])
})

test('session2 reconcile：手机端结束训练 → 本地跟着进总结', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch(JSON.parse(JSON.stringify(ACTIVE)), null, 7)
  const p = mount(comps.session2)
  await p.onInit()
  assert.equal(p.phase, 'train')
  p.reconcile({ workout: null, ready: null, pending: {}, unit: 'kg', restSec: 90, startedHere: null, finishedHere: [], entryIndex: 0, skipped: null, settings: {} })
  assert.equal(p.phase, 'summary')
  assert.equal(p.sumSets, 2)                           // 手机已记 2 组
})

// ---------- session2 页（S6：UI 语义集成） ----------
// 对齐 Apple Watch 版 OpenGymWatchApp.swift：跳过（长按两段确认 + 圆点找回）、单侧 L/R、
// 热身/超级组标签、有氧无数值、计时记秒、restSec=0 不休息、防抖、总结口径。

test('session2 热身组：标签与琥珀色圆点，进度与总结排除热身', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const active = { id: 'w3', name: '热身日', unit: 'kg', cur: 0, restSec: 90, start: Date.now(), entries: [
    { id: '0001', name: '卧推', mode: 'reps', restSec: 60, sets: [
      { w: 20, r: 8, done: false, warmup: true },
      { w: 40, r: 10, done: false, warmup: false }
    ] }
  ] }
  globalThis.__velaFetch = hubFetch(active, null, 3, true)
  const p = mount(comps.session2)
  await p.onInit()
  assert.equal(p.curWarmup, true)
  assert.ok(p.dotList[0].c.indexOf('dWarm') >= 0, '热身圆点带 dWarm 类')
  assert.equal(p.prog, '1/1 动作 · 0/1 组')            // progress 不数热身组
  p.dispW = 22.5
  p.dispR = 8
  await p.doneTap()
  assert.equal(p.state.workout.entries[0].sets[0].done, true)
  assert.equal(p.phase, 'rest')                        // 热身完也休息（下一组 restSec 60）
  p.restSkip()
  assert.equal(p.curWarmup, false)
  p.endTap()
  assert.equal(p.sumSets, 0)                           // 只记了热身 → 组数 0
  assert.equal(p.sumVol, 0)
  assert.deepEqual(p.sumList, [])                      // 总结列表也不列热身
})

test('session2 跳过：「跳过这组」两段点按确认 → 绕开该组不休息；点圆点找回；无可做组时自动前进/进总结', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const active = { id: 'w4', name: '跳过日', unit: 'kg', cur: 0, restSec: 90, start: Date.now(), entries: [
    { id: 'a1', name: '卧推', mode: 'reps', restSec: 60, sets: [
      { w: 40, r: 10, done: false, warmup: false },
      { w: 40, r: 10, done: false, warmup: false }
    ] },
    { id: 'b1', name: '深蹲', mode: 'reps', restSec: 60, sets: [
      { w: 60, r: 8, done: false, warmup: false }
    ] }
  ] }
  globalThis.__velaFetch = hubFetch(active, null, 3, true)
  const p = mount(comps.session2)
  await p.onInit()
  await p.skipTap()                                    // 第一段：武装确认
  assert.equal(p.skipConfirm, true)
  await p.skipTap()                                    // 第二段：跳过
  assert.equal(p.skipConfirm, false)
  assert.equal(p.phase, 'train')                       // 跳过不休息
  assert.equal(p.setI, 1)                              // 绕到第 2 组
  assert.ok(p.dotList[0].c.indexOf('dSkip') >= 0, '被跳的组圆点变 ✕')
  p.dotTap(0)                                          // 点圆点找回被跳的组
  assert.equal(p.setI, 0)
  p.dotTap(1)                                          // 再点回第 2 组
  assert.equal(p.setI, 1)
  await p.doneTap()                                    // 完成第 2 组 → 休息，下一处是深蹲
  assert.equal(p.phase, 'rest')
  assert.equal(p.nextName, '深蹲')
  p.restSkip()
  assert.deepEqual([p.exI, p.setI], [1, 0])
  await p.skipTap()
  await p.skipTap()                                    // 深蹲那组也跳过 → 整场无可做组
  assert.equal(p.phase, 'summary')
})

test('session2 单侧组：L/R 双按钮各记一侧，另一侧回到计划值，两侧都完成才休息', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const active = { id: 'w5', name: '单侧日', unit: 'kg', cur: 0, restSec: 90, start: Date.now(), entries: [
    { id: 'c1', name: '保加利亚分腿蹲', mode: 'reps', restSec: 60, perSide: true, sets: [
      { w: 20, r: 10, done: false, warmup: false, sides: { L: { w: 20, r: 10, done: false }, R: { w: 20, r: 10, done: false } } },
      { w: 20, r: 10, done: false, warmup: false }
    ] }
  ] }
  globalThis.__velaFetch = hubFetch(active, null, 3, true)
  const p = mount(comps.session2)
  await p.onInit()
  assert.equal(p.perSide, true)
  assert.equal(p.upSide, 'L')
  p.dispW = 22.5
  p.dispR = 8
  await p.sideTap('L')
  assert.equal(p.state.workout.entries[0].sets[0].sides.L.done, true)
  assert.equal(p.state.workout.entries[0].sets[0].sides.L.w, 22.5)
  assert.equal(p.phase, 'train')                       // 还有一侧，不休息
  assert.equal(p.upSide, 'R')
  assert.equal(p.dispW, 20)                            // R 侧回到计划值，不沿用 L 的实际值
  assert.equal(p.dispR, 10)
  assert.equal(p.lDone, true)
  await new Promise(r => setTimeout(r, 750))           // 完成键 700ms 防抖（S6）
  await p.sideTap('R')
  assert.equal(p.state.workout.entries[0].sets[0].done, true)
  assert.equal(p.phase, 'rest')
  const q = await getJSON('hubQueue', [])
  assert.deepEqual(q.filter(x => x.type === 'setDone').map(x => x.side), ['L', 'R'])
})

test('session2 超级组：成员轮转不休息，一轮完了才休息，标签显示', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const active = { id: 'w6', name: '超级组日', unit: 'kg', cur: 0, restSec: 90, start: Date.now(), entries: [
    { id: 'd0', name: '引体向上', mode: 'reps', restSec: 60, group: 'g1', sets: [{ w: 0, r: 8, done: false, warmup: false }] },
    { id: 'd1', name: '划船', mode: 'reps', restSec: 60, group: 'g1', sets: [{ w: 30, r: 12, done: false, warmup: false }] },
    { id: 'd2', name: '硬拉', mode: 'reps', restSec: 60, sets: [{ w: 80, r: 5, done: false, warmup: false }] }
  ] }
  globalThis.__velaFetch = hubFetch(active, null, 3, true)
  const p = mount(comps.session2)
  await p.onInit()
  assert.equal(p.hasGroup, true)
  await p.doneTap()
  assert.equal(p.phase, 'train')                       // 轮到超级组下一个成员，不休息
  assert.equal(p.curName, '划船')
  assert.equal(p.hasGroup, true)
  await new Promise(r => setTimeout(r, 750))           // 完成键 700ms 防抖（S6）
  await p.doneTap()
  assert.equal(p.phase, 'rest')                        // 一轮完了 → 休息
  assert.equal(p.nextName, '硬拉')                     // 下一处是组外动作
})

test('session2 有氧组：不带数值地记', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const active = { id: 'w7', name: '有氧日', unit: 'kg', cur: 0, restSec: 90, start: Date.now(), entries: [
    { id: 'e1', name: '跳绳', mode: 'cardio', restSec: 60, sets: [{ done: false, warmup: false }] },
    { id: 'e2', name: '深蹲', mode: 'reps', restSec: 60, sets: [{ w: 60, r: 8, done: false, warmup: false }] }
  ] }
  globalThis.__velaFetch = hubFetch(active, null, 3, true)
  const p = mount(comps.session2)
  await p.onInit()
  assert.equal(p.curCardio, true)
  await p.doneTap()
  const q = await getJSON('hubQueue', [])
  assert.equal(q[0].type, 'setDone')
  assert.equal(q[0].w, undefined)
  assert.equal(q[0].r, undefined)
  assert.equal(p.phase, 'rest')
})

test('session2 计时组：秒数记录', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const active = { id: 'w8', name: '计时日', unit: 'kg', cur: 0, restSec: 90, start: Date.now(), entries: [
    { id: 'f1', name: '平板支撑', mode: 'time', restSec: 60, sets: [{ sec: 40, done: false, warmup: false }] },
    { id: 'f2', name: '深蹲', mode: 'reps', restSec: 60, sets: [{ w: 60, r: 8, done: false, warmup: false }] }
  ] }
  globalThis.__velaFetch = hubFetch(active, null, 3, true)
  const p = mount(comps.session2)
  await p.onInit()
  assert.equal(p.modeSec, true)
  assert.equal(p.dispR, 40)
  p.dispR = 45
  await p.doneTap()
  const q = await getJSON('hubQueue', [])
  assert.equal(q[0].sec, 45)
  assert.equal(q[0].r, undefined)
})

test('session2 restSec=0：完成直接下一组，不进休息', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const active = { id: 'w9', name: '无休日', unit: 'kg', cur: 0, restSec: 90, start: Date.now(), entries: [
    { id: 'g1', name: '卧推', mode: 'reps', restSec: 0, sets: [{ w: 40, r: 10, done: false, warmup: false }] },
    { id: 'g2', name: '深蹲', mode: 'reps', restSec: 0, sets: [{ w: 60, r: 8, done: false, warmup: false }] }
  ] }
  globalThis.__velaFetch = hubFetch(active, null, 3, true)
  const p = mount(comps.session2)
  await p.onInit()
  await p.doneTap()
  assert.equal(p.phase, 'train')
  assert.deepEqual([p.exI, p.setI], [1, 0])
})

test('session2 完成键 700ms 防抖：连点只记一组', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const active = { id: 'wa', name: '防抖日', unit: 'kg', cur: 0, restSec: 90, start: Date.now(), entries: [
    { id: 'h1', name: '卧推', mode: 'reps', restSec: 0, sets: [
      { w: 40, r: 10, done: false, warmup: false },
      { w: 40, r: 10, done: false, warmup: false }
    ] }
  ] }
  globalThis.__velaFetch = hubFetch(active, null, 3, true)
  const p = mount(comps.session2)
  await p.onInit()
  await p.doneTap()
  assert.equal(p.state.workout.entries[0].sets[0].done, true)
  assert.deepEqual([p.exI, p.setI], [0, 1])
  await p.doneTap()                                    // 700ms 内的第二次点按被吞
  assert.equal(p.state.workout.entries[0].sets[1].done, false)
  await new Promise(r => setTimeout(r, 750))
  await p.doneTap()
  assert.equal(p.state.workout.entries[0].sets[1].done, true)
})

test('session2 总结口径：列表排除热身、计时显示秒、有氧无数值；PR 用 core beatsBest 口径', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const active = { id: 'wb', name: '口径日', unit: 'kg', cur: 0, restSec: 90, start: Date.now() - 300000, entries: [
    { id: 'i1', name: '卧推', mode: 'reps', restSec: 60, best: { w: 35, r: 10 }, sets: [
      { w: 20, r: 8, done: true, warmup: true, at: 1 },
      { w: 40, r: 10, done: true, warmup: false, at: 2 },
      { w: 40, r: 10, done: true, warmup: false, at: 3 }
    ] },
    { id: 'i2', name: '平板支撑', mode: 'time', restSec: 60, sets: [{ sec: 45, done: true, warmup: false, at: 4 }] },
    { id: 'i3', name: '跳绳', mode: 'cardio', restSec: 60, sets: [{ done: true, warmup: false, at: 5 }] }
  ] }
  globalThis.__velaFetch = hubFetch(active, null, 3, true)
  const p = mount(comps.session2)
  await p.onInit()                                     // 全部记完 → 直接接上总结
  assert.equal(p.phase, 'summary')
  assert.equal(p.sumSets, 4)                           // 卧推 2 + 平板 1 + 跳绳 1（热身不算）
  assert.equal(p.sumVol, 40 * 10 * 2)                  // 计时/有氧不计体量
  assert.deepEqual(p.sumList, ['卧推  40×10次 ×2组', '平板支撑  45秒 ×1组', '跳绳  ×1组'])
})

test('session2 总结 PR：比历史最佳更重即 PR（core beatsBest）', async () => {
  await sSet('hubHost', '127.0.0.1:8765')
  await sSet('hubToken', '13572468')
  const active = { id: 'wc', name: 'PR日', unit: 'kg', cur: 0, restSec: 90, start: Date.now(), entries: [
    { id: 'j1', name: '卧推', mode: 'reps', restSec: 60, best: { w: 35, r: 10 }, sets: [
      { w: 42.5, r: 8, done: true, warmup: false, at: 1 }
    ] }
  ] }
  globalThis.__velaFetch = hubFetch(active, null, 3, true)
  const p = mount(comps.session2)
  await p.onInit()
  assert.equal(p.phase, 'summary')
  assert.equal(p.sumPrs, '卧推')
})
