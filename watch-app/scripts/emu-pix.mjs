/* 模拟器画面像素定位工具（S7 走查坐标校准的确定性来源）：
 * 附着（不重启应用/实例）→ 截一帧 → 解码 PNG → 按指定颜色扫描矩形区域与行段落，
 * 打印浏览器可读的几何中心。用颜色跑段分割，不依赖任何视觉模型的估算。
 * 用法：node scripts\emu-pix.mjs [hexColor ...]   缺省扫描 #ff8a3d（按钮/选中页签）
 * 输出：每种颜色一列矩形（x1,y1,x2,y2,cx,cy）。 */
import { createRequire } from 'module'
import { inflateSync } from 'zlib'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { fileURLToPath } from 'node:url'
// 路径解析（公开版）：APP_ROOT/APP_DIR 指向本仓 watch-app 目录；PKG_ROOT 指向 aiot-toolkit
// 打包工程根（emulator SDK、node_modules、dist 都在里面），环境变量 AIOT_PKG 覆盖。
const APP_ROOT = fileURLToPath(new URL('../', import.meta.url))
const APP_DIR = APP_ROOT.replace(/[\\/]+$/, '')
const PKG_ROOT = process.env.AIOT_PKG || 'F:/Program/GymSets'

const COLORS_RAW = process.argv.slice(2)

const FILE_ARG = process.argv.indexOf('--file')
let buf
if (FILE_ARG >= 0) {
  buf = fs.readFileSync(process.argv[FILE_ARG + 1])
  process.argv.splice(FILE_ARG, 2)
} else {
  const require = createRequire(PKG_ROOT + '/node_modules/@aiot-toolkit/emulator/package.json')
  const { VvdManager } = require('@aiot-toolkit/emulator')
  const mgr = new VvdManager({ sdkHome: path.join(os.homedir(), '.vela', 'sdk') })
  const { getAgent } = await mgr.startVvd({
    vvdName: 'redmi_watch',
    stdoutCallback: () => { }, stderrCallback: () => { }
  })
  const agent = await getAgent()
  await agent.waitForReady()
  await new Promise(r => setTimeout(r, 800))
  buf = Buffer.from(await agent.getScreenshot())
  fs.writeFileSync(APP_ROOT + 'emu-pix-last.png', buf)
}
if (buf.readUInt32BE(0) !== 0x89504e47) { console.log('NOT-PNG'); process.exit(1) }
const COLORS = (COLORS_RAW.length ? COLORS_RAW : ['ff8a3d', '21262d', '161b22']).map(h => [
  parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)
])

// —— 最小 PNG 解码（8bit，RGB/RGBA，无 interlace；模拟器截图足够用）——
let pos = 8
let width = 0, height = 0, bitDepth = 0, colorType = 0
const idat = []
for (;;) {
  const len = buf.readUInt32BE(pos)
  const type = buf.toString('ascii', pos + 4, pos + 8)
  const data = buf.subarray(pos + 8, pos + 8 + len)
  if (type === 'IHDR') {
    width = data.readUInt32BE(0); height = data.readUInt32BE(4)
    bitDepth = data[8]; colorType = data[9]
  } else if (type === 'IDAT') {
    idat.push(data)
  } else if (type === 'IEND') {
    break
  }
  pos += 12 + len
}
const bpp = colorType === 6 ? 4 : (colorType === 2 ? 3 : 1)
const stride = width * bpp
const raw = inflateSync(Buffer.concat(idat))
const out = Buffer.alloc(height * stride)
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)
}
for (let y = 0; y < height; y++) {
  const f = raw[y * (stride + 1)]
  const line = out.subarray(y * stride, (y + 1) * stride)
  const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
  for (let x = 0; x < stride; x++) {
    const v = raw[y * (stride + 1) + 1 + x]
    const a = x >= bpp ? line[x - bpp] : 0
    const b = prev ? prev[x] : 0
    const c = x >= bpp && prev ? prev[x - bpp] : 0
    if (f === 1) line[x] = (v + a) & 255
    else if (f === 2) line[x] = (v + b) & 255
    else if (f === 3) line[x] = (v + ((a + b) >> 1)) & 255
    else if (f === 4) line[x] = (v + paeth(a, b, c)) & 255
    else line[x] = v
  }
}

