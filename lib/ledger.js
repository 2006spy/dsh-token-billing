/**
 * dsh-token-billing — 持久化账本与统计（零依赖，可在 Node 中单独测试）。
 *
 * 职责：
 *  - 账本文件（$DSH_HOME/storages/token-billing-ledger.json）：跨会话持久化
 *    每条已结算 step 的费用记录，幂等合并（键 = sessionId|turn|step）。
 *  - 聚合统计：今日 / 本月 / 累计 / 按模型 / 按天 / 本地模型节省。
 *  - 导出：JSON / CSV。
 *
 * 只依赖 node:fs / node:path / node:os。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** 账本文件名（位于 DSH_HOME/storages 下）。 */
export const LEDGER_FILENAME = 'token-billing-ledger.json'

/** 账本结构版本。 */
export const LEDGER_VERSION = 1

/** 空账本。 */
export function emptyLedger() {
  return { version: LEDGER_VERSION, steps: [], updatedAt: null }
}

/** 解析账本存放路径。 */
export function ledgerPath(dshHome) {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', LEDGER_FILENAME)
}

/** 读取账本；不存在或损坏返回空账本。 */
export function loadLedger(filePath) {
  try {
    if (!existsSync(filePath)) return emptyLedger()
    const raw = readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || !Array.isArray(data.steps)) return emptyLedger()
    return { version: LEDGER_VERSION, steps: data.steps, updatedAt: data.updatedAt ?? null }
  } catch {
    return emptyLedger()
  }
}

/** 写入账本（先写临时文件再原子改名；受限环境退化为直接写）。 */
export function saveLedger(filePath, ledger) {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...ledger, updatedAt: Date.now() }, null, 2), 'utf8')
    try {
      renameSync(tmp, filePath)
    } catch {
      writeFileSync(filePath, JSON.stringify({ ...ledger, updatedAt: Date.now() }, null, 2), 'utf8')
    }
  } catch (err) {
    console.warn(`[token-billing] 账本写入失败：${err.message}`)
  }
}

/** 幂等合并：把某个会话的 steps 并入账本（键 sessionId|turn|step，重复只覆盖）。 */
export function mergeSteps(ledger, sessionId, steps) {
  if (!Array.isArray(steps) || steps.length === 0) return ledger
  const seen = new Set()
  for (const s of ledger.steps) seen.add(`${s.sessionId}|${s.turn}|${s.step}`)
  let changed = false
  for (const s of steps) {
    const key = `${sessionId}|${s.turn}|${s.step}`
    const record = {
      sessionId,
      turn: s.turn,
      step: s.step,
      at: Number.isFinite(s.at) ? s.at : Date.now(),
      model: s.model ?? 'unknown',
      provider: s.provider ?? '',
      uncachedInputTokens: s.uncachedInputTokens ?? 0,
      outputTokens: s.outputTokens ?? 0,
      cacheReadTokens: s.cacheReadTokens ?? 0,
      cacheWriteTokens: s.cacheWriteTokens ?? 0,
      cost: s.cost ?? 0,
      currency: s.currency ?? '¥',
      estimated: s.estimated === true,
      mode: s.mode ?? 'usage',
    }
    if (seen.has(key)) continue
    seen.add(key)
    ledger.steps.push(record)
    changed = true
  }
  return changed ? ledger : ledger
}

/* ------------------------------------------------------------------ */
/* 聚合统计                                                           */
/* ------------------------------------------------------------------ */

/** 本地时区某天零点（YYYY-MM-DD）。 */
function dayKey(atMs, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(atMs)
    const m = {}
    for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value
    return `${m.year}-${m.month}-${m.day}`
  } catch {
    const d = new Date(atMs)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
}

/** 导出版 dayKey（供宿主端生成图表时间轴等场景复用，本地时区键）。 */
export function dayKeyOf(atMs, tz) {
  return dayKey(atMs, tz)
}

/** 本地时区当月键（YYYY-MM）。 */
function monthKey(atMs, tz) {
  return dayKey(atMs, tz).slice(0, 7)
}

/** 币种累计：把一笔费用累加到 {currency: cost} map。 */
function addCost(target, currency, cost) {
  if (!Number.isFinite(cost) || cost <= 0) return
  target[currency] = (target[currency] ?? 0) + cost
}

