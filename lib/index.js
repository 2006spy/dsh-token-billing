/**
 * dsh-token-billing — 宿主端插件入口（v0.2：官网实时价格 + DeepSeek 高峰/错峰计费）。
 *
 * 注册一个名为 `tokenBilling` 的会话投影：重放会话事件流，按模型价格表把
 * token 用量实时换算为费用（精确 usage 优先，流式期间用启发式估算并标记；
 * DeepSeek 高峰/错峰按官方时段自动切换计价）。
 *
 * 价格来源（`token-billing` settings 命名空间实时配置，改即重建、无需重启）：
 *  - builtin      仅内置表（近似价，用户可覆盖）
 *  - deepseek     抓取 DeepSeek 官方价格页（api-docs.deepseek.com），
 *                 解析平峰价 + 高峰/错峰价表与高峰时段，带 24h 缓存与后台自动刷新
 *  - custom-json  抓取用户自定义 JSON 价格端点（网关 / gist）
 * 合并优先级：用户「模型价格覆盖」> 官网抓取 > 内置表 > 未知模型默认价。
 *
 * 浏览器端「设置 → 插件 → Web UI 插件 → Token 计费」卡片可手动刷新价格，
 * 通过宿主路由 POST /token-billing/refresh（GET /token-billing/prices 查状态）。
 */
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import { z as zod } from 'zod'
import {
  createTokenBillingProjectionParts,
  resolveBillingSpec,
  applyFetchedPrices,
  priceAt,
} from './projection.js'
import {
  fetchDeepSeekPrices,
  fetchJsonPrices,
  loadPriceCache,
  savePriceCache,
  priceCachePath,
  isCacheStale,
  peakActive,
} from './prices.js'
import {
  ledgerPath,
  loadLedger,
  saveLedger,
  mergeSteps,
  computeStats,
  ledgerToCsv,
  ledgerToJson,
} from './ledger.js'

/** 计费命名空间（浏览器端同样拼写此值）。 */
export const BILLING_SETTINGS_NAMESPACE = settingsNamespace('token-billing')

