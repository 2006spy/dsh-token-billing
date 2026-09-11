/**
 * dsh-token-billing — 纯投影与计费数学（零依赖，可在 Node 中单独测试）。
 *
 * 该文件不 import 任何 dsh 包：投影定义的 init/apply/view 是纯同步函数，
 * 由宿主端 (index.js) 组装成 ProjectionDefinition 注册进 sessionProjections。
 * 状态必须保持为普通 JSON（持久化投影缓存的前置条件）。
 *
 * 计费口径：
 *  - 价格表以「每 1M token」计价，字段 input(未缓存) / output / cacheRead / cacheWrite；
 *  - 每条价格可带独立 currency；会话按币种分别累计费用；
 *  - 支持高峰/错峰计费（DeepSeek 官方：高峰 01:00-04:00 与 06:00-10:00 UTC，
 *    其余时段错峰半价）：时段内用高峰价，时段外用错峰价（或 高峰价×折扣率）；
 *  - 流式进行中（未收到精确 usage）用字符/4 启发式估算并标记 estimated；
 *    收到 usage 后立刻替换为精确值；被中断的估算步骤自动退款。
 */
import { fetchedToFlat, peakActive, currencySymbol, canonicalModelId, modelTier } from './prices.js'

export { canonicalModelId, modelTier }

/** 估算器默认参数（与 dsh-live-stats 保持一致）。 */
export const ESTIMATOR = { charsPerToken: 4, blockOverhead: 4, roleOverhead: 4 }

/**
 * 内置价格表（默认货币，通常为 ¥ / 1M token）。
 * 数值为 DeepSeek 官方「空闲价」（2026-09-10 12:00 起的现行价）；
 * 高峰价见 BUILTIN_PEAK_PRICES，按消息时刻由 PRICE_POLICY_TIMELINE 选择生效政策。
 * 官网抓取到的价格会覆盖内置表；用户「模型价格覆盖」优先级最高。
 */
export const BUILTIN_PRICES = {
  'deepseek-chat': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  'deepseek-reasoner': { input: 4, output: 16, cacheRead: 1, cacheWrite: 4 },
  // DeepSeek Flash（官方现名 deepseek-flash；旧名 deepseek-v4-flash 等按 Flash 价计费）
  'deepseek-flash': { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 1 },
  // DeepSeek V4 Pro
  'deepseek-v4-pro': { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 4.5 },
  'glm-4v-flash': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'glm-4v-plus': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  'glm-4.5-flash': { input: 0.6, output: 6, cacheRead: 0.3, cacheWrite: 0.6 },
  'glm-4.5-air': { input: 0.6, output: 6, cacheRead: 0.3, cacheWrite: 0.6 },
  'qwen-vl-plus': { input: 1.5, output: 10, cacheRead: 0.5, cacheWrite: 1.5 },
  'qwen3-vl-plus': { input: 1.5, output: 10, cacheRead: 0.5, cacheWrite: 1.5 },
  'qwen3-coder-plus': { input: 1.5, output: 10, cacheRead: 0.5, cacheWrite: 1.5 },
}

/**
 * 内置高峰价表（¥/1M，官方现行高峰价；空闲价见 BUILTIN_PRICES）。
 * 仅在无官网抓取高峰表时由价格政策时间线使用。
 */
export const BUILTIN_PEAK_PRICES = {
  'deepseek-flash': { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 },
  'deepseek-v4-pro': { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 9 },
}

/** fallback 默认价（每 1M token，官方现行 DeepSeek Flash 空闲价）。 */
export const DEFAULT_FALLBACK = { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 1 }

/** 价格政策时间线使用的货币（内置时间线为人民币）。 */
export const POLICY_CURRENCY = '¥'

/** 默认外币→人民币汇率（1 USD = 7.2 CNY），可在设置中调整。 */
export const DEFAULT_FX_RATE = 7.2

/**
 * 官方默认高峰窗口（北京时间分钟；第 3 位为星期几限定 days，0=周日…6=周六，缺省 = 每天）。
 * DeepSeek：北京时间 09:00-12:00 与 14:00-18:00，仅周一至周五（2026-08-23 起周末全天空闲价）。
 */
export const DEFAULT_PEAK_WINDOWS = [['09:00', '12:00', [1, 2, 3, 4, 5]], ['14:00', '18:00', [1, 2, 3, 4, 5]]]

/** 官方默认高峰窗口时区（北京时间；窗口分钟与星期几均按此日历读）。 */
export const DEFAULT_PEAK_TZ = 'Asia/Shanghai'

/** 官方周末空闲价生效时刻（UTC 绝对时刻）。此前的周末仍按高峰价计费，历史回看不得减半。 */
export const DEFAULT_WEEKEND_OFFPEAK_AT = Date.UTC(2026, 7, 22, 16)

/** 官方默认错峰折扣率（错峰 = 高峰 × 0.5）。 */
export const DEFAULT_PEAK_RATE = 0.5

/** 高峰/错峰默认适用模型（glob）。 */
export const DEFAULT_PEAK_MODELS = ['deepseek-*']

/**
 * 旧版 Config 默认高峰窗口（UTC，无星期几限定）。
 * 与内置默认（北京时间 + 周一至周五）语义等价：都表示「跟随官方默认」，
 * windowsAreDefault 必须同时认这两种写法，否则用户端官网窗口（带工作日）会被拒绝应用，
 * 2026-08-23 起的「周末全天空闲」规则随之失效。
 */
export const LEGACY_DEFAULT_PEAK_WINDOWS = [['01:00', '04:00'], ['06:00', '10:00']]

/**
 * 官方价格政策时间线（¥/1M token，条目按 since 升序；since=null 表示最早一段）。
 * 每个条目描述该政策生效后 flash/pro 档的价格：flat（平价）或 peak（高峰价，
 * 空闲价 = peak × offPeakRate）。取价按「消息发生时刻」选择生效段，
 * 历史回看不被新规追溯改写：
 *  - 2026-08-17 00:00（北京）起启用峰谷定价：flash 高峰 ¥0.10/3/9，pro 高峰 ¥0.30/9/27；
 *  - 2026-08-23 00:00（北京）起高峰仅周一至周五（周末全天空闲价，由窗口 days 表达）；
 *  - 2026-09-10 12:00（北京）起 Flash 新价：高峰 ¥0.04/2/8，空闲 ¥0.02/1/4；pro 不变。
 */
export const PRICE_POLICY_TIMELINE = [
  {
    since: null,
    label: '平价阶段（2026-08-17 峰谷定价前）',
    models: {
      'deepseek-flash': { flat: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1 } },
      'deepseek-v4-pro': { flat: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3 } },
    },
  },
  {
    since: Date.UTC(2026, 7, 16, 16), // 北京时间 2026-08-17 00:00
    label: '2026-08-17 起峰谷定价',
    models: {
      'deepseek-flash': { peak: { input: 3, output: 9, cacheRead: 0.1, cacheWrite: 3 } },
      'deepseek-v4-pro': { peak: { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 9 } },
    },
  },
  {
    since: Date.UTC(2026, 8, 10, 4), // 北京时间 2026-09-10 12:00
    label: '2026-09-10 12:00 起 Flash 新价',
    models: {
      'deepseek-flash': { peak: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 } },
      'deepseek-v4-pro': { peak: { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 9 } },
    },
  },
]

