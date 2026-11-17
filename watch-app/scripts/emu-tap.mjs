/* 交互式附着点按：附着当前实例 → 点按(x,y) → 可选截图（emu-s7-int\ 依次编号）。
 * 用法：node scripts\emu-tap.mjs <x> <y> [tag]   不杀实例、不重启应用。 */
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

const require = createRequire(PKG_ROOT + '/node_modules/@aiot-toolkit/emulator/package.json')
const { VvdManager } = require('@aiot-toolkit/emulator')
const mgr = new VvdManager({ sdkHome: path.join(os.homedir(), '.vela', 'sdk') })
const { getAgent } = await mgr.startVvd({
  vvdName: 'redmi_watch',
  stdoutCallback: () => { }, stderrCallback: () => { }
})
const agent = await getAgent()
await agent.waitForReady()
await new Promise(r => setTimeout(r, 600))

const X = Number(process.argv[2]); const Y = Number(process.argv[3]); const TAG = process.argv[4]
await agent.sendMouse({ x: X, y: Y, buttons: 1 })
await new Promise(r => setTimeout(r, 220))
await agent.sendMouse({ x: X, y: Y, buttons: 0 })
console.log('[tap]', X, Y)
await new Promise(r => setTimeout(r, 900))
if (TAG) {
  fs.mkdirSync(APP_ROOT + 'emu-s7-int', { recursive: true })
  const n = fs.readdirSync(APP_ROOT + 'emu-s7-int').length + 1
  const buf = await agent.getScreenshot()
  fs.writeFileSync(APP_ROOT + 'emu-s7-int/' + String(n).padStart(2, '0') + '-' + TAG + '.png', Buffer.from(buf))
  console.log('[shot]', TAG)
}