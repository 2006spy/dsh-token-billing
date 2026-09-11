/**
 * 验证视图 wire schema（与 lib/index.js 一致）能通过投影真实输出，
 * 覆盖：进行中视图、结算后视图、高峰/错峰生效后的多币种视图。
 * 运行：node tests/schema-check.mjs
 *
 * 自包含：不依赖任何第三方包，也不含任何写死的本机绝对路径。
 * （旧版把本机用户目录下的 npm 全局安装路径写死为模块加载基准、再据此加载
 *  zod，于是本机与任何 CI 上都会直接抛 Cannot find module 'zod' —— 该测试
 *  实际上从未真正跑通过。本文件改为内置一个只覆盖本文件所需能力的极简
 *  校验器（下方 `z`），断言强度与 zod 等价：类型、必填、整数/非负、strict
 *  （不允许多余键）、nullable / optional、record / tuple.rest，并用
 *  「校验器自检」把这些语义逐项固定下来。）
 */
import { readFileSync } from 'node:fs'
import {
  createTokenBillingProjectionParts,
  resolveBillingSpec,
  applyFetchedPrices,
} from '../lib/projection.js'
import { parseDeepSeekPricingHtml } from '../lib/prices.js'

/* ------------------------------------------------------------------------ *
 * 极简 wire-schema 校验器（自包含替代品，语义对齐 zod 4）
 * ------------------------------------------------------------------------ */
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

class Schema {
  constructor(kind, options = {}) {
    this.kind = kind
    this.options = options
  }

  withOptions(patch) {
    return new Schema(this.kind, { ...this.options, ...patch })
  }

  optional() {
    return this.withOptions({ optional: true })
  }

  nullable() {
    return this.withOptions({ nullable: true })
  }

  nonnegative() {
    return this.withOptions({ min: 0 })
  }

  int() {
    return this.withOptions({ int: true })
  }

  strict() {
    return this.withOptions({ strict: true })
  }

  rest(inner) {
    return this.withOptions({ rest: inner })
  }

  safeParse(value) {
    const issues = []
    this.validate(value, '', issues)
    return issues.length === 0
      ? { success: true, data: value }
      : { success: false, error: { issues } }
  }

  issue(issues, path, code, message) {
    issues.push({ path, code, message })
  }

  validate(value, path, issues) {
    const { optional, nullable, strict, min, int, shape, item, items, rest, value: valueSchema } =
      this.options

    if (value === undefined) {
      if (optional !== true) this.issue(issues, path, 'required', `必填字段缺失（期望 ${this.kind}）`)
      return
    }
    if (value === null) {
      if (nullable !== true) this.issue(issues, path, 'invalid_type', `不允许 null（期望 ${this.kind}）`)
      return
    }

    switch (this.kind) {
      case 'any':
        return
      case 'string':
        if (typeof value !== 'string')
          this.issue(issues, path, 'invalid_type', `期望 string，实际 ${typeof value}`)
        return
      case 'boolean':
        if (typeof value !== 'boolean')
          this.issue(issues, path, 'invalid_type', `期望 boolean，实际 ${typeof value}`)
        return
      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          const actual = typeof value === 'number' ? String(value) : typeof value
          this.issue(issues, path, 'invalid_type', `期望有限 number，实际 ${actual}`)
          return
        }
        if (int === true && !Number.isInteger(value))
          this.issue(issues, path, 'invalid_type', `期望整数，实际 ${value}`)
        if (typeof min === 'number' && value < min)
          this.issue(issues, path, 'too_small', `期望 >= ${min}，实际 ${value}`)
        return
      }
      case 'array':
        if (!Array.isArray(value)) {
          this.issue(issues, path, 'invalid_type', `期望 array，实际 ${typeof value}`)
          return
        }
        value.forEach((entry, index) => item.validate(entry, `${path}[${index}]`, issues))
        return
      case 'record':
        if (!isPlainObject(value)) {
          this.issue(issues, path, 'invalid_type', `期望 object（record），实际 ${Array.isArray(value) ? 'array' : typeof value}`)
          return
        }
        for (const [key, entry] of Object.entries(value)) {
          valueSchema.validate(entry, path === '' ? key : `${path}.${key}`, issues)
        }
        return
      case 'tuple': {
        if (!Array.isArray(value)) {
          this.issue(issues, path, 'invalid_type', `期望 array（tuple），实际 ${typeof value}`)
          return
        }
        items.forEach((schema, index) => {
          const itemPath = `${path}[${index}]`
          if (index < value.length) schema.validate(value[index], itemPath, issues)
          else this.issue(issues, itemPath, 'required', '元组元素缺失')
        })
        for (let index = items.length; index < value.length; index += 1) {
          const itemPath = `${path}[${index}]`
          if (rest) rest.validate(value[index], itemPath, issues)
          else this.issue(issues, itemPath, 'unrecognized_keys', '元组不允许多余元素')
        }
        return
      }
      case 'object': {
        if (!isPlainObject(value)) {
          this.issue(issues, path, 'invalid_type', `期望 object，实际 ${Array.isArray(value) ? 'array' : typeof value}`)
          return
        }
        for (const [key, schema] of Object.entries(shape)) {
          schema.validate(value[key], path === '' ? key : `${path}.${key}`, issues)
        }
        if (strict === true) {
          for (const key of Object.keys(value)) {
            if (!Object.hasOwn(shape, key))
              this.issue(issues, path === '' ? key : `${path}.${key}`, 'unrecognized_keys', '不允许多余键（strict）')
          }
        }
        return
      }
      default:
        this.issue(issues, path, 'internal', `未知 schema 类型 ${this.kind}`)
    }
  }
}

