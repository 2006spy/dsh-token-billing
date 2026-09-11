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
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { CODING_PLAN_PRICING } from './coding-plans.js'

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

/* ------------------------------------------------------------------ */
/* 模型名归一化（解析层与写入层共用）                                  */
/* ------------------------------------------------------------------ */

/**
 * 剥离官方定价页的脚注/上标标记：
 *   deepseek-flash(1) / deepseek-v4-pro（2） / deepseek-flash[1] / deepseek-flash¹ / deepseek-flash*
 *   → deepseek-flash / deepseek-v4-pro
 *
 * 官方价格表的模型表头带脚注编号（页脚 (1) 说明模型改名、(2) 说明下线计划），
 * 旧解析器把 "(1)" 一起当作模型名，产出 'deepseek-flash(1)' 这类脏 key，
 * 导致抓取价永远匹配不上真实模型名（只能回落陈旧的 BUILTIN_PRICES）。
 * 归一化必须发生在解析层与写入层，且共用同一函数。
 */
export function stripFootnoteMarks(text) {
  return String(text ?? '')
    // 尾部括号脚注：(1) （1） [1] 【1】
    .replace(/[\s\u00a0]*[（(\[【]\s*\d+\s*[)）\]】][\s\u00a0]*$/g, '')
    // 尾部上标数字/符号：¹²³⁴⁵⁶⁷⁸⁹⁰ * † ‡ ↑
    .replace(/[\s\u00a0]*[¹²³⁴⁵⁶⁷⁸⁹⁰*†‡↑]+[\s\u00a0]*$/g, '')
    .trim()
}

/**
 * 模型名基础键：小写 + 去首尾空白 + 去脚注标记 + 去同族 vendor 前缀。
 * 保留原有分隔符（. _ - 等），避免改动非 DeepSeek 模型的键（如 mimo-v2.5）。
 */
function modelBaseKey(model) {
  let s = stripFootnoteMarks(model).toLowerCase().trim()
  const slash = s.indexOf('/')
  if (slash > 0 && s.slice(0, slash) === 'deepseek' && s.slice(slash + 1).startsWith('deepseek')) {
    s = s.slice(slash + 1) // "deepseek/deepseek-v4-flash-0731" → "deepseek-v4-flash-0731"
  }
  return s
}

/** 档位判别用的规整形式：把任意分隔符（. _ 空格）统一成 -，忽略分隔符差异。 */
function tierForm(model) {
  return modelBaseKey(model).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** DeepSeek 官方档位对应的规范模型 id（官方现名）。 */
export const DEEPSEEK_MODEL_IDS = { flash: 'deepseek-flash', pro: 'deepseek-v4-pro' }

/**
 * DeepSeek 模型档位：'flash' | 'pro' | null（大小写与分隔符不敏感）。
 * 官方脚注 (1)：模型名请用 deepseek-flash；旧名 deepseek-v4-flash /
 * deepseek-v4-flash-vision-exp 等仍可调用并按 Flash 价格计费，故统一归入 flash 档。
 */
export function modelTier(model) {
  const t = tierForm(model)
  if (!/^deepseek(-|$)/.test(t)) return null
  if (t.includes('flash')) return 'flash'
  if (/(^|-)pro($|-)/.test(t)) return 'pro'
  return null
}

/**
 * 把任意模型名归一化为价格表查找键（解析层与写入层共用的唯一归一化函数）。
 *  - DeepSeek flash 家族（deepseek-flash / deepseek-v4-flash / deepseek-v4.1-flash /
 *    deepseek-v4-flash-0731 / deepseek-v4-flash-ga-260731 / deepseek-v4-flash-vision-exp /
 *    DeepSeek-V4-Flash-0731 / deepseek/deepseek-v4-flash-0731）→ 'deepseek-flash'
 *  - pro 家族（deepseek-v4-pro / deepseek-v4-pro-0813）→ 'deepseek-v4-pro'
 *  - 其余模型仅小写/去脚注/去同族 vendor 前缀，键形不变（deepseek-chat / glm-5.1 / mimo-v2.5 …）
 */
export function canonicalModelId(model) {
  const tier = modelTier(model)
  if (tier === null) return modelBaseKey(model)
  return DEEPSEEK_MODEL_IDS[tier]
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
    // 归一到规范模型 id：剥脚注 + 档位别名（旧名 → 官方现名）
    model = canonicalModelId(cells[0])
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
      // 模型列名同样归一化：官方表头形如 "deepseek-flash(1)" / "deepseek-v4-pro(2)"
      const models = headerCells.slice(1).map((c) => canonicalModelId(c)).filter(Boolean)
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
    out[canonicalModelId(model)] = parsed
    if (typeof entry.currency === 'string' && entry.currency.length > 0) currency = entry.currency
  }
  if (Object.keys(out).length === 0) throw new Error('价格端点未返回任何可解析的模型价格')
  return { currency, flat: out, peak: null }
}

