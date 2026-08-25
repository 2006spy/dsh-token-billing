/**
 * dsh-token-billing — 综合验证（无需 dsh 运行时，纯 Node）。
 * 运行：node tests/simulate.mjs
 */
import { readFileSync } from 'node:fs'
import {
  createTokenBillingProjectionParts,
  resolveBillingSpec,
  applyFetchedPrices,
  costOf,
  priceAt,
  inWindow,
  parsePeakWindows,
  providerModeOf,
  BUILTIN_PRICES,
} from '../lib/projection.js'
import { parseDeepSeekPricingHtml, fetchJsonPrices, parsePriceNumber, toMinutes, currencySymbol } from '../lib/prices.js'

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
  check('未知模型回退 fallback', spec.fallback.input === 2)
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
  check('货币 USD', parsed.currency === 'USD')
  check('平峰表含 deepseek-v4-flash', parsed.flat['deepseek-v4-flash'] !== undefined)
  check('平峰 flash 输出 $0.28', Math.abs(parsed.flat['deepseek-v4-flash'].output - 0.28) < 1e-9, parsed.flat['deepseek-v4-flash'])
  check('高峰表含 deepseek-v4-pro', parsed.peak !== null && parsed.peak.models['deepseek-v4-pro'] !== undefined)
  check('高峰 flash 输出 $1.32', parsed.peak !== null && Math.abs(parsed.peak.models['deepseek-v4-flash'].output - 1.32) < 1e-9)
  check('错峰 flash 输出 $0.66', parsed.peak !== null && Math.abs(parsed.peak.offPeak['deepseek-v4-flash'].output - 0.66) < 1e-9)
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
  const eFlash = specBefore.prices['deepseek-v4-flash']
  check('生效前：用户覆盖优先', eFlash.input === 9 && eFlash.output === 9, eFlash)
  check('生效前：无高峰表', Object.keys(specBefore.peak.prices).length === 0)
  check('生效前：其他模型用平峰价', Math.abs(specBefore.prices['deepseek-v4-pro'].output - 0.87) < 1e-9, specBefore.prices['deepseek-v4-pro'])

  const specAfter = resolveBillingSpec({ fxEnabled: false })
  applyFetchedPrices(specAfter, fetched, Date.UTC(2026, 7, 17, 0)) // 生效后
  check('生效后：flash 基准价为高峰价', Math.abs(specAfter.prices['deepseek-v4-flash'].output - 1.32) < 1e-9, specAfter.prices['deepseek-v4-flash'])
  check('生效后：高峰表就位', Math.abs(specAfter.peak.prices['deepseek-v4-flash'].output - 1.32) < 1e-9)
  check('生效后：错峰表就位', Math.abs(specAfter.peak.offPeakPrices['deepseek-v4-flash'].output - 0.66) < 1e-9)
  check('生效后：货币符号 $', specAfter.peak.prices['deepseek-v4-flash'].currency === '$')

  // 强制启用
  const specForce = resolveBillingSpec({ fxEnabled: false, offPeakForce: true })
  applyFetchedPrices(specForce, fetched, Date.UTC(2026, 7, 15, 0))
  check('强制：生效前也启用高峰价', Math.abs(specForce.prices['deepseek-v4-flash'].output - 1.32) < 1e-9)
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
  check('平峰 flash ¥0.02/1/2', Math.abs(parsed.flat['deepseek-v4-flash'].cacheRead - 0.02) < 1e-9
    && Math.abs(parsed.flat['deepseek-v4-flash'].input - 1) < 1e-9
    && Math.abs(parsed.flat['deepseek-v4-flash'].output - 2) < 1e-9, parsed.flat['deepseek-v4-flash'])
  check('高峰 flash ¥0.10/3.0/9.0', parsed.peak !== null && Math.abs(parsed.peak.models['deepseek-v4-flash'].cacheRead - 0.10) < 1e-9
    && Math.abs(parsed.peak.models['deepseek-v4-flash'].output - 9) < 1e-9, parsed.peak?.models['deepseek-v4-flash'])
  check('空闲 flash ¥0.05/1.5/4.5', parsed.peak !== null && Math.abs(parsed.peak.offPeak['deepseek-v4-flash'].cacheRead - 0.05) < 1e-9
    && Math.abs(parsed.peak.offPeak['deepseek-v4-flash'].output - 4.5) < 1e-9, parsed.peak?.offPeak['deepseek-v4-flash'])
  check('中文页窗口（北京时间）', parsed.peak !== null && parsed.peak.windows.length === 2
    && parsed.peak.windows[0][0] === '9:00' && parsed.peak.windows[1][1] === '18:00', parsed.peak?.windows)
  check('中文页时区 Asia/Shanghai', parsed.peak !== null && parsed.peak.tz === 'Asia/Shanghai')
  // 北京时间 2026-08-17 00:00 = UTC 2026-08-16 16:00
  check('中文页生效日期 = UTC 08-16 16:00', parsed.peak !== null && parsed.peak.effectiveAt === Date.UTC(2026, 7, 16, 16), parsed.peak?.effectiveAt)

  // 端到端：抓取价合并后直接以 ¥ 计费（无需折算）
  const spec = resolveBillingSpec({})
  applyFetchedPrices(spec, parsed, Date.UTC(2026, 7, 17, 0))
  check('合并后 flash 基准为高峰价 ¥9', Math.abs(spec.prices['deepseek-v4-flash'].output - 9) < 1e-9, spec.prices['deepseek-v4-flash'])
  check('合并后货币 ¥（无折算）', spec.prices['deepseek-v4-flash'].currency === '¥')
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
  check('美元价折算为人民币', Math.abs(spec.prices['deepseek-v4-flash'].output - 1.32 * 7.2) < 1e-9, spec.prices['deepseek-v4-flash'])
  check('折算后货币 ¥', spec.prices['deepseek-v4-flash'].currency === '¥')
  check('高峰价同样折算', Math.abs(spec.peak.prices['deepseek-v4-flash'].output - 1.32 * 7.2) < 1e-9)
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
  check('生效前用平峰价 ¥2', Math.abs(specBefore.prices['deepseek-v4-flash'].output - 2) < 1e-9, specBefore.prices['deepseek-v4-flash'])
  check('生效前无高峰表', Object.keys(specBefore.peak.prices).length === 0)

  // 生效后：同一份缓存，merge 时按当前时刻自动切换
  const specAfter = resolveBillingSpec({})
  applyFetchedPrices(specAfter, parsed, effectiveAt + 1000)
  check('生效后自动切高峰价 ¥9', Math.abs(specAfter.prices['deepseek-v4-flash'].output - 9) < 1e-9, specAfter.prices['deepseek-v4-flash'])
  check('生效后高峰表就位', Math.abs(specAfter.peak.prices['deepseek-v4-flash'].output - 9) < 1e-9)
  check('生效后空闲价就位', Math.abs(specAfter.peak.offPeakPrices['deepseek-v4-flash'].output - 4.5) < 1e-9)
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
  check('价格解析不受影响（高峰 ¥9）', zhParsed.peak !== null && Math.abs(zhParsed.peak.models['deepseek-v4-flash'].output - 9) < 1e-9)

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
  check('生效前无高峰表（平峰价 ¥2，历史账不受影响）', Math.abs(specEarly.prices['deepseek-v4-flash'].output - 2) < 1e-9, specEarly.prices['deepseek-v4-flash'])

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

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
