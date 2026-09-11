/**
 * dsh-token-billing — 综合验证（无需 dsh 运行时，纯 Node）。
 * 运行：node tests/simulate.mjs
 */
import { readFileSync } from 'node:fs'
import {
  createTokenBillingProjectionParts,
  resolveBillingSpec,
  applyFetchedPrices,
  applyProviderPrices,
  costOf,
  priceAt,
  priceEntry,
  lookupByModel,
  inWindow,
  parsePeakWindows,
  providerModeOf,
  policySegmentIndex,
  PRICE_POLICY_TIMELINE,
  BUILTIN_PRICES,
  BUILTIN_PEAK_PRICES,
  DEFAULT_FALLBACK,
} from '../lib/projection.js'
import {
  parseDeepSeekPricingHtml,
  fetchJsonPrices,
  parsePriceNumber,
  toMinutes,
  currencySymbol,
  canonicalModelId,
  modelTier,
  stripFootnoteMarks,
} from '../lib/prices.js'

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${extra === undefined ? '' : ' → ' + JSON.stringify(extra)}`)
  }
}

function ev(type, data, extra = {}) {
  return { type, data, seq: 0, time: 0, ...extra }
}

// 高峰窗口内的时刻（2026-08-16T01:30:00Z，官方窗口 01:00-04:00 UTC）
const PEAK_MS = Date.UTC(2026, 7, 16, 1, 30)
// 错峰时刻（2026-08-16T11:00:00Z）
const OFFPEAK_MS = Date.UTC(2026, 7, 16, 11, 0)

console.log('== 1. 配置解析 ==')
{
  const spec = resolveBillingSpec({ currency: '¥', prices: '{"deepseek-chat":{"input":1,"output":4}}' })
  check('overrides 生效', spec.overrides['deepseek-chat'].output === 4)
  check('内置表可查', BUILTIN_PRICES['glm-4v-flash'].input === 0)
  check('未知模型回退 fallback 为官方 Flash 空闲价 ¥1', spec.fallback.input === 1)
  check('高峰窗口默认解析', spec.peak.windows.length === 2 && spec.peak.windows[0][0] === toMinutes('09:00')
    && JSON.stringify(spec.peak.windows[0][2]) === '[1,2,3,4,5]')
  check('默认窗口时区 Asia/Shanghai', spec.peak.tz === 'Asia/Shanghai')
  check('默认适用 deepseek-*', spec.peak.models[0] === 'deepseek-*')
  check('非法 JSON 抛错', (() => { try { resolveBillingSpec({ prices: '{bad' }); return false } catch { return true } })())
  check('折扣率越界抛错', (() => { try { resolveBillingSpec({ offPeakRate: 2 }); return false } catch { return true } })())
}

console.log('== 2. DeepSeek 官方页解析（真实 fixture） ==')
{
  const html = readFileSync(new URL('./fixtures/deepseek-pricing.html', import.meta.url), 'utf8')
  const parsed = parseDeepSeekPricingHtml(html)
  // 该 fixture 是 2026-08-17 版官方页（模型名 deepseek-v4-flash）；归一化后统一为官方现名 deepseek-flash
  check('货币 USD', parsed.currency === 'USD')
  check('平峰表含 deepseek-flash（旧名归一化）', parsed.flat['deepseek-flash'] !== undefined, Object.keys(parsed.flat))
  check('平峰 flash 输出 $0.28', Math.abs(parsed.flat['deepseek-flash'].output - 0.28) < 1e-9, parsed.flat['deepseek-flash'])
  check('高峰表含 deepseek-v4-pro', parsed.peak !== null && parsed.peak.models['deepseek-v4-pro'] !== undefined)
  check('高峰 flash 输出 $1.32', parsed.peak !== null && Math.abs(parsed.peak.models['deepseek-flash'].output - 1.32) < 1e-9)
  check('错峰 flash 输出 $0.66', parsed.peak !== null && Math.abs(parsed.peak.offPeak['deepseek-flash'].output - 0.66) < 1e-9)
  check('高峰窗口 2 个', parsed.peak !== null && parsed.peak.windows.length === 2, parsed.peak?.windows)
  check('窗口值 09:00/12:00（UTC 折算北京）', parsed.peak !== null && parsed.peak.windows[0][0] === '9:00' && parsed.peak.windows[0][1] === '12:00')
  check('英文页窗口时区折算为 Asia/Shanghai', parsed.peak !== null && parsed.peak.tz === 'Asia/Shanghai')
  check('生效日期 2026-08-16 16:00 UTC', parsed.peak !== null && parsed.peak.effectiveAt === Date.UTC(2026, 7, 16, 16), parsed.peak?.effectiveAt)
}

console.log('== 3. 精确 usage 计价（¥ 内置） ==')
{
  const spec = resolveBillingSpec({ currency: '¥' })
  const parts = createTokenBillingProjectionParts(spec)
  const header = { config: { provider: 'deepseek', model: 'deepseek-chat' }, system: 'sys' }
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    ev('user/message', { content: [{ type: 'text', text: 'hello' }] }, { surfaceOp: 'append', seq: 2 }),
    ev('request/header', { header, reason: 'initial' }, { seq: 3 }),
    ev('step/start', { turn: 1, step: 0 }, { seq: 4 }),
    ev('assistant/message', { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 100 } }, { surfaceOp: 'append', seq: 5 }),
    ev('step/end', { turn: 1, step: 0 }, { seq: 6, time: OFFPEAK_MS }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 7 }),
  ]
  let state = parts.init()
  for (const e of events) state = parts.apply(state, e)
  const v = parts.view(state)
  // (1000*2 + 200*8 + 5000*0.5 + 100*2)/1e6 = 0.0063
  check('精确费用 ¥0.0063', Math.abs(v.totals.costs['¥'] - 0.0063) < 1e-9, v.totals.costs)
  check('输入桶 1000', v.totals.uncachedInputTokens === 1000)
  check('精确步数 1', v.totals.exactSteps === 1 && v.totals.estimatedSteps === 0)
  check('模型归属', v.perModel[0].model === 'deepseek-chat' && v.perModel[0].currency === '¥')
  check('本轮费用 = 总计', Math.abs(v.turn.costs['¥'] - v.totals.costs['¥']) < 1e-9 && v.turn.steps === 1)
  check('默认来源 deepseek', v.billing.source === 'deepseek')
  check('（未抓取）无高峰计费', v.billing.peakBilling === false)
}

console.log('== 4. 流式估算 → 精确修正 ==')
{
  const spec = resolveBillingSpec({})
  const parts = createTokenBillingProjectionParts(spec)
  const events = [
    ev('turn/start', { turn: 2 }, { seq: 1 }),
    ev('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' }, system: '系统提示' }, reason: 'initial' }, { seq: 2 }),
    ev('step/start', { turn: 2, step: 0 }, { seq: 3 }),
  ]
  let state = parts.init()
  for (const e of events) state = parts.apply(state, e)
  state = parts.apply(state, ev('assistant/chunk', { turn: 2, step: 0, chunk: { type: 'text-delta', index: 0, text: '你好，这是一段较长的输出文本用于估算' } }, { seq: 4 }))
  let v = parts.view(state)
  check('进行中有 active', v.active !== null && v.active.estimated === true)
  check('估算费用 > 0', v.active.cost > 0, v.active.cost)
  check('估算输出 token > 0', v.active.outputTokens > 0, v.active.outputTokens)
  check('进行中不计入 totals', Object.keys(v.totals.costs).length === 0 && v.totals.calls === 0)

  state = parts.apply(state, ev('assistant/chunk', { turn: 2, step: 0, chunk: { type: 'usage', usage: { inputTokens: 800, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } } }, { seq: 5 }))
  v = parts.view(state)
  check('usage 后变精确', v.active !== null && v.active.estimated === false)
  check('精确费用 (800*2+50*8)/1e6=0.002', Math.abs(v.active.cost - 0.002) < 1e-12, v.active.cost)

  state = parts.apply(state, ev('step/end', { turn: 2, step: 0 }, { seq: 6 }))
  state = parts.apply(state, ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, { seq: 7 }))
  v = parts.view(state)
  check('结算后精确入账', Math.abs(v.totals.costs['¥'] - 0.002) < 1e-12, v.totals.costs)
}

console.log('== 5. 多模型混合 + 多币种 ==')
{
  const spec = resolveBillingSpec({})
  const parts = createTokenBillingProjectionParts(spec)
  const events = [
    ev('turn/start', { turn: 3 }, { seq: 1 }),
    ev('request/header', { header: { config: { provider: 'zhipu', model: 'glm-4v-flash' } }, reason: 'change' }, { seq: 2 }),
    ev('step/start', { turn: 3, step: 0 }, { seq: 3 }),
    ev('assistant/message', { turn: 3, step: 0, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 20 } }, { surfaceOp: 'append', seq: 4 }),
    ev('step/end', { turn: 3, step: 0 }, { seq: 5 }),
    ev('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'change' }, { seq: 6 }),
    ev('step/start', { turn: 3, step: 1 }, { seq: 7 }),
    ev('assistant/message', { turn: 3, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 100 } }, { surfaceOp: 'append', seq: 8 }),
    ev('step/end', { turn: 3, step: 1 }, { seq: 9 }),
    ev('turn/end', { turn: 3, reason: { kind: 'completed' } }, { seq: 10 }),
  ]
  let state = parts.init()
  for (const e of events) state = parts.apply(state, e)
  const v = parts.view(state)
  check('glm-4v-flash 免费', v.perModel.find((m) => m.model === 'glm-4v-flash').cost === 0)
  const ds = v.perModel.find((m) => m.model === 'deepseek-chat')
  check('deepseek-chat (100*2+100*8)/1e6=0.001', Math.abs(ds.cost - 0.001) < 1e-12, ds.cost)
  check('总计 ¥0.001', Math.abs(v.totals.costs['¥'] - 0.001) < 1e-12, v.totals.costs)
  check('按费用降序', v.perModel[0].cost >= v.perModel[1].cost)
}

console.log('== 6. 中断退款（估算步骤不落地） ==')
{
  const spec = resolveBillingSpec({})
  const parts = createTokenBillingProjectionParts(spec)
  const events = [
    ev('turn/start', { turn: 4 }, { seq: 1 }),
    ev('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' }, { seq: 2 }),
    ev('step/start', { turn: 4, step: 0 }, { seq: 3 }),
    ev('assistant/chunk', { turn: 4, step: 0, chunk: { type: 'text-delta', index: 0, text: '输出文本……' } }, { seq: 4 }),
    ev('assistant/message', { turn: 4, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '输出文本……' }] } }, { surfaceOp: 'append', seq: 5 }),
    ev('step/end', { turn: 4, step: 0 }, { seq: 6 }),
    ev('turn/end', { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } }, { seq: 7 }),
  ]
  let state = parts.init()
  for (const e of events) state = parts.apply(state, e)
  const v = parts.view(state)
  check('中断后估算费用退款', Object.keys(v.totals.costs).length === 0 && v.totals.calls === 0, v.totals)
  check('中断后无 last', v.last === null)
  check('无步骤历史', v.steps.length === 0)
}

console.log('== 7. 官网抓取合并（优先级：覆盖 > 抓取 > 内置） ==')
{
  const html = readFileSync(new URL('./fixtures/deepseek-pricing.html', import.meta.url), 'utf8')
  const fetched = parseDeepSeekPricingHtml(html)
  // 生效日期未到 → 用平峰价；offPeakForce 后 → 用高峰价
  const specBefore = resolveBillingSpec({ fxEnabled: false, prices: '{"deepseek-v4-flash":{"input":9,"output":9}}' })
  applyFetchedPrices(specBefore, fetched, Date.UTC(2026, 7, 15, 0)) // 生效前
  const eFlash = specBefore.prices['deepseek-flash']
  check('生效前：用户覆盖优先（旧名 deepseek-v4-flash 归一化后仍命中）', eFlash.input === 9 && eFlash.output === 9, eFlash)
  check('生效前：无高峰表', Object.keys(specBefore.peak.prices).length === 0)
  check('生效前：其他模型用平峰价', Math.abs(specBefore.prices['deepseek-v4-pro'].output - 0.87) < 1e-9, specBefore.prices['deepseek-v4-pro'])

  const specAfter = resolveBillingSpec({ fxEnabled: false })
  applyFetchedPrices(specAfter, fetched, Date.UTC(2026, 7, 17, 0)) // 生效后
  check('生效后：flash 基准价为高峰价', Math.abs(specAfter.prices['deepseek-flash'].output - 1.32) < 1e-9, specAfter.prices['deepseek-flash'])
  check('生效后：高峰表就位', Math.abs(specAfter.peak.prices['deepseek-flash'].output - 1.32) < 1e-9)
  check('生效后：错峰表就位', Math.abs(specAfter.peak.offPeakPrices['deepseek-flash'].output - 0.66) < 1e-9)
  check('生效后：货币符号 $', specAfter.peak.prices['deepseek-flash'].currency === '$')

  // 强制启用
  const specForce = resolveBillingSpec({ fxEnabled: false, offPeakForce: true })
  applyFetchedPrices(specForce, fetched, Date.UTC(2026, 7, 15, 0))
  check('强制：生效前也启用高峰价', Math.abs(specForce.prices['deepseek-flash'].output - 1.32) < 1e-9)
}

console.log('== 8. 高峰/错峰时段计价（USD 原价路径，关折算） ==')
{
  const html = readFileSync(new URL('./fixtures/deepseek-pricing.html', import.meta.url), 'utf8')
  const fetched = parseDeepSeekPricingHtml(html)
  const spec = resolveBillingSpec({ fxEnabled: false })
  applyFetchedPrices(spec, fetched, Date.UTC(2026, 7, 17, 0)) // 生效后

  // 高峰窗口内（01:30 UTC）→ 高峰价
  const peak = priceAt('deepseek-v4-flash', spec, PEAK_MS)
  check('高峰窗口内用高峰价', Math.abs(peak.output - 1.32) < 1e-9, peak)
  check('高峰价货币 $', peak.currency === '$')
  // 错峰时段（11:00 UTC）→ 错峰价
  const off = priceAt('deepseek-v4-flash', spec, OFFPEAK_MS)
  check('错峰时段用错峰价', Math.abs(off.output - 0.66) < 1e-9, off)
  // 窗口边界函数（窗口/时区随抓取合并，均为北京时间）
  check('inWindow 01:30 高峰', inWindow(PEAK_MS, spec.peak.windows, spec.peak.tz) === true)
  check('inWindow 11:00 错峰', inWindow(OFFPEAK_MS, spec.peak.windows, spec.peak.tz) === false)
  // 非 deepseek 模型不受影响
  const glm = priceAt('glm-4v-flash', spec, PEAK_MS)
  check('glm 不参与高峰/错峰', Math.abs(glm.output) < 1e-12 && glm.currency === '¥')
  // 用户覆盖钉死，不参与高峰
  const specOv = resolveBillingSpec({ prices: '{"deepseek-v4-flash":{"input":9,"output":9,"cacheRead":9,"cacheWrite":9}}' })
  applyFetchedPrices(specOv, fetched, Date.UTC(2026, 7, 17, 0))
  const ovPeak = priceAt('deepseek-v4-flash', specOv, PEAK_MS)
  const ovOff = priceAt('deepseek-v4-flash', specOv, OFFPEAK_MS)
  check('用户覆盖不参与高峰/错峰', ovPeak.output === 9 && ovOff.output === 9, { ovPeak, ovOff })
}

console.log('== 9. 投影在高峰/错峰下按事件时刻结算（USD 原价路径，关折算） ==')
{
  const html = readFileSync(new URL('./fixtures/deepseek-pricing.html', import.meta.url), 'utf8')
  const fetched = parseDeepSeekPricingHtml(html)
  const spec = resolveBillingSpec({ fxEnabled: false })
  applyFetchedPrices(spec, fetched, Date.UTC(2026, 7, 17, 0))
  const parts = createTokenBillingProjectionParts(spec)

  const settle = (atMs) => {
    const events = [
      ev('turn/start', { turn: 5 }, { seq: 1, time: atMs }),
      ev('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' } }, reason: 'initial' }, { seq: 2, time: atMs }),
      ev('step/start', { turn: 5, step: 0 }, { seq: 3, time: atMs }),
      ev('assistant/message', { turn: 5, step: 0, message: { role: 'assistant', content: [] }, usage: { inputTokens: 1000, outputTokens: 1000 } }, { surfaceOp: 'append', seq: 4, time: atMs }),
      ev('step/end', { turn: 5, step: 0 }, { seq: 5, time: atMs }),
      ev('turn/end', { turn: 5, reason: { kind: 'completed' } }, { seq: 6, time: atMs }),
    ]
    let state = parts.init()
    for (const e of events) state = parts.apply(state, e)
    return parts.view(state)
  }

  const vPeak = settle(PEAK_MS)
  // 高峰：input 1000*0.44/1M + output 1000*1.32/1M = 0.00044 + 0.00132 = 0.00176
  check('高峰结算 $0.00176', Math.abs(vPeak.totals.costs['$'] - 0.00176) < 1e-9, vPeak.totals.costs)
  const vOff = settle(OFFPEAK_MS)
  // 错峰：input 1000*0.22/1M + output 1000*0.66/1M = 0.00022 + 0.00066 = 0.00088
  check('错峰结算 $0.00088', Math.abs(vOff.totals.costs['$'] - 0.00088) < 1e-9, vOff.totals.costs)
  check('错峰徽标', vOff.billing.peakBilling === true && vOff.billing.peakActive === false)
  check('高峰徽标', vPeak.billing.peakActive === true)
}

console.log('== 10. 自定义 JSON 价格端点 ==')
{
  const fakeFetch = async () => new Response(JSON.stringify({
    currency: 'CNY',
    models: { 'my-model': { input: 1.5, output: 6, cacheRead: 0.3, cacheWrite: 1.5 } },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const fetched = await fetchJsonPrices('https://example.test/prices.json', fakeFetch)
  check('自定义端点解析', fetched.currency === 'CNY' && fetched.flat['my-model'].output === 6)
  const spec = resolveBillingSpec({ priceSource: 'custom-json' })
  applyFetchedPrices(spec, fetched, Date.now())
  check('自定义价格入表（含货币符号）', spec.prices['my-model'].currency === '¥' && spec.prices['my-model'].input === 1.5)
}

console.log('== 11. 状态 JSON 可序列化（持久化前置） ==')
{
  const spec = resolveBillingSpec({})
  const parts = createTokenBillingProjectionParts(spec)
  const events = [
    ev('turn/start', { turn: 6 }, { seq: 1 }),
    ev('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' }, { seq: 2 }),
    ev('step/start', { turn: 6, step: 0 }, { seq: 3 }),
    ev('assistant/message', { turn: 6, step: 0, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 5 } }, { surfaceOp: 'append', seq: 4 }),
    ev('step/end', { turn: 6, step: 0 }, { seq: 5 }),
    ev('turn/end', { turn: 6, reason: { kind: 'completed' } }, { seq: 6 }),
  ]
  let state = parts.init()
  for (const e of events) state = parts.apply(state, e)
  const roundtrip = JSON.parse(JSON.stringify(state))
  check('可序列化且可回读', roundtrip.totals.calls === 1 && roundtrip.steps.length === 1)
}

console.log('== 12. 工具函数边界 ==')
{
  check('costOf 零桶零费用', costOf({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, BUILTIN_PRICES['deepseek-chat']) === 0)
  check('parsePriceNumber', parsePriceNumber('$0.007') === 0.007 && parsePriceNumber('¥2') === 2 && parsePriceNumber('1,234.5') === 1234.5)
  check('toMinutes', toMinutes('01:30') === 90 && Number.isNaN(toMinutes('abc')))
  check('currencySymbol', currencySymbol('USD') === '$' && currencySymbol('CNY') === '¥' && currencySymbol('¥') === '¥' && currencySymbol('XYZ') === 'XYZ')
  check('跨零点窗口', inWindow(Date.UTC(2026, 7, 16, 23, 0), [[22 * 60, 2 * 60]], 'UTC') === true)
  check('跨零点窗口外', inWindow(Date.UTC(2026, 7, 16, 12, 0), [[22 * 60, 2 * 60]], 'UTC') === false)
}

console.log('== 13. 北京时间公告表述与官方 UTC 表述等价 ==')
{
  const html = readFileSync(new URL('./fixtures/deepseek-pricing.html', import.meta.url), 'utf8')
  const fetched = parseDeepSeekPricingHtml(html)
  // 官方默认：UTC 窗口 01:00-04:00 / 06:00-10:00（本测试只比窗口行为，关折算保持美元原价）
  const specA = resolveBillingSpec({ fxEnabled: false })
  applyFetchedPrices(specA, fetched, Date.UTC(2026, 7, 17, 0))
  // 公告北京时间表述：窗口 09:00-12:00 / 14:00-18:00（Asia/Shanghai）
  const specB = resolveBillingSpec({ fxEnabled: false, offPeakTz: 'Asia/Shanghai', offPeakWindows: '[["09:00","12:00"],["14:00","18:00"]]' })
  applyFetchedPrices(specB, fetched, Date.UTC(2026, 7, 17, 0))
  check('北京表述窗口解析正确', specB.peak.windows[0][0] === 9 * 60 && specB.peak.windows[1][1] === 18 * 60, specB.peak.windows)

  // 北京时间 10:00（= UTC 02:00，高峰内）
  const bj1000 = Date.UTC(2026, 7, 17, 2, 0)
  // 北京时间 20:00（= UTC 12:00，错峰）
  const bj2000 = Date.UTC(2026, 7, 17, 12, 0)
  const a1 = priceAt('deepseek-v4-flash', specA, bj1000)
  const b1 = priceAt('deepseek-v4-flash', specB, bj1000)
  const a2 = priceAt('deepseek-v4-flash', specA, bj2000)
  const b2 = priceAt('deepseek-v4-flash', specB, bj2000)
  check('北京10:00 两种表述都是高峰价', Math.abs(a1.output - 1.32) < 1e-9 && Math.abs(b1.output - 1.32) < 1e-9, { a1, b1 })
  check('北京20:00 两种表述都是错峰价', Math.abs(a2.output - 0.66) < 1e-9 && Math.abs(b2.output - 0.66) < 1e-9, { a2, b2 })
  check('两种表述行为完全一致', a1.output === b1.output && a2.output === b2.output)
}

console.log('== 14. 中文官方页（人民币直计） ==')
{
  const html = readFileSync(new URL('./fixtures/deepseek-pricing-zh.html', import.meta.url), 'utf8')
  const parsed = parseDeepSeekPricingHtml(html)
  check('中文页币种 CNY', parsed.currency === 'CNY')
  check('平峰 flash ¥0.02/1/2', Math.abs(parsed.flat['deepseek-flash'].cacheRead - 0.02) < 1e-9
    && Math.abs(parsed.flat['deepseek-flash'].input - 1) < 1e-9
    && Math.abs(parsed.flat['deepseek-flash'].output - 2) < 1e-9, parsed.flat['deepseek-flash'])
  check('高峰 flash ¥0.10/3.0/9.0', parsed.peak !== null && Math.abs(parsed.peak.models['deepseek-flash'].cacheRead - 0.10) < 1e-9
    && Math.abs(parsed.peak.models['deepseek-flash'].output - 9) < 1e-9, parsed.peak?.models['deepseek-flash'])
  check('空闲 flash ¥0.05/1.5/4.5', parsed.peak !== null && Math.abs(parsed.peak.offPeak['deepseek-flash'].cacheRead - 0.05) < 1e-9
    && Math.abs(parsed.peak.offPeak['deepseek-flash'].output - 4.5) < 1e-9, parsed.peak?.offPeak['deepseek-flash'])
  check('中文页窗口（北京时间）', parsed.peak !== null && parsed.peak.windows.length === 2
    && parsed.peak.windows[0][0] === '9:00' && parsed.peak.windows[1][1] === '18:00', parsed.peak?.windows)
  check('中文页时区 Asia/Shanghai', parsed.peak !== null && parsed.peak.tz === 'Asia/Shanghai')
  // 北京时间 2026-08-17 00:00 = UTC 2026-08-16 16:00
  check('中文页生效日期 = UTC 08-16 16:00', parsed.peak !== null && parsed.peak.effectiveAt === Date.UTC(2026, 7, 16, 16), parsed.peak?.effectiveAt)

  // 端到端：抓取价合并后直接以 ¥ 计费（无需折算）
  const spec = resolveBillingSpec({})
  applyFetchedPrices(spec, parsed, Date.UTC(2026, 7, 17, 0))
  check('合并后 flash 基准为高峰价 ¥9', Math.abs(spec.prices['deepseek-flash'].output - 9) < 1e-9, spec.prices['deepseek-flash'])
  check('合并后货币 ¥（无折算）', spec.prices['deepseek-flash'].currency === '¥')
  check('窗口自动采用北京时间', spec.peak.windows[0][0] === 9 * 60 && spec.peak.tz === 'Asia/Shanghai', spec.peak)
  // 北京 10:00 高峰 → ¥9 输出；北京 20:00 空闲 → ¥4.5
  const bjPeak = priceAt('deepseek-v4-flash', spec, Date.UTC(2026, 7, 17, 2, 0))
  const bjOff = priceAt('deepseek-v4-flash', spec, Date.UTC(2026, 7, 17, 12, 0))
  check('北京时间高峰 ¥9', Math.abs(bjPeak.output - 9) < 1e-9, bjPeak)
  check('北京时间空闲 ¥4.5', Math.abs(bjOff.output - 4.5) < 1e-9, bjOff)
  check('全部以 ¥ 计价', bjPeak.currency === '¥' && bjOff.currency === '¥')
}

console.log('== 15. 外币→人民币折算（fx，兜底场景） ==')
{
  const html = readFileSync(new URL('./fixtures/deepseek-pricing.html', import.meta.url), 'utf8')
  const enFetched = parseDeepSeekPricingHtml(html)
  const spec = resolveBillingSpec({ fxEnabled: true, fxRate: 7.2 })
  applyFetchedPrices(spec, enFetched, Date.UTC(2026, 7, 17, 0))
  // $1.32 × 7.2 = ¥9.504
  check('美元价折算为人民币', Math.abs(spec.prices['deepseek-flash'].output - 1.32 * 7.2) < 1e-9, spec.prices['deepseek-flash'])
  check('折算后货币 ¥', spec.prices['deepseek-flash'].currency === '¥')
  check('高峰价同样折算', Math.abs(spec.peak.prices['deepseek-flash'].output - 1.32 * 7.2) < 1e-9)
  check('内置表不受影响', spec.prices['glm-4v-flash'].currency === '¥' && Math.abs(spec.prices['glm-4v-flash'].output) < 1e-9)
}

console.log('== 16. 高峰/错峰生效时刻自动切换（无需重抓官网） ==')
{
  const html = readFileSync(new URL('./fixtures/deepseek-pricing-zh.html', import.meta.url), 'utf8')
  const parsed = parseDeepSeekPricingHtml(html)
  const effectiveAt = parsed.peak.effectiveAt // 北京时间 2026-08-17 00:00 = UTC 08-16 16:00

  // 生效前：peakActive false → 用平峰价
  const specBefore = resolveBillingSpec({})
  applyFetchedPrices(specBefore, parsed, effectiveAt - 1000)
  check('生效前用平峰价 ¥2', Math.abs(specBefore.prices['deepseek-flash'].output - 2) < 1e-9, specBefore.prices['deepseek-flash'])
  check('生效前无高峰表', Object.keys(specBefore.peak.prices).length === 0)

  // 生效后：同一份缓存，merge 时按当前时刻自动切换
  const specAfter = resolveBillingSpec({})
  applyFetchedPrices(specAfter, parsed, effectiveAt + 1000)
  check('生效后自动切高峰价 ¥9', Math.abs(specAfter.prices['deepseek-flash'].output - 9) < 1e-9, specAfter.prices['deepseek-flash'])
  check('生效后高峰表就位', Math.abs(specAfter.peak.prices['deepseek-flash'].output - 9) < 1e-9)
  check('生效后空闲价就位', Math.abs(specAfter.peak.offPeakPrices['deepseek-flash'].output - 4.5) < 1e-9)
}

console.log('== 17. provider 收费形式（metering：订阅/免费/本地） ==')
{
  // 配置解析
  const spec = resolveBillingSpec({ providerModes: '{"opencode-go":"subscription","local*":"local","*free*":"free"}' })
  check('providerModes 解析数量', spec.providerModes.length === 3)
  check('精确匹配', providerModeOf(spec, 'opencode-go') === 'subscription')
  check('glob 匹配', providerModeOf(spec, 'local-ollama') === 'local')
  check('glob 匹配 free', providerModeOf(spec, 'somefree-provider') === 'free')
  check('未匹配默认 usage', providerModeOf(spec, 'myapi') === 'usage')
  check('空 provider 默认 usage', providerModeOf(spec, '') === 'usage')
  check('非法模式抛错', (() => { try { resolveBillingSpec({ providerModes: '{"x":"bogus"}' }); return false } catch { return true } })())
  check('坏 JSON 抛错', (() => { try { resolveBillingSpec({ providerModes: '{bad' }); return false } catch { return true } })())

  // 投影结算：step 带 mode
  const parts = createTokenBillingProjectionParts(spec)
  let state = parts.init()
  state = parts.apply(state, ev('turn/start', { turn: 1 }, { seq: 1 }))
  state = parts.apply(state, ev('request/header', { header: { config: { provider: 'opencode-go', model: 'deepseek-v4-flash' }, system: 'sys' }, reason: 'initial' }, { seq: 2 }))
  state = parts.apply(state, ev('step/start', { turn: 1, step: 0 }, { seq: 3 }))
  state = parts.apply(state, ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'abc' } }, { seq: 4 }))
  state = parts.apply(state, ev('assistant/message', { turn: 1, step: 0, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 20 } }, { surfaceOp: 'append', seq: 5 }))
  state = parts.apply(state, ev('step/end', { turn: 1, step: 0 }, { seq: 6 }))
  state = parts.apply(state, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 7 }))
  const view = parts.view(state)
  check('结算 step 带 mode=subscription', view.steps.length === 1 && view.steps[0].mode === 'subscription', view.steps[0])
  check('结算 step 仍计 cost（名义）', view.steps[0].cost > 0)
}

console.log('== 18. 新版官网（2026-08-23 起：高峰仅周一至周五、周末全天空闲） ==')
{
  // —— 中文版：句子带「周一至周五」，价格表结构与旧 fixture 一致 ——
  const zhHtml = `<html><body>
