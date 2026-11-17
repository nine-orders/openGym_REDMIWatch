/* 模拟器交互走查：附着已运行的 redmi_watch → 连拍/点击/日志。
 * 用法：node emu-drive.mjs shot [输出目录]          仅连拍 3 张
 *       node emu-drive.mjs tap x y [输出目录]       点击后拍 1 张
 *       node emu-drive.mjs install [输出目录]       重装 rpk + 启动 + 连拍
 *       node emu-drive.mjs log                      打印缓冲日志 */
import { createRequire } from 'module'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'node:url'
// 路径解析（公开版）：APP_ROOT/APP_DIR 指向本仓 watch-app 目录；PKG_ROOT 指向 aiot-toolkit
// 打包工程根（emulator SDK、node_modules、dist 都在里面），环境变量 AIOT_PKG 覆盖。
const APP_ROOT = fileURLToPath(new URL('../', import.meta.url))
const APP_DIR = APP_ROOT.replace(/[\\/]+$/, '')
const PKG_ROOT = process.env.AIOT_PKG || 'F:/Program/GymSets'

const mode = process.argv[2] || 'shot'
const arg3 = process.argv[3]
// 输出目录统一用环境变量 EMU_SHOTS 传，避免与各模式的位置参数打架
const OUT_DIR = process.env.EMU_SHOTS || APP_ROOT + 'emu-shots'
fs.mkdirSync(OUT_DIR, { recursive: true })

const require = createRequire(PKG_ROOT + '/node_modules/@aiot-toolkit/emulator/package.json')
const { VvdManager } = require('@aiot-toolkit/emulator')
const os = require('os')

const RPK = PKG_ROOT + '/dist/ch.duartesantos.opengym.debug.1.0.0.rpk'
const PKG = 'ch.duartesantos.opengym'

const logLines = []
const mgr = new VvdManager({ sdkHome: path.join(os.homedir(), '.vela', 'sdk') })
const { emulatorInstance, getAgent } = await mgr.startVvd({
  vvdName: 'redmi_watch',
  stdoutCallback: line => logLines.push(String(line)),
  stderrCallback: line => logLines.push(String(line))
})
const agent = await getAgent()
// SDK 的 sendMouse/sendTouch 在 connected=false 时静默丢弃，必须先 waitForReady
await agent.waitForReady()
console.log('[emu] grpc ready, connected =', agent.connected)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let n = 0
async function shot(tag) {
  n++
  const buf = await agent.getScreenshot()
  const p = path.join(OUT_DIR, `${String(n).padStart(2, '0')}-${tag}.png`)
  fs.writeFileSync(p, Buffer.from(buf))
  console.log('[shot]', p)
}

if (mode === 'log') {
  console.log(logLines.slice(-120).join('\n'))
} else if (mode === 'seq') {
  // 连续点按：argv[3]="x,y x,y ..."，键位间隔 700ms（等渲染），每点拍一张（胶片排查）+ 结束连拍
  const pts = String(process.argv[3]).split(' ').map(s => s.split(',').map(Number))
  for (const [x, y] of pts) {
    await agent.sendMouse({ x, y, buttons: 1 })
    await sleep(200)
    await agent.sendMouse({ x, y, buttons: 0 })
    console.log('[tap]', x, y)
    await sleep(500)
    await shot('step-' + x + '-' + y)
    await sleep(200)
  }
  await shot('seq1')
  await sleep(1500); await shot('seq2')
} else if (mode === 'flow') {
  // 完整流程：重启应用亮屏 → 等 home 渲染 → 点「开始配对」→ 连拍
  await emulatorInstance.startApp(PKG)
  await sleep(3500)
  await shot('f0-home')
  const x = Number(process.argv[3]); const y = Number(process.argv[4])
  await agent.sendMouse({ x, y, buttons: 1 })
  await sleep(300)
  await agent.sendMouse({ x, y, buttons: 0 })
  console.log('[tap]', x, y)
  await sleep(1200); await shot('f1-tap+1.2s')
  await sleep(2000); await shot('f2-tap+3.2s')
  await sleep(2000); await shot('f3-tap+5.2s')
} else if (mode === 'touch') {
  // sendTouch 序列：identifier=1 按下（pressure>0），随后抬手（空数组）
  // SDK 封装未暴露 sendTouch，直接调底层 grpc client
  const x = Number(process.argv[3]); const y = Number(process.argv[4])
  const down = { touches: [{ x, y, identifier: 1, pressure: 100 }], display: 0 }
  const up = { touches: [], display: 0 }
  await new Promise((res, rej) => agent.client.sendTouch(down, agent.authMate, e => e ? rej(e) : res()))
  await sleep(300)
  await new Promise((res, rej) => agent.client.sendTouch(up, agent.authMate, e => e ? rej(e) : res()))
  console.log('[touch]', x, y)
  await sleep(1500); await shot('touch1-' + x + '-' + y)
  await sleep(2500); await shot('touch2-' + x + '-' + y)
} else if (mode === 'tap') {
  const x = Number(process.argv[3]); const y = Number(process.argv[4])
  const hold = Number(process.argv[6] || 500)
  await agent.sendMouse({ x, y, buttons: 1 })
  await sleep(hold)
  await agent.sendMouse({ x, y, buttons: 0 })
  console.log('[tap]', x, y, 'hold', hold)
  await sleep(1500); await shot('tap1-' + x + '-' + y)
  await sleep(2500); await shot('tap2-' + x + '-' + y)
} else if (mode === 'install') {
  await emulatorInstance.pushAndInstall(RPK, PKG)
  console.log('[emu] install done')
  await emulatorInstance.startApp(PKG)
  await sleep(1500); await shot('t0')
  await sleep(2500); await shot('t4s')
  await sleep(4000); await shot('t8s')
} else {
  await sleep(500); await shot('a')
  await sleep(2000); await shot('b')
  await sleep(3000); await shot('c')
}
console.log('[log tail]')
console.log(logLines.slice(-60).join('\n').slice(-4000))