/* ------------------------------------------------------------------ */
/* pi-ai provider 价目目录：三层取数                                    */
/* ------------------------------------------------------------------ */
/*
 * 按路由计价需要「provider + model」各自的官方价。取数按优先级三层：
 *
 *   1. disk    —— 本机真的安装了 @earendil-works/pi-ai（<dir>/<provider>.json）
 *   2. asar    —— DSH 打包发行版把 pi-ai 封在 Electron 归档内：
 *                 <install>/resources/app.asar!/node_modules/@earendil-works/pi-ai/dist/providers/data
 *                 （本机即属此种：磁盘上没有该包，但归档里有 v0.85.1 全量 catalog）
 *   3. builtin —— 随包分发的 lib/coding-plans.js：任何机器都有价，不依赖本机是否装 pi-ai
 *
 * 三层都产出同一形状 { model: {input,output,cacheRead,cacheWrite,currency} }。
 * 实际命中的层由 loadProviderPrices() 的 source 如实返回（disk/asar/builtin/none），
 * 写入 spec.providerSources 时不得谎报来源。
 */

/** asar 内 pi-ai catalog 的相对路径（用 / 分段，逐级下钻）。 */
const PI_AI_ASAR_SUBPATH = 'node_modules/@earendil-works/pi-ai/dist/providers/data'
/** 磁盘上 pi-ai data 目录的相对尾部。 */
const PI_AI_DATA_TAIL = ['@earendil-works', 'pi-ai', 'dist', 'providers', 'data']
/** 显式指定 asar 位置的环境变量（便于测试与非常规部署）。 */
const PI_AI_ASAR_ENV = ['DSH_APP_ASAR', 'DSH_ASAR_PATH']

/**
 * 定位磁盘上 pi-ai 插件的 provider 价格数据目录（<dir>/<provider>.json 含每个模型的 cost）。
 * 依次探测 DSH_PI_AI_PATH、DSH_HOME/profiles、DSH_HOME、当前工作目录下的 node_modules；
 * 都不存在时返回首选路径（调用方会在三层取数里继续下探 asar / 内置表）。
 */
export function piAiDataDir(dshHome) {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const cands = []
  const env = process.env.DSH_PI_AI_PATH
  if (typeof env === 'string' && env !== '') {
    cands.push(env, join(env, ...PI_AI_DATA_TAIL.slice(2)), join(env, ...PI_AI_DATA_TAIL))
  }
  cands.push(
    join(home, 'profiles', 'node_modules', ...PI_AI_DATA_TAIL),
    join(home, 'node_modules', ...PI_AI_DATA_TAIL),
    join(process.cwd(), 'node_modules', ...PI_AI_DATA_TAIL),
  )
  for (const cand of cands) if (existsSync(cand)) return cand
  return cands[0]
}

/**
 * 把 pi-ai 的 provider JSON（{ api类型: { 模型id: { cost:{input,output,cacheRead,cacheWrite} } } }）
 * 摊平成 { model: {input,output,cacheRead,cacheWrite, currency:'USD'} }。跳过 cost 缺失/非数值项。
 */
