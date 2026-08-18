/**
 * 复现「费用行」链路：createTokenBillingProjectionParts → view 输出 providerPrices，
 * 再模拟 client.js 的 readSelectedModel/findPrice 匹配，定位"有的模型不显示价格"。
 * 运行：node tests/view-findprice-test.mjs
 */
import {
  createTokenBillingProjectionParts,
  resolveBillingSpec,
  applyProviderPrices,
} from '../lib/projection.js'
import { loadPiAiProvider, listPiAiProviders, piAiDataDir } from '../lib/prices.js'

let pass = 0
let fail = 0
const log = (ok, msg) => {
  console.log((ok ? '✅ ' : '❌ ') + msg)
  ok ? pass++ : fail++
}

// client.js 的 normalizeModel / findPrice（原样抄来）
function normalizeModel(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '')
}
function findPrice(modelLabel, prices) {
  if (!modelLabel || !prices || prices.length === 0) return null
  var label = normalizeModel(modelLabel)
  for (var i = 0; i < prices.length; i++) {
    var key = normalizeModel(prices[i].model)
    if (label === key || label.indexOf(key) >= 0 || key.indexOf(label) >= 0) return prices[i]
  }
  return null
}

// 模拟 index.js attach：resovleSpec + 装配所有 pi-ai provider
const spec = resolveBillingSpec({})
for (const provider of listPiAiProviders(piAiDataDir())) {
  applyProviderPrices(spec, provider, loadPiAiProvider(provider, piAiDataDir()))
}
const parts = createTokenBillingProjectionParts(spec)
const state = parts.init()
const view = parts.view(state)
const providerPrices = view.providerPrices || []

log(Array.isArray(providerPrices) && providerPrices.length > 0,
  `view.providerPrices 长度 = ${providerPrices.length}（应为 >0）`)

const og = providerPrices.filter((p) => p.provider === 'opencode-go')
log(og.length > 0, `open code-go provider 条目 = ${og.length}`)
const ogModels = og.map((p) => p.model)
log(ogModels.includes('mimo-v2.5'), `providerPrices 含 mimo-v2.5: ${ogModels.includes('mimo-v2.5')}`)
log(ogModels.includes('glm-5.1'), `providerPrices 含 glm-5.1: ${ogModels.includes('glm-5.1')}`)

// 模拟费用行：selectedModel 来自 DOM（可能是 id / 人性名 / 大小写混合）
const cases = [
  // [传入的显示名, 期望命中的模型 id]
  ['mimo-v2.5', 'mimo-v2.5'],
  ['MiMo V2.5', 'mimo-v2.5'],
  ['mimo v2.5', 'mimo-v2.5'],
  ['deepseek-v4-flash', 'deepseek-v4-flash'],
  ['DeepSeek-V4-Flash', 'deepseek-v4-flash'],
  ['glm-5.1', 'glm-5.1'],
  ['kimi-k2.6', 'kimi-k2.6'],
  ['qwen3.7-max', 'qwen3.7-max'],
  ['不存在-模型-xyz', null],
]
for (const [label, expected] of cases) {
  const hit = findPrice(label, og)
  const ok = expected === null ? hit === null : (hit !== null && hit.model === expected)
  log(ok, `findPrice("${label}") → ${hit ? hit.model : '(null)'}（期望 ${expected}）`)
}

// 模拟 readSelectedModel 解析的典型 aria-label
function readSelectedFromAria(aria) {
  const m = /当前(?:\s*模型)?\s*([^，,]+)/.exec(aria)
  if (m === null) return ''
  return m[1].trim().replace(/^模型\s*/, '')
}
const ariaCases = [
  ['选择模型 当前模型 MiMo V2.5', 'mimo-v2.5'],
  ['选择模型 当前 DeepSeek-V4-Flash', 'deepseek-v4-flash'],
  ['当前模型 GLM-5.1', 'glm-5.1'],
]
for (const [aria, expected] of ariaCases) {
  const name = readSelectedFromAria(aria)
  const hit = findPrice(name, og)
  const ok = hit !== null && hit.model === expected
  log(ok, `aria("${aria}") → "${name}" → ${hit ? hit.model : '(null)'}（期望 ${expected}）`)
}

console.log(`\n费用行链路验证：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail > 0 ? 1 : 0
