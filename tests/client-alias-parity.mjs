/**
 * t12 门禁：**客户端镜像 ≡ 宿主真源**（别名/档位归一化）
 *
 * 背景：lib/client.js 是手写 lazy-CJS bundle，只能 require('react')，拿不到宿主 helper，
 * 因此档位归一化必须在 bundle 内自足实现（方案 A）—— 即 lib/prices.js 的**镜像**。
 * 镜像天然有漂移风险，所以本测试：
 *   1. 从 lib/client.js 源码中**按名字提取** mirror 函数（括号配对，不靠 import）；
 *   2. 用 `new Function` 实例化它们；
 *   3. 对**已知别名全集**逐项断言「bundle 内实现 ≡ 服务端 canonicalModelId / modelTier」
 *      以及 stripFootnoteMarks 行为一致；
 *   4. 行为断言：抽取出的 findPrice 能在 **canonical ↔ 别名** 两个方向互相命中，
 *      且对不存在的模型仍返回 null（无假阳性）。
 *
 * 注：既有的 scripts/check-schema-parity.mjs 只校验 view schema 文本、**不含别名映射**，
 * 所以这层门禁必须独立存在（不能指望现有门禁自证）。
 *
 * 运行：node tests/client-alias-parity.mjs
 */
import { readFileSync } from 'node:fs'
import { canonicalModelId, modelTier } from '../lib/projection.js'
import { stripFootnoteMarks } from '../lib/prices.js'

let pass = 0
let fail = 0
const check = (ok, msg) => {
  console.log((ok ? '✅ ' : '❌ ') + msg)
  ok ? pass++ : fail++
}

const CLIENT_PATH = new URL('../lib/client.js', import.meta.url)
const src = readFileSync(CLIENT_PATH, 'utf8')

/** 从源码中按名字提取 `function name(...) {...}`（括号配对）。 */
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) return null
  const open = source.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

const MIRROR_NAMES = [
  'stripFootnoteMarksMirror',
  'modelBaseKeyMirror',
  'tierFormMirror',
  'modelTierMirror',
  'canonicalModelIdMirror',
]
const RUNTIME_NAMES = [...MIRROR_NAMES, 'normalizeModel', 'findPrice', 'priceLineParts']

const missing = RUNTIME_NAMES.filter((n) => extractFunction(src, n) === null)
check(missing.length === 0,
  `lib/client.js 中可提取到镜像函数（缺：${missing.length === 0 ? '无' : missing.join(', ')}）`)

let client = null
try {
  const code = RUNTIME_NAMES.map((n) => extractFunction(src, n)).join('\n')
  client = new Function(code + '\nreturn { stripFootnoteMarksMirror, canonicalModelIdMirror, modelTierMirror, normalizeModel, findPrice, priceLineParts }')()
} catch (err) {
  check(false, `镜像函数实例化失败：${err.message}`)
}
if (client === null) {
  console.log(`\n客户端别名镜像一致性：${pass} 通过 / ${fail + 1} 失败`)
  process.exit(1)
}

/* ------------------------------------------------------------------ */
/* 1. 已知别名全集：bundle 镜像 ≡ 服务端真源                            */
/* ------------------------------------------------------------------ */

const ALIASES = [
  // 官方现名 / 档位名
  'deepseek-flash', 'deepseek-v4-pro',
  // 历史与变体写法（真实账本与 DOM 里都出现过）
  'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash-0731',
  'deepseek-v4-flash-ga-260731', 'deepseek-v4-flash-vision-exp',
  'DeepSeek-V4-Flash-0731', 'deepseek/deepseek-v4-flash-0731', 'deepseek_v4_flash_0731',
  'deepseek-v4-pro-0813', 'DeepSeek-V4-Pro', 'DEEPSEEK-V4-PRO',
  // 非 flash/pro 档（应保持各自的 base key）
  'deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.2',
  // 带脚注污染（官方页表头）
  'deepseek-flash(1)', 'deepseek-v4-pro（2）', 'deepseek-flash[1]', 'deepseek-flash¹',
  // 非 DeepSeek 模型（镜像不得误伤）
  'mimo-v2.5', 'glm-5.1', 'kimi-k2.6', 'qwen3.7-max', 'MiniMax-M3', 'gpt-5.6-sol', 'grok-4.6',
]

/** 按给定顺序对别名列表做等价性比对，返回不一致清单。 */
function compareOrder(order) {
  const out = []
  for (const alias of order) {
    const server = canonicalModelId(alias)
    const mirror = client.canonicalModelIdMirror(alias)
    if (server !== mirror) out.push(`${alias}: server=${server} mirror=${mirror}`)
    const serverTier = modelTier(alias)
    const mirrorTier = client.modelTierMirror(alias)
    if (serverTier !== mirrorTier) out.push(`${alias}(tier): server=${serverTier} mirror=${mirrorTier}`)
    const serverStrip = stripFootnoteMarks(alias)
    const mirrorStrip = client.stripFootnoteMarksMirror(alias)
    if (serverStrip !== mirrorStrip) out.push(`${alias}(strip): server=${serverStrip} mirror=${mirrorStrip}`)
  }
  return out
}

