/**
 * 临时诊断：用缓存里的真实 tokenBilling state 跑 view 函数，
 * 用与宿主一致的 zod viewSchema 校验输出，定位 view 无法推送的原因。
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  resolveBillingSpec, applyFetchedPrices, createBillingView, applyProviderPrices,
} from '../lib/projection.js'
import { loadPriceCache, listPiAiProviders, loadPiAiProvider } from '../lib/prices.js'

// ---- 复制的宿主 viewSchema（与 lib/index.js 一致）----
const costsRecord = z.record(z.string(), z.number().nonnegative())
const viewSchema = z.object({
  currency: z.string(),
  billing: z.object({
    source: z.string(),
    peakBilling: z.boolean(),
    peakActive: z.boolean(),
    windows: z.array(z.tuple([z.number(), z.number()])),
  }).strict(),
  prices: z.array(z.object({
    model: z.string(), input: z.number().nonnegative(), output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(), currency: z.string(),
  }).strict()),
  providerPrices: z.array(z.object({
    provider: z.string(), model: z.string(), input: z.number().nonnegative(), output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(), currency: z.string(),
  }).strict()),
  totals: z.object({
    uncachedInputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative(),
    costs: costsRecord, calls: z.number().int().nonnegative(),
    estimatedSteps: z.number().int().nonnegative(), exactSteps: z.number().int().nonnegative(),
  }).strict(),
  turn: z.object({
    number: z.number().int().nonnegative(), costs: costsRecord, estimated: z.boolean(),
    steps: z.number().int().nonnegative(), estimatedSteps: z.number().int().nonnegative(),
  }).strict(),
  active: z.object({
    turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(), model: z.string(), provider: z.string(),
    uncachedInputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative(), currency: z.string(), estimated: z.boolean(),
  }).strict().nullable(),
  last: z.object({
    turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(), model: z.string(), provider: z.string(),
    outputTokens: z.number().int().nonnegative(), cost: z.number().nonnegative(), currency: z.string(), estimated: z.boolean(),
  }).strict().nullable(),
  perModel: z.array(z.object({
    model: z.string(), calls: z.number().int().nonnegative(), uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(), cost: z.number().nonnegative(), currency: z.string(),
    estimatedCalls: z.number().int().nonnegative(),
  }).strict()),
  steps: z.array(z.object({
    turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(), model: z.string(), provider: z.string(),
    at: z.number(), uncachedInputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative(), currency: z.string(), estimated: z.boolean(), mode: z.string().optional(),
  }).strict()),
}).strict()

// ---- 加载真实 state（缓存里 seq 最大的 tokenBilling）----
const cache = JSON.parse(readFileSync('C:/Users/spy31/.dsh/storages/session_projcache.json', 'utf8'))
function findKey(obj, key, out) {
  if (obj === null || typeof obj !== 'object') return
  for (const k of Object.keys(obj)) {
    if (k === key) out.push(obj[k])
    findKey(obj[k], key, out)
  }
}
const found = []
findKey(cache, 'tokenBilling', found)
console.log('tokenBilling 状态数:', found.length)
let best = null
for (const f of found) {
  if (f && f.val && (!best || (f.seq || 0) > (best.seq || 0))) best = f
}
if (!best) { console.log('无状态'); process.exit(1) }
const state = best.val
console.log('使用 seq:', best.seq, 'ver:', best.ver)

// ---- 构造 spec（真实配置 + 真实价格缓存）----
const config = { enabled: true, offPeakEnabled: true, offPeakForce: true, fxEnabled: true, fallbackInput: 2, fallbackOutput: 8, fallbackCacheRead: 0.5, fallbackCacheWrite: 2, refreshHours: 1, offPeakRate: 0.5, fxRate: 7.2 }
const spec = resolveBillingSpec(config)
const cached = loadPriceCache()
applyFetchedPrices(spec, cached, Date.now())
for (const p of listPiAiProviders()) {
  try { applyProviderPrices(spec, p, loadPiAiProvider(p)) } catch (e) { /* 单个 provider 失败忽略 */ }
}

const view = createBillingView(spec)
let out
try {
  out = view(state)
  console.log('view 计算 OK')
} catch (e) {
  console.log('✗ view 抛错:', e.message)
  process.exit(1)
}
const result = viewSchema.safeParse(out)
if (result.success) {
  console.log('✓ view 输出通过 viewSchema 校验')
} else {
  console.log('✗ view 输出未通过校验,错误:')
  console.log(JSON.stringify(result.error.issues, null, 2).slice(0, 2000))
}
