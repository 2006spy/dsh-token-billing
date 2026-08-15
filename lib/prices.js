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
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
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

  // 高峰时段（中文/英文两种表述）
  const windows = []
  let windowTz = null
  const zhWindowRe = /高峰时段(?:为)?(?:北京时间)?\s*(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s*[、，,]\s*(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/
  const zhWm = zhWindowRe.exec(text)
  if (zhWm !== null) {
    windows.push([zhWm[1], zhWm[2]], [zhWm[3], zhWm[4]])
    windowTz = 'Asia/Shanghai'
  } else {
    const enWindowRe = /Peak hours? are\s+(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})(?:\s*and\s+(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2}))?/i
    const enWm = enWindowRe.exec(text)
    if (enWm !== null) {
      windows.push([enWm[1], enWm[2]])
      if (enWm[3] !== undefined) windows.push([enWm[3], enWm[4]])
      windowTz = 'UTC'
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
    const hasPeakKind = rows.slice(1).some((r) => kindOf(r[0]) !== null)
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
      // Layout B：表头 [MODEL, m1, m2…]，行 = [标签(或段头|标签), 各模型价格…]
      // 中文/英文页的价格首行都可能是 [价格(1), 百万tokens输入（缓存命中）, 0.02元, …]，
      // 标签在第二格：匹配到 row[1] 时价格从 row.slice(2) 起。
      const models = headerCells.slice(1).map((c) => c.trim().toLowerCase()).filter(Boolean)
      const columns = { input: [], output: [], cacheRead: [], cacheWrite: [] }
      for (const row of rows.slice(1)) {
        let key = headerKey(row[0])
        if (key !== null && columns[key] !== undefined) {
          columns[key] = row.slice(1)
        } else {
          key = headerKey(row[1])
          if (key !== null && columns[key] !== undefined) columns[key] = row.slice(2)
        }
      }
      for (let i = 0; i < models.length; i++) {
        const cacheRead = parsePriceNumber(columns.cacheRead[i])
        const cacheWrite = parsePriceNumber(columns.cacheWrite[i])
        const output = parsePriceNumber(columns.output[i])
        if (cacheRead === null || cacheWrite === null || output === null) continue
        flat[models[i]] = { input: cacheWrite, cacheRead, cacheWrite, output }
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

/** 从 fetched 提取高峰窗口（分钟对列表）。 */
export function peakWindowsOf(fetched) {
  const windows = fetched?.peak?.windows ?? []
  return windows
    .map(([s, e]) => [toMinutes(s), toMinutes(e)])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s !== e)
}

/** "HH:MM" → 当天分钟数。 */
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (m === null) return NaN
  return Number(m[1]) * 60 + Number(m[2])
}