/**
 * 聚合统计（按本地时区）。
 * @param ledger - 账本。
 * @param opts - { now, tz, localProviders, localCostPerM, currency, providerModes }。
 *   providerModes：可选 [{ pattern, mode }]（parseProviderModes 产物）；账本记录未带 mode 或
 *   与配置不一致时以配置为准（支持配置后历史重估）。
 * @returns { today, month, total, perModel, perDay, perProvider, calls, savings, metering, cacheStats }。
 * metering：按收费形式（usage/subscription/free/local）分组的实际花费/名义价值/节省（参考 dsh-web-billing）。
 * cacheStats：token 桶汇总 + 缓存命中率。
 */
export function computeStats(ledger, opts = {}) {
  const now = opts.now ?? Date.now()
  const tz = opts.tz ?? 'Asia/Shanghai'
  const todayKey = dayKey(now, tz)
  const monthKeyNow = monthKey(now, tz)
  const localProviders = Array.isArray(opts.localProviders) ? opts.localProviders : []
  const localCostPerM = Number.isFinite(opts.localCostPerM) && opts.localCostPerM >= 0 ? opts.localCostPerM : 0
  const targetCurrency = opts.currency ?? '¥'
  const providerModes = Array.isArray(opts.providerModes) ? opts.providerModes : []
  /** 按配置解析某 provider 的收费形式（记录自带 mode 且与配置一致时优先用记录）。 */
  const modeOf = (s) => {
    if (providerModes.length > 0) {
      const p = String(s.provider ?? '')
      for (const { pattern, mode } of providerModes) {
        if (pattern === p || globMatch(pattern, p)) {
          return mode === 'local' ? (isLocalProvider(p) ? 'local' : mode) : mode
        }
      }
    }
    return s.mode ?? 'usage'
  }
  const isLocalProvider = (p) => localProviders.length > 0 && localProviders.some((lp) => globMatch(lp, p))

  const today = { costs: {}, calls: 0 }
  const month = { costs: {}, calls: 0 }
  const total = { costs: {}, calls: 0 }
  const perModel = {} // model -> { costs, calls }
  // dayKey -> { costs, calls, uncachedInput, output, cacheRead, cacheWrite }（token 分桶供趋势图）
  const perDay = {}
  const perProvider = {} // provider -> { costs, calls, mode, nominal, actual, saved }
  let nominalTotal = {} // 名义价值（官方价）成本
  let actualTotal = {} // 实际成本（本地按 localCostPerM）
  let savingsTotal = {} // 节省
  // metering：按收费形式分组 { mode -> { calls, costs, nominal, actual, saved } }
  const byMode = {}
  // cacheStats：token 桶汇总
  const cacheStats = { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }

  for (const s of ledger.steps) {
    const dk = dayKey(s.at, tz)
    const mk = monthKey(s.at, tz)
    const isLocal = isLocalProvider(s.provider || s.model)
    const mode = modeOf(s)

    if (dk === todayKey) { addCost(today.costs, s.currency, s.cost); today.calls += 1 }
    if (mk === monthKeyNow) { addCost(month.costs, s.currency, s.cost); month.calls += 1 }
    addCost(total.costs, s.currency, s.cost); total.calls += 1

    let pm = perModel[s.model]
    if (pm === undefined) { pm = { costs: {}, calls: 0 }; perModel[s.model] = pm }
    addCost(pm.costs, s.currency, s.cost); pm.calls += 1

    let pd = perDay[dk]
    if (pd === undefined) { pd = { costs: {}, calls: 0, uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; perDay[dk] = pd }
    addCost(pd.costs, s.currency, s.cost); pd.calls += 1
    pd.uncachedInput += s.uncachedInputTokens ?? 0
    pd.output += s.outputTokens ?? 0
    pd.cacheRead += s.cacheReadTokens ?? 0
    pd.cacheWrite += s.cacheWriteTokens ?? 0

    // 按 provider：区分实际花费（usage 计 cost，其余计 0）与名义价值（始终计 cost）
    let pp = perProvider[s.provider || '(无)']
    if (pp === undefined) { pp = { costs: {}, calls: 0, mode: mode, nominal: {}, actual: {}, saved: {} }; perProvider[s.provider || '(无)'] = pp }
    pp.calls += 1
    addCost(pp.costs, s.currency, s.cost)
    addCost(pp.nominal, s.currency, s.cost)
    if (mode === 'usage') addCost(pp.actual, s.currency, s.cost)
    else {
      // subscription / free / local：实际花费 0；本地可按 localCostPerM 折算实际成本
      if (isLocal) {
        const tokens = s.uncachedInputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens
        addCost(pp.actual, targetCurrency, tokens * localCostPerM / 1_000_000)
      }
      const saved = s.cost - (isLocal ? pp.actual[targetCurrency] ?? 0 : 0)
      if (saved > 0) addCost(pp.saved, s.currency, saved)
    }

    // metering：按收费形式分组
    let mm = byMode[mode]
    if (mm === undefined) { mm = { calls: 0, costs: {}, nominal: {}, actual: {}, saved: {} }; byMode[mode] = mm }
    mm.calls += 1
    addCost(mm.costs, s.currency, s.cost)
    addCost(mm.nominal, s.currency, s.cost)
    if (mode === 'usage') addCost(mm.actual, s.currency, s.cost)
    else {
      if (isLocal) {
        const tokens = s.uncachedInputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens
        addCost(mm.actual, targetCurrency, tokens * localCostPerM / 1_000_000)
      }
      const saved = s.cost - (isLocal ? mm.actual[targetCurrency] ?? 0 : 0)
      if (saved > 0) addCost(mm.saved, s.currency, saved)
    }

    if (isLocal) {
      // 名义价值 = 官方价计得的 cost（账本里已是）；实际成本 = 全部 token × 本地单价
      const tokens = s.uncachedInputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens
      const actual = tokens * localCostPerM / 1_000_000
      addCost(nominalTotal, s.currency, s.cost)
      addCost(actualTotal, targetCurrency, actual)
      const saved = s.cost - actual
      if (saved > 0) addCost(savingsTotal, s.currency, saved)
    }

    // cacheStats：token 桶汇总
    cacheStats.uncachedInput += s.uncachedInputTokens ?? 0
    cacheStats.output += s.outputTokens ?? 0
    cacheStats.cacheRead += s.cacheReadTokens ?? 0
    cacheStats.cacheWrite += s.cacheWriteTokens ?? 0
    cacheStats.calls += 1
  }

  return {
    today,
    month,
    total,
    perModel,
    perDay,
    perProvider,
    // 供客户端图表定位「今日 / 昨日」（本地时区键，如 2026-08-16）
    days: { today: todayKey, yesterday: dayKey(now - 86_400_000, tz) },
    savings: { nominal: nominalTotal, actual: actualTotal, total: savingsTotal },
    local: { enabled: localProviders.length > 0, providers: localProviders, costPerM: localCostPerM },
    metering: { byMode },
    cacheStats: {
      ...cacheStats,
      hitRate: cacheStats.uncachedInput + cacheStats.cacheRead > 0
        ? cacheStats.cacheRead / (cacheStats.uncachedInput + cacheStats.cacheRead)
        : 0,
    },
  }
}

/** glob（* / ?）匹配。 */
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

/* ------------------------------------------------------------------ */
/* 导出                                                               */
/* ------------------------------------------------------------------ */

/** 导出为 JSON（账本全量）。 */
export function ledgerToJson(ledger) {
  return JSON.stringify(ledger, null, 2)
}

/** 导出为 CSV（表头：会话,轮次,步骤,时间,模型,提供方,输入,输出,缓存读,缓存写,费用,币种,估算）。 */
export function ledgerToCsv(ledger) {
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const header = ['sessionId', 'turn', 'step', 'at', 'model', 'provider', 'input', 'output', 'cacheRead', 'cacheWrite', 'cost', 'currency', 'estimated']
  const rows = [header.join(',')]
  for (const s of ledger.steps) {
    rows.push([
      esc(s.sessionId), s.turn, s.step, s.at, esc(s.model), esc(s.provider),
      s.uncachedInputTokens, s.outputTokens, s.cacheReadTokens, s.cacheWriteTokens,
      s.cost, esc(s.currency), s.estimated ? '1' : '0',
    ].join(','))
  }
  return rows.join('\n')
}
