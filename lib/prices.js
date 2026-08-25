/**
 * dsh-token-billing — 价格源模块（零依赖，可在 Node 中单独测试）。
 *
 * 职责：
 *  - 抓取并解析 DeepSeek 官方价格页（api-docs.deepseek.com/quick_start/pricing），
 *    提取平峰价表、高峰/错峰价表与高峰时段（官方为 UTC）；
 *  - 抓取用户自定义 JSON 价格端点（网关 / gist 等）；
 *  - 价格缓存（~/.dsh/storages/token-billing-prices.json），带过期时间；
 *  - 合并优先级：用户覆盖（settings prices）> 官网抓取 > 内置表 > 默认价。
 *
 * 只依赖 node:fs / node:path / node:os 与全局 fetch；fetch 可在测试中注入。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** 价格缓存文件名（位于 DSH_HOME/storages 下）。 */
export const PRICE_CACHE_FILENAME = 'token-billing-prices.json'

/** 默认自动刷新间隔（小时）：价格表跟随官网更新。 */
export const DEFAULT_REFRESH_HOURS = 1

/** 深度求索官方价格页（中文/人民币优先，英文页兜底）。 */
export const DEEPSEEK_PRICE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
export const DEEPSEEK_PRICE_URL_EN = 'https://api-docs.deepseek.com/quick_start/pricing'

/* ------------------------------------------------------------------ */
/* 解析工具                                                           */
/* ------------------------------------------------------------------ */