/**
 * Provider 收费形式（metering，参考 dsh-web-billing / dsh-spend 的订阅/免费分类）：
 *  - usage        按量：按官方/配置价实算花费（默认）
 *  - subscription 订阅：月付固定费，调用实际花费计 0，官方名义价折算为「回本/节省」
 *  - free         活动免费：调用实际花费计 0（真正白嫖）
 *  - local        本地部署：调用实际花费计 0（或按 localCostPerM），省的是 API 钱
 * 统计层据此把「实际花费」与「名义价值」分开，差额即节省/回本。
 */
export const PROVIDER_MODES = ['usage', 'subscription', 'free', 'local']

/** 默认收费形式（未匹配任何 providerModes 时）。 */
export const DEFAULT_PROVIDER_MODE = 'usage'

/* ------------------------------------------------------------------ */
/* 估算                                                               */
/* ------------------------------------------------------------------ */

/** 估算一段文本块的 token 数。 */
export function estimateTextBlockTokens(characters) {
  return Math.ceil(characters / ESTIMATOR.charsPerToken) + ESTIMATOR.blockOverhead
}

/** 估算一次工具调用的 token 数。 */
export function estimateToolCallBlockTokens(nameCharacters, argumentCharacters) {
  return Math.ceil((nameCharacters + argumentCharacters) / ESTIMATOR.charsPerToken) + ESTIMATOR.blockOverhead
}

/** 估算一条消息的 token 数（content 各块之和 + 角色开销）。 */
export function estimateMessageTokens(message) {
  let chars = 0
  let blocks = 0
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' || block?.type === 'reasoning') {
      chars += (block.text ?? '').length
      blocks += 1
    } else if (block?.type === 'tool-call') {
      chars += (block.name ?? '').length + (block.arguments ?? '').length
      blocks += 1
    } else if (block?.type === 'tool-result') {
      try { chars += JSON.stringify(block).length } catch { /* ignore */ }
      blocks += 1
    }
  }
  if (blocks === 0) return 0
  return Math.ceil(chars / ESTIMATOR.charsPerToken) + blocks * ESTIMATOR.blockOverhead + ESTIMATOR.roleOverhead
}

/** 估算请求头（系统提示 + 工具 schema）的 token 数。 */
export function estimateHeaderTokens(header) {
  let total = 0
  if (header?.system && header.system.length > 0) {
    total += Math.ceil(header.system.length / ESTIMATOR.charsPerToken) + ESTIMATOR.blockOverhead
  }
  if (header?.tools && header.tools.length > 0) {
    try { total += Math.ceil(JSON.stringify(header.tools).length / ESTIMATOR.charsPerToken) + ESTIMATOR.blockOverhead } catch { /* ignore */ }
  }
  return total
}

/* ------------------------------------------------------------------ */
/* 计价                                                               */
/* ------------------------------------------------------------------ */

/** 按价格表计算四个桶的金额（token 数 × 单价 / 1M）。 */
export function costOf(buckets, price) {
  return (
    (buckets.uncachedInputTokens ?? 0) * price.input
    + (buckets.outputTokens ?? 0) * price.output
    + (buckets.cacheReadTokens ?? 0) * price.cacheRead
    + (buckets.cacheWriteTokens ?? 0) * price.cacheWrite
  ) / 1_000_000
}

/** 解析一份价格覆盖项（可只填部分字段，缺省字段由调用方回填）。非法值返回 null。 */
export function normalizePriceEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const out = {}
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const raw = entry[key]
    if (raw === undefined) continue
    const v = Number(raw)
    if (!Number.isFinite(v) || v < 0) return null
    out[key] = v
  }
  return out
}

/** 模型名归一化键。 */
function modelKey(model) {
  return String(model ?? '').trim().toLowerCase()
}

/** glob（* 与 ?）转正则。 */
export function globToRegExp(pattern) {
  let re = '^'
  for (const ch of String(pattern ?? '')) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(re + '$')
}

/** 名称是否匹配任一 glob。 */
export function globAny(patterns, name) {
  const n = modelKey(name)
  return (patterns ?? []).some((p) => globToRegExp(p).test(n))
}

/** 计算某时刻在指定时区的「当日分钟数」（如 01:30 → 90）。时区无效退回 UTC。 */
export function minuteInTz(atMs, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(atMs)
    let h = 0
    let m = 0
    for (const p of parts) {
      if (p.type === 'hour') h = Number(p.value) % 24
      else if (p.type === 'minute') m = Number(p.value)
    }
    return h * 60 + m
  } catch {
    const d = new Date(atMs)
    return d.getUTCHours() * 60 + d.getUTCMinutes()
  }
}

/** 计算某时刻在指定时区的星期几（0=周日 … 6=周六）。与 minuteInTz 同源（同一 tz），时区无效退回 UTC。 */
export function weekdayInTz(atMs, tz) {
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short',
    }).formatToParts(atMs)
    for (const p of parts) {
      if (p.type === 'weekday' && DOW[p.value] !== undefined) return DOW[p.value]
    }
    return new Date(atMs).getUTCDay()
  } catch {
    return new Date(atMs).getUTCDay()
  }
}

/**
 * 某时刻是否落在任一窗口内（支持跨零点窗口，如 22:00-02:00）。
 * 窗口可为 [起分, 止分] 或 [起分, 止分, days]；days 为星期几集合（0=周日…6=周六），缺省 = 每天。
 * days 按「当前时刻在 tz 中的星期几」判断（勿用 getUTCDay，避免 UTC/本地两本日历分歧）。
 * ignoreDays 为 true 时忽略 days（周末空闲规则生效前使用，历史回看不减半）。
 */
export function inWindow(atMs, windows, tz, ignoreDays = false) {
  if (!windows || windows.length === 0) return false
  const now = minuteInTz(atMs, tz)
  const dow = weekdayInTz(atMs, tz)
  for (const w of windows) {
    const s = w[0]
    const e = w[1]
    const days = w[2]
    if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) continue
    if (!ignoreDays && Array.isArray(days) && days.length > 0 && !days.includes(dow)) continue
    if (s < e) {
      if (now >= s && now < e) return true
    } else if (now >= s || now < e) {
      return true
    }
  }
  return false
}

/** 是否早于周末空闲规则生效时刻（此时星期几限定不生效，历史回看不减半）。 */
function isBeforeWeekendRule(pk, atMs) {
  return pk !== null && pk.effectiveAt !== null && pk.effectiveAt !== undefined && atMs < pk.effectiveAt
}

/** 解析 "HH:MM" 为分钟数。 */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (m === null) return NaN
  return Number(m[1]) * 60 + Number(m[2])
}

/** 解析高峰窗口配置（JSON 字符串或数组），返回分钟对列表（可带第 3 位 days：0=周日…6=周六）。非法回退官方默认。 */
export function parsePeakWindows(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((w) => {
        if (!Array.isArray(w) || w.length < 2) return [NaN, NaN]
        const s = toMinutes(w[0])
        const e = toMinutes(w[1])
        const days = Array.isArray(w[2])
          ? [...new Set(w[2].map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
          : undefined
        const out = [s, e]
        if (days !== undefined && days.length > 0) out.push(days)
        return out
      })
      .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s !== e)
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsePeakWindows(parsed)
    } catch { /* 落到默认 */ }
  }
  return parsePeakWindows(DEFAULT_PEAK_WINDOWS)
}