/** 插件配置（settings 命名空间 token-billing 的 schema）。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  currency: z.string().default('¥'),
  priceSource: z.string().default('deepseek'),
  customPriceUrl: z.string().default(''),
  refreshHours: z.number().min(0.1).default(1),
  fxEnabled: z.boolean().default(true),
  fxRate: z.number().min(0.000001).default(7.2),
  fallbackInput: z.number().min(0).default(2),
  fallbackOutput: z.number().min(0).default(8),
  fallbackCacheRead: z.number().min(0).default(0.5),
  fallbackCacheWrite: z.number().min(0).default(2),
  prices: z.string().default('{}'),
  offPeakEnabled: z.boolean().default(true),
  offPeakWindows: z.string().default('[["01:00","04:00"],["06:00","10:00"]]'),
  offPeakRate: z.number().min(0).max(1).default(0.5),
  offPeakModels: z.string().default('deepseek-*'),
  offPeakTz: z.string().default('UTC'),
  offPeakForce: z.boolean().default(false),
  localProviders: z.string().default(''),
  localCostPerM: z.number().min(0).default(0),
})

/** 投影视图的 wire schema（host 校验后才发给浏览器）。 */
const costsRecord = zod.record(zod.string(), zod.number().nonnegative())
const viewSchema = zod.object({
  currency: zod.string(),
  billing: zod.object({
    source: zod.string(),
    peakBilling: zod.boolean(),
    peakActive: zod.boolean(),
    windows: zod.array(zod.tuple([zod.number(), zod.number()])),
  }).strict(),
  prices: zod.array(zod.object({
    model: zod.string(),
    input: zod.number().nonnegative(),
    output: zod.number().nonnegative(),
    cacheRead: zod.number().nonnegative(),
    cacheWrite: zod.number().nonnegative(),
    currency: zod.string(),
  }).strict()),
  totals: zod.object({
    uncachedInputTokens: zod.number().int().nonnegative(),
    outputTokens: zod.number().int().nonnegative(),
    cacheReadTokens: zod.number().int().nonnegative(),
    cacheWriteTokens: zod.number().int().nonnegative(),
    costs: costsRecord,
    calls: zod.number().int().nonnegative(),
    estimatedSteps: zod.number().int().nonnegative(),
    exactSteps: zod.number().int().nonnegative(),
  }).strict(),
  turn: zod.object({
    number: zod.number().int().nonnegative(),
    costs: costsRecord,
    estimated: zod.boolean(),
    steps: zod.number().int().nonnegative(),
    estimatedSteps: zod.number().int().nonnegative(),
  }).strict(),
  active: zod.object({
    turn: zod.number().int().nonnegative(),
    step: zod.number().int().nonnegative(),
    model: zod.string(),
    provider: zod.string(),
    uncachedInputTokens: zod.number().int().nonnegative(),
    outputTokens: zod.number().int().nonnegative(),
    cacheReadTokens: zod.number().int().nonnegative(),
    cacheWriteTokens: zod.number().int().nonnegative(),
    cost: zod.number().nonnegative(),
    currency: zod.string(),
    estimated: zod.boolean(),
  }).strict().nullable(),
  last: zod.object({
    turn: zod.number().int().nonnegative(),
    step: zod.number().int().nonnegative(),
    model: zod.string(),
    provider: zod.string(),
    outputTokens: zod.number().int().nonnegative(),
    cost: zod.number().nonnegative(),
    currency: zod.string(),
    estimated: zod.boolean(),
  }).strict().nullable(),
  perModel: zod.array(zod.object({
    model: zod.string(),
    calls: zod.number().int().nonnegative(),
    uncachedInputTokens: zod.number().int().nonnegative(),
    outputTokens: zod.number().int().nonnegative(),
    cacheReadTokens: zod.number().int().nonnegative(),
    cacheWriteTokens: zod.number().int().nonnegative(),
    cost: zod.number().nonnegative(),
    currency: zod.string(),
    estimatedCalls: zod.number().int().nonnegative(),
  }).strict()),
  steps: zod.array(zod.object({
    turn: zod.number().int().nonnegative(),
    step: zod.number().int().nonnegative(),
    model: zod.string(),
    provider: zod.string(),
    at: zod.number(),
    uncachedInputTokens: zod.number().int().nonnegative(),
    outputTokens: zod.number().int().nonnegative(),
    cacheReadTokens: zod.number().int().nonnegative(),
    cacheWriteTokens: zod.number().int().nonnegative(),
    cost: zod.number().nonnegative(),
    currency: zod.string(),
    estimated: zod.boolean(),
  }).strict()),
}).strict()

/** 宿主端需要的服务。 */
export const inject = ['sessionProjections']

/**
 * 注册 tokenBilling 投影 + 价格抓取管理（价格/配置变化时重建）。
 * @param ctx - host 插件上下文（sessionProjections + settings + webServer）。
 * @param config - 组合层配置（schema 默认值已由 loader 填充）。
 */
