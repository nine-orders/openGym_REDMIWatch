/* S7 修复版走查（单进程全包，S6-evidence/SUMMARY 的问题全部对症）：
 *   a) 组参数按 emu-hub 快照的真实计划操作：卧推工作组从 20×8 调到 40×10（+2.5×8、+1×2），
 *      其余动作的计划值与预填一致、不需调；
 *   b) 步进错位根因：单侧行 0 两侧都完成后会进 5s 休息页（快照 restSec:5 遍历所有 set 间），
 *      旧脚本把它当「不休息直接轮到行 1」→ 修正为统一「每完成一个休息点 sleep 6.2s 等自然
 *      结束」；跳过演示放在帮推组还顺路测了「圆点找回」；
 *   c) 「等页面就绪」轮询：静态页（配对页/主页/总结页）转换后 waitStable() 用两帧字节相同
 *      判定就绪；训练页时钟每秒跳、休息页倒计时每秒跳，无法用帧稳定判定，用固定时延
 *      （restSec=5 → 6.2s）+ 逐步截屏人工复核；
 *   d) 每组完成都有防抖（700ms），连续点按两处之间 sleep 750ms。
 * 事件账单目标：start → setDone×12（卧推 1 热身+3 工作、分腿蹲 L/R×2 行、引体、划船、
 *   跳绳、平板）→ finish == 14 条全部 ack；总结页应为 9 组 · 2360 kg · PR：卧推。
 * 旧坑保留：杀旧实例→装包→且仅一次 startApp；每个实例只启用一次（见 S6 文档）。
 * 用法：node scripts\emu-s6.mjs [起始步骤号]   步骤 0 之外从现场续跑（不再杀实例重装）。
 * 产物：emu-s7-<时间戳>\（逐步骤截图）。事件账单另看 emu-hub 控制台输出。 */
import { createRequire } from 'module'
import { execSync, spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'node:url'
// 路径解析（公开版）：APP_ROOT/APP_DIR 指向本仓 watch-app 目录；PKG_ROOT 指向 aiot-toolkit
// 打包工程根（emulator SDK、node_modules、dist 都在里面），环境变量 AIOT_PKG 覆盖。
const APP_ROOT = fileURLToPath(new URL('../', import.meta.url))
const APP_DIR = APP_ROOT.replace(/[\\/]+$/, '')
const PKG_ROOT = process.env.AIOT_PKG || 'F:/Program/GymSets'

const OUT = APP_ROOT + 'emu-s8-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
fs.mkdirSync(OUT, { recursive: true })
const START = Number(process.argv[2] || 0)
const HUB_LOG = APP_ROOT + 'emu-hub-s8-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.log'

const require = createRequire(PKG_ROOT + '/node_modules/@aiot-toolkit/emulator/package.json')
const { VvdManager } = require('@aiot-toolkit/emulator')
const RPK = PKG_ROOT + '/dist/ch.duartesantos.opengym.debug.1.0.0.rpk'
const PKG = 'ch.duartesantos.opengym'
const logLines = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

if (START === 0) {
  // 杀旧实例（MuMuNxDevice 是 Vela 模拟器某版的运行时包装，qemu-system-armel 是底层；没有就算了）
  try { execSync('adb emu kill', { stdio: 'ignore' }) } catch (e) { }
  try { execSync('taskkill /f /im MuMuNxDevice.exe', { stdio: 'ignore' }) } catch (e) { }
  try { execSync('taskkill /f /im qemu-system-armel.exe', { stdio: 'ignore' }) } catch (e) { }
  await sleep(6000)
}
const mgr = new VvdManager({ sdkHome: path.join(os.homedir(), '.vela', 'sdk') })
const { emulatorInstance, getAgent } = await mgr.startVvd({
  vvdName: 'redmi_watch',
  stdoutCallback: l => logLines.push(String(l)),
  stderrCallback: l => logLines.push(String(l))
})
const agent = await getAgent()
await agent.waitForReady()
console.log('[emu] grpc ready')
// 假 hub 作为本脚本子进程（不吃 shell 回收，随走查全程存活）；端口就绪后才往下走
let hub = null
let hubFd = null
if (START === 0) {
  hubFd = fs.openSync(HUB_LOG, 'a')
  hub = spawn(process.execPath, ['scripts/emu-hub.mjs', '73012598'], {
    cwd: APP_DIR,
    stdio: ['ignore', hubFd, hubFd]
  })
  for (let i = 0; i < 25; i++) {
    try {
      const r = await fetch('http://127.0.0.1:8765/spike')
      if (r.ok) break
    } catch (e) { }
    await sleep(400)
  }
  console.log('[hub] up, log = ' + HUB_LOG)
}
let n = 0
async function shot(tag) {
  n++
  let buf = null
  for (let t = 0; t < 3; t++) {
    try {
      buf = await Promise.race([
        agent.getScreenshot(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('shot timeout')), 15000))
      ])
      break
    } catch (e) {
      console.log('[shot-retry]', tag, 'err=', e.message)
      await sleep(800)
    }
  }
  if (!buf) throw new Error('getScreenshot failed for ' + tag + ' (grpc/emu gone)')
  fs.writeFileSync(path.join(OUT, String(n).padStart(2, '0') + '-' + tag + '.png'), Buffer.from(buf))
  console.log('[shot]', tag)
}
async function tap(x, y, hold, tag) {
  await agent.sendMouse({ x, y, buttons: 1 })
  await sleep(hold || 220)
  await agent.sendMouse({ x, y, buttons: 0 })
  console.log('[tap]', x, y, hold || 220)
  await sleep(650)
  if (tag) await shot(tag)
}
// 「等页面就绪」轮询：两帧截图字节相同 = 页面静止（静态页可用；时钟/倒计时页不可用，见头注）
async function waitStable(tag, tries, gap) {
  tries = tries || 25
  gap = gap || 400
  let prev = null
  for (let i = 0; i < tries; i++) {
    const buf = Buffer.from(await agent.getScreenshot())
    if (prev && buf.equals(prev)) {
      console.log('[stable]', tag, 'after', Math.round(i * gap), 'ms')
      return true
    }
    prev = buf
    await sleep(gap)
  }
  console.log('[stable] TIMEOUT', tag)
  return false
}
// 点按并确认画面相对 baseline 发生了变化（导航真的发生了）
async function grabShot() {
  return await Promise.race([
    agent.getScreenshot(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('shot timeout')), 15000))
  ])
}
async function tapNav(x, y, tag) {
  const base = await grabShot()
  await agent.sendMouse({ x, y, buttons: 1 })
  await sleep(220)
  await agent.sendMouse({ x, y, buttons: 0 })
  console.log('[nav]', x, y)
  let changed = false
  for (let i = 0; i < 10; i++) {
    await sleep(400)
    const buf = await grabShot()
    if (!buf.equals(base)) { changed = true; break }
  }
  console.log('[nav] changed=', changed)
  if (tag) await shot(tag)
  return changed
}
if (START === 0) {
  // 新实例装包（不启动）→ 唯一一次 startApp（首启健康，点按可用）
  await emulatorInstance.pushAndInstall(RPK, PKG)
  console.log('[emu] install done')
  await sleep(1500)
  await emulatorInstance.startApp(PKG)
  await sleep(4000)
}

