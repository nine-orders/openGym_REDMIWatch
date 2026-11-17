/* 检查模拟器状态与截图尺寸 */
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
const { getAgent } = await mgr.startVvd({ vvdName: 'redmi_watch', stdoutCallback: () => {}, stderrCallback: () => {} })
const agent = await getAgent()

const status = await agent.getStatus()
console.log('hardwareConfig =', JSON.stringify(status.hardwareConfig, null, 1))

const buf = Buffer.from(await agent.getScreenshot())
fs.writeFileSync(APP_ROOT + 'emu-status.png', buf)
// PNG 宽高在 IHDR：字节 16-19 宽，20-23 高
console.log('screenshot size =', buf.readUInt32BE(16), 'x', buf.readUInt32BE(20))
