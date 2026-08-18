/**
 * 验证「按 provider 动态定价」：
 *  - priceAt(provider, model, spec, atMs) 的优先级（overrides > provider 表 > 全局表 > fallback）
 *  - pi-ai 本地价格自动兜底（provider:model）
 *  - fx 折算（USD → 人民币）
 *  - 向后兼容：providerPriceUrls='{}' 时行为与改造前一致
 * 运行：node tests/provider-pricing-test.mjs
 */
import {
  priceAt,
  resolveBillingSpec,
  applyProviderPrices,
  applyFetchedPrices,
  parseProviderUrlMap,
} from '../lib/projection.js'
import { loadPiAiProvider, listPiAiProviders, piAiDataDir } from '../lib/prices.js'

const NOW = Date.UTC(2026, 7, 18, 5, 0, 0)
let pass = 0
let fail = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error('❌ ' + msg)
    fail++
  } else {
    console.log('✅ ' + msg)
    pass++
  }
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps
// 无 fx 折算的 spec，便于断言美元原始价
const plainSpec = (extra = {}) => resolveBillingSpec({ fxEnabled: false, ...extra })

// 1) pi-ai 兜底：opencode-go / mimo-v2.5 → 0.14/0.28/0.0028/0（非 fallback 2/8）
const spec = plainSpec()
applyProviderPrices(spec, 'opencode-go', loadPiAiProvider('opencode-go', piAiDataDir()))
const mimo = priceAt('opencode-go', 'mimo-v2.5', spec, NOW)
assert(close(mimo.input, 0.14) && close(mimo.output, 0.28) && close(mimo.cacheRead, 0.0028) && close(mimo.cacheWrite, 0),
  `pi-ai 兜底 mimo-v2.5 = ${mimo.input}/${mimo.output}/${mimo.cacheRead}/${mimo.cacheWrite}（应为 0.14/0.28/0.0028/0，currency=${mimo.currency}）`)

// 2) 无 provider → 回落 fallback，而不是 provider 价
const noProv = priceAt('', 'mimo-v2.5', spec, NOW)
assert(close(noProv.input, 2) && close(noProv.output, 8), `无 provider 回落 fallback（${noProv.input}/${noProv.output}）`)

// 3) provider 优先级：qwen3.7-max @opencode-go = 2.5/7.5/0.5/3.125
const qwen = priceAt('opencode-go', 'qwen3.7-max', spec, NOW)
assert(close(qwen.input, 2.5) && close(qwen.output, 7.5) && close(qwen.cacheWrite, 3.125),
  `qwen3.7-max @opencode-go = ${qwen.input}/${qwen.output}/${qwen.cacheWrite}（应为 2.5/7.5/3.125）`)

// 4) 不同 provider 同名模型各按各的价格表，互不影响
applyProviderPrices(spec, 'deepseek', loadPiAiProvider('deepseek', piAiDataDir()))
const dsFlash = priceAt('deepseek', 'deepseek-v4-flash', spec, NOW)
const ogFlash = priceAt('opencode-go', 'deepseek-v4-flash', spec, NOW)
assert(close(dsFlash.input, 0.14) && close(dsFlash.input, ogFlash.input),
  `deepseek-v4-flash 双 provider 各自计价（deepseek=${dsFlash.input}，opencode-go=${ogFlash.input}）`)

// 5) 用户全局覆盖最高（钉死，不随 provider 变）
const specOv = resolveBillingSpec({ fxEnabled: false, prices: JSON.stringify({ 'mimo-v2.5': { input: 99, output: 99, cacheRead: 9, cacheWrite: 9 } }) })
applyProviderPrices(specOv, 'opencode-go', loadPiAiProvider('opencode-go', piAiDataDir()))
const ov = priceAt('opencode-go', 'mimo-v2.5', specOv, NOW)
assert(close(ov.input, 99) && close(ov.output, 99), `用户覆盖优先于 provider 价（${ov.input}/${ov.output}）`)