/** 与 zod 的链式写法同形：z.string() / z.array(...) / z.object({...}).strict() … */
const z = {
  any: () => new Schema('any'),
  string: () => new Schema('string'),
  boolean: () => new Schema('boolean'),
  number: () => new Schema('number'),
  array: (item) => new Schema('array', { item }),
  record: (key, value) => new Schema('record', { value }),
  tuple: (items) => new Schema('tuple', { items }),
  object: (shape) => new Schema('object', { shape }),
}

/* ------------------------------------------------------------------------ *
 * 视图 wire schema（与 lib/index.js 输出一致）
 * ------------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------------ *
 * 校验器自检：固定 strict / 非负 / 必填 / 可选 / nullable / record / tuple 语义
 * （期望值与真实 zod 逐项比对过，见提交说明）
 * ------------------------------------------------------------------------ */
function selfTest() {
  const strictObject = z.object({ a: z.number().nonnegative(), b: z.string().optional() }).strict()
  const tuples = z.array(z.tuple([z.number(), z.number()]).rest(z.any()))
  const cases = [
    ['合法对象', () => strictObject.safeParse({ a: 0 }).success, true],
    ['缺必填（strict 对象）', () => strictObject.safeParse({}).success, false],
    ['负数（nonnegative）', () => strictObject.safeParse({ a: -1 }).success, false],
    ['多余键（strict）', () => strictObject.safeParse({ a: 1, extra: 1 }).success, false],
    ['字符串冒充数字', () => strictObject.safeParse({ a: '1' }).success, false],
    ['Infinity 不算 number', () => strictObject.safeParse({ a: Infinity }).success, false],
    ['NaN 不算 number', () => strictObject.safeParse({ a: Number.NaN }).success, false],
    ['小数不算 int', () => z.number().int().safeParse(1.5).success, false],
    ['可选字段可缺省', () => z.object({ b: z.string().optional() }).strict().safeParse({}).success, true],
    ['nullable 接受 null', () => z.object({ a: z.number() }).strict().nullable().safeParse(null).success, true],
    ['非 nullable 拒绝 null', () => z.object({ a: z.number() }).strict().safeParse(null).success, false],
    ['record 校验值', () => z.record(z.string(), z.number().nonnegative()).safeParse({ a: -1 }).success, false],
    ['record 拒绝数组', () => z.record(z.string(), z.number()).safeParse([1, 2]).success, false],
    ['tuple.rest 允许多余元素', () => tuples.safeParse([[1, 2, 'x']]).success, true],
    ['tuple 元素不足', () => tuples.safeParse([[1]]).success, false],
    // 承重语义：windows（lib/index.js:90 / 本文件:187）是无 .rest() 的二元 tuple，
    // 必须拒绝第 3 个元素，否则该字段会「测试假绿而 host 拒发视图」。
    ['无 .rest() 的二元 tuple 拒绝多余元素', () => z.array(z.tuple([z.number(), z.number()])).safeParse([[1, 2, 3]]).success, false],
  ]
  let bad = 0
  for (const [label, run, want] of cases) {
    const got = run()
    if (got !== want) {
      bad += 1
      console.log(`  ✗ 校验器自检「${label}」：期望 ${want}，实际 ${got}`)
    }
  }
  console.log(
    bad === 0
      ? `校验器自检: 通过（${cases.length} 项）`
      : `校验器自检: ${bad}/${cases.length} 项失败`,
  )
  return bad
}

