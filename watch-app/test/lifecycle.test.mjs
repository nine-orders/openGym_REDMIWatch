// 页面生命周期回归测试：pages.test.mjs 只做静态检查、从不执行 onInit——这里用
// test/stubs/ 实例化组件，真实调用 onInit/onShow/事件处理并断言状态。覆盖 v1 审查的
// Bug 1（onInit 调 firstUndoneAfter(-1,-1) 抛 TypeError，页面永远停在"载入中"）与
// Bug 3（index 的粘性 startRid 覆盖"今天该练的"），以及训练主流程的页面级行为。
import './register.mjs'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', 'src')

// 与 pages.test.mjs 相同的方式把 .ux 的 script 生成到 .gen/ 下再导入
const PAGES = [['pages/index', 'index'], ['pages/pair', 'pair'], ['pages/pick', 'pick'], ['pages/session', 'session'], ['pages/session2', 'session2'], ['pages/spike', 'spike']]
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
  p.doneTap()
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
  p.doneTap()
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
  p2.doneTap(); p2.endTap()
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

// ---------- index 页 ----------

test('index onShow：展示服务器/待同步/今日动作单；今日动作单按 dayPlan > 队列 > 周计划', async () => {
  await sSet('host', '192.168.1.10:8080')
  await sSet('token', 'tok')
  await seedPlan()
  const p = mount(comps.index)
  await p.onShow()
  assert.equal(p.hasSetup, true)
  assert.equal(p.host, '192.168.1.10:8080')
  assert.equal(p.todayName, '推日') // 队列 ['r1']

  const dow = String(new Date().getDay())
  await seedPlan({ queue: null, week: { [dow]: ['r2'] } })
  const p2 = mount(comps.index)
  await p2.onShow()
  assert.equal(p2.todayName, '腿日')
})

test('index startTap：按今日计划经 params 传目标，粘性 startRid 不再覆盖（Bug 3）', async () => {
  await seedPlan()
  await setJSON('startRid', 'r2') // 两天前手动挑过腿日，粘着
  const p = mount(comps.index)
  await p.startTap()
  assert.equal(globalThis.__routes.length, 1)
  assert.equal(globalThis.__routes[0].uri, '/pages/session')
  assert.equal(globalThis.__routes[0].params.rid, 'r1') // 今天该练的（队列第一项），不是粘性 r2
  // 开局不写粘性值：startRid 只属于「选动作单」页的手动挑选
  assert.equal(await getJSON('startRid', ''), 'r2')
})

test('index startTap：rest 日落到选动作单页；有未结束会话时直接续训', async () => {
  const today = todayISO()
  await seedPlan({ dayPlan: { [today]: 'rest' }, queue: null })
  const p = mount(comps.index)
  await p.startTap()
  assert.deepEqual(globalThis.__routes, [{ way: 'push', uri: '/pages/pick' }])

  await seedPlan()
  const active = {
    id: 's1', routineId: 'r1', name: '推日', unit: 'kg', start: Date.now(), restSec: 90,
    entries: [{ id: '0001', name: '0001', mode: 'reps', rs: 60, sets: [{ w: 20, r: 10, done: false, ts: 0 }] }]
  }
  await setJSON('active', active)
  const p2 = mount(comps.index)
  await p2.onShow() // 真实页面里 active 由 onShow 填充
  assert.equal(p2.active.id, 's1')
  await p2.startTap()
  assert.deepEqual(globalThis.__routes.slice(1), [{ way: 'push', uri: '/pages/session' }]) // 续训不传 rid
})

test('index startTap：本地无计划给可读提示', async () => {
  const p = mount(comps.index)
  await p.startTap()
  assert.match(p.syncMsg, /本地无计划/)
  assert.deepEqual(globalThis.__routes, [])
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
  assert.equal(p.todayName, '腿日')              // 「开始训练」指向肩日，不再永远胸日
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
  assert.equal(p.todayName, '推日')
})

// ---------- pick 页 ----------

