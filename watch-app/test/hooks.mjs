// 测试用模块解析钩子：
//   1) '@system.xxx'（快应用特性）→ test/stubs/xxx.mjs 桩模块
//   2) 无扩展名的相对导入（快应用工具链允许，Node ESM 不允许）→ 自动补 .js
const STUBS = new URL('./stubs/', import.meta.url)

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@system.')) {
    return { url: new URL(specifier.slice('@system.'.length) + '.mjs', STUBS).href, shortCircuit: true }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?js(\?|$)/.test(specifier)) {
    try { return await next(specifier, context) }
    catch (e) {
      if (e && e.code === 'ERR_MODULE_NOT_FOUND') return next(specifier + '.js', context)
      throw e
    }
  }
  return next(specifier, context)
}