/** 解析 "$0.007" / "¥2" / "0.02元" / "1,234.5" 这类价格字符串。解析失败或为空返回 null。 */
export function parsePriceNumber(text) {
  const cleaned = String(text ?? '')
    .replace(/[,，\s]/g, '')
    .replace(/^[$¥€£￥]/, '')
    .replace(/元$/, '') // 人民币后缀（"0.02元"）
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 把单元格归一化为峰谷档位：'PEAK' / 'OFF-PEAK'，非档位返回 null。 */
function kindOf(cell) {
  const t = String(cell ?? '').toUpperCase()
  if (t.includes('高峰') || t === 'PEAK') return 'PEAK'
  if (t.includes('空闲') || t.includes('OFF-PEAK') || t.includes('OFFPEAK')) return 'OFF-PEAK'
  return null
}

/** 币种代码 → 显示符号（未知代码原样返回，如 "¥" 已是符号）。 */
export function currencySymbol(code) {
  const map = {
    USD: '$', USDC: '$', USDT: '$', CNY: '¥', CNH: '¥', RMB: '¥', EUR: '€', GBP: '£', JPY: '¥', KRW: '₩', HKD: 'HK$',
  }
  const key = String(code ?? '').toUpperCase()
  return map[key] ?? String(code ?? '')
}

/** 简单 HTML 实体解码（覆盖价格页出现的字符）。 */
export function decodeHtml(text) {
  return String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** 从 HTML 提取全部 <table> 的逐行单元格数组。 */
export function tablesOf(html) {
  const tables = []
  const tableRe = /<table[\s\S]*?<\/table>/gi
  let tm
  while ((tm = tableRe.exec(html)) !== null) {
    const rows = []
    const rowRe = /<tr[\s\S]*?<\/tr>/gi
    let rm
    while ((rm = rowRe.exec(tm[0])) !== null) {
      const cells = []
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
      let cm
      while ((cm = cellRe.exec(rm[0])) !== null) {
        const stripped = cm[1].replace(/<[^>]+>/g, '')
        cells.push(decodeHtml(stripped).trim())
      }
      rows.push(cells)
    }
    tables.push(rows)
  }
  return tables
}

/** 把 "1M INPUT TOKENS (CACHE HIT)" / "百万tokens输入（缓存命中）" 这类表头归一化为字段键。 */
function headerKey(text) {
  const t = String(text ?? '').toUpperCase()
  if (t.includes('CACHE HIT') || t.includes('缓存命中')) return 'cacheRead'
  if (t.includes('CACHE MISS') || t.includes('缓存未命中')) return 'cacheWrite'
  if (t.includes('OUTPUT') || t.includes('输出')) return 'output'
  if (t.includes('INPUT') || t.includes('输入')) return 'input'
  return null
}

/**
 * 解析「高峰/错峰表」的一行（Layout A）：
 *   [model, 'OFF-PEAK'|'PEAK', hit, miss, out]   —— 带模型名
 *   ['OFF-PEAK'|'PEAK', hit, miss, out]          —— 续行（模型名继承）
 *   [model, hit, miss, out]                      —— 无 kind 的平峰行
 * @returns { model, kind, cacheRead, cacheWrite, output } | null
 */
function rowPrices(cells, carriedModel) {
  let model = carriedModel
  let kind = null
  let rest = cells
  const firstKind = kindOf(cells[0])
  if (firstKind !== null) {
    kind = firstKind
    rest = cells.slice(1)
  } else if (cells.length >= 4) {
    // 首格是模型名；第二格可能带档位（高峰/空闲、PEAK/OFF-PEAK）
    model = String(cells[0]).trim().toLowerCase()
    const secondKind = kindOf(cells[1])
    if (secondKind !== null) {
      kind = secondKind
      rest = cells.slice(2)
    } else {
      rest = cells.slice(1)
    }
  }
  if (rest.length < 3) return null
  const cacheRead = parsePriceNumber(rest[0])
  const cacheWrite = parsePriceNumber(rest[1])
  const output = parsePriceNumber(rest[2])
  if (cacheRead === null || cacheWrite === null || output === null) return null
  return { model, kind, cacheRead, cacheWrite, output }
}

/** 从价格单元格内容探测币种：'CNY' / 'USD'，探测不到返回 null。 */
function detectCurrency(rows) {
  for (const row of rows) {
    for (const cell of row) {
      const s = String(cell ?? '')
      if (s.includes('元') || s.startsWith('¥') || s.startsWith('￥')) return 'CNY'
      if (s.includes('$')) return 'USD'
    }
  }
  return null
}

/** 从整页 HTML 提取两套价格：flat（当前平峰价）与 peak（高峰价表 + 错峰价 + 窗口 + 生效日期 + 时区）。 */
export function parseDeepSeekPricingHtml(html) {
  const text = decodeHtml(
    String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  )

  // 高峰时段（中文/英文两种表述；可带星期几限定，如「周一至周五」「Monday through Friday」）
  const windows = []
  let windowTz = null
  // 星期几限定 → days（0=周日…6=周六）；无限定 days = undefined（每天）。
  // 优先级：工作日表述优先于周末表述（「周一至周五高峰、周末空闲」的句子两种字样都会出现）。
  const zhWeekdayRe = /(?:周一|星期一|礼拜一)\s*(?:至|到|～|~|-|—|–)\s*(?:周五|星期五|礼拜五)|工作日/
  const zhWeekendRe = /周末|周六\s*(?:日|周日)/
  const enWeekdayRe = /\b(?:monday|mon)\b[\s-]*(?:through|to)\s*\b(?:friday|fri)\b|\bweekdays?\b/i
  const enWeekendRe = /\bweekend\b|\b(?:saturday|sat)\b[\s,&]*\b(?:sunday|sun)\b|\b(?:sunday|sun)\b[\s,&]*\b(?:saturday|sat)\b/i
  let days
  if (zhWeekdayRe.test(text) || enWeekdayRe.test(text)) days = [1, 2, 3, 4, 5]
  else if (zhWeekendRe.test(text) || enWeekendRe.test(text)) days = [0, 6]
  const zhWindowRe = /高峰时段(?:为)?(?:北京时间)?(?:\s*[^0-9]{0,14}?)?\s*(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s*[、，,]\s*(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/
  const zhWm = zhWindowRe.exec(text)
  if (zhWm !== null) {
    windows.push([zhWm[1], zhWm[2], days], [zhWm[3], zhWm[4], days])
    windowTz = 'Asia/Shanghai'
  } else {
    const enWindowRe = /Peak hours? are\s+(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})(?:\s*and\s+(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2}))?/i
    const enWm = enWindowRe.exec(text)
    if (enWm !== null) {
      // 英文页窗口按 UTC 表述；统一折算为北京时间（+8h），与中文页同一日历。
      // 关键：星期几限定（days）也必须按北京日历读（厂商中文页写「北京时间周一至周五」，
      // UTC 与北京两本日历在周五/周日 16:00-24:00 UTC 分歧）。
      windows.push([shiftHhmm(enWm[1], 480), shiftHhmm(enWm[2], 480), days])
      if (enWm[3] !== undefined) windows.push([shiftHhmm(enWm[3], 480), shiftHhmm(enWm[4], 480), days])
      windowTz = 'Asia/Shanghai'
    }
  }
  if (text.includes('北京时间')) windowTz = 'Asia/Shanghai'

  // 生效日期（中文/英文两种表述；统一换算为 UTC 绝对时刻）
  let effectiveAt = null
  const zhDateRe = /(?:北京时间)?\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/
  const zhDm = zhDateRe.exec(text)
  if (zhDm !== null) {
    // 北京时间 = UTC+8：先按 UTC 构造再减 8 小时
    effectiveAt = Date.UTC(Number(zhDm[1]), Number(zhDm[2]) - 1, Number(zhDm[3]), Number(zhDm[4]), Number(zhDm[5])) - 8 * 3600_000
  } else {
    const enDateRe = /at\s+(\d{1,2}):(\d{2})\s*(?:UTC|GMT)\s*on\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/i
    const enDm = enDateRe.exec(text)
    if (enDm !== null) {
      const months = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 }
      effectiveAt = Date.UTC(Number(enDm[5]), months[enDm[3].toLowerCase()], Number(enDm[4]), Number(enDm[1]), Number(enDm[2]))
    }
  }

  const tables = tablesOf(html)
  const flat = {}
  const peak = {}
  const offPeak = {}

  for (const rows of tables) {
    const headerCells = rows[0] ?? []
    // 价格表判定：表头带 CACHE HIT（高峰表），或首列行标签含 CACHE HIT/MISS/OUTPUT（平峰表）
    const rowKeys = rows.slice(1).map((r) => headerKey(r[0])).filter((k) => k !== null)
    const isPriceTable = headerCells.some((c) => headerKey(c) === 'cacheRead') || rowKeys.length >= 2
    if (!isPriceTable) continue
    // 布局判别——纯数据驱动，不依赖表头文案（官方改表头措辞也不会崩）：
    //
    //   Layout A（模型行首，单模型一行）价格行形态 [模型|档位, hit, miss, out]：
    //     行首是档位(高峰/空闲) 且行内价格数固定 3（cacheRead/cacheWrite/output）。
    //   Layout B（模型横排，模型在表头列 / DeepSeek V4 深表头）价格行形态：
    //     [指标|档位, 各模型价格…]，价格数 = 模型列数（≥2），行首从不是「档位+3 价」。
    //
    // 判据：body 中是否存在「首格为档位且行内价格 ≥ 3」的数据行。
    //   有 → 单模型 3 价 → Layout A（模型行首）
    //   无 → 模型横排在列上 → Layout B
    const isColModels = !rows.slice(1).some((r) =>
      kindOf(r[0]) !== null && r.filter((c) => parsePriceNumber(c) !== null).length >= 3
    )
    const hasPeakKind = !isColModels && rows.slice(1).some((r) => kindOf(r[0]) !== null)
    if (hasPeakKind) {
      // Layout A：行 = [模型, (高峰/空闲), hit, miss, out]
      let carried = null
      for (const row of rows.slice(1)) {
        const parsed = rowPrices(row, carried)
        if (parsed === null) continue
        if (parsed.model !== null) carried = parsed.model
        if (carried === null) continue
        const entry = { input: parsed.cacheWrite, cacheRead: parsed.cacheRead, cacheWrite: parsed.cacheWrite, output: parsed.output }
        if (parsed.kind === 'PEAK') peak[carried] = entry
        else if (parsed.kind === 'OFF-PEAK') offPeak[carried] = entry
        else flat[carried] = entry
      }
      if (Object.keys(peak).length > 0) break
    } else {
      const models = headerCells.slice(1).map((c) => c.trim().toLowerCase()).filter(Boolean)
      // Layout B（含 DeepSeek V4 的「空闲/高峰」二层行）：
      // 行可能是 [指标, 档位, p1, p2…]、[档位, p1, p2…]（指标继承上行）、或 [指标, p1, p2…]。
      // 用状态机跟踪当前指标与档位，从每行提取与模型列对齐的价格数字。
      let curKey = null
      let curIsPeak = false
      const columns = { input: [], output: [], cacheRead: [], cacheWrite: [] }
      const columnsPeak = { input: [], output: [], cacheRead: [], cacheWrite: [] }
      for (const row of rows.slice(1)) {
        // 1) 扫描指标标签（跨行延续，如「高峰时段」独立行继承上一行指标）
        let keyHit = null
        for (const cell of row) {
          const k = headerKey(cell)
          if (k !== null && columns[k] !== undefined) { keyHit = k; break }
        }
        if (keyHit !== null) curKey = keyHit
        // 2) 扫描档位徽标（空闲/高峰）
        let kindHit = null
        for (const cell of row) {
          const k = kindOf(cell)
          if (k !== null) { kindHit = k; break }
        }
        if (kindHit !== null) curIsPeak = kindHit === 'PEAK'
        // 3) 仅在本行出现指标或档位时才提取价格，避免残留状态污染后续元数据行
        if (curKey === null || (keyHit === null && kindHit === null)) continue
        const nums = row.map((c) => parsePriceNumber(c)).filter((n) => n !== null)
        if (nums.length < models.length) continue
        const slot = curIsPeak ? columnsPeak : columns
        slot[curKey] = nums.slice(-models.length)
      }
      for (let i = 0; i < models.length; i++) {
        for (const [slot, target] of [[columns, flat], [columnsPeak, peak]]) {
          if (slot.cacheRead?.[i] == null || slot.cacheWrite?.[i] == null || slot.output?.[i] == null) continue
          target[models[i]] = { input: slot.cacheWrite[i], cacheRead: slot.cacheRead[i], cacheWrite: slot.cacheWrite[i], output: slot.output[i] }
        }
      }
    }
  }

  return {
    currency: detectCurrency(tables) ?? 'USD',
    flat,
    peak: Object.keys(peak).length > 0 ? { models: peak, offPeak, windows, effectiveAt, tz: windowTz } : null,
  }
}

/** 抓取 DeepSeek 官方价格页（中文/人民币优先，英文页兜底）。fetchImpl 可注入（默认全局 fetch）。 */
export async function fetchDeepSeekPrices(fetchImpl = fetch) {
  const attempts = [
    { url: DEEPSEEK_PRICE_URL, label: '中文页' },
    { url: DEEPSEEK_PRICE_URL_EN, label: '英文页' },
  ]
  let lastError = null
  for (const { url, label } of attempts) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': 'dsh-token-billing/0.2 (price fetcher)', accept: 'text/html' },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const html = await response.text()
      const parsed = parseDeepSeekPricingHtml(html)
      if (Object.keys(parsed.flat).length === 0 && (parsed.peak === null || Object.keys(parsed.peak.models).length === 0)) {
        throw new Error('未找到价格表')
      }
      return parsed
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`DeepSeek 价格抓取失败（${attempts.map((a) => a.label).join(' / ')}）：${lastError?.message ?? '未知错误'}`)
}