/** 解析适用模型列表（JSON 数组或逗号分隔字符串）。 */
export function parseModelList(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
      } catch { /* 落到逗号分隔 */ }
    }
    return trimmed.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  }
  return []
}

/** 在价格表中按模型名查找：归一化键 → 原样键 → 归一化后同键（兼容历史脏 key，如 'deepseek-flash(1)'）。 */
export function lookupByModel(table, model) {
  if (table === undefined || table === null) return undefined
  const key = canonicalModelId(model)
  if (table[key] !== undefined) return table[key]
  const raw = modelKey(model)
  if (raw !== key && table[raw] !== undefined) return table[raw]
  for (const k of Object.keys(table)) {
    if (canonicalModelId(k) === key) return table[k]
  }
  return undefined
}

/** 取某个模型的基础价格（合并表；不含高峰/错峰）。 */
export function priceEntry(model, spec) {
  const entry = lookupByModel(spec.prices, model)
  if (entry !== undefined) return entry
  return { ...(spec.fallback ?? {}), currency: spec.fallback?.currency ?? spec.currency }
}

/** 某时刻生效的价格政策段索引（since 升序；早于首条用首条）。 */
export function policySegmentIndex(atMs) {
  let idx = 0
  for (let i = 0; i < PRICE_POLICY_TIMELINE.length; i += 1) {
    const since = PRICE_POLICY_TIMELINE[i].since
    if (since === null || since <= atMs) idx = i
  }
  return idx
}

/** 某时刻某模型命中的价格政策段；模型不在时间线内返回 null。 */
export function policyPriceAt(model, atMs) {
  const key = canonicalModelId(model)
  const index = policySegmentIndex(atMs)
  const segment = PRICE_POLICY_TIMELINE[index]
  const entry = segment?.models?.[key]
  if (entry === undefined) return null
  return { key, index, isLatest: index === PRICE_POLICY_TIMELINE.length - 1, segment, model: entry }
}

/**
 * 内置价格政策时间线取价。返回 null 表示该模型/该时刻不走时间线，继续走抓取/合并表。
 *
 * 规则（「按消息发生时刻取价」+「历史回看不被新规追溯改写」）：
 *  - 仅当该模型当前生效价条目为人民币（¥）时启用内置时间线；外币抓取价（英文页 / 关闭 fx）原样使用；
 *  - 非最新政策段一律用内置历史价——即使已抓到新价，也不追溯改写历史消息的计价；
 *  - 最新政策段若已有官网抓取价（人民币），交给抓取表，从而可跟随官网未来调价；
 *  - 平价段直接返回 flat；峰谷段按窗口判峰，空闲价缺省 = 高峰价 × offPeakRate。
 */
export function priceAtPolicy(spec, model, atMs) {
  const hit = policyPriceAt(model, atMs)
  if (hit === null) return null
  const base = spec.prices?.[hit.key]
  const currency = base === undefined ? (spec.currency ?? POLICY_CURRENCY) : (base.currency ?? spec.currency)
  if (currency !== POLICY_CURRENCY) return null
  const currencyOf = spec.currency ?? POLICY_CURRENCY
  const withCurrency = (e) => ({
    input: e.input,
    output: e.output,
    cacheRead: e.cacheRead,
    cacheWrite: e.cacheWrite,
    currency: e.currency ?? currencyOf,
  })
  const m = hit.model
  if (m.flat !== undefined) return withCurrency(m.flat)
  if (hit.isLatest && spec.fetchedModels?.[hit.key] === true) return null
  const rate = Number.isFinite(spec.peak?.rate) && spec.peak.rate >= 0 ? spec.peak.rate : DEFAULT_PEAK_RATE
  const offPeak = m.offPeak ?? {
    input: m.peak.input * rate,
    output: m.peak.output * rate,
    cacheRead: m.peak.cacheRead * rate,
    cacheWrite: m.peak.cacheWrite * rate,
  }
  const pk = spec.peak
  const peakApplies = pk !== null && pk !== undefined && pk.enabled === true && globAny(pk.models, hit.key)
  if (!peakApplies) return withCurrency(offPeak)
  const inPeak = inWindow(atMs, pk.windows, pk.tz, isBeforeWeekendRule(pk, atMs))
  return withCurrency(inPeak ? m.peak : offPeak)
}

/**
 * 某时刻某模型的生效价格（含高峰/错峰）。
 * 优先级：用户覆盖（overrides，钉死）> 该 provider 的价格表 > 内置价格政策时间线 > 全局表 > fallback。
 * provider 表项不参与高峰/错峰（同用户覆盖，固定价）；全局表命中的模型保持现有高峰/错峰逻辑。
 *
 * 重要：provider 未命中时**不再**扫描其它 provider 的同名模型价（不跨 provider 串价），
 * 而是回落全局表/官方政策链——聚合网关会中转同名真实模型，串价会给出错误单价。
 * @param provider - 当前 provider 字符串（可为 ''，表示未知/无 provider，回落全局表）。
 */
export function priceAt(provider, model, spec, atMs) {
  // 向后兼容旧签名：priceAt(model, spec, atMs)
  if (model !== null && typeof model === 'object' && typeof spec === 'number') {
    atMs = spec
    spec = model
    model = provider
    provider = ''
  }
  const key = canonicalModelId(model)
  const override = lookupByModel(spec.overrides, model)
  if (override !== undefined) {
    return { ...override, currency: override.currency ?? spec.currency }
  }
  if (typeof provider === 'string' && provider !== '') {
    const prov = lookupByModel(spec.providerPrices?.[provider], model)
    if (prov !== undefined) {
      return { ...prov, currency: prov.currency ?? spec.currency }
    }
  }
  // 内置价格政策时间线：按消息时刻取价，历史回看不被新规追溯改写
  const policy = priceAtPolicy(spec, model, atMs)
  if (policy !== null) return policy
  const base = priceEntry(model, spec)
  const pk = spec.peak
  if (pk === null || pk === undefined || !pk.enabled || !globAny(pk.models, key)) return base
  const peakEntry = lookupByModel(pk.prices, model)
  if (peakEntry === undefined) return base
  const inPeak = inWindow(atMs, pk.windows, pk.tz, isBeforeWeekendRule(pk, atMs))
  if (inPeak) return peakEntry
  const off = lookupByModel(pk.offPeakPrices, model)
  if (off !== undefined) return off
  const rate = Number.isFinite(pk.rate) && pk.rate >= 0 ? pk.rate : DEFAULT_PEAK_RATE
  return {
    input: peakEntry.input * rate,
    output: peakEntry.output * rate,
    cacheRead: peakEntry.cacheRead * rate,
    cacheWrite: peakEntry.cacheWrite * rate,
    currency: peakEntry.currency ?? spec.currency,
  }
}

/**
 * 解析「provider → 价格 URL」映射（JSON 字符串，如 {"opencode-go":"https://…"}）。
 * 空串或 '{}' 返回 {}；坏 JSON 抛错（与 prices 覆盖一致）。
 */
export function parseProviderUrlMap(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '' || s === '{}') return {}
  let parsed
  try {
    parsed = JSON.parse(s)
  } catch (err) {
    throw new Error(`token-billing: providerPriceUrls 不是合法 JSON（${err.message}）`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('token-billing: providerPriceUrls 必须是 { "provider": "https://…" } 对象')
  }
  const out = {}
  for (const [provider, url] of Object.entries(parsed)) {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) out[provider] = url
  }
  return out
}