const px = (x, y) => {
  const o = (y * width + x) * bpp
  // 模拟器帧可能是 BGR 序：按两种序各试一次背景色，用命中的那个（自动判定）
  return [out[o], out[o + 1], out[o + 2]]
}
const close = (p, c, tol) => Math.abs(p[0] - c[0]) <= tol && Math.abs(p[1] - c[1]) <= tol && Math.abs(p[2] - c[2]) <= tol
const closeSwap = (p, c, tol) => Math.abs(p[0] - c[2]) <= tol && Math.abs(p[1] - c[1]) <= tol && Math.abs(p[2] - c[0]) <= tol
let swapped = false
{
  const bg = [13, 17, 23] // 页面底 #0d1117
  let hit = 0, hitSwap = 0
  for (let y = 10; y < height - 10; y += 7) {
    for (let x = 10; x < width - 10; x += 7) {
      const p = px(x, y)
      if (close(p, bg, 6)) hit++
      if (closeSwap(p, bg, 6)) hitSwap++
    }
  }
  swapped = hitSwap > hit
  console.log('bg-order: rgb=' + hit + ' bgr=' + hitSwap + ' => ' + (swapped ? 'BGR' : 'RGB'))
}

console.log('size=' + width + 'x' + height + ' bpp=' + bpp + ' colorType=' + colorType)
// 采样诊断：按可能的位置打点看真实像素值（按钮中心/键中心/页底/页签/文字）
for (const [sx, sy] of [[216, 312], [47, 187], [47, 247], [100, 70], [216, 8], [10, 400], [216, 100], [338, 70], [170, 245]]) {
  console.log('  sample(' + sx + ',' + sy + ') = ' + px(sx, sy).join(','))
}
for (const c of COLORS) {
  const hex = c.map(v => v.toString(16).padStart(2, '0')).join('')
  // 行剖面：每行命中像素数；连续带（count>阈）打印 y 带与 x 范围，参数少、最稳
  const counts = []
  for (let y = 0; y < height; y++) {
    let n = 0
    for (let x = 0; x < width; x++) {
      if (swapped ? closeSwap(px(x, y), c, 14) : close(px(x, y), c, 14)) n++
    }
    counts.push(n)
  }
  const bands = []
  for (let y = 0; y < counts.length; y++) {
    if (counts[y] > 20) {
      const b = bands[bands.length - 1]
      if (b && y - b.y2 <= 2) b.y2 = y
      else bands.push({ y1: y, y2: y })
    }
  }
  console.log('PROFILE #' + hex + ' bands=' + bands.length + ' (minWidth 20)')
  for (const b of bands) {
    // 该带内的 x 范围
    let minX = width, maxX = -1
    for (let y = b.y1; y <= b.y2; y += Math.max(1, Math.floor((b.y2 - b.y1 + 1) / 4))) {
      for (let x = 0; x < width; x++) {
        if (swapped ? closeSwap(px(x, y), c, 14) : close(px(x, y), c, 14)) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
      }
    }
    console.log('  band y ' + b.y1 + '-' + b.y2 + ' cy=' + Math.round((b.y1 + b.y2) / 2) +
      ' x ' + minX + '-' + maxX + ' cx=' + Math.round((minX + maxX) / 2))
  }
  const hex2 = hex
  // 行扫描：找到颜色跑段，纵向合并相邻行构成矩形
  const rows = []
  for (let y = 0; y < height; y++) {
    const runs = []
    let x = 0
    while (x < width) {
      const hit = swapped ? closeSwap(px(x, y), c, 8) : close(px(x, y), c, 8)
      if (hit) {
        let x2 = x
        let h2 = true
        while (h2 && x2 + 1 < width) {
          x2++
          h2 = swapped ? closeSwap(px(x2, y), c, 8) : close(px(x2, y), c, 8)
        }
        if (!h2) x2--
        runs.push([x, x2]); x = x2 + 1
      } else x++
    }
    rows.push(runs)
  }
  // 合并：同一 x 段相邻行归入同矩形
  const rects = []
  for (let y = 0; y < height; y++) {
    for (const [x1, x2] of rows[y]) {
      const r = rects.find(r => !r.done && r.x1 === x1 && r.x2 === x2 && y - r.y2 <= 1)
      if (r) r.y2 = y
      else rects.push({ x1, x2, y1: y, y2: y, done: false })
    }
    for (const r of rects) if (r.y2 < y) r.done = true
  }
  rects.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
  const kept = rects.filter(r => (r.x2 - r.x1) >= 6 && (r.y2 - r.y1) >= 6)
  console.log('COLOR #' + hex + ' rects=' + kept.length)
  for (const r of kept) {
    console.log('  rect x1=' + r.x1 + ' y1=' + r.y1 + ' x2=' + r.x2 + ' y2=' + r.y2 +
      ' cx=' + Math.round((r.x1 + r.x2) / 2) + ' cy=' + Math.round((r.y1 + r.y2) / 2) +
      ' w=' + (r.x2 - r.x1 + 1) + ' h=' + (r.y2 - r.y1 + 1))
  }
}