export function apply(ctx, config = {}) {
  // 权威配置源：浏览器设置面就绪后换成 settings scope，否则用组合配置。
  let current = () => config ?? {}
  let disposeProjection
  let fetchInFlight = false
  /** 最近一次成功抓取（内存兜底；磁盘缓存同时保留）。 */
  let lastFetched = null
  /** 最近一次重建的计费规格（供路由读取当前生效单价）。 */
  let currentSpec = null

  const cachePath = priceCachePath()

  /* ------------------------- 持久化账本（A1） ------------------------- */
  const ledgerFile = ledgerPath()
  let ledger = loadLedger(ledgerFile)
  let ledgerTimer = null
  const flushLedger = () => {
    ledgerTimer = null
    saveLedger(ledgerFile, ledger)
  }
  const scheduleLedgerFlush = () => {
    if (ledgerTimer !== null) return
    ledgerTimer = setTimeout(flushLedger, 1000)
  }
  /** 会话 id 提取（兼容 Session 对象 / 字符串）。 */
  const sessionIdOf = (session) => {
    if (session === null || session === undefined) return 'anon'
    if (typeof session === 'string') return session
    return String(session.id ?? session.sessionId ?? session.title ?? 'anon')
  }
  // 订阅投影变更：tokenBilling 每次结算 → 幂等合并进账本（1s 防抖落盘）
  if (typeof ctx.sessionProjections?.onChanged === 'function') {
    ctx.sessionProjections.onChanged((session, key, value) => {
      if (key !== 'tokenBilling' || value === null || value === undefined) return
      if (Array.isArray(value.steps) && value.steps.length > 0) {
        mergeSteps(ledger, sessionIdOf(session), value.steps)
        scheduleLedgerFlush()
      }
    })
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      if (ledgerTimer !== null) { clearTimeout(ledgerTimer); ledgerTimer = null }
      flushLedger()
    })
  }

  /* ------------------------- 账户余额（A2） ------------------------- */
  let balanceCache = { at: 0, data: null, error: null }
  /** 余额抓取：复用 DEEPSEEK_API_KEY（env 或凭证），60s 缓存。 */
  const fetchBalance = async () => {
    const now = Date.now()
    if (balanceCache.data !== null && now - balanceCache.at < 60_000) return { ok: true, ...balanceCache.data }
    if (balanceCache.error !== null && now - balanceCache.at < 60_000) return { ok: false, error: balanceCache.error }
    const key = process.env.DEEPSEEK_API_KEY
      ?? (typeof ctx.credentials === 'object' ? ctx.credentials?.DEEPSEEK_API_KEY : undefined)
      ?? ''
    if (!key) {
      balanceCache = { at: now, data: null, error: '未配置 DEEPSEEK_API_KEY' }
      return { ok: false, error: balanceCache.error }
    }
    try {
      const base = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
      const res = await fetch(`${base}/user/balance`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const data = {
        balanceInfos: Array.isArray(json?.balance_infos) ? json.balance_infos : null,
        isAvailable: json?.is_available === true,
        raw: json,
      }
      balanceCache = { at: now, data, error: null }
      return { ok: true, ...data }
    } catch (err) {
      balanceCache = { at: now, data: null, error: err.message ?? String(err) }
      return { ok: false, error: balanceCache.error }
    }
  }

  /** 本地 provider 名单（settings 逗号分隔字符串 → 数组）。 */
  const localProvidersOf = () => {
    const raw = current().localProviders
    if (typeof raw !== 'string' || raw.trim() === '') return []
    return raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  }

  /** 当前配置 → 计费规格（合并缓存/内存中的抓取价格）。 */
  const buildSpec = () => {
    const spec = resolveBillingSpec(current())
    const cached = lastFetched ?? loadPriceCache(cachePath)
    return applyFetchedPrices(spec, cached, Date.now())
  }

  const registerProjection = (spec) => {
    if (disposeProjection !== undefined) {
      disposeProjection()
      disposeProjection = undefined
    }
    if (spec.enabled === false) return
    const parts = createTokenBillingProjectionParts(spec)
    disposeProjection = ctx.sessionProjections.register({
      key: parts.key,
      schema: viewSchema,
      init: parts.init,
      apply: parts.apply,
      view: parts.view,
      stateVersion: parts.stateVersion,
    })
  }

  const rebuild = () => {
    try {
      const spec = buildSpec()
      currentSpec = spec
      registerProjection(spec)
    } catch (err) {
      console.warn(`[token-billing] 配置无效，沿用未注册状态：${err.message}`)
    }
  }

  /**
   * 周期跟随官网：每分钟检查一次。
   *  - 高峰/错峰生效时刻（effectiveAt）到达时，立即重建投影（峰谷价自动切换）；
   *  - 价格表缓存过期（refreshHours）或来源变更时，后台重抓官网。
   * 价格表跟随官网变化、峰谷价按当前时刻生效，均无需重启。
   */
  let lastPeakActive = null
  let lastSource = null
  const tick = () => {
    const cfg = current()
    const cached = lastFetched ?? loadPriceCache(cachePath)
    if (cached !== null) {
      const activeNow = peakActive(cached, cfg.offPeakForce === true, Date.now())
      if (activeNow !== lastPeakActive || cached.source !== lastSource) {
        lastPeakActive = activeNow
        lastSource = cached.source
        rebuild()
      }
    }
    refreshPrices(false).catch(() => {})
  }
  const timer = setInterval(tick, 60_000)
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => clearInterval(timer))
  }

  /** 抓取一次价格并重建投影。force=true 忽略缓存过期。 */
  const refreshPrices = async (force = false) => {
    if (fetchInFlight) return { ok: false, error: '正在抓取中，请稍候' }
    const cfg = current()
    const cached = loadPriceCache(cachePath)
    const stale = cached === null
      || isCacheStale(cached, cfg.refreshHours)
      || cached.source !== cfg.priceSource
      || (cfg.priceSource === 'custom-json' && cached.url !== cfg.customPriceUrl)
    if (!force && !stale) return { ...statusWithEffective(cached, Date.now()), ok: true, cached: true }
    fetchInFlight = true
    try {
      let fetched
      if (cfg.priceSource === 'deepseek') {
        fetched = await fetchDeepSeekPrices()
      } else if (cfg.priceSource === 'custom-json') {
        fetched = await fetchJsonPrices(cfg.customPriceUrl)
      } else {
        // builtin：无抓取记录，但可展示内置表当前生效价
        return { ok: true, source: 'builtin', fetchedAt: null, flatModels: 0, peak: null, fx: fxStatus(), effective: effectiveFrom(Date.now()) }
      }
      const record = {
        ...fetched,
        source: cfg.priceSource,
        url: cfg.customPriceUrl,
        fetchedAt: Date.now(),
      }
      savePriceCache(cachePath, record)
      lastFetched = record
      rebuild()
      return { ...statusWithEffective(record, Date.now()), ok: true }
    } catch (err) {
      console.warn(`[token-billing] 价格抓取失败：${err.message}`)
      return { ok: false, error: err.message }
    } finally {
      fetchInFlight = false
    }
  }

  /** 当前折算配置（外币→目标货币）。 */
  const fxStatus = () => {
    const cfg = current()
    return {
      enabled: cfg.fxEnabled !== false,
      rate: cfg.fxRate,
      target: cfg.currency,
    }
  }

  const statusOf = (record) => ({
    source: record.source ?? 'builtin',
    fetchedAt: record.fetchedAt ?? null,
    currency: record.currency ?? null,
    flatModels: Object.keys(record.flat ?? {}).length,
    peak: record.peak === null ? null : {
      models: Object.keys(record.peak.models ?? {}).length,
      windows: record.peak.windows ?? [],
      effectiveAt: record.peak.effectiveAt ?? null,
    },
  })

  /** 附带当前折算配置的价格状态。 */
  const statusWithFx = (record) => ({
    ...(record === null ? { ok: false, error: '尚无价格缓存' } : { ok: true, ...statusOf(record) }),
    fx: fxStatus(),
  })

  /** 所有模型当前生效单价表（含高峰/错峰，按 now 计价）——builtin 无抓取记录时也能展示。 */
  const effectiveFrom = (now = Date.now()) => {
    if (currentSpec === null) return {}
    const effective = {}
    for (const model of Object.keys(currentSpec.prices)) {
      const p = priceAt(model, currentSpec, now)
      effective[model] = {
        input: p.input,
        output: p.output,
        cacheRead: p.cacheRead,
        cacheWrite: p.cacheWrite,
        currency: p.currency,
      }
    }
    return effective
  }

  /** 附带「当前生效单价表」（含高峰/错峰，按当前时刻计价），供设置卡「状态」页实时展示。 */
  const statusWithEffective = (record, now = Date.now()) => {
    const base = statusWithFx(record)
    if (record === null || currentSpec === null) return { ...base, effective: {} }
    return { ...base, effective: effectiveFrom(now) }
  }

  // 浏览器端手动刷新/查询价格的路由（仅 web profile 存在 webServer）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (host) => {
      /** 读取 POST JSON 请求体（有界）。 */
      const readJsonBody = (req) => new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > 256 * 1024) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          try {
            resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            reject(new Error('invalid JSON body'))
          }
        })
        req.on('error', reject)
      })

      host.webServer.register({
        name: 'token-billing-refresh',
        kind: 'exact',
        path: '/token-billing/refresh',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
            return
          }
          try {
            const result = await refreshPrices(true)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: err.message }))
          }
        },
      })
      host.webServer.register({
        name: 'token-billing-prices',
        kind: 'exact',
        path: '/token-billing/prices',
        handler: (req, res) => {
          const record = lastFetched ?? loadPriceCache(cachePath)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(statusWithEffective(record, Date.now())))
        },
      })

      /** 读取本命名空间的配置（走宿主 settings 服务，避开家族/官方白名单）。 */
      const readConfig = () => {
        const svc = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
        if (svc && typeof svc.describe === 'function') {
          const descriptor = svc.describe({ redactSecrets: true })
            .find((d) => String(d.ns) === 'token-billing')
          if (descriptor !== undefined) {
            return {
              ok: true,
              value: descriptor.value,
              base: descriptor.base ?? {},
              user: descriptor.user ?? {},
              revision: descriptor.revision,
              writable: svc.writable !== false,
            }
          }
        }
        // 兜底：组合层配置（无 settings 服务时）
        return { ok: true, value: current(), base: {}, user: {}, revision: 0, writable: true }
      }

      host.webServer.register({
        name: 'token-billing-config',
        kind: 'exact',
        path: '/token-billing/config',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(readConfig()))
        },
      })

      host.webServer.register({
        name: 'token-billing-config-save',
        kind: 'exact',
        path: '/token-billing/config/save',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
            return
          }
          try {
            const body = await readJsonBody(req)
            if (body === null || typeof body !== 'object' || typeof body.section !== 'object' || body.section === null) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'section 必须是对象' }))
              return
            }
            const svc = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
            if (!svc || typeof svc.replace !== 'function') {
              res.writeHead(500, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'settings 服务不可用' }))
              return
            }
            await svc.replace(BILLING_SETTINGS_NAMESPACE, body.section, body.expectedRevision)
            const after = readConfig()
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, revision: after.revision }))
          } catch (err) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: err.message ?? String(err) }))
          }
        },
      })

      /** 历史统计（今日/本月/累计/按模型/按天/节省）。 */
      host.webServer.register({
        name: 'token-billing-stats',
        kind: 'exact',
        path: '/token-billing/stats',
        handler: (req, res) => {
          const cfg = current()
          const stats = computeStats(ledger, {
            now: Date.now(),
            tz: cfg.offPeakTz || 'Asia/Shanghai',
            localProviders: localProvidersOf(),
            localCostPerM: Number.isFinite(cfg.localCostPerM) ? cfg.localCostPerM : 0,
            currency: cfg.currency || '¥',
          })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, stats }))
        },
      })

      /** 导出账本（?format=csv|json）。 */
      host.webServer.register({
        name: 'token-billing-export',
        kind: 'exact',
        path: '/token-billing/export',
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json'
          if (format === 'csv') {
            res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="token-billing-ledger.csv"' })
            res.end('\uFEFF' + ledgerToCsv(ledger))
          } else {
            res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="token-billing-ledger.json"' })
            res.end(ledgerToJson(ledger))
          }
        },
      })

      /** 账户余额（只读，60s 缓存）。 */
      host.webServer.register({
        name: 'token-billing-balance',
        kind: 'exact',
        path: '/token-billing/balance',
        handler: async (req, res) => {
          const result = await fetchBalance()
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(result))
        },
      })
    })
  }

  installSettingsSection(ctx, BILLING_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => { current = source },
    onChange: () => {
      rebuild()
      // 价格来源或刷新参数变化时，异步补一次抓取（后台进行，不阻塞）。
      refreshPrices(false).catch(() => {})
    },
  })
  rebuild()
  refreshPrices(false).catch(() => {})
}

export { createTokenBillingProjectionParts, resolveBillingSpec, applyFetchedPrices } from './projection.js'
export { parseDeepSeekPricingHtml, fetchDeepSeekPrices, fetchJsonPrices } from './prices.js'