const mismatches = compareOrder(ALIASES)
check(mismatches.length === 0,
  `bundle 镜像 ≡ 服务端 canonicalModelId / modelTier / stripFootnoteMarks（${ALIASES.length} 个别名）` +
  (mismatches.length === 0 ? '' : `\n    ${mismatches.join('\n    ')}`))

// t13：等价性断言必须对**顺序不敏感** —— 逆序再算一遍，结果应完全一致
const reversedMismatches = compareOrder([...ALIASES].reverse())
check(reversedMismatches.length === mismatches.length && reversedMismatches.length === 0,
  `t13: 等价性断言对顺序不敏感（正序不一致 ${mismatches.length} 处 / 逆序 ${reversedMismatches.length} 处；应均为 0）`)

// 镜像必须真正覆盖到「规范化确实发生」的样例，否则等价断言可能空转
const renamed = ALIASES.filter((a) => canonicalModelId(a) !== a.toLowerCase().trim())
check(renamed.length > 0 && renamed.some((a) => canonicalModelId(a) === 'deepseek-flash'),
  `样例集中包含真实改名用例（${renamed.length} 个，例如 deepseek-v4-flash → deepseek-flash）`)

/* ------------------------------------------------------------------ */
/* 2. 行为断言：live findPrice 双向命中 canonical ↔ 别名                */
/* ------------------------------------------------------------------ */

const rowCanonical = [{ provider: 'opencode-go', model: 'deepseek-flash', input: 1, output: 4 }]
const rowAlias = [{ provider: 'opencode-go', model: 'deepseek-v4-flash', input: 1, output: 4 }]

check(client.findPrice('deepseek-v4-flash', rowCanonical) !== null,
  'live findPrice：标签=别名(deepseek-v4-flash) × 行=规范名(deepseek-flash) → 命中')
check(client.findPrice('deepseek-flash', rowAlias) !== null,
  'live findPrice：标签=规范名(deepseek-flash) × 行=别名(deepseek-v4-flash) → 命中')
check(client.findPrice('DeepSeek-V4-Flash-0731', rowCanonical) !== null,
  'live findPrice：标签=历史写法(DeepSeek-V4-Flash-0731) × 行=规范名 → 命中')
check(client.findPrice('deepseek/deepseek-v4-flash-0731', rowAlias) !== null,
  'live findPrice：标签=vendor 前缀写法 × 行=别名 → 命中')
check(client.findPrice('不存在-模型-xyz', rowCanonical) === null,
  'live findPrice：不存在的模型仍返回 null（无假阳性）')

/* ------------------------------------------------------------------ */
/* 3. 接线断言：findPrice 确实使用了档位分支（防「实现了没接上」）        */
/* ------------------------------------------------------------------ */

check(/canonicalModelIdMirror\(prices\[i\]\.model\)/.test(src),
  'lib/client.js 的 findPrice 确实按**双方档位归一化**比较（接线断言）')

/* ------------------------------------------------------------------ */
/* 4. v0.8.1 行为断言：费用行「当前模型 + 单价」段显示什么              */
/*    修的是「走全局表（官方定价页）时显示官方档位名」的误导标签：        */
/*    deepseek-v4.1-flash 曾被显示成 deepseek-flash。                   */
/* ------------------------------------------------------------------ */

const rowOfficial = { model: 'deepseek-flash', input: 1, output: 4, currency: '¥' }

const p1 = client.priceLineParts('deepseek-v4.1-flash', rowOfficial)
check(p1.model === 'deepseek-v4.1-flash' && p1.note.includes('deepseek-flash'),
  `priceLineParts：用户模型(deepseek-v4.1-flash) + 官方档位行走全局表 → 显示用户模型名并附注档位（得到 "${p1.model}" / "${p1.note}"）`)

const p2 = client.priceLineParts('mimo-v2.5', { model: 'mimo-v2.5', output: 0.28, currency: '$' })
check(p2.model === 'mimo-v2.5' && p2.note === '',
  `priceLineParts：名称一致时不附注（得到 "${p2.model}" / "${p2.note}"）`)

const p3 = client.priceLineParts('DeepSeek-V4-Flash', { model: 'deepseek-v4-flash', output: 4, currency: '¥' })
check(p3.model === 'DeepSeek-V4-Flash' && p3.note === '',
  `priceLineParts：仅大小写/分隔符不同（归一化后同名）不附注（得到 "${p3.model}" / "${p3.note}"）`)

const p4 = client.priceLineParts('', rowOfficial)
check(p4.model === 'deepseek-flash' && p4.note === '',
  `priceLineParts：读不到选中模型时回落价目行名且不附注（得到 "${p4.model}" / "${p4.note}"）`)

const p5 = client.priceLineParts('deepseek-v4.1-flash', null)
check(p5.model === '' && p5.note === '',
  `priceLineParts：无命中价目时返回空（得到 "${p5.model}" / "${p5.note}"）`)

check(/priceLineParts\(selectedModel, current\)/.test(src),
  'lib/client.js 的费用行确实调用了 priceLineParts（接线断言，防「实现了没接上」）')
check(!/current\.model \+ ' ' \+ formatCost/.test(src),
  'lib/client.js 不再直接渲染 current.model 作为模型名（回归断言）')

console.log(`\n客户端别名镜像一致性：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail > 0 ? 1 : 0