/**
 * 确定性挑选展示别名：对映射到同一规范键的**全部原始 id**，按
 * 「**长度升序，同长按字典序升序**」排序后取第一个。
 *
 * **为什么不能用「迭代顺序上的第一个」**：catalog 由 `scripts/sync-coding-plans.mjs` 在每次
 * 升级 pi-ai 时重新生成，键序可能变化；若依赖顺序，alias 会翻成同族的另一个变体
 * （如 `deepseek-v4-flash` → `deepseek-v4-flash-vision-exp`），进而改变 projection view 的
 * 价目行名、让 `tests/view-findprice-test.mjs` 以极难定位的原因失败。本规则与键序无关。
 *
 * 例：`deepseek-v4-flash`(17) vs `deepseek-v4-flash-vision-exp`(28) → 取 `deepseek-v4-flash`。
 * 注：规范名本身**不入候选**（调用方只收 `canonicalModelId(id) !== id` 的原始 id），
 * 因此不会退化成规范键名。
 */
function pickDeterministicAlias(candidates) {
  const sorted = [...candidates].sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0))
  return sorted[0]
}

/**
 * 把 pi-ai 的 provider JSON（{ api类型: { 模型id: { cost:{input,output,cacheRead,cacheWrite} } } }）
 * 摊平成 { model: {input,output,cacheRead,cacheWrite, currency:'USD', alias?} }。跳过 cost 缺失/非数值项。
 */
export function flattenPiAiCost(providerJson) {
  const out = {}
  // 规范键 → 映射到它的**被改名的原始 id** 集合（键名与原名相同的项不入候选）。
  const aliasCandidates = new Map()
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
      const key = canonicalModelId(model)
      // 键被规范化（改名 / 档位折叠）时记下原始 id，循环结束后**确定性地**挑一个作展示别名。
      // 用途：projection view 的 providerPrices 行用 alias 作 model，使 UI 传来的历史模型名
      // （deepseek-v4-flash / …-0731 / DeepSeek-V4-Flash / vendor 前缀写法）仍能匹配到价目
      // —— 见 tests/view-findprice-test.mjs 与 tests/client-alias-parity.mjs。
      // 价格本体保持原行为（后写覆盖）。
      if (key !== model) {
        let set = aliasCandidates.get(key)
        if (set === undefined) {
          set = new Set()
          aliasCandidates.set(key, set)
        }
        set.add(model)
      }
      out[key] = { input, output, cacheRead, cacheWrite, currency: 'USD' }
    }
  }
  for (const [key, candidates] of aliasCandidates) {
    const entry = out[key]
    if (entry === undefined) continue
    const alias = pickDeterministicAlias(candidates)
    if (alias !== undefined) entry.alias = alias
  }
  return out
}

/* ---- 第 2 层：asar 归档（Electron 打包发行版）----------------------- */

/**
 * 从 PATH 上的 dsh 启动器推导安装目录下的 resources/app.asar。
 * 启动器（dsh.cmd / dsh.bat / dsh 脚本）里写着安装的绝对路径，
 * 例如 `"...\resources\app.asar\lib\desktop-cli.js"`；由此得到 asar 位置，
 * 不需要在本插件里硬编码任何安装路径。
 */