/**
 * 抓取用户自定义 JSON 价格端点。
 * 期望形状：{ "模型id": {"input":2,"output":8,"cacheRead":0.5,"cacheWrite":2} }
 * 或外层带 currency / models：{ "currency": "CNY", "models": {...} }
 */
export async function fetchJsonPrices(url, fetchImpl = fetch) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('自定义价格 URL 必须是 http(s) 地址')
  }
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-token-billing/0.2 (price fetcher)' },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`价格端点返回 HTTP ${response.status}`)
  const data = await response.json()
  const models = (data && typeof data === 'object' && data.models && typeof data.models === 'object') ? data.models : data
  const out = {}
  let currency = typeof data?.currency === 'string' && data.currency.length > 0 ? data.currency : null
  for (const [model, entry] of Object.entries(models)) {
    if (entry === null || typeof entry !== 'object') continue
    const parsed = {
      input: parsePriceNumber(entry.input),
      output: parsePriceNumber(entry.output),
      cacheRead: parsePriceNumber(entry.cacheRead ?? entry.cache_hit),
      cacheWrite: parsePriceNumber(entry.cacheWrite ?? entry.cache_miss),
    }
    if (parsed.input === null || parsed.output === null || parsed.cacheRead === null || parsed.cacheWrite === null) continue
    out[String(model).toLowerCase()] = parsed
    if (typeof entry.currency === 'string' && entry.currency.length > 0) currency = entry.currency
  }
  if (Object.keys(out).length === 0) throw new Error('价格端点未返回任何可解析的模型价格')
  return { currency, flat: out, peak: null }
}