/* ------------------------------------------------------------------------ *
 * 投影真实输出校验
 * ------------------------------------------------------------------------ */
const ev = (type, data, extra = {}) => ({ type, data, seq: 0, time: 0, ...extra })
/** 2026-08-16 01:30 UTC = 北京时间 09:30，高峰窗口内。 */
const PEAK_MS = Date.UTC(2026, 7, 16, 1, 30)
/** 2026-08-16 05:00 UTC = 北京时间 13:00，两个高峰窗口之间（错峰）。 */
const OFF_PEAK_MS = Date.UTC(2026, 7, 16, 5, 0)
const html = readFileSync(new URL('./fixtures/deepseek-pricing.html', import.meta.url), 'utf8')
const fetched = parseDeepSeekPricingHtml(html)

let failed = 0

function validate(label, spec, at = PEAK_MS) {
  const parts = createTokenBillingProjectionParts(spec)
  let state = parts.init()
  state = parts.apply(state, ev('turn/start', { turn: 1 }, { seq: 1, time: at }))
  state = parts.apply(state, ev('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' }, system: 'sys' }, reason: 'initial' }, { seq: 2, time: at }))
  state = parts.apply(state, ev('step/start', { turn: 1, step: 0 }, { seq: 3, time: at }))
  state = parts.apply(state, ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'abc' } }, { seq: 4, time: at }))
  let result = viewSchema.safeParse(parts.view(state))
  console.log(`${label}·进行中:`, result.success ? '通过' : '失败\n' + JSON.stringify(result.error.issues, null, 1))
  if (!result.success) failed += 1

  state = parts.apply(state, ev('assistant/message', { turn: 1, step: 0, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 20 } }, { surfaceOp: 'append', seq: 5, time: at }))
  state = parts.apply(state, ev('step/end', { turn: 1, step: 0 }, { seq: 6, time: at }))
  state = parts.apply(state, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 7, time: at }))
  result = viewSchema.safeParse(parts.view(state))
  console.log(`${label}·结算后:`, result.success ? '通过' : '失败\n' + JSON.stringify(result.error.issues, null, 1))
  if (!result.success) failed += 1
}

failed += selfTest()

// 场景 1：仅内置表（¥）
validate('仅内置表', resolveBillingSpec({}))

// 场景 2：官网抓取生效后（高峰价，$ 多币种）
const specFetched = resolveBillingSpec({})
applyFetchedPrices(specFetched, fetched, Date.UTC(2026, 7, 17, 0))
validate('官网高峰价', specFetched)

// 场景 3：同一份多币种价表在错峰时段生效（peakActive=false 分支）
validate('官网错峰价', specFetched, OFF_PEAK_MS)

console.log(failed === 0 ? '\nschema 校验全部通过' : `\n${failed} 处失败`)
process.exit(failed === 0 ? 0 : 1)