function asarFromLauncher() {
  const dirs = String(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter((d) => d !== '')
  for (const dir of dirs) {
    for (const name of ['dsh.cmd', 'dsh.bat', 'dsh.ps1', 'dsh']) {
      const file = join(dir, name)
      if (!existsSync(file)) continue
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch { continue }
      // 优先取引号内的路径（安装路径常含空格，如 "DSH Desktop"）
      for (const quoted of text.match(/"[^"\r\n]*app\.asar[^"\r\n]*"/gi) ?? []) {
        const inner = quoted.slice(1, -1)
        const idx = inner.toLowerCase().indexOf('app.asar')
        if (idx <= 0) continue
        const cand = inner.slice(0, idx + 'app.asar'.length)
        if (existsSync(cand)) return cand
      }
      // 退化：未被引号包裹、且不含空格的绝对路径
      const m = text.match(/[A-Za-z]:[\\/][^"'\r\n;]*?app\.asar/i)
      if (m !== null && existsSync(m[0])) return m[0]
    }
  }
  return null
}

/** 各平台常见安装位置的 app.asar 猜测（仅作补充，找不到就跳过）。 */
function conventionalAsarPaths() {
  const out = []
  const names = ['DeepSeek Harness', 'deepseek-harness', 'DSH Desktop', 'DSH-Desktop']
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (typeof base !== 'string' || base === '') continue
    for (const name of names) {
      out.push(join(base, name, 'resources', 'app.asar'))
      out.push(join(base, 'Programs', name, 'resources', 'app.asar'))
    }
  }
  out.push(
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
    '/usr/lib/deepseek-harness/resources/app.asar',
    '/opt/DeepSeek Harness/resources/app.asar',
  )
  return out
}

/**
 * asar 归档的候选路径（按优先级）。按运行环境推导，**不硬编码任何单一绝对路径**：
 *  1. 环境变量 DSH_APP_ASAR / DSH_ASAR_PATH（显式指定，测试与非常规部署）；
 *  2. Electron 的 process.resourcesPath（插件在宿主进程内运行时命中，最可靠）；
 *  3. 从 process.execPath 推导 <dir>/resources/app.asar 与 <dir>/../resources/app.asar；
 *  4. 从 PATH 上的 dsh 启动器推导安装路径；
 *  5. 各平台常见安装位置。
 */
function asarCandidates() {
  const out = []
  for (const key of PI_AI_ASAR_ENV) {
    const v = process.env[key]
    if (typeof v === 'string' && v.trim() !== '') out.push(v.trim())
  }
  const res = process.resourcesPath
  if (typeof res === 'string' && res !== '') out.push(join(res, 'app.asar'))
  const exe = process.execPath
  if (typeof exe === 'string' && exe !== '') {
    const dir = dirname(exe)
    out.push(join(dir, 'resources', 'app.asar'), join(dir, '..', 'resources', 'app.asar'))
  }
  const fromLauncher = asarFromLauncher()
  if (fromLauncher !== null) out.push(fromLauncher)
  out.push(...conventionalAsarPaths())
  return [...new Set(out)]
}

/**
 * asar 头部布局（Electron asar 规范）：
 *   u32@0 = 4（pickle 头）  u32@4 = headerSize  u32@8 = jsonLen+4  u32@12 = jsonLen
 *   偏移 16 起为 header JSON；数据段基址 = 8 + u32@4 = 16 + jsonLen。
 * 注意：header JSON 里条目的 size/offset 是**字符串**，必须 Number()，否则会变成字符串拼接。
 * 结果按 asar 路径缓存（header 可达数 MB，只解析一次）。
 */
const asarInfoCache = new Map()
function asarCatalogInfo(asarPath) {
  if (asarInfoCache.has(asarPath)) return asarInfoCache.get(asarPath)
  let info = null
  let fd = null
  try {
    if (!existsSync(asarPath)) {
      asarInfoCache.set(asarPath, null)
      return null
    }
    fd = openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    if (readSync(fd, head, 0, 16, 0) !== 16) throw new Error('asar 头部不足 16 字节')
    const jsonLen = head.readUInt32LE(12)
    // 合理性护栏：避免把非 asar 文件当成归档解析
    if (!Number.isFinite(jsonLen) || jsonLen <= 0 || jsonLen > 64 * 1024 * 1024) throw new Error('asar 头部长度异常')
    const jsonBuf = Buffer.alloc(jsonLen)
    if (readSync(fd, jsonBuf, 0, jsonLen, 16) !== jsonLen) throw new Error('asar 头部读取不完整')
    const header = JSON.parse(jsonBuf.toString('utf8'))
    const base = 8 + head.readUInt32LE(4)
    if (header === null || typeof header !== 'object') throw new Error('asar 头部不是对象')
    info = { base, files: header.files ?? {} }
  } catch {
    info = null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* 忽略关闭失败 */ }
    }
  }
  asarInfoCache.set(asarPath, info)
  return info
}

/** 按路径分段下钻 asar 文件树；任一段缺失返回 null。 */
function walkAsar(files, segments) {
  let node = { files }
  for (const seg of segments) {
    const next = node?.files?.[seg]
    if (next === undefined || next === null) return null
    node = next
  }
  return node
}

/**
 * 按路径分段读取 asar 内某个文件的原文；asar 不可用或该文件不存在时返回 null。
 * 分段示例：['node_modules','@earendil-works','pi-ai','package.json']
 */
