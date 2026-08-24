/**
 * 临时诊断：对缓存里【全部】tokenBilling 状态逐一体检：
 *  1) 深度无损 JSON 检查（undefined / NaN / Infinity —— JSON.stringify 会把
 *     NaN/Infinity 变 null、丢弃 undefined，均违反宿主 plain-JSON 契约）；
 *  2) 用真实 spec 跑 view 函数并按宿主 zod viewSchema 校验。
 * 目标：定位宿主 "projection checkpoint is not losslessly JSON-serializable"
 * 与浏览器端 view=undefined 的根因。
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  resolveBillingSpec, applyFetchedPrices, createBillingView, applyProviderPrices,
} from '../lib/projection.js'
import { loadPriceCache, listPiAiProviders, loadPiAiProvider } from '../lib/prices.js'

const cache = JSON.parse(readFileSync('C:/Users/spy31/.dsh/storages/session_projcache.json', 'utf8'))

/** 找出所有 tokenBilling 条目及其所属会话路径。 */
const found = []
function walk(obj, path) {
  if (obj === null || typeof obj !== 'object') return
  for (const k of Object.keys(obj)) {
    if (k === 'tokenBilling' && obj[k] && typeof obj[k] === 'object' && obj[k].val) {
      found.push({ path, entry: obj[k] })
    }
    walk(obj[k], path ? `${path}.${k}` : k)
  }
}
walk(cache, '')
console.log('tokenBilling 状态数:', found.length)

/** 深度无损 JSON 检查：返回违规路径列表。 */
function findBad(v, path, out) {
  if (v === undefined) { out.push(`${path} = undefined`); return }
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) out.push(`${path} = ${v}`)
    return
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) findBad(v[i], `${path}[${i}]`, out)
    return
  }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) findBad(v[k], `${path}.${k}`, out)
    return
  }
  out.push(`${path} = 不可序列化类型 ${typeof v}`)
}

// ---- 宿主同款 viewSchema ----
const costsRecord = z.record(z.string(), z.number().nonnegative())
const viewSchema = z.object({
  currency: z.string(),
  billing: z.object({
    source: z.string(), peakBilling: z.boolean(), peakActive: z.boolean(),
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

// ---- 真实 spec ----
const config = { enabled: true, offPeakEnabled: true, offPeakForce: true, fxEnabled: true, fallbackInput: 2, fallbackOutput: 8, fallbackCacheRead: 0.5, fallbackCacheWrite: 2, refreshHours: 1, offPeakRate: 0.5, fxRate: 7.2 }
const spec = resolveBillingSpec(config)
applyFetchedPrices(spec, loadPriceCache(), Date.now())
for (const p of listPiAiProviders()) {
  try { applyProviderPrices(spec, p, loadPiAiProvider(p)) } catch { /* 忽略 */ }
}
const view = createBillingView(spec)

for (const { path, entry } of found) {
  const sid = /session-[0-9a-f-]{16,}/.exec(path)?.[0] ?? '(未知会话)'
  console.log(`\n===== ${sid} · ver=${entry.ver} seq=${entry.seq} =====`)
  const state = entry.val
  const bad = []
  findBad(state, 'state', bad)
  if (bad.length > 0) {
    console.log(`✗ 无损 JSON 违规 ${bad.length} 处（前 12 条）:`)
    bad.slice(0, 12).forEach((b) => console.log('   ', b))
  } else {
    console.log('✓ state 无损 JSON 检查通过')
  }
  let out
  try { out = view(state) } catch (e) {
    console.log('✗ view 抛错:', e.message)
    continue
  }
  // view 输出同样做无损检查（NaN 在 zod 前就暴露）
  const vbad = []
  findBad(out, 'view', vbad)
  if (vbad.length > 0) {
    console.log(`✗ view 输出含非有限数 ${vbad.length} 处（前 12 条）:`)
    vbad.slice(0, 12).forEach((b) => console.log('   ', b))
  }
  const result = viewSchema.safeParse(out)
  console.log(result.success ? '✓ view 通过 viewSchema 校验' : '✗ view 未通过 viewSchema: ' + JSON.stringify(result.error.issues.slice(0, 6)))
}