/**
 * 从配置解析计费规格（不含抓取价格）。配置形状（settings 命名空间 token-billing）：
 *   enabled / currency / fallback 四个默认价 / prices 覆盖（见 README）
 *   priceSource/customPriceUrl/refreshHours（价格来源）
 *   providerPriceUrls（按 provider 的 URL 抓取覆盖，JSON 字符串）
 *   offPeakEnabled/offPeakWindows/offPeakRate/offPeakModels/offPeakTz/offPeakForce（高峰/错峰）
 * @returns 计费规格；非法配置抛错。
 */
export function resolveBillingSpec(config = {}) {
  const currency = typeof config.currency === 'string' && config.currency.length > 0 ? config.currency : '¥'
  const source = typeof config.priceSource === 'string' && config.priceSource.length > 0 ? config.priceSource : 'deepseek'
  const offPeakModels = parseModelList(config.offPeakModels)
  const spec = {
    enabled: config.enabled !== false,
    currency,
    source,
    customPriceUrl: typeof config.customPriceUrl === 'string' ? config.customPriceUrl : '',
    refreshHours: numOr(config.refreshHours, 1),
    fx: {
      enabled: config.fxEnabled !== false,
      rate: numOr(config.fxRate, DEFAULT_FX_RATE),
    },
    fallback: {
      input: numOr(config.fallbackInput, DEFAULT_FALLBACK.input),
      output: numOr(config.fallbackOutput, DEFAULT_FALLBACK.output),
      cacheRead: numOr(config.fallbackCacheRead, DEFAULT_FALLBACK.cacheRead),
      cacheWrite: numOr(config.fallbackCacheWrite, DEFAULT_FALLBACK.cacheWrite),
      currency,
    },
    overrides: {},
    prices: {},
    providerPrices: {},
    providerSources: {},
    /** 已由官网抓取/自定义端点写入全局表的模型键（用于政策时间线判断是否让位给抓取价）。 */
    fetchedModels: {},
    /** 内置价格政策时间线（只读参考，取价逻辑见 priceAtPolicy）。 */
    policyTimeline: PRICE_POLICY_TIMELINE,
    providerPriceUrls: parseProviderUrlMap(config.providerPriceUrls),
    providerModes: parseProviderModes(config.providerModes),
    peak: {
      enabled: config.offPeakEnabled !== false,
      force: config.offPeakForce === true,
      tz: typeof config.offPeakTz === 'string' && config.offPeakTz.length > 0 ? config.offPeakTz : DEFAULT_PEAK_TZ,
      rate: numOr(config.offPeakRate, DEFAULT_PEAK_RATE),
      models: offPeakModels.length > 0 ? offPeakModels : DEFAULT_PEAK_MODELS,
      windows: parsePeakWindows(config.offPeakWindows),
      // 周末空闲规则的生效时刻；此前的周末仍按高峰价（历史回看不减半）。抓取官网后由 fetched.peak.effectiveAt 覆盖。
      effectiveAt: DEFAULT_WEEKEND_OFFPEAK_AT,
      prices: {},
      offPeakPrices: {},
    },
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (!Number.isFinite(spec.fallback[key]) || spec.fallback[key] < 0) {
      throw new Error(`token-billing: fallback${key} 必须是大于等于 0 的数字`)
    }
  }
  if (!Number.isFinite(spec.peak.rate) || spec.peak.rate < 0 || spec.peak.rate > 1) {
    throw new Error('token-billing: offPeakRate 必须是 0~1 之间的数字')
  }
  if (!Number.isFinite(spec.fx.rate) || spec.fx.rate <= 0) {
    throw new Error('token-billing: fxRate 必须是大于 0 的数字')
  }
  // 内置表作为初始合并表（每项带默认货币）
  for (const [model, entry] of Object.entries(BUILTIN_PRICES)) {
    spec.prices[model] = { ...entry, currency }
  }
  // 用户覆盖
  const rawPrices = typeof config.prices === 'string' ? config.prices.trim() : ''
  if (rawPrices !== '' && rawPrices !== '{}') {
    let parsed
    try {
      parsed = JSON.parse(rawPrices)
    } catch (err) {
      throw new Error(`token-billing: prices 不是合法 JSON（${err.message}）`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('token-billing: prices 必须是 { "模型": {input,output,cacheRead,cacheWrite} } 对象')
    }
    for (const [model, entry] of Object.entries(parsed)) {
      const partial = normalizePriceEntry(entry)
      if (partial === null) {
        throw new Error(`token-billing: prices 中 "${model}" 的价格项无效（需要非负数字 input/output/cacheRead/cacheWrite）`)
      }
      const key = canonicalModelId(model)
      const base = spec.prices[key] ?? spec.fallback
      const merged = {
        input: partial.input ?? base.input,
        output: partial.output ?? base.output,
        cacheRead: partial.cacheRead ?? base.cacheRead,
        cacheWrite: partial.cacheWrite ?? base.cacheWrite,
      }
      spec.overrides[key] = { ...merged, currency: typeof entry.currency === 'string' && entry.currency.length > 0 ? entry.currency : currency }
      spec.prices[key] = spec.overrides[key]
    }
  }
  return spec
}

/**
 * 把抓取到的价格并入规格（抓取 > 内置；用户覆盖仍然最高，且不参与高峰/错峰）。
 * 写入前统一用 canonicalModelId 归一化模型键：官方页脚注（'deepseek-flash(1)'）与旧模型名
 * （'deepseek-v4-flash'）都不会落进全局表 / provider 桶，价格缓存也不会再落脏 key。
 * @param spec - resolveBillingSpec 的产物。
 * @param fetched - fetchDeepSeekPrices / fetchJsonPrices 的产物，或 null。
 * @param now - 计价时刻。
 * @param provider - 非空时把价格写入该 provider 的表（spec.providerPrices[provider]），
 *                   否则按现状写入全局 spec.prices 并处理高峰/错峰。
 */
export function applyFetchedPrices(spec, fetched, now = Date.now(), provider = null) {
  if (fetched === null || typeof fetched !== 'object') return spec
  if (spec.fetchedModels === undefined || spec.fetchedModels === null) spec.fetchedModels = {}
  const flat = fetchedToFlat(fetched, spec.peak.force, now)
  if (typeof provider === 'string' && provider !== '') {
    const bucket = (spec.providerPrices[provider] ??= {})
    for (const [model, entry] of Object.entries(flat)) {
      const key = canonicalModelId(model)
      if (spec.overrides[key] !== undefined) continue
      bucket[key] = convertEntry(spec, entry)
    }
    spec.providerSources[provider] = 'custom-json'
    return spec
  }
  for (const [model, entry] of Object.entries(flat)) {
    const key = canonicalModelId(model)
    if (spec.overrides[key] !== undefined) continue
    spec.prices[key] = convertEntry(spec, entry)
    spec.fetchedModels[key] = true
  }
  if (spec.peak !== null && fetched.peak !== null && peakActive(fetched, spec.peak.force, now)) {
      // 自动跟随官网的高峰窗口与时区（用户未自定义窗口/时区时）
      const fetchedWindows = (fetched.peak.windows ?? [])
        .map((w) => {
          if (!Array.isArray(w) || w.length < 2) return [NaN, NaN]
          const out = [toMinutes(w[0]), toMinutes(w[1])]
          if (Array.isArray(w[2]) && w[2].length > 0) out.push(w[2])
          return out
        })
        .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s !== e)
      // 默认窗口的等价写法（旧 Config 的 UTC 窗口 / 北京无 days）也视为未自定义，
      // 否则官网窗口（带工作日）永远进不来，2026-08-23 起的周末空闲规则会失效。
      if (fetchedWindows.length > 0 && windowsAreDefault(spec.peak.windows, spec.peak.tz)) {
        spec.peak.windows = fetchedWindows
      }
      if (fetched.peak.effectiveAt !== null && fetched.peak.effectiveAt !== undefined) {
        spec.peak.effectiveAt = fetched.peak.effectiveAt
      }
      // 时区同步：默认等价时区（Asia/Shanghai / 旧 Config 的 UTC）才跟随官网窗口的日历
      if (fetched.peak.tz !== null && fetched.peak.tz !== undefined && tzIsDefault(spec.peak.tz)) {
        spec.peak.tz = fetched.peak.tz
      }
      const currencyOf = currencySymbol(fetched.currency ?? spec.currency)
      for (const [model, entry] of Object.entries(fetched.peak.models)) {
        const key = canonicalModelId(model)
        if (spec.overrides[key] !== undefined) continue
        spec.peak.prices[key] = convertEntry(spec, {
          ...entry,
          currency: entry.currency === undefined ? currencyOf : currencySymbol(entry.currency),
        })
        spec.fetchedModels[key] = true
      }
      for (const [model, entry] of Object.entries(fetched.peak.offPeak ?? {})) {
        const key = canonicalModelId(model)
        if (spec.overrides[key] !== undefined) continue
        spec.peak.offPeakPrices[key] = convertEntry(spec, {
          ...entry,
          currency: entry.currency === undefined ? currencyOf : currencySymbol(entry.currency),
        })
      }
    }
  return spec
}

