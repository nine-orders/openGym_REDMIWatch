// build-names.mjs：扫描 state-*.json（档案真身）、中文名与自建名兜底、无数据时写空表。
// 运行前后保存/还原 names.js，测试产物不污染真实生成物。
import './register.mjs'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const EXDB_MOD = await import('../vendor/exercises-data.js')
const ZH_MOD = await import('../vendor/zh.js')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const SCRIPT = path.join(APP, 'scripts', 'build-names.mjs')
const NAMES = path.join(APP, 'src', 'js', 'names.js')
const EXDB = EXDB_MOD.EXDB || EXDB_MOD.default || []
const ZH = ZH_MOD.default || {}

let original
before(() => { original = fs.readFileSync(NAMES, 'utf8') })
after(() => { fs.writeFileSync(NAMES, original) })

const readNames = () => {
  const src = fs.readFileSync(NAMES, 'utf8')
  return JSON.parse(src.slice(src.indexOf('export default') + 'export default'.length).trim())
}

test('build-names：state-*.json 提供动作 id，zh 语言包与自建名兜底', () => {
  const withZh = EXDB.find(e => e && e.id && ZH[e.id])
  assert.ok(withZh, '语言包里至少应有一个内置动作（测试数据自检）')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-names-'))
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'u1' }] })) // db.json 里没有 routines
  fs.writeFileSync(path.join(dir, 'state-u1.json'), JSON.stringify({
    routines: [{ id: 'r1', name: 'x', ex: [{ id: withZh.id, sets: 3, reps: 10, weight: 20 }, { id: 'c9', sets: 3, reps: 12 }] }],
    customEx: [{ id: 'c9', n: '自建测试动作' }]
  }))

  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' })
  assert.equal(r.status, 0, '脚本退出码非 0：' + (r.stderr || r.stdout))
  const names = readNames()
  assert.equal(names[withZh.id], ZH[withZh.id])
  assert.equal(names.c9, '自建测试动作')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('build-names：空数据目录写空表并正常退出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-names-empty-'))
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  assert.match(fs.readFileSync(NAMES, 'utf8'), /export default \{\}/)
  fs.rmSync(dir, { recursive: true, force: true })
})
