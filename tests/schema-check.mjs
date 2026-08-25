/**
 * 验证视图 wire schema（与 lib/index.js 一致）能通过投影真实输出，
 * 覆盖：进行中视图、结算后视图、高峰/错峰生效后的多币种视图。
 * 运行：node tests/schema-check.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import {
  createTokenBillingProjectionParts,
  resolveBillingSpec,
  applyFetchedPrices,
} from '../lib/projection.js'
import { parseDeepSeekPricingHtml } from '../lib/prices.js'

const require = createRequire(
  'C:/Users/spy31/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/stub.js',
)
const { z } = require('zod')

const costsRecord = z.record(z.string(), z.number().nonnegative())
const viewSchema = z.object({
  currency: z.string(),
  billing: z.object({
    source: z.string(),
    peakBilling: z.boolean(),
    peakActive: z.boolean(),
    windows: z.array(z.tuple([z.number(), z.number()]).rest(z.any())),
  }).strict(),
  prices: z.array(z.object({
    model: z.string(),
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    currency: z.string(),
  }).strict()),
  providerPrices: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    currency: z.string(),
  }).strict()),
  totals: z.object({
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    costs: costsRecord,
    calls: z.number().int().nonnegative(),
    estimatedSteps: z.number().int().nonnegative(),
    exactSteps: z.number().int().nonnegative(),
  }).strict(),
  turn: z.object({
    number: z.number().int().nonnegative(),
    costs: costsRecord,
    estimated: z.boolean(),
    steps: z.number().int().nonnegative(),
    estimatedSteps: z.number().int().nonnegative(),
  }).strict(),
  active: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    model: z.string(),
    provider: z.string(),
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative(),
    currency: z.string(),
    estimated: z.boolean(),
  }).strict().nullable(),
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    model: z.string(),
    provider: z.string(),
    outputTokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative(),
    currency: z.string(),
    estimated: z.boolean(),
  }).strict().nullable(),
  perModel: z.array(z.object({
    model: z.string(),
    calls: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative(),
    currency: z.string(),
    estimatedCalls: z.number().int().nonnegative(),
  }).strict()),
  steps: z.array(z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    model: z.string(),
    provider: z.string(),
    at: z.number(),
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative(),
    currency: z.string(),
    estimated: z.boolean(),
    mode: z.string().optional(),
  }).strict()),
}).strict()

const ev = (type, data, extra = {}) => ({ type, data, seq: 0, time: 0, ...extra })
const PEAK_MS = Date.UTC(2026, 7, 16, 1, 30)
const html = readFileSync(new URL('./fixtures/deepseek-pricing.html', import.meta.url), 'utf8')
const fetched = parseDeepSeekPricingHtml(html)

let failed = 0

function validate(label, spec) {
  const parts = createTokenBillingProjectionParts(spec)
  let state = parts.init()
  state = parts.apply(state, ev('turn/start', { turn: 1 }, { seq: 1, time: PEAK_MS }))
  state = parts.apply(state, ev('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' }, system: 'sys' }, reason: 'initial' }, { seq: 2, time: PEAK_MS }))
  state = parts.apply(state, ev('step/start', { turn: 1, step: 0 }, { seq: 3, time: PEAK_MS }))
  state = parts.apply(state, ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'abc' } }, { seq: 4, time: PEAK_MS }))
  let result = viewSchema.safeParse(parts.view(state))
  console.log(`${label}·进行中:`, result.success ? '通过' : '失败\n' + JSON.stringify(result.error.issues, null, 1))
  if (!result.success) failed += 1

  state = parts.apply(state, ev('assistant/message', { turn: 1, step: 0, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 20 } }, { surfaceOp: 'append', seq: 5, time: PEAK_MS }))
  state = parts.apply(state, ev('step/end', { turn: 1, step: 0 }, { seq: 6, time: PEAK_MS }))
  state = parts.apply(state, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 7, time: PEAK_MS }))
  result = viewSchema.safeParse(parts.view(state))
  console.log(`${label}·结算后:`, result.success ? '通过' : '失败\n' + JSON.stringify(result.error.issues, null, 1))
  if (!result.success) failed += 1
}

// 场景 1：仅内置表（¥）
validate('仅内置表', resolveBillingSpec({}))

// 场景 2：官网抓取生效后（高峰价，$ 多币种）
const specFetched = resolveBillingSpec({})
applyFetchedPrices(specFetched, fetched, Date.UTC(2026, 7, 17, 0))
validate('官网高峰价', specFetched)

console.log(failed === 0 ? '\nschema 校验全部通过' : `\n${failed} 处失败`)
process.exit(failed === 0 ? 0 : 1)