/**
 * 解析「provider + model 显式价目」配置（JSON 字符串）：
 *   { "mxy": { "deepseek-v4-flash-0731": { "input": 1, "output": 4, "cacheRead": 0.02, "cacheWrite": 1, "currency": "¥" } } }
 * 空串 / '{}' 返回 {}；坏 JSON 或非法值抛错（与 prices / providerModes 同样严格）。
 * 这是设置卡「按路由价目」编辑器的持久化形态：用户为某个中转 provider 的某个模型钉死单价。
 * 单项可只填部分字段，缺省字段由 applyProviderPriceOverrides 按全局表回填。
 */
export function parseProviderPricesConfig(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '' || s === '{}') return {}
  let parsed
  try {
    parsed = JSON.parse(s)
  } catch (err) {
    throw new Error(`token-billing: providerPrices 不是合法 JSON（${err.message}）`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('token-billing: providerPrices 必须是 { "provider": { "模型": {input,output,cacheRead,cacheWrite} } } 对象')
  }
  const out = {}
  for (const [provider, models] of Object.entries(parsed)) {
    const p = String(provider ?? '').trim()
    if (p === '' || models === null || typeof models !== 'object' || Array.isArray(models)) continue
    const bucket = {}
    for (const [model, entry] of Object.entries(models)) {
      const m = String(model ?? '').trim()
      if (m === '') continue
      const partial = normalizePriceEntry(entry)
      if (partial === null) {
        throw new Error(`token-billing: providerPrices 中 "${p}.${m}" 的价格项无效（需要非负数字 input/output/cacheRead/cacheWrite）`)
      }
      bucket[m] = {
        ...partial,
        currency: typeof entry?.currency === 'string' && entry.currency.length > 0 ? entry.currency : undefined,
      }
    }
    if (Object.keys(bucket).length > 0) out[p] = bucket
  }
  return out
}

/**
 * 把显式 provider 价目并入规格，来源标为 'override'。
 * 优先级：全局 `prices` 覆盖（钉死）> 本显式价目 > URL 抓取 > 三层 catalog 价 > 官方政策链。
 * 未填的字段按该模型的全局生效价（或 fallback）回填，避免出现 NaN。
 */
export function applyProviderPriceOverrides(spec, map) {
  if (map === null || typeof map !== 'object') return spec
  const overrides = spec.overrides ?? {}
  for (const [provider, models] of Object.entries(map)) {
    if (models === null || typeof models !== 'object') continue
    const filled = {}
    for (const [model, entry] of Object.entries(models)) {
      const key = canonicalModelId(model)
      if (overrides[key] !== undefined) continue // 全局钉死优先
      const base = spec.prices?.[key] ?? spec.fallback ?? DEFAULT_FALLBACK
      filled[model] = {
        input: entry.input ?? base.input,
        output: entry.output ?? base.output,
        cacheRead: entry.cacheRead ?? base.cacheRead,
        cacheWrite: entry.cacheWrite ?? base.cacheWrite,
        currency: entry.currency ?? spec.currency,
      }
    }
    applyProviderPrices(spec, provider, filled, 'override')
  }
  return spec
}

/**
 * 解析「provider 收费形式」配置（JSON 字符串，如
 * `{"opencode-go":"subscription","myapi":"usage","local*":"local","*free*":"free"}`）。
 * 空串 / '{}' 返回空数组；坏 JSON 抛错（与 prices 覆盖一致）。
 * 返回 [{ pattern, mode }] 列表，保持声明顺序（精确匹配优先于 glob）。
 */
export function parseProviderModes(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '' || s === '{}') return []
  let parsed
  try {
    parsed = JSON.parse(s)
  } catch (err) {
    throw new Error(`token-billing: providerModes 不是合法 JSON（${err.message}）`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('token-billing: providerModes 必须是 { "provider模式": "usage|subscription|free|local" } 对象')
  }
  const out = []
  for (const [pattern, mode] of Object.entries(parsed)) {
    const m = String(mode ?? '').toLowerCase()
    if (!PROVIDER_MODES.includes(m)) {
      throw new Error(`token-billing: providerModes 中 "${pattern}" 的模式 "${mode}" 无效（可选 ${PROVIDER_MODES.join('/')}）`)
    }
    if (String(pattern).trim() !== '') out.push({ pattern: String(pattern), mode: m })
  }
  return out
}

/**
 * 某 provider 的收费形式（默认 usage）。
 * 匹配规则：先精确匹配，再按声明顺序 glob 匹配（如 local* / *free*）。
 * @param spec - resolveBillingSpec 的产物。
 * @param provider - provider 名（可为 ''，返回默认 usage）。
 */
export function providerModeOf(spec, provider) {
  if (spec === null || typeof spec !== 'object') return DEFAULT_PROVIDER_MODE
  const modes = spec.providerModes ?? []
  if (modes.length === 0) return DEFAULT_PROVIDER_MODE
  const p = String(provider ?? '')
  if (p === '') return DEFAULT_PROVIDER_MODE
  for (const { pattern, mode } of modes) {
    if (pattern === p || globMatch(pattern, p)) return mode
  }
  return DEFAULT_PROVIDER_MODE
}

/** glob（* / ?）匹配（与 ledger.js 同款）。 */
function globMatch(pattern, name) {
  const p = String(pattern ?? '')
  const n = String(name ?? '')
  let re = '^'
  for (const ch of p) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(re + '$').test(n)
}