<p>(1) 我们将对 DeepSeek API 价格进行更新调整，采用峰谷定价，空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。新价格将于北京时间 2026 年 8 月 23 日 00:00 开始生效，具体如下：</p>
<div style="font-size:14px"><b><table style="text-align:center"><tr><td colspan="2" style="text-align:center">模型</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr><tr><td colspan="2">BASE URL (OpenAI 格式)</td><td colspan="2">https://api.deepseek.com</td></tr><tr><td colspan="2">BASE URL (Anthropic 格式)</td><td colspan="2">https://api.deepseek.com/anthropic</td></tr><tr><td colspan="2" style="text-align:center">模型版本</td><td>DeepSeek-V4-Flash-0731</td><td>DeepSeek-V4-Pro-0813</td></tr><tr><td colspan="2">上下文长度</td><td colspan="2">1M</td></tr><tr><td colspan="2">输出长度</td><td colspan="2">最大 384K</td></tr><tr><td rowspan="3">价格<sup>(1)</sup></td><td>百万tokens输入（缓存命中）</td><td>0.02元</td><td>0.025元</td></tr><tr><td>百万tokens输入（缓存未命中）</td><td>1元</td><td>3元</td></tr><tr><td>百万tokens输出</td><td>2元</td><td>6元</td></tr></table></b></div>
<div style="font-size:14px"><table style="text-align:center"><tr><td colspan="2">模型</td><td>百万tokens输入（缓存命中）</td><td>百万tokens输入（缓存未命中）</td><td>百万tokens输出</td></tr><tr><td rowspan="2">deepseek-v4-flash</td><td>空闲时段</td><td>0.05元</td><td>1.5元</td><td>4.5元</td></tr><tr><td>高峰时段</td><td>0.10元</td><td>3.0元</td><td>9.0元</td></tr><tr><td rowspan="2">deepseek-v4-pro</td><td>空闲时段</td><td>0.15元</td><td>4.5元</td><td>13.5元</td></tr><tr><td>高峰时段</td><td>0.30元</td><td>9.0元</td><td>27.0元</td></tr></table></div>
</body></html>`
  const zhParsed = parseDeepSeekPricingHtml(zhHtml)
  check('中文新版解析出 2 个窗口', zhParsed.peak !== null && zhParsed.peak.windows.length === 2, zhParsed.peak?.windows)
  check('中文新版窗口带工作日 days', zhParsed.peak !== null
    && JSON.stringify(zhParsed.peak.windows[0][2]) === '[1,2,3,4,5]'
    && JSON.stringify(zhParsed.peak.windows[1][2]) === '[1,2,3,4,5]', zhParsed.peak?.windows)
  check('中文新版时区 Asia/Shanghai', zhParsed.peak !== null && zhParsed.peak.tz === 'Asia/Shanghai')
  check('中文新版生效 = UTC 2026-08-22 16:00', zhParsed.peak !== null && zhParsed.peak.effectiveAt === Date.UTC(2026, 7, 22, 16), zhParsed.peak?.effectiveAt)
  check('价格解析不受影响（高峰 ¥9）', zhParsed.peak !== null && Math.abs(zhParsed.peak.models['deepseek-flash'].output - 9) < 1e-9)

  // —— 英文版：Monday through Friday ——
  const enHtml = `<html><body><p>DeepSeek API pricing will be updated to peak / off-peak billing. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday. The new prices take effect at 16:00 UTC on August 22, 2026.</p>