test('pick：onShow 列出动作单并标今日；pick 持久化 startRid 并进 session（手动挑选才持久化）', async () => {
  await seedPlan()
  const p = mount(comps.pick)
  await p.onShow()
  assert.deepEqual(p.routines, [
    { id: 'r1', name: '推日', exN: 1 },
    { id: 'r2', name: '腿日', exN: 1 }
  ])
  assert.equal(p.todayRid, 'r1') // 队列第一项标「今日」

  await p.pick(1)
  assert.equal(await getJSON('startRid', ''), 'r2') // 持久化的是手动挑的腿日
  assert.deepEqual(globalThis.__routes, [{ way: 'push', uri: '/pages/session' }])
})

test('pick：空计划显示空态提示', async () => {
  await setJSON('plan', buildPlanCache({}))
  const p = mount(comps.pick)
  await p.onShow()
  assert.deepEqual(p.routines, [])
  assert.equal(p.todayRid, '')
})

// ---------- pair 页（S4：hub 配对） ----------

test('pair onShow：host 优先取 hubHost 并去 http:// 前缀；键盘按页签重建', async () => {
  await sSet('hubHost', 'http://192.168.1.20')
  const p = mount(comps.pair)
  await p.onShow()
  assert.equal(p.host, '192.168.1.20')
  assert.equal(p.rows.length, 2) // '1234567890.:' 12 个按 6 个一行

  p.setTab('code')
  assert.equal(p.tab, 'code')
  assert.equal(p.rows.length, 2) // 10 个数字按 6 个一行（hub token 是 8 位数字）
  p.tapChar(0, 0)
  assert.equal(p.code, '0')
  p.tapBack()
  assert.equal(p.code, '')
})

test('pair pairTap：缺 host / 配对码不是 8 位数字先本地校验，不发请求', async () => {
  const p = mount(comps.pair)
  await p.pairTap()
  assert.match(p.msg, /服务器/)
  p.host = '192.168.1.20'
  p.code = 'ABC'
  await p.pairTap()
  assert.match(p.msg, /8 位数字/)
  assert.equal(p.busy, false)
  assert.equal(globalThis.__velaFetch, undefined)
})

test('pair pairTap：hub 配对成功——ping+快照种子，token 验证过才保留，1.2s 后自动回主页', async () => {
  globalThis.__velaFetch = async opts => {
    if (opts.url.endsWith('/watch/ping')) return { code: 200, data: { ok: true, server: 'hub', rev: 1, time: 1 } }
    if (opts.url.endsWith('/watch/snapshot')) {
      return { code: 200, data: { ok: true, rev: 1, snapshot: { v: 1, unit: 'kg', restSec: 90, active: null, ready: { today: { name: '推日' }, others: [{ name: '腿日' }] } } } }
    }
    return { code: 404, data: { ok: false, error: 'not_found' } }
  }
  const p = mount(comps.pair)
  p.host = '192.168.1.20'
  p.code = '13572468'
  await p.pairTap()
  assert.match(p.msg, /配对成功/)
  const { sGet } = await import('../src/js/store')
  assert.equal(await sGet('hubToken', ''), '13572468')
  assert.equal(await sGet('hubHost', ''), '192.168.1.20')
  const st = await getJSON('hubState', null)
  assert.equal(st.ready.today.name, '推日')      // 快照已种子进本地状态
  await new Promise(res => setTimeout(res, 1400)) // 自动回主页的定时器
  assert.deepEqual(globalThis.__routes, [{ way: 'back' }])
})

test('pair pairTap：ping 失败（token 错）→ token 清掉不算配对', async () => {
  globalThis.__velaFetch = async () => ({ code: 401, data: { ok: false, error: 'unauthorized' } })
  const p = mount(comps.pair)
  p.host = '192.168.1.20'
  p.code = '13572468'
  await p.pairTap()
  assert.match(p.msg, /失败/)
  const { sGet } = await import('../src/js/store')
  assert.equal(await sGet('hubToken', ''), '')
})

test('pair spikeTap：跳转传输诊断页', async () => {
  const p = mount(comps.pair)
  p.spikeTap()
  assert.deepEqual(globalThis.__routes, [{ way: 'push', uri: '/pages/spike' }])
})

// ---------- pair hub 开关（S7：hub/直连 切换 + 持久化 + 明确状态） ----------