/**
 * 把某 provider 的价格表并入规格（按路由计价的基础）。
 * 用户覆盖仍最高；随后的 URL 抓取会覆盖同名条目。
 *
 * **空表不得登记来源**：三层取数（disk / asar / builtin）都没有该 provider 的价时，
 * 既不建空桶、也不能在 `providerSources` 里谎报来源（否则状态页会显示一个并不存在的价目来源）。
 * @param spec - resolveBillingSpec 的产物。
 * @param provider - provider 名。
 * @param flatMap - 三层取数产物 { model: entry }（带 currency）。
 * @param source - 价格实际命中层：'disk' | 'asar' | 'builtin' | 'custom-json' | 'override'。
 */
export function applyProviderPrices(spec, provider, flatMap, source = 'pi-ai') {
  if (typeof provider !== 'string' || provider === '') return spec
  if (flatMap === null || typeof flatMap !== 'object') return spec
  const overrides = spec.overrides ?? {}
  const entries = []
  for (const [model, entry] of Object.entries(flatMap)) {
    // 写入前归一化：provider 表键与全局表键保持同一套规范 id
    const key = canonicalModelId(model)
    if (overrides[key] !== undefined) continue
    entries.push([key, entry])
  }
  // 一条都写不进去（空表，或全被用户覆盖挡下）：不建桶、不登记来源
  if (entries.length === 0) return spec
  const bucket = (spec.providerPrices[provider] ??= {})
  for (const [key, entry] of entries) bucket[key] = convertEntry(spec, entry)
  if (spec.providerSources !== undefined && spec.providerSources !== null) {
    spec.providerSources[provider] = source
  }
  return spec
}

/** 两个星期几集合是否相等（undefined/null 视为「每天」）。 */
function daysEqual(a, b) {
  const na = Array.isArray(a) ? a : []
  const nb = Array.isArray(b) ? b : []
  if (na.length !== nb.length) return false
  return na.every((d) => nb.includes(d))
}

/** 两个窗口集合是否逐项相同（含星期几限定）。 */
function sameWindows(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((w, i) => w[0] === b[i][0] && w[1] === b[i][1] && daysEqual(w[2], b[i][2]))
}

/** 两个窗口集合的时段是否相同（忽略星期几限定）。 */
function sameWindowsLoose(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((w, i) => w[0] === b[i][0] && w[1] === b[i][1])
}

/** 时区是否为「默认等价」（内置北京时间，或旧版 Config 默认 UTC）。 */
export function tzIsDefault(tz) {
  return tz === undefined || tz === null || tz === '' || tz === DEFAULT_PEAK_TZ || tz === 'UTC'
}

/**
 * 窗口是否仍是「用户未自定义」的默认，需要同时认三种等价写法：
 *  - 内置默认：北京时间 09:00-12:00 / 14:00-18:00（带工作日 days）；
 *  - 旧版 Config 默认：UTC 01:00-04:00 / 06:00-10:00（无 days）——语义上等价于官方默认；
 *  - 北京时间时段但漏写 days（用户照公告手填的常见写法）。
 * 只有认定为默认时才允许用官网抓取到的窗口覆盖；否则用户自定义窗口会被冲掉。
 */
function windowsAreDefault(windows, tz) {
  if (sameWindows(windows, parsePeakWindows(DEFAULT_PEAK_WINDOWS))) return true
  if (!tzIsDefault(tz)) return false
  if (sameWindowsLoose(windows, parsePeakWindows(LEGACY_DEFAULT_PEAK_WINDOWS))) return true
  if (sameWindowsLoose(windows, parsePeakWindows([['09:00', '12:00'], ['14:00', '18:00']]))) return true
  return false
}

/**
 * 外币 → 目标货币折算（默认人民币）。开启 fx 且条目货币与目标货币不同时，
 * 四项价格 × 汇率并改标目标货币；否则原样返回。
 * @param spec - 计费规格（含 fx 配置与 currency 目标）。
 * @param entry - 带 currency 的价格条目。
 */
function convertEntry(spec, entry) {
  if (!spec.fx.enabled) return entry
  const target = spec.currency
  const cur = entry.currency ?? target
  if (cur === target) return entry
  const r = spec.fx.rate
  const next = {
    input: entry.input * r,
    output: entry.output * r,
    cacheRead: entry.cacheRead * r,
    cacheWrite: entry.cacheWrite * r,
    currency: target,
  }
  // 折算时一并带上展示别名（view 行用它作 model，见 attachProviderPrices 与 client findPrice）
  if (entry.alias !== undefined) next.alias = entry.alias
  return next
}

function numOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/* ------------------------------------------------------------------ */
/* 投影                                                               */
/* ------------------------------------------------------------------ */

const zeroBuckets = () => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

