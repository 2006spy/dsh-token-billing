/**
 * 验证「按路由计价」(per provider + model routing)：
 *
 *  1. (provider, model) **双命中**才走该 provider 的价；
 *  2. 同一模型名在不同 provider 下取到各自 provider 的价；
 *  3. provider 未命中时**不跨 provider 串价**，回落全局表 / 官方政策链；
 *  4. 名称匹配对**大小写与分隔符不敏感**（deepseek/… 前缀、下划线/点/大写）；
 *  5. 三层取数（disk → asar → builtin）**来源如实标注**，空表不登记来源、不建空桶；
 *  6. 显式 provider 价目（providerPrices 配置）→ source='override'，优先级高于 catalog，
 *     但全局 prices 覆盖仍最高；
 *  7. 收费形式（usage / subscription / free / local）在结算层生效：订阅/免费/本地**实付 0**
 *     而**名义价值仍计入**节省与回本；
 *  8. 配置解析的严格性（坏 JSON / 非法值抛错）。
 *
 * 运行：node tests/route-pricing-test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  priceAt,
  resolveBillingSpec,
  applyProviderPrices,
  applyProviderPriceOverrides,
  parseProviderPricesConfig,
  parseProviderModes,
  providerModeOf,
  canonicalModelId,
  modelTier,
  createTokenBillingProjectionParts,
} from '../lib/projection.js'
import {
  loadProviderPrices,
  builtinProviderNames,
  listPiAiProviders,
  flattenPiAiCost,
} from '../lib/prices.js'
import { POLICY_PRICED_PROVIDER_IDS } from '../lib/coding-plans.js'
import { computeStats } from '../lib/ledger.js'

const NOW = Date.UTC(2026, 8, 11, 5, 0, 0) // 2026-09-11 05:00Z
let pass = 0
let fail = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error('❌ ' + msg)
    fail++
  } else {
    console.log('✅ ' + msg)
    pass++
  }
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps
const plainSpec = (extra = {}) => resolveBillingSpec({ fxEnabled: false, ...extra })

/* ================================================================== */
/* 0. 测试夹具：临时目录（disk 层）与手工构造的极小 asar（asar 层）    */
/* ================================================================== */

const tmpRoot = mkdtempSync(join(tmpdir(), 'route-pricing-'))
const emptyDir = join(tmpRoot, 'empty')
mkdirSync(emptyDir, { recursive: true })

// disk 层：<dir>/myprov.json（pi-ai catalog 形状：{ api: { 模型: { cost:{…} } } }）
const diskDir = join(tmpRoot, 'disk')
mkdirSync(diskDir, { recursive: true })
writeFileSync(join(diskDir, 'myprov.json'), JSON.stringify({
  'openai-completions': {
    'myprov-model-a': { cost: { input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3 } },
  },
}), 'utf8')

/**
 * 手工写一个极小 asar：布局为
 *   u32(4) · u32(jsonLen+8) · u32(jsonLen+4) · u32(jsonLen) · header JSON · 数据段
 * 数据段基址 = 16 + jsonLen。条目 size/offset 按真实 asar 写成**字符串**。
 */
function buildAsar(filePath, entries) {
  const root = { files: {} }
  const blobs = []
  let cursor = 0
  for (const p of Object.keys(entries)) {
    const content = entries[p]
    const segs = p.split('/')
    let node = root.files
    for (let i = 0; i < segs.length - 1; i++) {
      if (node[segs[i]] === undefined) node[segs[i]] = { files: {} }
      node = node[segs[i]].files
    }
    node[segs[segs.length - 1]] = { size: String(Buffer.byteLength(content)), offset: String(cursor) }
    cursor += Buffer.byteLength(content)
    blobs.push(content)
  }
  const headerJson = JSON.stringify({ files: root.files })
  const pad = (4 - (Buffer.byteLength(headerJson) % 4)) % 4
  const header = headerJson + ' '.repeat(pad)
  const jsonLen = Buffer.byteLength(header)
  const buf = Buffer.alloc(16 + jsonLen + cursor)
  buf.writeUInt32LE(4, 0)
  buf.writeUInt32LE(jsonLen + 8, 4)
  buf.writeUInt32LE(jsonLen + 4, 8)
  buf.writeUInt32LE(jsonLen, 12)
  buf.write(header, 16, 'utf8')
  let at = 16 + jsonLen
  for (const b of blobs) {
    buf.write(b, at, 'utf8')
    at += Buffer.byteLength(b)
  }
  writeFileSync(filePath, buf)
  return filePath
}