test('pair modeTap：hub↔直连 切换持久化 pairMode，键盘与状态文案按模式重建', async () => {
  const p = mount(comps.pair)
  await p.onShow()                        // 无凭证 → 默认 hub（v2 主路径）
  assert.equal(p.pairMode, 'hub')
  assert.equal(p.rows.length, 2)          // host '1234567890.:' 12 个按 6/行
  p.setTab('code')
  assert.equal(p.rows.length, 2)          // hub token 10 个数字按 6/行

  await p.modeTap()
  assert.equal(p.pairMode, 'direct')
  assert.match(p.msg, /直连服务器/)
  assert.equal(await sGet('pairMode', ''), 'direct')
  p.setTab('code')
  assert.equal(p.rows.length, 4)          // v1 配对码 32 个按 8/行

  await p.modeTap()
  assert.equal(p.pairMode, 'hub')
  assert.match(p.msg, /手机 hub/)
  assert.equal(await sGet('pairMode', ''), 'hub')
  assert.equal(p.rows.length, 2)
})

test('pair onShow：已有 v1 凭证且未显式选模式 → 自动落直连', async () => {
  await sSet('host', '192.168.1.10:8080')
  await sSet('token', 'tok')
  const p = mount(comps.pair)
  await p.onShow()
  assert.equal(p.pairMode, 'direct')
  assert.equal(p.host, '192.168.1.10:8080')
})

test('pair 直连 pairTap：redeem 成功 → host 带 :8080 落库、token 保存、计划缓存、自动回主页', async () => {
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
  assert.match(p.msg, /直连配对成功/)
  assert.equal(await sGet('host', ''), '192.168.1.10:8080')
  assert.equal(await sGet('token', ''), 'tok-90d')
  const plan = await getJSON('plan', null)
  assert.equal(plan.routines.length, 2)
  assert.equal(plan.queue.ids[0], 'r1')
  await new Promise(res => setTimeout(res, 1400))   // 自动回主页
  assert.deepEqual(globalThis.__routes, [{ way: 'back' }])
})

test('pair 直连 pairTap：redeem 失败 → token 清掉不算配对', async () => {
  globalThis.__velaFetch = async () => ({ code: 400, data: { error: 'code_expired' } })
  const p = mount(comps.pair)
  await p.onShow()
  p.pairMode = 'direct'
  p.host = '192.168.1.10'
  p.code = 'ABCD2345'
  await p.pairTap()
  assert.match(p.msg, /失败/)
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
  assert.equal(p.hubMode, false)
  assert.equal(p.host, '127.0.0.1:8080')
  assert.equal(p.hasSetup, true)
  assert.equal(p.todayName, '推日')
})

// ---------- pair/index（S8 2A：免输入系统配对 interconnect） ----------

test('pair onShow：系统通道诊断 1001（手机未装 App）→ 明确文案不静默', async () => {
  globalThis.__icDiag = 1001
  const p = mount(comps.pair)
  await p.onShow()
  await new Promise(r => setTimeout(r, 10))   // 诊断桩一步异构步，等它落定
  assert.match(p.msg, /手机未安装 openGym/)
  globalThis.__icDiag = undefined
})

test('pair onShow：系统通道 OK 且无凭证 → 免输入自动配对（ping+快照种子、写 interconnect 凭证、自动回主页）', async () => {
  globalThis.__icDiag = 0
  globalThis.__icTimeout = 60
  globalThis.__icSent = []
  globalThis.__icReply = async m => {
    if (m.path === '/watch/ping') return { id: m.id, status: 200, body: { ok: true, rev: 1, time: 1 } }
    if (m.path === '/watch/snapshot') {
      return { id: m.id, status: 200, body: { ok: true, rev: 1, snapshot: { v: 1, unit: 'kg', restSec: 90, active: null, ready: { today: { name: '推日训练' }, others: [{ name: '腿日' }] } } } }
    }
    return { id: m.id, status: 200, body: { ok: true, acked: ((m.body && m.body.events) || []).map(e => e.id) } }
  }
  const p = mount(comps.pair)
  await p.onShow()
  await new Promise(r => setTimeout(r, 1500))   // 成功定时回主页（1200ms）
  assert.match(p.msg, /配对成功 ✓（免输入）/)
  assert.equal(await sGet('hubHost', ''), 'interconnect')
  assert.equal(await sGet('hubToken', ''), 'interconnect')
  const st = await getJSON('hubState', null)
  assert.equal(st.ready.today.name, '推日训练')
  assert.deepEqual(globalThis.__routes, [{ way: 'back' }])
  assert.deepEqual(globalThis.__icSent.map(x => x.path), ['/watch/ping', '/watch/snapshot'])
  globalThis.__icDiag = undefined
  globalThis.__icTimeout = undefined
  globalThis.__icReply = undefined
  globalThis.__icSent = undefined
})