function bucketsFrom(usage) {
  return {
    uncachedInputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

function addBuckets(target, buckets) {
  target.uncachedInputTokens += buckets.uncachedInputTokens
  target.outputTokens += buckets.outputTokens
  target.cacheReadTokens += buckets.cacheReadTokens
  target.cacheWriteTokens += buckets.cacheWriteTokens
}

function subBuckets(target, buckets) {
  target.uncachedInputTokens = Math.max(0, target.uncachedInputTokens - buckets.uncachedInputTokens)
  target.outputTokens = Math.max(0, target.outputTokens - buckets.outputTokens)
  target.cacheReadTokens = Math.max(0, target.cacheReadTokens - buckets.cacheReadTokens)
  target.cacheWriteTokens = Math.max(0, target.cacheWriteTokens - buckets.cacheWriteTokens)
}

function addCost(target, currency, cost) {
  if (!Number.isFinite(cost) || cost <= 0) return
  target[currency] = (target[currency] ?? 0) + cost
}

function subCost(target, currency, cost) {
  if (!Number.isFinite(cost) || cost <= 0) return
  const next = (target[currency] ?? 0) - cost
  if (next <= 1e-12) delete target[currency]
  else target[currency] = next
}

/** 初始状态：全部普通 JSON。 */
export function initBillingState() {
  return {
    header: null,
    headerTokens: 0,
    totals: {
      ...zeroBuckets(),
      costs: {},
      calls: 0,
      estimatedSteps: 0,
      exactSteps: 0,
    },
    perModel: {},
    steps: [],
    last: null,
    lastEstimated: null,
    active: null,
    turn: { number: 0, costs: {}, steps: 0, estimatedSteps: 0 },
    surface: {},
    surfaceTokens: 0,
    _now: Date.now(),
  }
}

function blockEstimate(block) {
  switch (block.kind) {
    case 'text':
    case 'reasoning':
      return estimateTextBlockTokens(block.characters)
    case 'tool-call':
      return estimateToolCallBlockTokens(block.nameCharacters, block.argumentCharacters)
    case 'fixed':
      return block.tokens
    default:
      return 0
  }
}

function writeBlock(active, index, previous, next) {
  active.pricedTokens += blockEstimate(next) - (previous === undefined ? 0 : blockEstimate(previous))
  if (previous === undefined) active.pricedBlocks += 1
  active.blocks[index] = next
}

/** 估算一整块内容的 token（block-end 用）。 */
function estimateContentTokens(block) {
  switch (block?.type) {
    case 'text':
    case 'reasoning':
      return estimateTextBlockTokens((block.text ?? '').length)
    case 'tool-call':
      return estimateToolCallBlockTokens((block.name ?? '').length, (block.arguments ?? '').length)
    default:
      return 0
  }
}

/** 把一个流式 chunk 应用到进行中的 step（估算输出 token）。 */
function applyOutputChunk(active, chunk) {
  switch (chunk.type) {
    case 'text-delta': {
      if (chunk.text === '') return false
      const previous = active.blocks[chunk.index]
      writeBlock(active, chunk.index, previous, {
        kind: 'text',
        characters: (previous?.kind === 'text' ? previous.characters : 0) + chunk.text.length,
      })
      return true
    }
    case 'reasoning-delta': {
      if (chunk.text === '') return false
      const previous = active.blocks[chunk.index]
      writeBlock(active, chunk.index, previous, {
        kind: 'reasoning',
        characters: (previous?.kind === 'reasoning' ? previous.characters : 0) + chunk.text.length,
      })
      return true
    }
    case 'tool-call-delta': {
      if (chunk.name === undefined && chunk.argumentsDelta === '') return false
      const previous = active.blocks[chunk.index]
      writeBlock(active, chunk.index, previous, {
        kind: 'tool-call',
        nameCharacters: chunk.name?.length ?? (previous?.kind === 'tool-call' ? previous.nameCharacters : 0),
        argumentCharacters: (previous?.kind === 'tool-call' ? previous.argumentCharacters : 0) + chunk.argumentsDelta.length,
      })
      return true
    }
    case 'block-end': {
      const previous = active.blocks[chunk.index]
      writeBlock(active, chunk.index, previous, { kind: 'fixed', tokens: estimateContentTokens(chunk.block) })
      return true
    }
    default:
      return false
  }
}

function surfaceMessage(event) {
  switch (event.type) {
    case 'user/message':
      return event.data
    case 'assistant/message':
    case 'tool/result':
      return event.data.message
    default:
      return undefined
  }
}

function applySurface(state, event) {
  const message = surfaceMessage(event)
  const tokens = message === undefined ? 0 : estimateMessageTokens(message)
  if (event.surfaceOp === 'append') {
    state.surface[String(event.seq)] = tokens
    state.surfaceTokens += tokens
    return state
  }
  const op = event.surfaceOp
  if (op.op !== 'replace') return state
  let removed = 0
  for (const seq of Object.keys(state.surface)) {
    const n = Number(seq)
    if (n < op.start) continue
    if (n > op.end) break
    removed += state.surface[seq]
    delete state.surface[seq]
  }
  state.surface[String(event.seq)] = tokens
  state.surfaceTokens = state.surfaceTokens - removed + tokens
  return state
}

/** 用精确 usage 覆盖进行中的 step。 */
function exactStep(active, usage) {
  active.buckets = bucketsFrom(usage)
  active.exact = true
  active.blocks = {}
  active.pricedTokens = 0
  active.pricedBlocks = 0
  return active
}

/** 结算一个 step：按结算时刻的生效价格计价并累加 totals/perModel/turn。 */
function settleStep(state, active, spec, atMs) {
  const model = active.model
  const price = priceAt(active.provider, model, spec, atMs)
  const cost = costOf(active.buckets, price)
  const currency = price.currency
  const estimated = !active.exact
  const mode = providerModeOf(spec, active.provider)

  addBuckets(state.totals, active.buckets)
  addCost(state.totals.costs, currency, cost)
  state.totals.calls += 1
  if (estimated) state.totals.estimatedSteps += 1
  else state.totals.exactSteps += 1

  let pm = state.perModel[model]
  if (pm === undefined) {
    pm = { model, calls: 0, uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, currency, estimatedCalls: 0 }
    state.perModel[model] = pm
  }
  pm.calls += 1
  addBuckets(pm, active.buckets)
  pm.cost += cost
  pm.currency = currency
  if (estimated) pm.estimatedCalls += 1

  if (state.turn.number === active.turn) {
    addCost(state.turn.costs, currency, cost)
    state.turn.steps += 1
    if (estimated) state.turn.estimatedSteps += 1
  }

  state.steps.push({
    turn: active.turn,
    step: active.step,
    model,
    provider: active.provider,
    at: atMs,
    uncachedInputTokens: active.buckets.uncachedInputTokens,
    outputTokens: active.buckets.outputTokens,
    cacheReadTokens: active.buckets.cacheReadTokens,
    cacheWriteTokens: active.buckets.cacheWriteTokens,
    cost,
    currency,
    estimated,
    mode,
  })
  if (state.steps.length > 1000) state.steps.splice(0, state.steps.length - 1000)

  // 仅估算 step 缓存退款所需精确桶数据（不受 steps 截断影响，见 refundLastEstimated）
  if (estimated) {
    state.lastEstimated = {
      buckets: {
        uncachedInputTokens: active.buckets.uncachedInputTokens,
        outputTokens: active.buckets.outputTokens,
        cacheReadTokens: active.buckets.cacheReadTokens,
        cacheWriteTokens: active.buckets.cacheWriteTokens,
      },
      cost,
      currency,
      step: active.step,
      turn: active.turn,
    }
  } else {
    state.lastEstimated = null
  }

  state.last = {
    turn: active.turn,
    step: active.step,
    model,
    provider: active.provider,
    outputTokens: active.buckets.outputTokens,
    cost,
    currency,
    estimated,
  }
  state.active = null
  return state
}

/** 撤销一次未完成的估算 step（turn 非正常结束时）。 */
function refundLastEstimated(state, spec) {
  const last = state.last
  if (last === null || !last.estimated) return state
  // 用结算时缓存的精确桶数据，避免依赖 steps 尾部（可能已被 >100 截断/顺序变化）。
  const est = state.lastEstimated
  const buckets = est === null || est === undefined ? undefined : est.buckets
  const cost = est?.cost ?? last.cost
  const currency = est?.currency ?? last.currency
  if (buckets !== undefined) {
    subBuckets(state.totals, buckets)
    subCost(state.totals.costs, currency, cost)
    if (state.totals.estimatedSteps > 0) state.totals.estimatedSteps -= 1
    state.totals.calls = Math.max(0, state.totals.calls - 1)
    const pm = state.perModel[last.model]
    if (pm !== undefined) {
      subBuckets(pm, buckets)
      pm.cost = Math.max(0, pm.cost - cost)
      pm.calls = Math.max(0, pm.calls - 1)
      if (pm.estimatedCalls > 0) pm.estimatedCalls -= 1
    }
    if (state.turn.number === last.turn) {
      subCost(state.turn.costs, currency, cost)
      state.turn.steps = Math.max(0, state.turn.steps - 1)
      if (state.turn.estimatedSteps > 0) state.turn.estimatedSteps -= 1
    }
    // 移除对应的估算 step（从尾向前定位，避免 steps 截断后误弹其它条目）
    for (let si = state.steps.length - 1; si >= 0; si--) {
      const s = state.steps[si]
      if (s.step === last.step && s.turn === last.turn && s.estimated) {
        state.steps.splice(si, 1)
        break
      }
    }
  }
  state.last = null
  state.lastEstimated = null
  return state
}

/**
 * 组装 tokenBilling 投影的 apply 纯函数。
 *
 * 注意：框架用 `Object.is(next, state)` 判定状态是否变化并推送变更通知，
 * 因此任何「状态发生改变」的事件都必须返回一个新的顶层引用（浅拷贝即可，
 * 嵌套对象原地更新）；不关心的事件原样返回同一引用。
 * @param spec - resolveBillingSpec + applyFetchedPrices 的产物。
 */
export function createBillingApply(spec) {
  return function apply(state, event) {
    let touched = false
    switch (event.type) {
      case 'request/header': {
        const config = event.data?.header?.config
        state.header = config === undefined ? null : { provider: config.provider ?? '', model: config.model ?? 'unknown' }
        state.headerTokens = estimateHeaderTokens(event.data.header)
        if (state.active !== null) {
          state.active.provider = state.header?.provider ?? ''
          state.active.model = state.header?.model ?? 'unknown'
          state.active.buckets = {
            ...state.active.buckets,
            uncachedInputTokens: state.headerTokens + state.surfaceTokens,
          }
        }
        touched = true
        break
      }
      case 'step/start': {
        state.active = {
          turn: event.data.turn,
          step: event.data.step,
          provider: state.header?.provider ?? '',
          model: state.header?.model ?? 'unknown',
          exact: false,
          buckets: {
            ...zeroBuckets(),
            uncachedInputTokens: state.headerTokens + state.surfaceTokens,
          },
          blocks: {},
          pricedTokens: 0,
          pricedBlocks: 0,
        }
        touched = true
        break
      }
      case 'assistant/chunk': {
        if (state.active === null) return state
        const { chunk } = event.data
        if (chunk.type === 'usage') {
          exactStep(state.active, chunk.usage)
          touched = true
          break
        }
        if (state.active.exact) return state
        if (applyOutputChunk(state.active, chunk)) {
          const tokens = state.active.pricedBlocks === 0 ? 0 : state.active.pricedTokens + ESTIMATOR.roleOverhead
          state.active.buckets = { ...state.active.buckets, outputTokens: tokens }
          touched = true
        }
        break
      }
      case 'assistant/message': {
        if (state.active === null) return state
        if (event.data.usage !== undefined) {
          exactStep(state.active, event.data.usage)
          touched = true
        }
        break
      }
      case 'step/end': {
        if (state.active === null) return state
        settleStep(state, state.active, spec, event.time)
        touched = true
        break
      }
      case 'turn/start': {
        state.turn = { number: event.data.turn, costs: {}, steps: 0, estimatedSteps: 0 }
        touched = true
        break
      }
      case 'turn/end': {
        if (event.data.reason?.kind !== 'completed' && state.last !== null && state.last.turn === event.data.turn && state.last.estimated) {
          refundLastEstimated(state, spec)
          touched = true
        }
        break
      }
      default:
        break
    }
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
      applySurface(state, event)
      touched = true
    }
    if (touched) {
      state._now = event.time
      return { ...state }
    }
    return state
  }
}

/**
 * 组装 tokenBilling 投影的 view 纯函数（state → 浏览器可读的计费视图）。
 */
export function createBillingView(spec) {
  return function view(state) {
    const atMs = state._now ?? Date.now()
    const active = state.active
    const activePrice = active === null ? null : priceAt(active.provider, active.model, spec, atMs)
    const activeCost = active === null || activePrice === null ? 0 : costOf(active.buckets, activePrice)
    const activeCurrency = activePrice?.currency ?? spec.currency
    const activeEstimated = active !== null && !active.exact
    const turnCosts = { ...state.turn.costs }
    if (active !== null && activeCost > 0) addCost(turnCosts, activeCurrency, activeCost)
    const peakBilling = spec.peak !== null && spec.peak.enabled && Object.keys(spec.peak.prices).length > 0
    const peakActiveNow = peakBilling && inWindow(atMs, spec.peak.windows, spec.peak.tz, isBeforeWeekendRule(spec.peak, atMs))
    const perModel = Object.values(state.perModel)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 20)
    // 每个模型的当前生效单价（含高峰/错峰，按视图时刻 atMs 计价）——供客户端随模型切换实时显示
    const prices = Object.keys(spec.prices)
      .map((model) => {
        const p = priceAt('', model, spec, atMs)
        return {
          model,
          input: p.input,
          output: p.output,
          cacheRead: p.cacheRead,
          cacheWrite: p.cacheWrite,
          currency: p.currency,
        }
      })
      .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
    // 每个 provider 的价格表（含折算），供客户端按 provider 精确显示
    const providerPrices = []
    for (const [provider, bucket] of Object.entries(spec.providerPrices ?? {})) {
      for (const [model, entry] of Object.entries(bucket)) {
        providerPrices.push({
          provider,
          // 行名优先用**原始模型 id**（alias）：价表内部键是规范化后的档位 id
          // （如 deepseek-flash），而 UI 传来的模型名可能是历史写法（deepseek-v4-flash /
          // …-0731 / DeepSeek-V4-Flash / vendor 前缀），用 alias 才能匹配上。
          // 注意：这里只改 **model 的取值**，条目的键集合仍严格是 schema 规定的 7 个（不新增字段）。
          model: typeof entry.alias === 'string' && entry.alias !== '' ? entry.alias : model,
          input: entry.input,
          output: entry.output,
          cacheRead: entry.cacheRead,
          cacheWrite: entry.cacheWrite,
          currency: entry.currency ?? spec.currency,
        })
      }
    }
    providerPrices.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
    return {
      currency: spec.currency,
      billing: {
        source: spec.source,
        peakBilling,
        peakActive: peakActiveNow,
        // wire schema（lib/index.js）对 windows 用 2 元 tuple，星期几维度只在计价内部使用；
        // 这里按 [起, 止] 输出，避免带 days 的官网窗口导致视图校验失败。
        windows: spec.peak !== null ? spec.peak.windows.map((w) => [w[0], w[1]]) : [],
      },
      prices,
      providerPrices,
      totals: {
        uncachedInputTokens: state.totals.uncachedInputTokens,
        outputTokens: state.totals.outputTokens,
        cacheReadTokens: state.totals.cacheReadTokens,
        cacheWriteTokens: state.totals.cacheWriteTokens,
        costs: state.totals.costs,
        calls: state.totals.calls,
        estimatedSteps: state.totals.estimatedSteps,
        exactSteps: state.totals.exactSteps,
      },
      turn: {
        number: state.turn.number,
        costs: turnCosts,
        estimated: state.turn.estimatedSteps > 0 || activeEstimated,
        steps: state.turn.steps + (active === null ? 0 : 1),
        estimatedSteps: state.turn.estimatedSteps + (activeEstimated ? 1 : 0),
      },
      active: active === null ? null : {
        turn: active.turn,
        step: active.step,
        model: active.model,
        provider: active.provider,
        uncachedInputTokens: active.buckets.uncachedInputTokens,
        outputTokens: active.buckets.outputTokens,
        cacheReadTokens: active.buckets.cacheReadTokens,
        cacheWriteTokens: active.buckets.cacheWriteTokens,
        cost: activeCost,
        currency: activeCurrency,
        estimated: activeEstimated,
      },
      last: state.last,
      perModel,
      steps: state.steps,
    }
  }
}

/**
 * 完整投影定义（缺 schema，由宿主补）。
 * @param spec - 计费规格（已合并抓取价格）。
 */
export function createTokenBillingProjectionParts(spec) {
  return {
    key: 'tokenBilling',
    init: initBillingState,
    apply: createBillingApply(spec),
    view: createBillingView(spec),
    stateVersion: 2,
  }
}
