/**
 * sync-coding-plans — 从本机 DeepSeek Harness 内置/打包的 `@earendil-works/pi-ai`
 * catalog 重新生成 `lib/coding-plans.js`（随包分发的 provider 官方美元价表，$ / 1M tokens）。
 *
 * 数据源探测（实现见 lib/prices.js 的三层取数，本脚本复用其 asar 读取，不重复实现）：
 *   1. 磁盘：<DSH_HOME>/profiles/node_modules/@earendil-works/pi-ai/dist/providers/data
 *      （本机真的装了 pi-ai 时的常规位置）
 *   2. asar：DSH 打包发行版把 pi-ai 封在 Electron 归档内
 *      <install>/resources/app.asar!/node_modules/@earendil-works/pi-ai/dist/providers/data
 *
 * 覆盖方式：DSH_PI_AI_PATH 指定磁盘目录；DSH_APP_ASAR / DSH_ASAR_PATH 指定 asar 位置。
 *
 * 用法：node scripts/sync-coding-plans.mjs
 *   - catalog 完全不可得（disk 与 asar 都没有）时：打印清晰提示并**以非 0 退出**，
 *     绝不静默写出空表。
 *   - 生成后请跑 `node tests/route-pricing-test.mjs` 验证，并提交 lib/coding-plans.js。
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPiAiCatalog, piAiDataDir } from '../lib/prices.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

/**
 * 内置价表覆盖的 provider 集合（与上游 bpc-oss/dsh-web-billing 的 coding-plan 集合对齐，
 * ⚠️ **故意不含 first-party `deepseek`**（t7 评审 F1 / 队长裁决：发布前必须处理）。
 * pi-ai catalog 的 `deepseek.json` 是 **pre-2026-08-17 的静态快照**（USD）：它既不知道
 * 08-17 的峰谷起点、也不知道 09-10 12:00 的 flash 调价，还会把 cacheWrite 记成 0。
 * 一旦它作为 provider 价目表被种进 `spec.providerPrices['deepseek']`，就会按 priceAt 的
 * 「provider 表优先」语义**盖住** t1 的时间感知官方价格政策链
 * （`PRICE_POLICY_TIMELINE` + `BUILTIN_PRICES` / `BUILTIN_PEAK_PRICES`）：
 * 输出低约一半、cacheWrite 记 0、完全不参与峰谷、并绕开历史回看保护。
 * 因此本生成器**排除该 provider** —— DeepSeek 官方模型一律由政策链权威定价。
 * 逃生口保留：用户经设置卡「按路由」编辑器 / `providerPriceUrls` 显式写入的 provider 价
 * 仍优先于政策链（那是用户明确意图，不是快照越权）。
 */
const PROVIDERS = [
  { id: 'opencode-go', label: 'OpenCode GO', kind: 'coding' },
  { id: 'opencode', label: 'OpenCode Zen', kind: 'coding' },
  { id: 'kimi-coding', label: 'Kimi Coding', kind: 'coding' },
  { id: 'qwen-token-plan', label: 'Qwen Token Plan', kind: 'subscription' },
  { id: 'qwen-token-plan-cn', label: 'Qwen Token Plan (CN)', kind: 'subscription' },
  { id: 'xiaomi-token-plan-ams', label: 'Xiaomi MiMo Token Plan (AMS)', kind: 'subscription' },
  { id: 'xiaomi-token-plan-cn', label: 'Xiaomi MiMo Token Plan (CN)', kind: 'subscription' },
  { id: 'xiaomi-token-plan-sgp', label: 'Xiaomi MiMo Token Plan (SGP)', kind: 'subscription' },
  { id: 'zai-coding-cn', label: 'Z.ai Coding (CN)', kind: 'subscription' },
]

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** catalog 文件 → { modelId: { input, output, cacheRead, cacheWrite, currency } }（同一 id 出现在多个 api 段时以最后一条为准）。 */
function modelsOf(raw) {
  const out = {}
  for (const modelsByApi of Object.values(raw ?? {})) {
    if (modelsByApi === null || typeof modelsByApi !== 'object') continue
    for (const [id, entry] of Object.entries(modelsByApi)) {
      const cost = entry?.cost
      if (cost === null || typeof cost !== 'object') continue
      const input = num(cost.input)
      const output = num(cost.output)
      const cacheRead = num(cost.cacheRead)
      const cacheWrite = num(cost.cacheWrite)
      if (input === null || output === null || cacheRead === null || cacheWrite === null) continue
      out[id] = { input, output, cacheRead, cacheWrite, currency: 'USD' }
    }
  }
  return out
}

const catalog = openPiAiCatalog()
if (catalog.source === 'none') {
  console.error('[sync-coding-plans] 未找到 pi-ai catalog 数据源。')
  console.error('  已探测的磁盘目录： ' + piAiDataDir())
  console.error('  已探测的 asar 位置： DSH_APP_ASAR / DSH_ASAR_PATH、process.resourcesPath、process.execPath 同级 resources/')
  console.error('  请安装 DeepSeek Harness（其归档内自带 catalog），或用 DSH_PI_AI_PATH / DSH_APP_ASAR 显式指定。')
  console.error('  **拒绝写出空价表**：catalog 不可得时不做任何修改。')
  process.exit(1)
}

const built = {}
const missing = []
for (const meta of PROVIDERS) {
  const raw = catalog.read(meta.id)
  const parsed = raw === null ? null : JSON.parse(raw)
  const models = parsed === null ? {} : modelsOf(parsed)
  if (Object.keys(models).length === 0) {
    missing.push(meta.id)
    continue
  }
  const sorted = {}
  for (const id of Object.keys(models).sort()) sorted[id] = models[id]
  built[meta.id] = { label: meta.label, kind: meta.kind, models: sorted }
}

