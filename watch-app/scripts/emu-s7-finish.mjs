/* S7 真机联调收尾补充证据（第一轮完整走查的中断现场收尾）：
 * 第一轮走查（emu-s6.mjs 0 13，日志 emu-s7-full-*.log）跑完了配对与 12 组记组、进入总结页
 * （截图 01-35 在 emu-s7-2026-11-03T03-32-*），但过程中假 hub 进程死亡 → 事件全部滞留
 * 手表本地队列（离线补投语义被真实现场验证）；随后模拟器实例退出、脚本在总结页卡住被我终止。
 * 本脚本在一台**新实例**上收尾（应用数据在 AVD 磁盘上持久）：
 *   startApp（新实例首启=健康启动）→ 离线打开会话页（本地状态齐全、全部组已记 → 直接总结页）
 *   → 拉起子进程假 hub（随本进程存活，不吃 shell 回收）→ 「结束并同步」→ 队列全量补投
 *   → hub 事件账单应为：2 条上时代滞留 + start + setDone×12 + finish = 16 条，全部 ack。
 * 产物截图 emu-s7-finish\；hub 账单打印在标准输出（并落 <log> 参数指定的文件）。
 * 用法：node scripts\emu-s7-finish.mjs [hubLogPath] */
import { createRequire } from 'module'
import { spawn, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'node:url'
// 路径解析（公开版）：APP_ROOT/APP_DIR 指向本仓 watch-app 目录；PKG_ROOT 指向 aiot-toolkit
// 打包工程根（emulator SDK、node_modules、dist 都在里面），环境变量 AIOT_PKG 覆盖。
const APP_ROOT = fileURLToPath(new URL('../', import.meta.url))
const APP_DIR = APP_ROOT.replace(/[\\/]+$/, '')
const PKG_ROOT = process.env.AIOT_PKG || 'F:/Program/GymSets'

const OUT = APP_ROOT + 'emu-s7-finish'
fs.mkdirSync(OUT, { recursive: true })
const HUB_LOG = process.argv[2] || (APP_ROOT + 'emu-hub-s7-finish-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.log')

const require = createRequire(PKG_ROOT + '/node_modules/@aiot-toolkit/emulator/package.json')
const { VvdManager } = require('@aiot-toolkit/emulator')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 新实例（阿妹旧的退场；START=0 同款清理）
try { execSync('adb emu kill', { stdio: 'ignore' }) } catch (e) { }
try { execSync('taskkill /f /im MuMuNxDevice.exe', { stdio: 'ignore' }) } catch (e) { }
try { execSync('taskkill /f /im qemu-system-armel.exe', { stdio: 'ignore' }) } catch (e) { }
await sleep(6000)

const mgr = new VvdManager({ sdkHome: path.join(os.homedir(), '.vela', 'sdk') })
const { emulatorInstance, getAgent } = await mgr.startVvd({
  vvdName: 'redmi_watch',
  stdoutCallback: () => { },
  stderrCallback: () => { }
})
const agent = await getAgent()
await agent.waitForReady()
console.log('[emu] grpc ready')
let n = 0
async function shot(tag) {
  n++
  const buf = await agent.getScreenshot()
  fs.writeFileSync(path.join(OUT, String(n).padStart(2, '0') + '-' + tag + '.png'), Buffer.from(buf))
  console.log('[shot]', tag)
}
async function tap(x, y, hold, tag) {
  await agent.sendMouse({ x, y, buttons: 1 })
  await sleep(hold || 220)
  await agent.sendMouse({ x, y, buttons: 0 })
  console.log('[tap]', x, y)
  await sleep(650)
  if (tag) await shot(tag)
}

// 新实例首启（健康；此时假 hub 未起 = 离线现场）
await emulatorInstance.startApp('ch.duartesantos.opengym')
await sleep(5000)
await shot('00-home')
await tap(216, 332, 220)          // 开始训练 → session2（离线路径：本地状态齐全 → 总结页）
await sleep(4000)
await shot('01-summary')          // 期待：训练完成总结页（9 组 · 2360 kg · PR：卧推）

// 拉起假 hub（子进程，本进程存活期间必活）并等端口就绪
const hubFd = fs.openSync(HUB_LOG, 'a')
const hub = spawn(process.execPath, ['scripts/emu-hub.mjs', '73012598'], {
  cwd: APP_DIR,
  stdio: ['ignore', hubFd, hubFd]
})
for (let i = 0; i < 20; i++) {
  try {
    const r = await fetch('http://127.0.0.1:8765/spike')
    if (r.ok) break
  } catch (e) { }
  await sleep(400)
}
console.log('[hub] up, log = ' + HUB_LOG)

// 「结束并同步」→ end() + flush：start/setDone×12/finish（含上时代 2 条滞留）一路补投
await tap(216, 390, 220, '02-sent')
await sleep(3000)
await shot('03-final')            // 期待：已发到手机 ✓

await sleep(500)
hub.kill()
fs.closeSync(hubFd)

const lines = fs.readFileSync(HUB_LOG, 'utf8').split('\n')
const events = lines.filter(l => l.includes('[emu-hub] EVENT '))
const acks = lines.filter(l => l.includes('[emu-hub] ACK '))
const ackIds = []
for (const l of acks) {
  const m = l.match(/ACK (\[.*\])$/)
  if (m) { try { ackIds.push(...JSON.parse(m[1])) } catch (e) { } }
}
console.log('[bill] EVENT lines = ' + events.length + ', ACK lines = ' + acks.length +
  ', unique acked ids = ' + new Set(ackIds).size)
for (const l of events) console.log(l.replace('[emu-hub] EVENT ', 'EVENT '))
console.log('[done]')