/* ------------------------------------------------------------------ */
/* pi-ai 本地价格（自动兜底）                                          */
/* ------------------------------------------------------------------ */

/** 模型名归一化键（小写、去首尾空白）。 */
function modelKey(model) {
  return String(model ?? '').trim().toLowerCase()
}

/** 定位 pi-ai 插件的 provider 价格数据目录（<dir>/<provider>.json 含每个模型的 cost）。 */
export function piAiDataDir(dshHome) {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
}

/**
 * 把 pi-ai 的 provider JSON（{ api类型: { 模型id: { cost:{input,output,cacheRead,cacheWrite} } } }）
 * 摊平成 { model: {input,output,cacheRead,cacheWrite, currency:'USD'} }。跳过 cost 缺失/非数值项。
 */
export function flattenPiAiCost(providerJson) {
  const out = {}
  for (const apis of Object.values(providerJson ?? {})) {
    if (apis === null || typeof apis !== 'object') continue
    for (const [model, entry] of Object.entries(apis)) {
      if (entry === null || typeof entry !== 'object') continue
      const cost = entry.cost
      if (cost === null || typeof cost !== 'object') continue
      const input = parsePriceNumber(cost.input)
      const output = parsePriceNumber(cost.output)
      const cacheRead = parsePriceNumber(cost.cacheRead)
      const cacheWrite = parsePriceNumber(cost.cacheWrite)
      if (input === null || output === null || cacheRead === null || cacheWrite === null) continue
      out[modelKey(model)] = { input, output, cacheRead, cacheWrite, currency: 'USD' }
    }
  }
  return out
}