function readAsarFile(segments) {
  for (const asarPath of asarCandidates()) {
    const info = asarCatalogInfo(asarPath)
    if (info === null) continue
    const node = walkAsar(info.files, segments)
    // 目录节点（带 files）不是文件，跳过
    if (node === null || node.files !== undefined) continue
    const size = Number(node.size)
    const offset = Number(node.offset)
    if (!Number.isFinite(size) || !Number.isFinite(offset) || size <= 0) continue
    let fd = null
    try {
      fd = openSync(asarPath, 'r')
      const buf = Buffer.alloc(size)
      if (readSync(fd, buf, 0, size, info.base + offset) !== size) continue
      return buf.toString('utf8')
    } catch {
      continue
    } finally {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* 忽略关闭失败 */ }
      }
    }
  }
  return null
}

/** asar 内 pi-ai catalog 的 provider 名清单；asar 不可用返回 null（与「asar 里没有该 provider」区分开）。 */
function asarCatalogProviderNames() {
  for (const asarPath of asarCandidates()) {
    const info = asarCatalogInfo(asarPath)
    if (info === null) continue
    const dir = walkAsar(info.files, PI_AI_ASAR_SUBPATH.split('/'))
    if (dir === null) continue
    return Object.keys(dir.files ?? {})
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort()
  }
  return null
}

/** 从 asar 读一个 catalog json 的原文；找不到返回 null。 */
function readAsarCatalogRaw(provider) {
  if (typeof provider !== 'string' || provider === '') return null
  return readAsarFile([...PI_AI_ASAR_SUBPATH.split('/'), `${provider}.json`])
}

/* ---- 第 3 层：随包内置价表 ---------------------------------------- */

/** 内置价表覆盖的 provider 名单（随包分发，永远可用）。 */
export function builtinProviderNames() {
  return Object.keys(CODING_PLAN_PRICING).sort()
}

/** 内置价表条目 → 与 flattenPiAiCost 同形状的平表（键同样走 canonicalModelId 归一化）。 */
function flattenBuiltinModels(models) {
  const out = {}
  // 与 flattenPiAiCost 同一策略：收集**被改名的原始 id**，循环后由 pickDeterministicAlias 定夺。
  const aliasCandidates = new Map()
  for (const [model, entry] of Object.entries(models ?? {})) {
    if (entry === null || typeof entry !== 'object') continue
    const input = parsePriceNumber(entry.input)
    const output = parsePriceNumber(entry.output)
    const cacheRead = parsePriceNumber(entry.cacheRead)
    const cacheWrite = parsePriceNumber(entry.cacheWrite)
    if (input === null || output === null || cacheRead === null || cacheWrite === null) continue
    const key = canonicalModelId(model)
    if (key !== model) {
      let set = aliasCandidates.get(key)
      if (set === undefined) {
        set = new Set()
        aliasCandidates.set(key, set)
      }
      set.add(model)
    }
    out[key] = {
      input,
      output,
      cacheRead,
      cacheWrite,
      currency: typeof entry.currency === 'string' && entry.currency !== '' ? entry.currency : 'USD',
    }
  }
  for (const [key, candidates] of aliasCandidates) {
    const entry = out[key]
    if (entry === undefined) continue
    const alias = pickDeterministicAlias(candidates)
    if (alias !== undefined) entry.alias = alias
  }
  return out
}

/* ---- 三层取数（对外）---------------------------------------------- */

/**
 * 三层取数：返回 { source, models }。
 *  - source ∈ 'disk' | 'asar' | 'builtin' | 'none'（如实反映实际命中的层）
 *  - models 为 { model: {input,output,cacheRead,cacheWrite,currency} }
 * @param provider - provider 名。
 * @param dataDir - 显式磁盘目录（缺省 piAiDataDir()）；该目录不存在时继续下探 asar / 内置表。
 */
