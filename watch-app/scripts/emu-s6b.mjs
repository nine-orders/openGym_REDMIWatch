/* S6 手测续跑（一次性）：从「保加利亚 row1 两侧未记」的现场接下去，专补
 * 超级组轮转之后的链条：有氧（compact 布局坐标）→ 计时记秒 → 总结 PR → 同步。
 * 不杀实例、不重启应用（startApp 是第二次重启会进坏状态）；附着 + 点按 + 截屏。
 * 用法：node scripts\emu-s6b.mjs   （前提：emu-hub 在跑，应用停在训练页） */
import { createRequire } from 'module'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'node:url'
// 路径解析（公开版）：APP_ROOT/APP_DIR 指向本仓 watch-app 目录；PKG_ROOT 指向 aiot-toolkit
// 打包工程根（emulator SDK、node_modules、dist 都在里面），环境变量 AIOT_PKG 覆盖。
const APP_ROOT = fileURLToPath(new URL('../', import.meta.url))
const APP_DIR = APP_ROOT.replace(/[\\/]+$/, '')
const PKG_ROOT = process.env.AIOT_PKG || 'F:/Program/GymSets'

const OUT = APP_ROOT + 'emu-s6b'
fs.mkdirSync(OUT, { recursive: true })

const require = createRequire(PKG_ROOT + '/node_modules/@aiot-toolkit/emulator/package.json')
const { VvdManager } = require('@aiot-toolkit/emulator')
const mgr = new VvdManager({ sdkHome: path.join(os.homedir(), '.vela', 'sdk') })
const { getAgent } = await mgr.startVvd({
  vvdName: 'redmi_watch',
  stdoutCallback: () => { },
  stderrCallback: () => { }
})
const agent = await getAgent()
await agent.waitForReady()
console.log('[emu] grpc ready')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let n = 0
async function shot(tag) {
  n++
  const buf = await agent.getScreenshot()
  fs.writeFileSync(path.join(OUT, String(n).padStart(2, '0') + '-' + tag + '.png'), Buffer.from(buf))
  console.log('[shot]', tag)
}
async function tap(x, y, tag) {
  await agent.sendMouse({ x, y, buttons: 1 })
  await sleep(220)
  await agent.sendMouse({ x, y, buttons: 0 })
  console.log('[tap]', x, y)
  await sleep(650)
  if (tag) await shot(tag)
}

await shot('00-state')                     // 现场确认：保加利亚 row1 双侧未记
// 完成两侧（隔开 700ms 防抖）
await tap(115, 362, '01-L')
await sleep(750)
await tap(317, 362, '02-R')                // 两侧完成 → 动作完 → 休息 5s
await sleep(6200)
await shot('03-superset')                  // 引体向上（超级组标签）
await tap(216, 362, '04-turn')             // 完成 → 直接划船（无休息）
await tap(216, 362, '05-roundRest')        // 完成 → 一轮完才休息
await sleep(6200)
await shot('06-cardio')                    // 跳绳（无数值区 + 提示）
await tap(216, 287, '07-cardioRest')       // 有氧页完成键实测中心 ~287
await sleep(6200)
await shot('08-timed')                     // 平板支撑（秒数 stepper）
await tap(216, 362, '09-summary')          // 完成 → 总结（PR：卧推）
await tap(216, 390, '10-sent')             // 结束并同步（实测中心 ~390）→ 已发到手机 ✓
console.log('[done]')