const ASAR_SUBDIR = 'node_modules/@earendil-works/pi-ai/dist/providers/data'
const asarPath = join(tmpRoot, 'app.asar')
buildAsar(asarPath, {
  [`${ASAR_SUBDIR}/asarprov.json`]: JSON.stringify({
    'openai-completions': {
      'asar-model-a': { cost: { input: 7, output: 21, cacheRead: 0.7, cacheWrite: 7 } },
    },
  }),
  // t11：模拟真实 catalog 的 deepseek.json —— **pre-2026-08-17 静态快照**（USD、cacheWrite=0）。
  // 镜像真实归档中该文件的三条模型（两条 flash 变体会被 canonicalModelId 折叠为 deepseek-flash）。
  // 有了它，`loadProviderPrices('deepseek')` 在测试里也会命中 asar 层，
  // 从而真正验证「装配层必须拦截」而不是「三层恰好都没有」。
  [`${ASAR_SUBDIR}/deepseek.json`]: JSON.stringify({
    'openai-completions': {
      'deepseek-v4-flash': { cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
      'deepseek-v4-flash-vision-exp': { cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
      'deepseek-v4-pro': { cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 } },
    },
  }),
  // t14：**前缀相近**的名字各造一份 catalog 数据 —— 它们必须**不被**跳过集扫入。
  // 有了数据，「照常装配」才是可验证的**行为级**断言（而非仅检查常量内容）。
  // 价格刻意取与 deepseek 快照/政策链（¥1/4/0.02/1）都不同的值，便于断言辨识。
  [`${ASAR_SUBDIR}/deepseek-official.json`]: JSON.stringify({
    'openai-completions': {
      'deepseek-v4-flash': { cost: { input: 0.9, output: 1.8, cacheRead: 0.09, cacheWrite: 0.9 } },
    },
  }),
  [`${ASAR_SUBDIR}/deepseek-x.json`]: JSON.stringify({
    'openai-completions': {
      'deepseek-v4-flash': { cost: { input: 0.8, output: 1.6, cacheRead: 0.08, cacheWrite: 0.8 } },
    },
  }),
  'node_modules/@earendil-works/pi-ai/package.json': JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.0.0-test' }),
})

// 让三层取数在本测试里可确定：disk 指向空目录，asar 指向上面手工构造的归档。
// （真实机器上 asar 由安装位置/启动器推导；这里显式指定以便可移植复现。）
process.env.DSH_PI_AI_PATH = emptyDir
process.env.DSH_APP_ASAR = asarPath

/* ================================================================== */
/* 1. 三层取数：来源如实标注                                          */
/* ================================================================== */

const diskLoaded = loadProviderPrices('myprov', diskDir)
assert(diskLoaded.source === 'disk' && close(diskLoaded.models['myprov-model-a'].input, 3),
  `disk 层：source=${diskLoaded.source}，myprov-model-a input=${diskLoaded.models['myprov-model-a']?.input}（应为 disk / 3）`)

const asarLoaded = loadProviderPrices('asarprov')
assert(asarLoaded.source === 'asar' && close(asarLoaded.models['asar-model-a'].output, 21),
  `asar 层：source=${asarLoaded.source}，asar-model-a output=${asarLoaded.models['asar-model-a']?.output}（应为 asar / 21）`)

const missing = loadProviderPrices('no-such-provider-at-all')
assert(missing.source === 'none' && Object.keys(missing.models).length === 0,
  `三层都未命中：source=${missing.source}，models=${Object.keys(missing.models).length}（应为 none / 0）`)

// 内置价表（随包分发）必须覆盖验收点名的平台，且数字来自本机 catalog
const builtinNames = builtinProviderNames()
assert(['opencode-go', 'opencode', 'kimi-coding'].every((n) => builtinNames.includes(n)),
  `内置价表覆盖 opencode-go / opencode / kimi-coding（共 ${builtinNames.length} 个 provider）`)
assert(['qwen-token-plan', 'qwen-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai-coding-cn']
  .every((n) => builtinNames.includes(n)),
  '内置价表覆盖订阅型 token 包（qwen-token-plan* / xiaomi-token-plan* / zai-coding-cn）')
// t11：内置价表**不得**含 first-party `deepseek` 快照（否则按 provider 表优先语义盖住政策链）
assert(!builtinNames.includes('deepseek'),
  `内置价表不含 first-party deepseek 快照（t11 裁决）；实际 ${builtinNames.length} 个：${builtinNames.join(', ')}`)

const union = listPiAiProviders()
assert(union.includes('asarprov') && union.includes('kimi-coding'),
  `listPiAiProviders 是 asar ∪ builtin 的并集（含 asarprov / kimi-coding，共 ${union.length} 个）`)
// 显式传磁盘目录时，三层并集应同时含 disk / asar / builtin 三层的 provider
const unionWithDisk = listPiAiProviders(diskDir)
assert(['myprov', 'asarprov', 'kimi-coding'].every((n) => unionWithDisk.includes(n)),
  `listPiAiProviders(diskDir) 是三层并集（disk=myprov / asar=asarprov / builtin=kimi-coding，共 ${unionWithDisk.length} 个）`)

/* ================================================================== */
/* 2. 路由命中 / 取各自 provider 的价                                  */
/* ================================================================== */

const spec = plainSpec()
applyProviderPrices(spec, 'opencode-go', loadProviderPrices('opencode-go').models, 'builtin')

const og = priceAt('opencode-go', 'mimo-v2.5', spec, NOW)
const og2 = priceAt('opencode-go', 'mimo-v2.5', spec, NOW)
assert(og.input === og2.input && og.input > 0, `(provider, model) 双命中走 provider 价：opencode-go/mimo-v2.5=${og.input}`)

// 同名模型在不同 provider 下各按各的价。
// 注：t11 后内置表不再含 first-party `deepseek`（改由政策链权威定价），
// 故第二个 provider 用**显式价目**构造，避免测试依赖那张被移除的快照。
applyProviderPrices(spec, 'alt-prov', { 'deepseek-v4-flash': { input: 5, output: 10, cacheRead: 0.5, cacheWrite: 5 } }, 'override')
const flashAtOg = priceAt('opencode-go', 'deepseek-v4-flash', spec, NOW)
const flashAtAlt = priceAt('alt-prov', 'deepseek-v4-flash', spec, NOW)
const ALT_FLASH_INPUT = 5
assert(close(flashAtOg.input, 0.22) && close(flashAtAlt.input, ALT_FLASH_INPUT) && flashAtOg.input !== flashAtAlt.input,
  `同名 deepseek-v4-flash 各 provider 各自的价（opencode-go=${flashAtOg.input}，alt-prov=${flashAtAlt.input}；应 0.22 / ${ALT_FLASH_INPUT}）`)

/* ================================================================== */
/* 3. 未命中不串价                                                     */
/* ================================================================== */

// opencode-go 只配到 spec，probe-provider 没有任何价目：
// 必须回落全局表/政策链，**不能**取 opencode-go 的同名模型价。
const notHit = priceAt('probe-provider', 'mimo-v2.5', spec, NOW)
assert(!close(notHit.input, og.input),
  `provider 未命中时不跨 provider 串价：probe-provider/mimo-v2.5=${notHit.input}（不得等于 opencode-go 的 ${og.input}）`)

// 显式把 provider 表清空后，未命中同样不得借用其它 provider 的价
const spec2 = plainSpec()
applyProviderPrices(spec2, 'has-price', { 'shared-model': { input: 11, output: 22, cacheRead: 1, cacheWrite: 1, currency: 'USD' } }, 'override')
const borrowed = priceAt('has-no-price', 'shared-model', spec2, NOW)
assert(!close(borrowed.input, 11),
  `未命中不借用同名模型价：has-no-price/shared-model=${borrowed.input}（不得为 11）`)

/* ================================================================== */
/* 3.5 t11：provider 恰为 `deepseek` → 由官方价格政策链权威定价         */
/* ================================================================== */

// 前置：内置价表不得再含 first-party `deepseek` 快照，
// 否则它会按 priceAt 的「provider 表优先」语义盖住时间感知的政策链。
assert(!builtinProviderNames().includes('deepseek'),
  't11 前置：内置价表不含 first-party deepseek 快照')

const OFF_0911 = Date.UTC(2026, 8, 11, 12, 0, 0)  // 09-11 20:00 北京时间（空闲）
const PEAK_0911 = Date.UTC(2026, 8, 11, 2, 0, 0)  // 09-11 10:00 北京时间（高峰）
const OFF_0820 = Date.UTC(2026, 7, 20, 12, 0, 0)  // 08-20 20:00 北京时间（空闲；09-10 调价前的政策段）
const PEAK_0820 = Date.UTC(2026, 7, 20, 2, 0, 0)  // 08-20 10:00 北京时间（高峰；同上政策段）

// 没有任何 deepseek provider 桶 → 完全由全局表 + 政策时间线解析
const specPolicy = plainSpec()
const dsOff = priceAt('deepseek', 'deepseek-v4-flash', specPolicy, OFF_0911)
assert(close(dsOff.input, 1) && close(dsOff.output, 4) && close(dsOff.cacheRead, 0.02) && close(dsOff.cacheWrite, 1),
  `t11: (deepseek, deepseek-v4-flash) 09-11 空闲由政策链定价 = ¥${dsOff.input}/${dsOff.output}/${dsOff.cacheRead}/${dsOff.cacheWrite}（应 1/4/0.02/1）`)

const dsPeak = priceAt('deepseek', 'deepseek-v4-flash', specPolicy, PEAK_0911)
assert(close(dsPeak.input, 2) && close(dsPeak.output, 8) && close(dsPeak.cacheRead, 0.04) && close(dsPeak.cacheWrite, 2),
  `t11: 同 09-11 高峰 = ¥${dsPeak.input}/${dsPeak.output}/${dsPeak.cacheRead}/${dsPeak.cacheWrite}（应 2/8/0.04/2；cacheWrite 不得为 0）`)

// 时间感知 + 历史保护：08-20（调价前政策段）与 09-11 取到各自的价，不被固定快照钉死
const dsOld = priceAt('deepseek', 'deepseek-v4-flash', specPolicy, OFF_0820)
assert(close(dsOld.input, 1.5) && close(dsOld.output, 4.5) && close(dsOld.cacheWrite, 1.5),
  `t11: 08-20 空闲取到调价前的政策段价 = ¥${dsOld.input}/${dsOld.output}/${dsOld.cacheRead}/${dsOld.cacheWrite}（应 1.5/4.5/0.05/1.5）`)
assert(!close(dsOld.output, dsOff.output) && !close(dsOld.input, dsOff.input),
  `t11: 08-20 与 09-11 价格不同（时间感知，未被固定快照钉死）：¥${dsOld.output} vs ¥${dsOff.output}`)

// 第四个时点（08-20 高峰），与上面三个一起覆盖「四时点必须为政策链值」
const dsOldPeak = priceAt('deepseek', 'deepseek-v4-flash', specPolicy, PEAK_0820)
assert(close(dsOldPeak.input, 3) && close(dsOldPeak.output, 9) && close(dsOldPeak.cacheWrite, 3),
  `t11: 08-20 高峰取到调价前的政策段价 = ¥${dsOldPeak.input}/${dsOldPeak.output}/${dsOldPeak.cacheRead}/${dsOldPeak.cacheWrite}（应 3/9/0.1/3）`)

// 2026-08-17 峰谷起点之前没有峰谷区分（高峰/空闲同价）
const preA = priceAt('deepseek', 'deepseek-v4-flash', specPolicy, Date.UTC(2026, 7, 15, 2, 0, 0))
const preB = priceAt('deepseek', 'deepseek-v4-flash', specPolicy, Date.UTC(2026, 7, 15, 12, 0, 0))
assert(close(preA.output, preB.output),
  `t11: 08-17 峰谷起点前高峰/空闲同价（¥${preA.output} == ¥${preB.output}）`)

// 逃生口：用户显式配置的 provider 价仍**优先于**政策链
const specEscape = plainSpec()
applyProviderPriceOverrides(specEscape, parseProviderPricesConfig('{"deepseek":{"deepseek-v4-flash":{"input":7,"output":70,"cacheRead":0.7,"cacheWrite":7}}}'))
const escaped = priceAt('deepseek', 'deepseek-v4-flash', specEscape, OFF_0911)
assert(close(escaped.input, 7) && close(escaped.output, 70),
  `t11: 用户显式配置的 provider 价优先于政策链（¥${escaped.input}/${escaped.output}；应 7/70 —— 逃生口保留）`)

// ---- t11（授权方案 1）：宿主装配必须对政策链定价的 provider 跳过 catalog 取数 ----
assert(POLICY_PRICED_PROVIDER_IDS.includes('deepseek'),
  `t11: 政策链定价 provider 名单含 deepseek（${JSON.stringify(POLICY_PRICED_PROVIDER_IDS)}）`)

// 前置：catalog 层**仍然**为 deepseek 供给那张 pre-08-17 快照 —— 这正是必须靠装配层拦截的原因
const dsCatalog = loadProviderPrices('deepseek')
assert(dsCatalog.source === 'asar' && close(dsCatalog.models['deepseek-flash'].input, 0.14),
  `t11 前置：catalog 仍供 deepseek 快照（source=${dsCatalog.source}，deepseek-flash=${dsCatalog.models['deepseek-flash']?.input}；应 asar / 0.14）`)

// 模拟宿主 attachProviderPrices 的装配循环（同一谓词 + 同一取数调用）
const specAsm = plainSpec()
for (const provider of ['deepseek', 'asarprov']) {
  if (POLICY_PRICED_PROVIDER_IDS.includes(provider)) continue
  const { source, models } = loadProviderPrices(provider)
  if (source !== 'none') applyProviderPrices(specAsm, provider, models, source)
}
assert(specAsm.providerPrices.deepseek === undefined && specAsm.providerSources.deepseek === undefined,
  't11: 装配跳过 deepseek —— 不建桶、不登记来源（/token-billing/providers 将如实显示 none）')
assert(specAsm.providerSources.asarprov === 'asar',
  `t11 护栏(a)：非政策链 provider 不受影响（asarprov 照常装配，source=${specAsm.providerSources.asarprov}）`)
const dsAsm = priceAt('deepseek', 'deepseek-v4-flash', specAsm, OFF_0911)
assert(close(dsAsm.input, 1) && close(dsAsm.output, 4) && close(dsAsm.cacheWrite, 1),
  `t11: 装配后该路由仍由政策链定价 = ¥${dsAsm.input}/${dsAsm.output}/${dsAsm.cacheRead}/${dsAsm.cacheWrite}（应 1/4/0.02/1）`)

// 反向对照：若不做拦截，catalog 快照确实会盖住政策链 —— 证明本条用例不是空转
const specUnfiltered = plainSpec()
applyProviderPrices(specUnfiltered, 'deepseek', dsCatalog.models, dsCatalog.source)
const dsRaw = priceAt('deepseek', 'deepseek-v4-flash', specUnfiltered, OFF_0911)
assert(close(dsRaw.input, 0.14) && close(dsRaw.cacheWrite, 0) && !close(dsRaw.input, dsAsm.input),
  `t11 反向对照：不拦截则被快照覆盖（input=${dsRaw.input}、cacheWrite=${dsRaw.cacheWrite}，≠ 政策链 ${dsAsm.input}）`)

// 源码级护栏：宿主装配确实接上了该谓词。
// （lib/index.js 依赖 @deepseek-ai/dsh-settings 等宿主包，纯 node 下无法 import，
//   故用源码断言防「测试过了但宿主没接」这种最危险的假绿。）
const indexSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
assert(/if \(POLICY_PRICED_PROVIDER_IDS\.includes\(provider\)\) continue/.test(indexSrc),
  't11: lib/index.js 的装配循环确实用 POLICY_PRICED_PROVIDER_IDS 跳过（源码级护栏）')

/* ================================================================== */
/* 4. 名称归一化：大小写与分隔符不敏感                                 */
/* ================================================================== */

assert(canonicalModelId('DeepSeek-V4-Flash-0731') === 'deepseek-flash', 'canonicalModelId 大写连字符 → deepseek-flash')
assert(canonicalModelId('deepseek/deepseek-v4-flash-0731') === 'deepseek-flash', 'canonicalModelId vendor 前缀 → deepseek-flash')
assert(canonicalModelId('deepseek_v4_flash_0731') === 'deepseek-flash', 'canonicalModelId 下划线分隔 → deepseek-flash')
assert(modelTier('deepseek-v4.1-flash') === 'flash' && modelTier('deepseek-v4-pro-0813') === 'pro',
  'modelTier 识别 flash / pro 档')

// 6 种写法都必须归一到同一档位键，从而命中同一份 provider 价目（用 alt-prov 的显式价目验证）
const spellings = ['deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash-0731', 'DeepSeek-V4-Flash-0731', 'deepseek/deepseek-v4-flash-0731', 'deepseek-v4-flash-ga-260731']
const allSame = spellings.every((s) => close(priceAt('alt-prov', s, spec, NOW).input, ALT_FLASH_INPUT))
assert(allSame, `6 种写法都命中同一 provider 档位价（alt-prov/deepseek-v4-flash → ${ALT_FLASH_INPUT}）`)

/* ================================================================== */
/* 5. 来源如实标注；空表不登记来源、不建空桶                           */
/* ================================================================== */

const specSrc = plainSpec()
applyProviderPrices(specSrc, 'kimi-coding', loadProviderPrices('kimi-coding').models, 'builtin')
assert(['disk', 'asar', 'builtin'].includes(specSrc.providerSources['kimi-coding']),
  `providerSources 如实标注为三层之一：kimi-coding → ${specSrc.providerSources['kimi-coding']}`)

const specEmpty = plainSpec()
applyProviderPrices(specEmpty, 'ghost-provider', {}, 'builtin')
assert(specEmpty.providerSources.ghost === undefined && specEmpty.providerPrices.ghost === undefined,
  '空表不得登记来源、也不得建空桶（修掉旧实现的谎报）')

/* ================================================================== */
/* 6. 显式 provider 价目（override）与优先级                           */
/* ================================================================== */

const parsedRoute = parseProviderPricesConfig('{"mxy":{"deepseek-v4-flash-0731":{"input":1,"output":4,"cacheRead":0.02,"cacheWrite":1}}}')
assert(close(parsedRoute.mxy['deepseek-v4-flash-0731'].input, 1), 'parseProviderPricesConfig 解析嵌套 provider 价目')

const specOv = plainSpec()
applyProviderPrices(specOv, 'mxy', loadProviderPrices('opencode-go').models, 'builtin') // 先铺一层 catalog 价
applyProviderPriceOverrides(specOv, parsedRoute)
const mxyPrice = priceAt('mxy', 'deepseek-v4-flash-0731', specOv, NOW)
assert(close(mxyPrice.input, 1) && close(mxyPrice.output, 4) && specOv.providerSources.mxy === 'override',
  `显式价目覆盖 catalog 价并标 override：mxy/deepseek-v4-flash-0731=${mxyPrice.input}/${mxyPrice.output}（应 1/4，source=${specOv.providerSources.mxy}）`)

// 全局 prices 覆盖仍最高（钉死）
const specGlobal = plainSpec({ prices: JSON.stringify({ 'mimo-v2.5': { input: 99, output: 99, cacheRead: 9, cacheWrite: 9 } }) })
applyProviderPriceOverrides(specGlobal, parseProviderPricesConfig('{"opencode-go":{"mimo-v2.5":{"input":5,"output":5,"cacheRead":5,"cacheWrite":5}}}'))
const pinned = priceAt('opencode-go', 'mimo-v2.5', specGlobal, NOW)
assert(close(pinned.input, 99), `全局 prices 覆盖仍最高：${pinned.input}（应 99，而非显式 provider 价的 5）`)

// 只填部分字段 → 其余按全局价回填（不出现 NaN）
const specPartial = plainSpec()
applyProviderPriceOverrides(specPartial, parseProviderPricesConfig('{"mxy":{"mimo-v2.5":{"input":2}}}'))
const partial = priceAt('mxy', 'mimo-v2.5', specPartial, NOW)
assert(close(partial.input, 2) && Number.isFinite(partial.output) && Number.isFinite(partial.cacheRead) && Number.isFinite(partial.cacheWrite),
  `部分字段的显式价目：其余字段按全局价回填（input=${partial.input}, output=${partial.output}, cacheRead=${partial.cacheRead}, cacheWrite=${partial.cacheWrite}）`)

/* ================================================================== */
/* 7. 收费形式：订阅/免费/本地实付 0，名义价值保留                     */
/* ================================================================== */

const modes = parseProviderModes('{"sub-prov":"subscription","free*":"free","local*":"local"}')
const specMode = resolveBillingSpec({ fxEnabled: false, providerModes: '{"sub-prov":"subscription","free*":"free","local*":"local"}' })
assert(providerModeOf(specMode, 'sub-prov') === 'subscription' && providerModeOf(specMode, 'free-tier') === 'free' &&
  providerModeOf(specMode, 'local-llama') === 'local' && providerModeOf(specMode, 'anything-else') === 'usage',
  'providerModeOf：精确匹配 + glob + 默认 usage')

const COST = 12.5
const miniLedger = {
  steps: [
    { at: NOW, provider: 'sub-prov', model: 'glm-5.1', uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: COST, currency: '¥' },
    { at: NOW, provider: 'pay-prov', model: 'glm-5.1', uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 3, currency: '¥' },
  ],
}
const stats = computeStats(miniLedger, { now: NOW, tz: 'Asia/Shanghai', currency: '¥', providerModes: modes, localProviders: [], localCostPerM: 0 })
const byMode = stats.metering.byMode
assert(close(byMode.subscription.nominal['¥'], COST) && (byMode.subscription.actual['¥'] ?? 0) === 0,
  `订阅型 provider：名义价值保留 ${byMode.subscription.nominal['¥']}，实付 ${byMode.subscription.actual['¥'] ?? 0}（应为 0）`)
assert(close(byMode.subscription.saved['¥'], COST),
  `订阅型 provider 的节省 = 名义价值（${byMode.subscription.saved['¥']}）`)
assert(close(byMode.usage.actual['¥'], 3), `按量 provider 实付 = 实际成本（${byMode.usage.actual['¥']}）`)

/* ================================================================== */
/* 8. 配置解析严格性                                                   */
/* ================================================================== */

let threw = false
try { parseProviderPricesConfig('{bad') } catch { threw = true }
assert(threw, 'parseProviderPricesConfig 坏 JSON 抛错')

threw = false
try { parseProviderPricesConfig('{"mxy":{"m":{"input":-1}}}') } catch { threw = true }
assert(threw, 'parseProviderPricesConfig 负价抛错')

threw = false
try { parseProviderModes('{"p":"nonsense"}') } catch { threw = true }
assert(threw, 'parseProviderModes 非法模式抛错')

threw = false
try { resolveBillingSpec({ prices: '{bad' }) } catch { threw = true }
assert(threw, 'resolveBillingSpec 对坏 prices JSON 抛错')

/* ================================================================== */
/* 9. t12：catalog 键被规范化时保留**原始 id** 作 alias（供 view 行匹配）*/
/* ================================================================== */

const flatAlias = flattenPiAiCost({
  'openai-completions': {
    'deepseek-v4-flash': { cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
    'deepseek-v4-flash-vision-exp': { cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
    'deepseek-v4-pro': { cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 } },
  },
})
assert(close(flatAlias['deepseek-flash'].input, 0.14) && flatAlias['deepseek-flash'].alias === 'deepseek-v4-flash',
  `t12/t13: 规范化键保留**确定性选出**的原始 id 作 alias（键 deepseek-flash，alias=${flatAlias['deepseek-flash'].alias}；应 deepseek-v4-flash 而非 …-vision-exp）`)
assert(flatAlias['deepseek-v4-pro'] !== undefined && flatAlias['deepseek-v4-pro'].alias === undefined,
  't12: 原名即规范名时不产生 alias（deepseek-v4-pro）')

// ---- t13：alias 必须**确定性**选择（长度升序、同长字典序升序），与 catalog 键序无关 ----
// 真实风险：catalog 每次升级 pi-ai 都由 scripts/sync-coding-plans.mjs 重新生成，键序可能变化。
// 若依赖「迭代顺序上的第一个」，alias 会翻成同族变体 → view 价目行名改变 → 冻结测试以极难定位的原因失败。
const mkCatalog = (ids) => ({
  'openai-completions': Object.fromEntries(
    ids.map((id) => [id, { cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } }]),
  ),
})
const ALIAS_PAIR = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']
const fwdAlias = flattenPiAiCost(mkCatalog(ALIAS_PAIR))['deepseek-flash'].alias
const revAlias = flattenPiAiCost(mkCatalog([...ALIAS_PAIR].reverse()))['deepseek-flash'].alias
assert(fwdAlias === 'deepseek-v4-flash' && revAlias === fwdAlias,
  `t13: alias 与候选顺序无关（正序=${fwdAlias}，逆序=${revAlias}；应同为 deepseek-v4-flash）`)

// 同长度时按字典序升序：'-'(0x2D) < '_'(0x5F) → deepseek-v4-flash 胜
const tieAlias = flattenPiAiCost(mkCatalog(['deepseek_v4_flash', 'deepseek-v4-flash']))['deepseek-flash'].alias
assert(tieAlias === 'deepseek-v4-flash',
  `t13: 同长按字典序升序（${tieAlias}；应 deepseek-v4-flash）`)

// 单候选时行为与原先一致
const singleAlias = flattenPiAiCost(mkCatalog(['deepseek-v4-flash']))['deepseek-flash'].alias
assert(singleAlias === 'deepseek-v4-flash', `t13: 单候选行为不变（${singleAlias}）`)

// 规范名本身**不入候选**：即使 catalog 里真出现 'deepseek-flash'，alias 也不得退化为规范名
const withCanonical = flattenPiAiCost(mkCatalog(['deepseek-flash', 'deepseek-v4-flash-vision-exp']))
assert(withCanonical['deepseek-flash'].alias === 'deepseek-v4-flash-vision-exp',
  `t13: 规范名不入候选（alias=${withCanonical['deepseek-flash'].alias}；应 deepseek-v4-flash-vision-exp）`)
assert(flatAlias['deepseek-flash'].alias !== 'deepseek-flash' && flatAlias['deepseek-flash'].alias !== 'deepseek-v4-flash-vision-exp',
  `t13: 真实 catalog 下别名不退化为 deepseek-flash / …-vision-exp（实际 ${flatAlias['deepseek-flash'].alias}）`)

// view 行的 model 用 alias —— UI 传来的历史模型名（deepseek-v4-flash 等）才能匹配上
const specView = plainSpec()
applyProviderPrices(specView, 'opencode-go', flatAlias, 'asar')
const partsView = createTokenBillingProjectionParts(specView)
const viewRows = (partsView.view(partsView.init()).providerPrices ?? []).filter((r) => r.provider === 'opencode-go')
assert(viewRows.some((r) => r.model === 'deepseek-v4-flash'),
  `t12: view 行以 alias 作 model（实际：${viewRows.map((r) => r.model).join(', ')}）`)
assert(viewRows.length > 0 &&
  Object.keys(viewRows[0]).sort().join(',') === 'cacheRead,cacheWrite,currency,input,model,output,provider',
  `t12: view 行仍严格是 schema 的 7 个键、未新增字段（实际：${viewRows.length > 0 ? Object.keys(viewRows[0]).sort().join(',') : '(无行)'}）`)

// alias 只影响**展示**：内部计价仍走规范化键
assert(close(priceAt('opencode-go', 'deepseek-v4-flash', specView, NOW).input, 0.14),
  `t12: priceAt 仍通过规范化键命中（${priceAt('opencode-go', 'deepseek-v4-flash', specView, NOW).input}；alias 不改变计价）`)

/* ================================================================== */
/* 10. t14：跳过集是**精确相等**匹配 —— 前缀相近的 provider 不得被扫入   */
/* ================================================================== */
//
// 背景：lib/index.js 用 `POLICY_PRICED_PROVIDER_IDS.includes(provider)` —— **精确相等**语义，
// 常量当前为 ["deepseek"]。
//
// 为什么必须钉死：一次**看起来合理**的编辑就能造成静默错价——
//  (1) 有人看到本机真实路由 `deepseek-official` / `deepseek-modlens` 同样服务于 DeepSeek，
//      顺手把它们**加进跳过集**（"更一致"）→ 这两个路由不再装配 catalog 价；
//  (2) 或有人把精确匹配改成**前缀/正则**匹配（如 `startsWith('deepseek')`）→ 后果相同。
// 两者都会让这些路由的价目**静默回落**（不再取该 provider 的 catalog 价，而是走全局表 /
// 官方价格政策链；本机政策链为 ¥1/4/0.02/1，旧默认 fallback 曾为 2/8/0.5/2）
// → **静默错价**，且此前的断言抓不到（既有「非政策链 provider 照常装配」用的是合成名
// `asarprov`，即使匹配被放宽为前缀，`asarprov` 依然不会被跳过）。
//
// 因此这里同时钉两层：常量内容（精确相等）+ 装配行为（前缀相近名照常装配）。
assert(POLICY_PRICED_PROVIDER_IDS.includes('deepseek'),
  `t14: 跳过集含**精确名** deepseek（${JSON.stringify(POLICY_PRICED_PROVIDER_IDS)}）`)

const FORBIDDEN_IN_SKIP = ['deepseek-official', 'deepseek-modlens', 'deepseek-x', 'deepseek2']
const wronglyIncluded = FORBIDDEN_IN_SKIP.filter((n) => POLICY_PRICED_PROVIDER_IDS.includes(n))
assert(wronglyIncluded.length === 0,
  `t14: 跳过集为**精确相等**匹配，不得含前缀相近名（误入：${wronglyIncluded.join(', ') || '无'}）——` +
  '放宽为前缀/正则，或把这些真实路由加进跳过集，都会使其 catalog 价静默回落造成错价')

// 行为级（更强）：装配这些前缀相近 provider 时，其 catalog 价**照常装配**（桶非空、来源如实）
const specPrefix = plainSpec()
for (const provider of ['deepseek', 'deepseek-official', 'deepseek-x']) {
  if (POLICY_PRICED_PROVIDER_IDS.includes(provider)) continue
  const { source, models } = loadProviderPrices(provider)
  if (source !== 'none') applyProviderPrices(specPrefix, provider, models, source)
}
assert(specPrefix.providerPrices.deepseek === undefined && specPrefix.providerSources.deepseek === undefined,
  't14: 精确名 deepseek 被跳过（不建桶、不登记来源）')
assert(Object.keys(specPrefix.providerPrices['deepseek-official'] ?? {}).length > 0 &&
  Object.keys(specPrefix.providerPrices['deepseek-x'] ?? {}).length > 0,
  't14: 前缀相近名的 catalog 价**照常装配**（桶非空）')
assert(specPrefix.providerSources['deepseek-official'] === 'asar' && specPrefix.providerSources['deepseek-x'] === 'asar',
  `t14: 两者来源如实标为 asar（${specPrefix.providerSources['deepseek-official']} / ${specPrefix.providerSources['deepseek-x']}），证明确实走了 catalog 装配`)
assert(close(priceAt('deepseek-official', 'deepseek-v4-flash', specPrefix, NOW).input, 0.9) &&
  close(priceAt('deepseek-x', 'deepseek-v4-flash', specPrefix, NOW).input, 0.8),
  `t14: 取到各自 catalog 价（deepseek-official=${priceAt('deepseek-official', 'deepseek-v4-flash', specPrefix, NOW).input}，` +
  `deepseek-x=${priceAt('deepseek-x', 'deepseek-v4-flash', specPrefix, NOW).input}；应 0.9 / 0.8，而非政策链 ¥1 或 fallback）`)

/* ================================================================== */
/* 清理                                                                */
/* ================================================================== */

try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
delete process.env.DSH_PI_AI_PATH
delete process.env.DSH_APP_ASAR

console.log(`\n按路由计价验证完成：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail > 0 ? 1 : 0