if (Object.keys(built).length === 0) {
  console.error('[sync-coding-plans] catalog 可用，但目标 provider 一个都没取到数据——拒绝写出空表。')
  process.exit(1)
}

const manifest = catalog.manifest ?? {}
const version = catalog.packageJson?.version ?? 'unknown'
const sourceLabel = catalog.source === 'disk'
  ? `disk — ${piAiDataDir()}`
  : 'asar — resources/app.asar!/node_modules/@earendil-works/pi-ai/dist/providers/data'

const header = `/**
 * CODING_PLAN_PRICING — 随包分发的 provider 官方美元价表（$ / 1M tokens）。
 *
 * ⚠️ **生成物，勿手改**。由 \`node scripts/sync-coding-plans.mjs\` 从本机 DeepSeek Harness
 * 内置/打包的 \`@earendil-works/pi-ai\` catalog 生成；DSH 升级后重跑该脚本即可同步。
 *
 * 数据源：${sourceLabel}
 * pi-ai 版本：${version}
 * catalog generatedAt：${manifest.generatedAt ?? 'unknown'}
 * catalog schemaVersion：${manifest.schemaVersion ?? 'unknown'}
 * catalog structureHash：${manifest.structureHash ?? 'unknown'}
 * 生成时间：${new Date().toISOString()}
 *
 * 覆盖范围：${Object.keys(built).length} 个 provider（coding plan 平台量价 + 订阅 token 包）。
 * **不含 first-party \`deepseek\`** —— 见下方裁决说明。
 *
 * 语义：
 * - kind "coding"       平台公开的官方量价（$ / 1M tokens）。
 * - kind "subscription" 订阅制 token 包。**本表仍如实保留 catalog 里的挂牌价，不在此处抹 0** ——
 *   订阅用户的「实际花费归零」由 providerModes 配置（{"<provider>":"subscription"}）在结算层完成；
 *   抹 0 会让名义价值 / 回本无法计算。（zai-coding-cn 在本机 catalog 里带真实挂牌价，即按此处理。）
 * - 人民币展示价 = usd × 配置 fxRate（fxEnabled 时由折算层完成，见 lib/projection.js convertEntry）。
 * - 用户 \`prices\` 覆盖与 provider 级单价仍优先于此表（见 lib/projection.js priceAt 的优先级）。
 *
 * ⚠️ **裁决：不收录 first-party \`deepseek\` 快照**（t7 评审 F1 / 队长裁决：发布前必须处理）
 * - DeepSeek 官方模型由**时间感知的官方价格政策链权威定价**：
 *   \`lib/projection.js\` 的 \`PRICE_POLICY_TIMELINE\` + \`BUILTIN_PRICES\` / \`BUILTIN_PEAK_PRICES\`
 *   （2026-08-17 峰谷起点 / 2026-08-23 周末空闲 / 2026-09-10 12:00 flash 调价）。
 * - pi-ai catalog 的 \`deepseek.json\` 是 **pre-2026-08-17 的静态快照（USD）**：时间无关、
 *   不知道任何一次调价、cacheWrite 记为 0，且完全不参与峰谷 —— 它**没有资格**按 priceAt 的
 *   「provider 表优先」语义盖住政策链。故生成器**排除该 provider**。
 * - 逃生口保留：用户经设置卡「按路由」编辑器 / \`providerPriceUrls\` 显式写入的 provider 价
 *   仍优先于政策链（用户明确意图 ≠ 快照越权）。
 */
export const CODING_PLAN_SOURCE = Object.freeze(${JSON.stringify({
  package: '@earendil-works/pi-ai',
  version,
  catalogSource: catalog.source,
  generatedAt: manifest.generatedAt ?? null,
  structureHash: manifest.structureHash ?? null,
  syncedAt: new Date().toISOString(),
}, null, 2)})

export const CODING_PLAN_PRICING = ${JSON.stringify(built, null, 2)}

/**
 * 由**官方价格政策链**权威定价、其 catalog 静态快照**不得**覆盖政策链的 provider 名单。
 * 宿主装配（lib/index.js 的 attachProviderPrices）按此**以 provider id 为键**跳过 catalog 取数：
 * 只有恰好叫这些名字的路由会命中对应 catalog 文件，因此不会误伤其它 provider 的 catalog 价；
 * 跳过时**不建桶、不登记 providerSources**，让 /token-billing/providers 如实显示 none。
 * 用户显式配置（providerPrices / providerPriceUrls）不受影响 —— 逃生口保留。
 * @see 文件头「裁决：不收录 first-party deepseek 快照」
 */
export const POLICY_PRICED_PROVIDER_IDS = Object.freeze(['deepseek'])
`

const target = join(repoRoot, 'lib', 'coding-plans.js')
writeFileSync(target, header, 'utf8')
console.log(`已生成 ${target}`)
console.log(`catalog 来源：${catalog.source}（pi-ai ${version}）`)
console.log(`provider 数：${Object.keys(built).length}`)
for (const [id, provider] of Object.entries(built)) {
  console.log(`  ${id} (${provider.kind})：${Object.keys(provider.models).length} 个模型`)
}
if (missing.length > 0) {
  console.warn(`警告：以下 provider 在 catalog 中无数据，已跳过：${missing.join(', ')}`)
}
