// 测试用模块解析钩子（见 hooks.mjs）：'@system.*' → 桩模块，无扩展名相对导入 → 补 .js。
// 另补 globalThis.require：快应用引擎有 CommonJS require，Node ESM 没有——store.js 顶层
// require('@system.vibrator') 在测试里否则会静默失败（震动桩无法断言）。
import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)

globalThis.require = specifier => {
  if (specifier === '@system.vibrator') {
    return {
      vibrate(o) { (globalThis.__buzzes = globalThis.__buzzes || []).push((o && o.mode) || 'short') }
    }
  }
  throw new Error('测试环境 require 未支持: ' + specifier)
}