// 6) fx 折算：USD 价 ×7.2 → ¥
const specFx = resolveBillingSpec({ fxEnabled: true, fxRate: 7.2, currency: '¥' })
applyProviderPrices(specFx, 'opencode-go', loadPiAiProvider('opencode-go', piAiDataDir()))
const fx = priceAt('opencode-go', 'mimo-v2.5', specFx, NOW)
assert(close(fx.input, 0.14 * 7.2) && close(fx.output, 0.28 * 7.2) && fx.currency === '¥',
  `fx 折算 mimo-v2.5 = ¥${fx.input}/${fx.output}（应为 1.008/2.016，currency=${fx.currency}）`)

// 7) parseProviderUrlMap：解析 / 空 / 坏 JSON
const parsed = parseProviderUrlMap('{"opencode-go":"https://x","deepseek":"https://y"}')
assert(typeof parsed['opencode-go'] === 'string' && typeof parsed.deepseek === 'string', 'parseProviderUrlMap 解析 {opencode-go,deepseek}')
assert(Object.keys(parseProviderUrlMap('{}')).length === 0 && Object.keys(parseProviderUrlMap('')).length === 0, 'parseProviderUrlMap 空串/{} → {}')
let threw = false
try { parseProviderUrlMap('{bad') } catch { threw = true }
assert(threw, 'parseProviderUrlMap 坏 JSON 抛错')

// 8) applyFetchedPrices 向后兼容：provider 缺省时走全局表（与改造前一致）
const after = applyFetchedPrices(resolveBillingSpec({ fxEnabled: false }), { currency: 'USD', flat: { 'mimo-v2.5': { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02 } }, peak: null }, NOW)
assert(close(after.prices['mimo-v2.5'].input, 0.1), `applyFetchedPrices 无 provider → 全局表（${after.prices['mimo-v2.5'].input}）`)

// 9) applyFetchedPrices 带 provider → 写入 provider 表而非全局
const specP = resolveBillingSpec({ fxEnabled: false })
applyFetchedPrices(specP, { currency: 'USD', flat: { 'custom-model': { input: 5, output: 6, cacheRead: 0.5, cacheWrite: 1 } }, peak: null }, NOW, 'opencode-go')
assert(close(specP.providerPrices['opencode-go']['custom-model'].input, 5), `applyFetchedPrices 带 provider → provider 表（${specP.providerPrices['opencode-go']['custom-model'].input}）`)
assert(specP.prices['custom-model'] === undefined, 'provider 抓取不污染全局表')

// 10) listPiAiProviders 能找到 opencode-go（attach 依赖它扫描）
const providers = listPiAiProviders(piAiDataDir())
assert(providers.includes('opencode-go') && providers.includes('deepseek'), `listPiAiProviders 包含 opencode-go/deepseek（共 ${providers.length} 个 provider）`)

// 11) 自动装配所有 pi-ai provider（模拟 attach 步骤1：遍历 listPiAiProviders 逐个 applyProviderPrices）
const specAuto = plainSpec()
for (const provider of listPiAiProviders(piAiDataDir())) {
  applyProviderPrices(specAuto, provider, loadPiAiProvider(provider, piAiDataDir()))
}
const autoMimo = priceAt('opencode-go', 'mimo-v2.5', specAuto, NOW)
assert(close(autoMimo.input, 0.14) && close(autoMimo.output, 0.28),
  `自动装配全部 provider 后 mimo-v2.5 @opencode-go = ${autoMimo.input}/${autoMimo.output}（0.14/0.28）`)
const autoKimi = priceAt('opencode-go', 'kimi-k2.6', specAuto, NOW)
assert(close(autoKimi.input, 0.95) && close(autoKimi.output, 4),
  `自动装配后 kimi-k2.6 @opencode-go = ${autoKimi.input}/${autoKimi.output}（0.95/4）`)

console.log(`\nprovider 定价验证完成：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail > 0 ? 1 : 0