export function loadProviderPrices(provider, dataDir) {
  if (typeof provider !== 'string' || provider.trim() === '') return { source: 'none', models: {} }
  const name = provider.trim()
  // 第 1 层：磁盘
  try {
    const file = join(dataDir ?? piAiDataDir(), `${name}.json`)
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data !== null && typeof data === 'object') return { source: 'disk', models: flattenPiAiCost(data) }
    }
  } catch { /* 损坏则下探 */ }
  // 第 2 层：asar
  try {
    const raw = readAsarCatalogRaw(name)
    if (raw !== null) {
      const data = JSON.parse(raw)
      if (data !== null && typeof data === 'object') return { source: 'asar', models: flattenPiAiCost(data) }
    }
  } catch { /* 损坏则下探 */ }
  // 第 3 层：内置价表
  const builtin = CODING_PLAN_PRICING[name]
  if (builtin !== undefined && builtin !== null && typeof builtin.models === 'object') {
    return { source: 'builtin', models: flattenBuiltinModels(builtin.models) }
  }
  return { source: 'none', models: {} }
}

/**
 * 打开 pi-ai catalog 的**只读访问面**（仅 disk / asar 两层，**不含内置表**）。
 * 供 `scripts/sync-coding-plans.mjs` 生成/刷新内置价表使用，避免那份脚本重复实现 asar 读取。
 * @param dataDir - 显式磁盘目录（缺省 piAiDataDir()）。
 * @returns {{ source:'disk'|'asar'|'none', providers:string[], read:(name:string)=>string|null, manifest:object|null, packageJson:object|null }}
 */
export function openPiAiCatalog(dataDir) {
  const dir = dataDir ?? piAiDataDir()
  const diskNames = []
  let hasDisk = false
  try {
    if (existsSync(dir)) {
      hasDisk = true
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.json') && !f.startsWith('.')) diskNames.push(f.slice(0, -'.json'.length))
      }
    }
  } catch { /* 忽略目录读取失败 */ }
  const asarNames = asarCatalogProviderNames()
  const providers = [...new Set([...diskNames, ...(asarNames ?? [])])].sort()
  const source = providers.length === 0 ? 'none' : hasDisk ? 'disk' : 'asar'

  /** 读 catalog 原文：磁盘优先，其次 asar。可传 provider 名或完整文件名（.manifest.json）。 */
  const read = (name) => {
    if (typeof name !== 'string' || name.trim() === '') return null
    const file = name.trim().endsWith('.json') ? name.trim() : `${name.trim()}.json`
    try {
      const p = join(dir, file)
      if (existsSync(p)) return readFileSync(p, 'utf8')
    } catch { /* 下探 asar */ }
    return readAsarFile([...PI_AI_ASAR_SUBPATH.split('/'), file])
  }
  const asJson = (raw) => {
    if (raw === null) return null
    try { return JSON.parse(raw) } catch { return null }
  }
  // pi-ai 版本：磁盘 <dataDir>/../../../package.json，其次 asar 内包清单
  let packageJson = null
  try {
    const p = join(dir, '..', '..', '..', 'package.json')
    if (existsSync(p)) packageJson = JSON.parse(readFileSync(p, 'utf8'))
  } catch { /* 下探 asar */ }
  if (packageJson === null) {
    packageJson = asJson(readAsarFile(['node_modules', '@earendil-works', 'pi-ai', 'package.json']))
  }
  return { source, providers, read, manifest: asJson(read('.manifest.json')), packageJson }
}

/** 列出可取价的 provider 名（disk ∪ asar ∪ builtin 并集，去重排序）。 */
export function listPiAiProviders(dataDir) {
  const names = new Set()
  try {
    const dir = dataDir ?? piAiDataDir()
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.json') && !f.startsWith('.')) names.add(f.slice(0, -'.json'.length))
      }
    }
  } catch { /* 忽略目录读取失败 */ }
  const asarNames = asarCatalogProviderNames()
  if (asarNames !== null) for (const n of asarNames) names.add(n)
  for (const n of builtinProviderNames()) names.add(n)
  return [...names].sort()
}

/** 读取某个 provider 的价格表（三层取数，只取模型表）。三层都没有时返回 {}。 */
export function loadPiAiProvider(provider, dataDir) {
  return loadProviderPrices(provider, dataDir).models
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
    // 写入层同样归一化：脏 key（带脚注）与旧模型名都不会落进价格表
    out[canonicalModelId(model)] = {
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
