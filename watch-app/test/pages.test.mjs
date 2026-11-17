// 四个页面的静态验证：脚本能独立加载（语法 + 导入名），模板绑定的每个事件处理都存在，
// 每个跳转 uri 都在 manifest 里登记——防止路径错位（entry/uri 对不上）这类编译期才发现的问题。
import './register.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', 'src')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'))
const PAGES = [['pages/index', 'index'], ['pages/pair', 'pair'], ['pages/pick', 'pick'], ['pages/session', 'session'], ['pages/session2', 'session2'], ['pages/spike', 'spike']]

for (const [key, file] of PAGES) {
  test('页面 ' + key + '：脚本可加载、事件绑定与跳转目标都有落点', async () => {
    const raw = fs.readFileSync(path.join(SRC, key, file + '.ux'), 'utf8')
    const sm = /<script>([\s\S]*?)<\/script>/.exec(raw)
    assert.ok(sm, '没有 script 块')

    // 生成模块放在 test/.gen/ 下；.ux 里 '../../js/x' 以 src/pages/<p>/ 为基准，
    // 从 .gen/<p>/ 出发要再上两级才能到 src/js/。
    const genDir = path.join(HERE, '.gen', key)
    fs.mkdirSync(genDir, { recursive: true })
    const genFile = path.join(genDir, file + '.mjs')
    fs.writeFileSync(genFile, sm[1].replace(/\.\.\/\.\.\/js\//g, '../../../../src/js/'))

    const mod = await import('./.gen/' + key + '/' + file + '.mjs')
    const comp = mod.default
    assert.ok(comp && typeof comp === 'object')

    // 模板里绑定的每个事件处理都必须是组件方法
    const handlers = new Set()
    for (const m of raw.matchAll(/on(?:click|change|select|longpress)="([A-Za-z_$][\w$]*)/g)) handlers.add(m[1])
    for (const h of handlers) assert.equal(typeof comp[h], 'function', '缺事件处理函数: ' + h)

    // 页面里每个跳转 uri 都必须是 manifest 登记的页面
    for (const m of sm[1].matchAll(/uri:\s*'\/?([\w/]+)'/g)) {
      assert.ok(MANIFEST.router.pages[m[1]], '跳转目标未登记: ' + m[1])
    }
    // manifest 自身：entry 必须是已登记页面，页面文件必须真实存在
    assert.ok(MANIFEST.router.pages[MANIFEST.router.entry], 'entry 未登记: ' + MANIFEST.router.entry)
    for (const [k, v] of Object.entries(MANIFEST.router.pages)) {
      assert.ok(fs.existsSync(path.join(SRC, k, v.component + '.ux')), '页面文件缺失: ' + k + '/' + v.component)
    }
  })
}