// —— 步骤表（emu-hub 全家桶快照的真实计划：卧推[热身20×8+3×40×10] → 分腿蹲[单侧 20×10 ×2行]
//     → 引体[自重8]+划船[30×12]超级组 → 跳绳[有氧] → 平板[计时40s]；全程 restSec=5 ——
// 每完成一个「休息点」sleep 6.2s 等休息自然结束（时钟跳秒所以不用 waitStable）。
const steps = [
  async () => {  // 0 进配对页（幂等：未配对走「开始配对」，已配对走「配对设置」）并截图供坐标校准
    await shot('00-wake')
    await waitStable('home')                       // 主页（静态）
    await shot('01-home')
    let ok = await tapNav(194, 236, null)          // 未配对：卡片「开始配对」（压缩后实测中心）
    if (!ok) ok = await tapNav(317, 450, null)     // 已配对：row2「配对设置」（压缩后约 y 450，待实测复核）
    if (!ok) console.log('[WARN] pair entry taps did not navigate')
    await waitStable('pair')
    await shot('02-pair')
  },
  async () => {  // 1 配对（S7 pair.ux 像素实测：键行0 y174 行1 y222、行0键心 x50/112/174/236/298/360、
    // 行1 host 六键同 x，行1 code 四键 x50/112/174/236；页签 y71：配对码(228) 清空(374)；配对钮(216,284)）
    await tap(374, 71, 220)                        // 服务器页「清空」（清掉旧预填值）
    // host 键盘注意：服务器页首行是 1-6、二行 7 8 9 0 . :（「0」在二行 x236）
    for (const [x, y] of [[50, 174], [236, 222], [298, 222], [236, 222], [298, 222], [112, 174], [298, 222], [112, 174]]) {
      await tap(x, y, 180)                         // 1 0 . 0 . 2 . 2
    }
    await shot('03-host')
    await tap(228, 71, 220)                        // 「配对码」页签
    await tap(374, 71, 220)                        // 清空
    for (const [x, y] of [[112, 222], [236, 174], [50, 174], [112, 174], [174, 174], [360, 174], [236, 222], [174, 222]]) {
      await tap(x, y, 180)                         // 7 3 0 1 2 5 9 8
    }
    await shot('04-code')
    await tap(216, 284, 220)                       // 配对并拉取快照 → 1.2s 自动回主页
    await sleep(2200)
    await shot('05-pairDone')
    await tap(216, 397, 220)                       // 开始训练（S7 压缩后 btn-main 实测中心）→ session2
    await sleep(2000)
    await shot('06-session')
  },
  // 1 完成热身组（20×8 预填即是计划值）→ 休息 5s
  async () => { await tap(216, 370, 220, '10-rest'); await sleep(6200); await shot('11-work1') },
  // 2 工作组1：重量 20→40（+2.5×8）、次数 8→10（+1×2）→ 完成 → 休息
  // （S8 加固：休息页转训练页后「首次交互」会被页面重渲染吞掉——先按一记中性键吸收它，
  //   再步进；两拍间距 ~1.15s 远离 700ms 防抖。三轮实测每次恰丢一拍，此修法双态皆稳）
  async () => {
    await tap(216, 130, 120)                                    // 中性一按：动作名区域，无副作用
    for (let i = 0; i < 8; i++) { await tap(343, 209, 200); await sleep(300) }   // +2.5（重量步进行，像素实测）
    for (let i = 0; i < 2; i++) { await tap(352, 307, 200); await sleep(300) }   // +1（次数步进行，像素实测）
    await shot('12-set40')
    await tap(216, 370, 220, '13-rest')
    await sleep(6200)
    await shot('14-work2')
  },
  // 3 工作组2：跳过两段确认 → ✕
  async () => {
    await tap(216, 452, 220, '15-skip1')                   // 跳过这组（行3 中键，像素实测）
    await tap(216, 452, 220, '16-skipped')
  },
  // 4 点被跳圆点找回（idx2，圆点行 y118 心距 38）→ 完成（预填 40×10）→ 休息
  async () => {
    await tap(112, 118, 220, '17-dotBack')
    await tap(216, 370, 220, '18-rest')
    await sleep(6200)
    await shot('19-work3')
  },
  // 5 工作组3：完成（预填 40×10；卧推完）→ 休息
  async () => {
    await tap(216, 370, 220, '20-rest')
    await sleep(6200)
    await shot('21-side')
  },
  // 6 分腿蹲行0：完成左侧 → 隔 750ms 完成右侧（防抖跨过）→ 休息 5s
  async () => {
    await tap(115, 370, 220, '22-L')
    await sleep(750)
    await tap(317, 370, 220, '23-R')
    await sleep(6200)
    await shot('24-side2')
  },
  // 7 分腿蹲行1：完成左侧 → 右侧 → 休息
  async () => {
    await tap(115, 370, 220, '25-L')
    await sleep(750)
    await tap(317, 370, 220, '26-R')
    await sleep(6200)
    await shot('27-superset')
  },
  // 8 引体：自重 8（预填），完成 → 超级组直切划船（无休息）
  async () => { await tap(216, 370, 220, '28-turn'); await sleep(1200); await shot('29-row') },
  // 9 划船：30×12（预填），完成 → 一轮完了休息 5s
  async () => { await tap(216, 370, 220, '30-roundRest'); await sleep(6200); await shot('31-cardio') },
  // 10 跳绳（有氧：无数值区布局上移，完成键 S6 实测中心 ~287）：完成 → 休息
  async () => { await tap(216, 287, 220, '32-cardioRest'); await sleep(6200); await shot('33-timed') },
  // 11 平板支撑（计时 sec:40 预填）：完成 → 总结页
  async () => { await tap(216, 370, 220, '34-summary'); await sleep(1200); await shot('35-summary') },
  // 12 总结页（静态）：截图核对口径 → 结束并同步 → 「已发到手机 ✓」
  // （S8 加固：点后帧比对，「未送达」未翻牌就再点重试同步，直至翻牌或 3 次）
  async () => {
    await waitStable('summary')
    await shot('36-summary2')
    let base = Buffer.from(await agent.getScreenshot())
    let tries = 0
    while (tries < 3) {
      await tap(216, 390, 220)
      await sleep(2500)
      const cur = Buffer.from(await agent.getScreenshot())
      if (!cur.equals(base)) break                  // UI 翻牌（✓ 或按钮态变化）
      tries++
      console.log('[retry-sync] unchanged, attempt ' + tries)
    }
    await sleep(1500)
    await shot('37-sent' + (tries ? '-' + tries : ''))
    await sleep(2000)
    await shot('38-final')
  }
]
const MAX = Number(process.argv[3] || steps.length)
for (let i = START; i < Math.min(steps.length, MAX); i++) {
  console.log('[step]', i)
  await steps[i]()
}
console.log('[log tail]')
console.log(logLines.slice(-40).join('\n').slice(-2000))
// 收尾：杀掉随走的假 hub，并把它的账单打出来（EVENT/ACK 行数 + 唯一 ack id 数）
if (hub) {
  try { hub.kill() } catch (e) { }
  try { fs.closeSync(hubFd) } catch (e) { }
  const lines = fs.readFileSync(HUB_LOG, 'utf8').split('\n')
  const events = lines.filter(l => l.includes('[emu-hub] EVENT '))
  const acks = lines.filter(l => l.includes('[emu-hub] ACK '))
  const ackIds = []
  for (const l of acks) {
    const m = l.match(/ACK (\[.*\])$/)
    if (m) { try { ackIds.push(...JSON.parse(m[1])) } catch (e) { } }
  }
  console.log('[bill] EVENT lines = ' + events.length + ', ACK lines = ' + acks.length +
    ', unique acked ids = ' + new Set(ackIds).size + ', hub log = ' + HUB_LOG)
  for (const l of events) console.log(l.replace('[emu-hub] ', ''))
}