/** 读取某个 provider 的 pi-ai 本地价格表；文件缺失/损坏返回 {}。 */
export function loadPiAiProvider(provider, dataDir) {
  if (typeof provider !== 'string' || provider.trim() === '') return {}
  const dir = dataDir ?? piAiDataDir()
  const file = join(dir, `${provider}.json`)
  try {
    if (!existsSync(file)) return {}
    const raw = readFileSync(file, 'utf8')
    const data = JSON.parse(raw)
    if (data === null || typeof data !== 'object') return {}
    return flattenPiAiCost(data)
  } catch {
    return {}
  }
}

/** 列出 pi-ai data 目录里所有 provider 名（对应每个 *.json，去扩展名）；跳过隐藏/清单文件（.manifest.json）。 */
export function listPiAiProviders(dataDir) {
  const dir = dataDir ?? piAiDataDir()
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* 缓存                                                               */
/* ------------------------------------------------------------------ */

/** 解析价格缓存文件的存放路径。 */
export function priceCachePath(dshHome) {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', PRICE_CACHE_FILENAME)
}

/** 读取缓存；不存在或损坏返回 null。 */
export function loadPriceCache(filePath) {
  try {
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || typeof data.fetchedAt !== 'number') return null
    return data
  } catch {
    return null
  }
}

/** 写入缓存（先写临时文件再原子改名）。 */
export function savePriceCache(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    try {
      renameSync(tmp, filePath)
    } catch {
      // 某些受限环境 rename 失败，退化为直接写目标
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
    }
  } catch (err) {
    console.warn(`[token-billing] 价格缓存写入失败：${err.message}`)
  }
}

/** 缓存是否过期（refreshHours 小时未更新）。 */
export function isCacheStale(cache, refreshHours) {
  if (cache === null || typeof cache.fetchedAt !== 'number') return true
  const hours = Number.isFinite(refreshHours) && refreshHours > 0 ? refreshHours : DEFAULT_REFRESH_HOURS
  return Date.now() - cache.fetchedAt > hours * 3600_000
}

/* ------------------------------------------------------------------ */
/* 合并                                                               */
/* ------------------------------------------------------------------ */

/**
 * 把抓取结果归一化为 { model: entry } 平表（含 currency）。
 * 高峰/错峰生效（已到生效日期或 force）时以高峰价作为基准价，否则用平峰价。
 */
export function fetchedToFlat(fetched, forcePeak = false, now = Date.now()) {
  if (fetched === null || typeof fetched !== 'object') return {}
  const models = fetched.peak !== null && (fetched.peak.effectiveAt === null || fetched.peak.effectiveAt <= now || forcePeak)
    ? fetched.peak.models
    : fetched.flat
  const currency = fetched.currency === null || fetched.currency === undefined ? null : currencySymbol(fetched.currency)
  const out = {}
  for (const [model, entry] of Object.entries(models)) {
    out[String(model).toLowerCase()] = {
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
      currency: entry.currency === undefined ? currency : currencySymbol(entry.currency),
    }
  }
  return out
}

/** 高峰/错峰计费是否生效（抓到高峰表且（已到生效日期或强制））。 */
export function peakActive(fetched, forcePeak = false, now = Date.now()) {
  if (fetched === null || typeof fetched !== 'object' || fetched.peak === null) return false
  const p = fetched.peak
  if (p.effectiveAt !== null && p.effectiveAt > now && !forcePeak) return false
  return true
}

/** 从 fetched 提取高峰窗口（分钟对列表，可带第 3 位星期几限定）。 */
export function peakWindowsOf(fetched) {
  const windows = fetched?.peak?.windows ?? []
  return windows
    .map((w) => {
      const out = [toMinutes(w[0]), toMinutes(w[1])]
      if (Array.isArray(w[2]) && w[2].length > 0) out.push(w[2])
      return out
    })
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s !== e)
}

/** "HH:MM" → 当天分钟数。 */
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (m === null) return NaN
  return Number(m[1]) * 60 + Number(m[2])
}

/** "HH:MM" 偏移 delta 分钟（如 +480 = 折算为北京时间），结果仍为 "H:MM" 形式。 */
function shiftHhmm(hhmm, delta) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (m === null) return hhmm
  const total = (Number(m[1]) * 60 + Number(m[2]) + delta) % 1440
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