<div style="font-size:14px"><table style="text-align:center"><tr><td colspan="2">MODEL</td><td>1M INPUT TOKENS (CACHE HIT)</td><td>1M INPUT TOKENS (CACHE MISS)</td><td>1M OUTPUT TOKENS</td></tr><tr><td rowspan="2">deepseek-v4-flash</td><td>OFF-PEAK</td><td>$0.007</td><td>$0.22</td><td>$0.66</td></tr><tr><td>PEAK</td><td>$0.014</td><td>$0.44</td><td>$1.32</td></tr></table></div>
</body></html>`
  const enParsed = parseDeepSeekPricingHtml(enHtml)
  check('英文新版窗口带工作日 days', enParsed.peak !== null && enParsed.peak.windows.length === 2
    && JSON.stringify(enParsed.peak.windows[0][2]) === '[1,2,3,4,5]', enParsed.peak?.windows)
  check('英文新版窗口折算为北京时间', enParsed.peak !== null && enParsed.peak.tz === 'Asia/Shanghai'
    && enParsed.peak.windows[0][0] === '9:00' && enParsed.peak.windows[0][1] === '12:00')
  check('英文新版生效 = UTC 2026-08-22 16:00', enParsed.peak !== null && enParsed.peak.effectiveAt === Date.UTC(2026, 7, 22, 16), enParsed.peak?.effectiveAt)

  // —— inWindow 直接验证星期几维度（北京时间窗口）——
  const wBeijingDays = [[540, 720, [1, 2, 3, 4, 5]], [840, 1080, [1, 2, 3, 4, 5]]]
  check('inWindow 周五 15:00 北京 = 高峰', inWindow(Date.UTC(2026, 7, 28, 7, 0), wBeijingDays, 'Asia/Shanghai') === true)
  check('inWindow 周六 15:00 北京 = 空闲', inWindow(Date.UTC(2026, 7, 29, 7, 0), wBeijingDays, 'Asia/Shanghai') === false)
  check('inWindow 周日 15:00 北京 = 空闲', inWindow(Date.UTC(2026, 7, 23, 7, 0), wBeijingDays, 'Asia/Shanghai') === false)

  // —— 端到端：合并官网价后按星期几判峰 ——
  const spec = resolveBillingSpec({})
  applyFetchedPrices(spec, zhParsed, Date.UTC(2026, 7, 23, 0))
  check('合并后窗口带 days', spec.peak.windows.length === 2 && JSON.stringify(spec.peak.windows[0][2]) === '[1,2,3,4,5]', spec.peak.windows)
  const fri = priceAt('deepseek-v4-flash', spec, Date.UTC(2026, 7, 28, 7, 0))
  const sat = priceAt('deepseek-v4-flash', spec, Date.UTC(2026, 7, 29, 7, 0))
  const sun = priceAt('deepseek-v4-flash', spec, Date.UTC(2026, 7, 23, 7, 0))
  check('周五 15:00 北京按高峰 ¥9', Math.abs(fri.output - 9) < 1e-9, fri)
  check('周六 15:00 北京按空闲 ¥4.5', Math.abs(sat.output - 4.5) < 1e-9, sat)
  check('周日 15:00 北京按空闲 ¥4.5', Math.abs(sun.output - 4.5) < 1e-9, sun)

  // —— 历史回看：生效前周末仍按高峰价（勿整体减半）——
  const specEarly = resolveBillingSpec({})
  applyFetchedPrices(specEarly, zhParsed, Date.UTC(2026, 7, 22, 15))
  check('生效前无高峰表（平峰价 ¥2，历史账不受影响）', Math.abs(specEarly.prices['deepseek-flash'].output - 2) < 1e-9, specEarly.prices['deepseek-flash'])

  // —— 历史回看：生效后合并的 spec，回看生效前（8/22）周末时刻仍按高峰价 ——
  const specLate = resolveBillingSpec({})
  applyFetchedPrices(specLate, zhParsed, Date.UTC(2026, 7, 23, 0))
  const satMorn = priceAt('deepseek-v4-flash', specLate, Date.UTC(2026, 7, 22, 1, 30)) // 8/22 周六 09:30 北京
  const satEve = priceAt('deepseek-v4-flash', specLate, Date.UTC(2026, 7, 22, 9, 59, 59)) // 8/22 周六 17:59:59 北京
  check('历史回看：生效前周六上午仍按高峰 ¥9', Math.abs(satMorn.output - 9) < 1e-9, satMorn)
  check('历史回看：生效前周六傍晚仍按高峰 ¥9', Math.abs(satEve.output - 9) < 1e-9, satEve)

  // —— 用户自定义 3 元组窗口 ——
  const custom = parsePeakWindows([['22:00', '02:00', [5]]])
  check('用户自定义 3 元组窗口解析', custom.length === 1 && custom[0][0] === 1320 && custom[0][1] === 120 && JSON.stringify(custom[0][2]) === '[5]', custom)
  check('旧版 2 元组窗口兼容（days 缺省）', parsePeakWindows([['09:00', '12:00']])[0][2] === undefined)
}

/* ------------------------------------------------------------------ */
/* v0.8.0 计价正确性回归（脚注归一化 / 档位别名 / 现值 / 政策时间线）   */
/* ------------------------------------------------------------------ */

console.log('== 19. 官方现页（2026-09 版）脚注污染归一化 ==')
{
  const zh = parseDeepSeekPricingHtml(readFileSync(new URL('./fixtures/deepseek-pricing-zh-2026-09.html', import.meta.url), 'utf8'))
  const en = parseDeepSeekPricingHtml(readFileSync(new URL('./fixtures/deepseek-pricing-en-2026-09.html', import.meta.url), 'utf8'))
  const hasFootnoteKey = (obj) => Object.keys(obj ?? {}).some((k) => /[()（）[\]【】]/.test(k))

  check('中文现页无括号脚注 key', !hasFootnoteKey(zh.flat) && !hasFootnoteKey(zh.peak?.models) && !hasFootnoteKey(zh.peak?.offPeak))
  check('英文现页无括号脚注 key', !hasFootnoteKey(en.flat) && !hasFootnoteKey(en.peak?.models))
  check('旧脏 key 不再出现', zh.flat['deepseek-flash(1)'] === undefined && zh.flat['deepseek-v4-pro(2)'] === undefined)
  check('中文现页 key = 官方现名', zh.flat['deepseek-flash'] !== undefined && zh.flat['deepseek-v4-pro'] !== undefined, Object.keys(zh.flat))
  check('中文现页币种 CNY', zh.currency === 'CNY')
  // 官方现值（¥/1M）：flash 空闲 0.02/1/4、高峰 0.04/2/8
  check('中文现页 flash 空闲 ¥0.02/1/4', Math.abs(zh.flat['deepseek-flash'].cacheRead - 0.02) < 1e-9
    && Math.abs(zh.flat['deepseek-flash'].input - 1) < 1e-9
    && Math.abs(zh.flat['deepseek-flash'].output - 4) < 1e-9, zh.flat['deepseek-flash'])
  check('中文现页 flash 高峰 ¥0.04/2/8', zh.peak !== null && Math.abs(zh.peak.models['deepseek-flash'].cacheRead - 0.04) < 1e-9
    && Math.abs(zh.peak.models['deepseek-flash'].input - 2) < 1e-9
    && Math.abs(zh.peak.models['deepseek-flash'].output - 8) < 1e-9, zh.peak?.models['deepseek-flash'])
  check('中文现页 pro 空闲 ¥0.15/4.5/13.5', Math.abs(zh.flat['deepseek-v4-pro'].cacheRead - 0.15) < 1e-9
    && Math.abs(zh.flat['deepseek-v4-pro'].input - 4.5) < 1e-9
    && Math.abs(zh.flat['deepseek-v4-pro'].output - 13.5) < 1e-9)
  check('中文现页 pro 高峰 ¥0.3/9/27', zh.peak !== null && Math.abs(zh.peak.models['deepseek-v4-pro'].cacheRead - 0.3) < 1e-9
    && Math.abs(zh.peak.models['deepseek-v4-pro'].input - 9) < 1e-9
    && Math.abs(zh.peak.models['deepseek-v4-pro'].output - 27) < 1e-9)
  check('中文现页高峰窗口带工作日 days', zh.peak !== null && JSON.stringify(zh.peak.windows[0][2]) === '[1,2,3,4,5]'
    && JSON.stringify(zh.peak.windows[1][2]) === '[1,2,3,4,5]', zh.peak?.windows)
  check('中文现页时区 Asia/Shanghai', zh.peak !== null && zh.peak.tz === 'Asia/Shanghai')
  // 英文页（USD/1M）：flash 空闲 0.003/0.15/0.6、高峰 0.006/0.3/1.2
  check('英文现页币种 USD', en.currency === 'USD')
  check('英文现页 flash 空闲 $0.003/0.15/0.6', Math.abs(en.flat['deepseek-flash'].cacheRead - 0.003) < 1e-9
    && Math.abs(en.flat['deepseek-flash'].input - 0.15) < 1e-9
    && Math.abs(en.flat['deepseek-flash'].output - 0.6) < 1e-9)
  check('英文现页 flash 高峰 $0.006/0.3/1.2', en.peak !== null && Math.abs(en.peak.models['deepseek-flash'].cacheRead - 0.006) < 1e-9
    && Math.abs(en.peak.models['deepseek-flash'].output - 1.2) < 1e-9)
  // 端到端：抓中文现页合并后按官方现价计费（北京 20:00 空闲 / 10:00 高峰）
  const spec = resolveBillingSpec({})
  applyFetchedPrices(spec, zh, Date.UTC(2026, 8, 11, 13, 52))
  const nowOff = priceAt('', 'deepseek-flash', spec, Date.UTC(2026, 8, 11, 12, 0))
  const nowPeak = priceAt('', 'deepseek-flash', spec, Date.UTC(2026, 8, 11, 2, 0))
  check('现页合并后 09-11 空闲 ¥0.02/1/4', Math.abs(nowOff.cacheRead - 0.02) < 1e-9 && Math.abs(nowOff.output - 4) < 1e-9, nowOff)
  check('现页合并后 09-11 高峰 ¥0.04/2/8', Math.abs(nowPeak.cacheRead - 0.04) < 1e-9 && Math.abs(nowPeak.output - 8) < 1e-9, nowPeak)
}

console.log('== 20. 模型档位/别名归一化（解析层与写入层共用） ==')
{
  const flashNames = [
    'deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash-0731',
    'deepseek-v4-flash-ga-260731', 'deepseek-v4-flash-vision-exp', 'DeepSeek-V4-Flash-0731',
    'deepseek/deepseek-v4-flash-0731', 'deepseek-flash(1)',
  ]
  for (const name of flashNames) {
    check(`flash 档：${name}`, modelTier(name) === 'flash' && canonicalModelId(name) === 'deepseek-flash',
      { tier: modelTier(name), id: canonicalModelId(name) })
  }
  for (const name of ['deepseek-v4-pro', 'deepseek-v4-pro-0813', 'DeepSeek-V4-Pro-0813', 'deepseek-v4-pro(2)']) {
    check(`pro 档：${name}`, modelTier(name) === 'pro' && canonicalModelId(name) === 'deepseek-v4-pro',
      { tier: modelTier(name), id: canonicalModelId(name) })
  }
  check('非 DeepSeek 模型键不变', canonicalModelId('mimo-v2.5') === 'mimo-v2.5' && canonicalModelId('deepseek-chat') === 'deepseek-chat')
  check('档位不误判（proxy 不是 pro）', modelTier('deepseek-v4-proxy') === null)
  check('脚注剥离函数', stripFootnoteMarks('deepseek-flash(1)') === 'deepseek-flash'
    && stripFootnoteMarks('deepseek-v4-pro（2）') === 'deepseek-v4-pro'
    && stripFootnoteMarks('deepseek-flash¹') === 'deepseek-flash')
  // 账本里的全部真实模型名都能命中档位价（而不是回落 fallback）
  const spec = resolveBillingSpec({})
  const at = Date.UTC(2026, 8, 11, 12, 0) // 北京时间 20:00（空闲价）
  for (const name of [
    'deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash-0731',
    'deepseek-v4-flash-ga-260731', 'deepseek-v4-flash-vision-exp', 'DeepSeek-V4-Flash-0731',
    'deepseek/deepseek-v4-flash-0731',
  ]) {
    const p = priceAt('', name, spec, at)
    check(`flash 档取价：${name}`, Math.abs(p.output - 4) < 1e-9 && Math.abs(p.cacheRead - 0.02) < 1e-9, p)
  }
  for (const name of ['deepseek-v4-pro', 'deepseek-v4-pro-0813']) {
    const p = priceAt('', name, spec, at)
    check(`pro 档取价：${name}`, Math.abs(p.output - 13.5) < 1e-9 && Math.abs(p.cacheRead - 0.15) < 1e-9, p)
  }
}

console.log('== 21. 内置表与 fallback 更新为官方现值 ==')
{
  check('BUILTIN flash 空闲 ¥0.02/1/4', BUILTIN_PRICES['deepseek-flash'].cacheRead === 0.02
    && BUILTIN_PRICES['deepseek-flash'].input === 1 && BUILTIN_PRICES['deepseek-flash'].output === 4, BUILTIN_PRICES['deepseek-flash'])
  check('BUILTIN pro 空闲 ¥0.15/4.5/13.5', BUILTIN_PRICES['deepseek-v4-pro'].cacheRead === 0.15
    && BUILTIN_PRICES['deepseek-v4-pro'].input === 4.5 && BUILTIN_PRICES['deepseek-v4-pro'].output === 13.5, BUILTIN_PRICES['deepseek-v4-pro'])
  check('BUILTIN 高峰 flash ¥0.04/2/8', BUILTIN_PEAK_PRICES['deepseek-flash'].cacheRead === 0.04
    && BUILTIN_PEAK_PRICES['deepseek-flash'].input === 2 && BUILTIN_PEAK_PRICES['deepseek-flash'].output === 8)
  check('BUILTIN 高峰 pro ¥0.3/9/27', BUILTIN_PEAK_PRICES['deepseek-v4-pro'].cacheRead === 0.3
    && BUILTIN_PEAK_PRICES['deepseek-v4-pro'].input === 9 && BUILTIN_PEAK_PRICES['deepseek-v4-pro'].output === 27)
  check('DEFAULT_FALLBACK = 官方 Flash 空闲价 ¥0.02/1/4', DEFAULT_FALLBACK.input === 1 && DEFAULT_FALLBACK.output === 4
    && DEFAULT_FALLBACK.cacheRead === 0.02 && DEFAULT_FALLBACK.cacheWrite === 1, DEFAULT_FALLBACK)
  check('旧内置 flash 价 2/8/0.5/2 已退役', BUILTIN_PRICES['deepseek-v4-flash'] === undefined)
}

console.log('== 22. 价格政策时间线（按消息时刻取价，历史回看不被追溯改写） ==')
{
  // 北京时间 → UTC 绝对时刻（bj(8,17,10) = 2026-08-17 10:00 北京）
  const bj = (m, d, h, mi = 0) => Date.UTC(2026, m - 1, d, h - 8, mi)
  const spec = resolveBillingSpec({}) // 仅内置表（无抓取）
  check('时间线三段（平价 / 08-17 峰谷 / 09-10 Flash 新价）', PRICE_POLICY_TIMELINE.length === 3
    && PRICE_POLICY_TIMELINE[1].since === Date.UTC(2026, 7, 16, 16)
    && PRICE_POLICY_TIMELINE[2].since === Date.UTC(2026, 8, 10, 4), PRICE_POLICY_TIMELINE.map((s) => s.label))
  check('政策段索引随时刻变化', policySegmentIndex(bj(8, 16, 10)) === 0
    && policySegmentIndex(bj(8, 20, 10)) === 1 && policySegmentIndex(bj(9, 10, 12)) === 2)

  // 08-17 峰谷起点：之前平价（早晚同价），之后峰谷分明
  const pre = priceAt('', 'deepseek-v4-flash', spec, bj(8, 16, 10))
  const preEve = priceAt('', 'deepseek-v4-flash', spec, bj(8, 16, 22))
  check('08-17 前：平价 ¥0.02/1/2（早晚同价）', Math.abs(pre.output - 2) < 1e-9 && Math.abs(preEve.output - 2) < 1e-9, { pre, preEve })
  const onPeak = priceAt('', 'deepseek-v4-flash', spec, bj(8, 17, 10))
  const onOff = priceAt('', 'deepseek-v4-flash', spec, bj(8, 17, 20))
  check('08-17 起：高峰 ¥0.10/3/9', Math.abs(onPeak.cacheRead - 0.1) < 1e-9 && Math.abs(onPeak.output - 9) < 1e-9, onPeak)
  check('08-17 起：空闲 ¥0.05/1.5/4.5', Math.abs(onOff.cacheRead - 0.05) < 1e-9 && Math.abs(onOff.output - 4.5) < 1e-9, onOff)

  // 08-23 周末空闲：之前周末仍按高峰，之后周末全天空闲
  const satBefore = priceAt('', 'deepseek-v4-flash', spec, bj(8, 22, 10))
  const satAfter = priceAt('', 'deepseek-v4-flash', spec, bj(8, 29, 10))
  const sunAfter = priceAt('', 'deepseek-v4-flash', spec, bj(8, 30, 10))
  const monAfter = priceAt('', 'deepseek-v4-flash', spec, bj(8, 31, 10))
  check('08-23 前：周六上午仍按高峰 ¥9', Math.abs(satBefore.output - 9) < 1e-9, satBefore)
  check('08-23 起：周六全天空闲 ¥4.5', Math.abs(satAfter.output - 4.5) < 1e-9, satAfter)
  check('08-23 起：周日全天空闲 ¥4.5', Math.abs(sunAfter.output - 4.5) < 1e-9, sunAfter)
  check('08-23 起：工作日仍按高峰 ¥9', Math.abs(monAfter.output - 9) < 1e-9, monAfter)

  // 09-10 12:00 Flash 调价边界（都在高峰窗口内，隔离时段因素）
  const beforeChange = priceAt('', 'deepseek-v4-flash', spec, bj(9, 10, 11, 30))
  const afterChange = priceAt('', 'deepseek-v4-flash', spec, bj(9, 10, 14, 30))
  check('09-10 12:00 前：高峰仍 ¥9', Math.abs(beforeChange.output - 9) < 1e-9, beforeChange)
  check('09-10 12:00 后：高峰降为 ¥8', Math.abs(afterChange.output - 8) < 1e-9, afterChange)
  check('09-10 12:00 后：空闲 ¥0.02/1/4', Math.abs(priceAt('', 'deepseek-v4-flash', spec, bj(9, 11, 20)).output - 4) < 1e-9)
  check('pro 档 09-10 未调价（高峰 ¥27）', Math.abs(priceAt('', 'deepseek-v4-pro', spec, bj(9, 11, 10)).output - 27) < 1e-9)

  // 历史回看：抓到 09 月现页后，旧消息仍按当时政策计价（不被新规追溯改写）
  const zh = parseDeepSeekPricingHtml(readFileSync(new URL('./fixtures/deepseek-pricing-zh-2026-09.html', import.meta.url), 'utf8'))
  const specNow = resolveBillingSpec({})
  applyFetchedPrices(specNow, zh, Date.UTC(2026, 8, 11, 13, 52))
  check('抓取现页后：08-20 历史消息仍按旧价 ¥9', Math.abs(priceAt('', 'deepseek-v4-flash', specNow, bj(8, 20, 10)).output - 9) < 1e-9,
    priceAt('', 'deepseek-v4-flash', specNow, bj(8, 20, 10)))
  check('抓取现页后：08-16 历史消息仍按平价 ¥2', Math.abs(priceAt('', 'deepseek-v4-flash', specNow, bj(8, 16, 10)).output - 2) < 1e-9)
  check('抓取现页后：09-11 当前高峰 ¥8（跟随官网）', Math.abs(priceAt('', 'deepseek-v4-flash', specNow, bj(9, 11, 10)).output - 8) < 1e-9)
  check('抓取现页后：09-11 当前空闲 ¥4（跟随官网）', Math.abs(priceAt('', 'deepseek-v4-flash', specNow, bj(9, 11, 20)).output - 4) < 1e-9)
}

console.log('== 23. windowsAreDefault 默认等价（旧 Config 的 UTC 窗口 = 内置北京窗口） ==')
{
  const zh = parseDeepSeekPricingHtml(readFileSync(new URL('./fixtures/deepseek-pricing-zh-2026-09.html', import.meta.url), 'utf8'))
  const now = Date.UTC(2026, 8, 11, 13, 52)
  // 旧版 Config 默认：UTC 窗口 + UTC 时区（无星期几）——语义上等价于官方默认
  const specLegacy = resolveBillingSpec({ offPeakWindows: '[["01:00","04:00"],["06:00","10:00"]]', offPeakTz: 'UTC' })
  check('旧默认窗口初始无 days、时区 UTC', specLegacy.peak.windows[0][2] === undefined && specLegacy.peak.tz === 'UTC', specLegacy.peak)
  applyFetchedPrices(specLegacy, zh, now)
  check('旧默认窗口被官网窗口覆盖（带工作日）', JSON.stringify(specLegacy.peak.windows[0][2]) === '[1,2,3,4,5]', specLegacy.peak.windows)
  check('时区同步为 Asia/Shanghai', specLegacy.peak.tz === 'Asia/Shanghai')
  const sat = priceAt('', 'deepseek-v4-flash', specLegacy, Date.UTC(2026, 7, 29, 2, 0)) // 北京周六 10:00
  const mon = priceAt('', 'deepseek-v4-flash', specLegacy, Date.UTC(2026, 7, 31, 2, 0)) // 北京周一 10:00
  check('旧默认窗口下周六 = 空闲 ¥4.5（周末规则生效）', Math.abs(sat.output - 4.5) < 1e-9, sat)
  check('旧默认窗口下周一 = 高峰 ¥9', Math.abs(mon.output - 9) < 1e-9, mon)
  // 北京时段但漏写 days 的写法同样视为默认
  const specBj = resolveBillingSpec({ offPeakWindows: '[["09:00","12:00"],["14:00","18:00"]]', offPeakTz: 'Asia/Shanghai' })
  applyFetchedPrices(specBj, zh, now)
  check('北京时段无 days 写法同样视为默认', JSON.stringify(specBj.peak.windows[0][2]) === '[1,2,3,4,5]', specBj.peak.windows)
  // 真正自定义的窗口不被官网抓取覆盖
  const specCustom = resolveBillingSpec({ offPeakWindows: '[["22:00","23:00"]]', offPeakTz: 'Asia/Shanghai' })
  applyFetchedPrices(specCustom, zh, now)
  check('自定义窗口不被官网覆盖', specCustom.peak.windows.length === 1 && specCustom.peak.windows[0][0] === 1320, specCustom.peak.windows)
}

console.log('== 24. applyFetchedPrices 写入前归一化（脏 key 不落盘） ==')
{
  // 模拟旧版本落进价格缓存的脏 key（官方页脚注污染）
  const dirty = {
    currency: 'CNY',
    flat: {
      'deepseek-flash(1)': { input: 7, output: 11, cacheRead: 0.07, cacheWrite: 7 },
      'deepseek-v4-pro(2)': { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 4.5 },
    },
    peak: null,
  }
  const spec = resolveBillingSpec({})
  applyFetchedPrices(spec, dirty, Date.now())
  const paren = Object.keys(spec.prices).filter((k) => /[()（）]/.test(k))
  check('全局表无脏 key', paren.length === 0, paren)
  check('脏 key 归一化进 deepseek-flash', spec.prices['deepseek-flash'] !== undefined && spec.prices['deepseek-flash'].output === 11,
    spec.prices['deepseek-flash'])
  check('归一化记录进 fetchedModels', spec.fetchedModels['deepseek-flash'] === true)

  // provider 桶同样归一化，且不污染全局表
  const specP = resolveBillingSpec({})
  applyFetchedPrices(specP, dirty, Date.now(), 'mxy')
  const bucketParen = Object.keys(specP.providerPrices['mxy']).filter((k) => /[()（）]/.test(k))
  check('provider 桶无脏 key', bucketParen.length === 0 && specP.providerPrices['mxy']['deepseek-flash'] !== undefined, specP.providerPrices['mxy'])
  check('provider 抓取不写入全局 fetchedModels', specP.fetchedModels['deepseek-flash'] !== true)

  // 历史价格缓存里的脏 key：读取时仍能宽松命中（lookupByModel）
  const legacyTable = { 'deepseek-flash(1)': { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 1, currency: '¥' } }
  check('读取历史脏 key 表仍可命中', lookupByModel(legacyTable, 'deepseek-v4-flash-0731') !== undefined)
  check('priceEntry 兼容历史脏 key', priceEntry('deepseek-v4.1-flash', { prices: legacyTable, fallback: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 1 }, currency: '¥' }).output === 4)
}

console.log('== 25. 不跨 provider 串价 + 同名模型各自计价 ==')
{
  const at = Date.UTC(2026, 8, 11, 12, 0) // 北京时间 20:00（当前空闲价）
  const spec = resolveBillingSpec({})
  applyProviderPrices(spec, 'mxy', { 'deepseek-v4-flash-0731': { input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3, currency: '¥' } })
  const hitMxy = priceAt('mxy', 'deepseek-v4-flash-0731', spec, at)
  check('provider 命中用自身价', Math.abs(hitMxy.input - 3) < 1e-9 && Math.abs(hitMxy.output - 12) < 1e-9, hitMxy)
  const missHy = priceAt('hy', 'deepseek-v4-flash-0731', spec, at)
  check('provider 未命中不串别的 provider 价（回落官方政策价 ¥4）', Math.abs(missHy.output - 12) > 1e-9 && Math.abs(missHy.output - 4) < 1e-9, missHy)
  const missEmpty = priceAt('', 'deepseek-v4-flash-0731', spec, at)
  check('无 provider 回落全局政策价', Math.abs(missEmpty.output - 4) < 1e-9, missEmpty)
  // 同一模型名在不同 provider 下各按各自价表（大小写/分隔符不敏感）
  applyProviderPrices(spec, 'hy', { 'DeepSeek-V4-Flash-0731': { input: 5, output: 20, cacheRead: 0.5, cacheWrite: 5, currency: '¥' } })
  const a = priceAt('mxy', 'deepseek-v4-flash-0731', spec, at)
  const b = priceAt('hy', 'DeepSeek-V4-Flash-0731', spec, at)
  check('同名模型不同 provider 各自计价', Math.abs(a.output - 12) < 1e-9 && Math.abs(b.output - 20) < 1e-9, { a, b })
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
