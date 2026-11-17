// 生成手表端的动作名称表 src/js/names.js。
// 数据来源（openGym 把每个档案的状态存在 state-<uid>.json，db.json 只有用户/凭据）：
//   1) <数据目录>\state-*.json 与 db.json —— 你的 routines（要哪些动作 id）与 customEx（自建动作名）
//   2) openGym 前端中文语言包 exercise-names/zh.js —— 内置动作中文名
//   3) openGym 前端目录 exercises-data.js —— 英文名兜底
// 计划变化（增删动作）后重跑：node scripts\build-names.mjs [数据目录]，然后重新打包 rpk。
// 用法：node scripts\build-names.mjs [openGym 数据目录]，或设环境变量 OPENGYM_DATA
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const dataDir = process.argv[2]
  ? resolve(process.argv[2])
  : (process.env.OPENGYM_DATA ? resolve(process.env.OPENGYM_DATA) : null)

// 上游 openGym 的动作名数据已 vendor 进本仓（AGPL-3.0，来源 DuarteSantos8/openGym）
const zhPath = join(appRoot, 'vendor', 'zh.js')
const exdbPath = join(appRoot, 'vendor', 'exercises-data.js')
const outPath = join(appRoot, 'src', 'js', 'names.js')

const zhMod = await import(pathToFileURL(zhPath).href)
const ZH = zhMod.default || {}
const exMod = await import(pathToFileURL(exdbPath).href)
const EXDB = exMod.EXDB || exMod.default || []
const EXMAP = {}
EXDB.forEach(e => { if (e && e.id) EXMAP[e.id] = e.n || e.id })

// 深度遍历每个档案文件：任何包含 routines/customEx 数组的对象都收集（不依赖具体档案层级）
const ids = new Set()
const customs = {}
const walk = v => {
  if (!v || typeof v !== 'object') return
  if (Array.isArray(v)) { v.forEach(walk); return }
  if (Array.isArray(v.routines)) {
    v.routines.forEach(r => (Array.isArray(r && r.ex) ? r.ex : []).forEach(e => {
      if (e && e.id) ids.add(e.id)
    }))
  }
  if (Array.isArray(v.customEx)) {
    v.customEx.forEach(c => { if (c && c.id && c.n) customs[c.id] = c.n })
  }
  Object.values(v).forEach(walk)
}

// db.json（旧版全量数据）+ state-<uid>.json（每个档案的状态）都可能是来源
const files = dataDir && existsSync(dataDir)
  ? readdirSync(dataDir).filter(f => f === 'db.json' || /^state-.*\.json$/.test(f))
  : []

if (!files.length) {
  if (!dataDir) {
    console.log('[!] 未指定 openGym 数据目录：传参数 node scripts\\build-names.mjs <数据目录>，或设环境变量 OPENGYM_DATA。')
    console.log('    数据目录 = openGym 部署的 data\\，应含 db.json 与 state-*.json。')
  } else {
    console.log('[!] 未找到 ' + dataDir + ' 下的 db.json / state-*.json（还没有创建 openGym 档案）。')
    console.log('    请先：网页端登录 openGym → 建档案 → 添加动作单 → 再重跑本脚本。')
  }
  console.log('    现在先写入空表，手表端将显示动作 id 代替名称。')
  writeFileSync(outPath, '// 由 scripts/build-names.mjs 生成；当前无档案数据，重跑即可填充\nexport default {}\n', 'utf8')
  process.exit(0)
}

files.forEach(f => {
  try { walk(JSON.parse(readFileSync(join(dataDir, f), 'utf8'))) }
  catch (e) { console.log('[!] 跳过无法解析的 ' + f + '：' + e.message) }
})

const names = {}
let zhCount = 0
ids.forEach(id => {
  if (customs[id]) { names[id] = customs[id]; return }
  if (ZH[id]) { names[id] = ZH[id]; zhCount++; return }
  names[id] = EXMAP[id] || id
})
Object.entries(customs).forEach(([id, n]) => { names[id] = n })

writeFileSync(outPath, '// 由 scripts/build-names.mjs 生成，勿手改；计划变化后重跑\nexport default ' + JSON.stringify(names) + '\n', 'utf8')

console.log(`[ok] 扫描 ${files.length} 个档案文件，共 ${ids.size} 个动作已写入 names.js（中文名 ${zhCount} 个，自建动作 ${Object.keys(customs).length} 个，其余用英文/ID兜底）`)
if (ids.size === 0) console.log('[!] 档案里还没有任何动作单——先去网页端添加。')
