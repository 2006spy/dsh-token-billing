/**
 * dsh-token-billing — 浏览器 bundle 冒烟测试（零依赖）。
 *
 * 在 Node 里模拟浏览器加载路径：window.__ModuleLoader__.load 收到工厂后，
 * 用 React shim 调用工厂。验证：
 *  - client.js 能完整求值（无顶层语法/引用错误）；
 *  - 工厂正常执行并导出 apply / inject（插槽注册契约）。
 * 不渲染真实 DOM —— 图表/卡片组件仅在 React 环境内定义，运行时错误由
 *  DSH Web 的真实加载路径暴露。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 最小 React shim：任何属性都返回可调用函数（组件仅需 h / hooks 形状）。 */
function reactShim() {
  const callable = () => callable
  return new Proxy(function () {}, {
    get: (target, prop) => {
      if (prop === 'useState') return (v) => [v, callable]
      if (prop === 'useEffect' || prop === 'useRef' || prop === 'useSyncExternalStore') return callable
      if (prop === 'memo') return (c) => c
      if (prop === 'createElement') return () => ({ __shim: true })
      if (prop === Symbol.toPrimitive) return () => 'React'
      return callable
    },
  })
}

/** 收集全局 require 的模块 id（确认只依赖 react）。 */
const required = new Set()
function requireShim(id) {
  required.add(id)
  if (id === 'react') return reactShim()
  throw new Error('bundle 依赖了未知模块：' + id)
}

let factory = null
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      factory = entry.factory
    },
  },
}

// 求值 bundle（严格模式，禁止隐式全局）
new Function('window', '"use strict";' + src)(globalThis.window)

if (typeof factory !== 'function') throw new Error('window.__ModuleLoader__.load 未被调用')

// 工厂内部自建 module/exports，返回值即插件对象
const exported = factory(requireShim)

if (typeof exported.apply !== 'function') throw new Error('exports.apply 不是函数')
if (!Array.isArray(exported.inject)) throw new Error('exports.inject 不是数组')
if (exported.inject.indexOf('slots') < 0) throw new Error('exports.inject 缺少 slots')

console.log('bundle 冒烟测试通过')
console.log('  - bundle 求值 + 工厂执行 OK')
console.log('  - 依赖模块：' + [...required].join(', '))
console.log('  - exports.apply / inject 契约 OK')
