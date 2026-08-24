/**
 * 临时诊断 v2：从导出的 jsonl 重放真实事件流驱动 tokenBilling 投影，
 * 每步做无损 JSON 检查（undefined/NaN/Infinity）+ view 试算 + zod 校验，
 * 定位第一个让状态违反宿主 plain-JSON 契约的事件。
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  resolveBillingSpec, applyFetchedPrices, createTokenBillingProjectionParts, createBillingView,
} from '../lib/projection.js'
import { loadPriceCache } from '../lib/prices.js'

const file = process.argv[2] ?? 'D:/workshop/.dsh-tmp/session-6fe90fa3-1eee-4fd6-be2d-8c1968314280.jsonl'
const text = readFileSync(file, 'utf8')
const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`共 ${lines.length} 行待重放`)

function findBad(v, path, out) {
  if (v === undefined) { out.push(`${path} = undefined`); return }
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return
  if (typeof v === 'number') { if (!Number.isFinite(v)) out.push(`${path} = ${v}`); return }
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) findBad(v[i], `${path}[${i}]`, out); return }
  if (typeof v === 'object') { for (const k of Object.keys(v)) findBad(v[k], `${path}.${k}`, out); return }
  out.push(`${path} = 类型 ${typeof v}`)
}

const config = { enabled: true, offPeakEnabled: true, offPeakForce: true, fxEnabled: true, fallbackInput: 2, fallbackOutput: 8, fallbackCacheRead: 0.5, fallbackCacheWrite: 2, refreshHours: 1, offPeakRate: 0.5, fxRate: 7.2 }
const spec = resolveBillingSpec(config)
applyFetchedPrices(spec, loadPriceCache(), Date.now())
const parts = createTokenBillingProjectionParts(spec)
const view = createBillingView(spec)

const costsRecord = z.record(z.string(), z.number().nonnegative())
const viewSchema = z.object({
  currency: z.string(),
  billing: z.object({ source: z.string(), peakBilling: z.boolean(), peakActive: z.boolean(), windows: z.array(z.tuple([z.number(), z.number()])) }).strict(),
  prices: z.array(z.object({ model: z.string(), input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(), currency: z.string() }).strict()),
  providerPrices: z.array(z.object({ provider: z.string(), model: z.string(), input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(), currency: z.string() }).strict()),
  totals: z.object({
    uncachedInputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative(),
    costs: costsRecord, calls: z.number().int().nonnegative(), estimatedSteps: z.number().int().nonnegative(), exactSteps: z.number().int().nonnegative(),
  }).strict(),
  turn: z.object({ number: z.number().int().nonnegative(), costs: costsRecord, estimated: z.boolean(), steps: z.number().int().nonnegative(), estimatedSteps: z.number().int().nonnegative() }).strict(),
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
    cacheWriteTokens: z.number().int().nonnegative(), cost: z.number().nonnegative(), currency: z.string(), estimatedCalls: z.number().int().nonnegative(),
  }).strict()),
  steps: z.array(z.object({
    turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(), model: z.string(), provider: z.string(),
    at: z.number(), uncachedInputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative(), currency: z.string(), estimated: z.boolean(), mode: z.string().optional(),
  }).strict()),
}).strict()

let state = parts.init()
let applied = 0
let skipped = 0
for (let i = 0; i < lines.length; i++) {
  let row
  try { row = JSON.parse(lines[i]) } catch { skipped += 1; continue }
  if (!row.type || row.type.startsWith('$')) { skipped += 1; continue }
  let next
  try { next = parts.apply(state, row) } catch (e) {
    console.log(`✗ 行 ${i + 1} [${row.type}] apply 抛错: ${e.message}`)
    console.log('   ', lines[i].slice(0, 500))
    process.exit(1)
  }
  const bad = []
  findBad(next, 'state', bad)
  if (bad.length > 0) {
    console.log(`\n✗✗✗ 行 ${i + 1} [${row.type}] 后状态违规（${bad.length} 处，前 10 条）:`)
    bad.slice(0, 10).forEach((b) => console.log('   ', b))
    console.log('   行内容:', lines[i].slice(0, 800))
    console.log(`\n   之前成功应用 ${applied} 个事件`)
    // 打印肇事前的关键状态
    console.log('   active:', JSON.stringify(state.active)?.slice(0, 400))
    process.exit(1)
  }
  try {
    const out = view(next)
    const r = viewSchema.safeParse(out)
    if (!r.success) {
      console.log(`\n✗✗✗ 行 ${i + 1} [${row.type}] 后 view 未通过 zod:`)
      console.log(JSON.stringify(r.error.issues.slice(0, 6), null, 2))
      console.log('   行内容:', lines[i].slice(0, 800))
      process.exit(1)
    }
  } catch (e) {
    console.log(`\n✗✗✗ 行 ${i + 1} [${row.type}] 后 view 抛错: ${e.message}`)
    process.exit(1)
  }
  state = next
  applied += 1
}
console.log(`\n全部完成：应用 ${applied} 个事件（跳过 ${skipped}），状态始终合规`)
console.log('最终 totals:', JSON.stringify(state.totals).slice(0, 300))