test('index onShow：interconnect 凭证 → hub 模式、主机行显示自动配对、今日来自快照', async () => {
  await sSet('hubHost', 'interconnect')
  await sSet('hubToken', 'interconnect')
  globalThis.__icDiag = 0
  globalThis.__icTimeout = 60
  globalThis.__icReply = async m => m.path === '/watch/snapshot'
    ? { id: m.id, status: 200, body: { ok: true, rev: 2, snapshot: { v: 1, unit: 'kg', restSec: 90, active: null, ready: { today: { name: '推日训练' }, others: [] } } } }
    : { id: m.id, status: 200, body: { ok: true, acked: ((m.body && m.body.events) || []).map(e => e.id) } }
  const p = mount(comps.index)
  await p.onShow()
  assert.equal(p.hubMode, true)
  assert.equal(p.host, '自动配对（系统通道）')
  assert.equal(p.hasSetup, true)
  assert.equal(p.todayName, '推日训练')
  globalThis.__icDiag = undefined
  globalThis.__icTimeout = undefined
  globalThis.__icReply = undefined
})

// ---------- spike 页（S2 传输诊断） ----------

test('spike onShow：目标默认取配对 host 裸 IP，端口固定 8765；可独立改手机 IP', async () => {
  await sSet('host', 'http://192.168.1.10:8080')
  const p = mount(comps.spike)
  await p.onShow()
  assert.equal(p.host, '192.168.1.10:8080')
  assert.equal(p.ip, '192.168.1.10')
  assert.equal(p.tgt, '192.168.1.10') // 未设 spikeHost 时回落配对 IP
  assert.equal(p.PORT, 8765)

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
  await sSet('host', '192.168.1.10:8080')
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
  await sSet('host', '192.168.1.10')
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
  await sSet('host', '192.168.1.10')
  let n = 0
  globalThis.__velaFetch = async () => ({ code: 200, data: 'ok' + (++n) })
  const p = mount(comps.spike)
  await p.onShow()
  await p.seqTap()
  assert.equal(n, 3)
  assert.match(p.lines[0], /^×3 \d+ms \/ \d+ms \/ \d+ms$/)
})

test('spike 失败路径：网络失败记 ✗ 不炸页面，短震动；HTTP 5xx 也是"通"', async () => {
  await sSet('host', '192.168.1.10')
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

test('index onShow：hub 模式——显示手机 IP、今日来自快照 ready，开局路由到 session2', async () => {
  await sSet('hubHost', '192.168.1.20')
  await sSet('hubToken', '13572468')
  globalThis.__velaFetch = hubFetch(null, { today: { name: '推日训练' }, others: [] }, 3)
  const p = mount(comps.index)
  await p.onShow()
  assert.equal(p.hubMode, true)
  assert.equal(p.host, '192.168.1.20')
  assert.equal(p.todayName, '推日训练')
  await p.startTap()
  assert.deepEqual(globalThis.__routes, [{ way: 'push', uri: '/pages/session2' }])
})

test('index onShow：hub 模式断网沿用本地快照状态', async () => {
  await sSet('hubHost', '192.168.1.20')
  await sSet('hubToken', '13572468')
  await setJSON('hubState', { workout: null, ready: { today: { name: '缓存动作单' } } })
  const p = mount(comps.index)
  await p.onShow() // __velaFetch 未注入 = 断网
  assert.equal(p.hubMode, true)
  assert.equal(p.todayName, '缓存动作单')
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
