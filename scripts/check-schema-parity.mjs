#!/usr/bin/env node
/**
 * schema 同构门禁 —— 一条命令程序化对比「测试镜像 schema」与「运行时 wire schema」。
 *
 *   node scripts/check-schema-parity.mjs        （等价：npm run check:parity）
 *
 * 为什么需要它：本仓库有两份同一份 wire schema 的副本 ——
 *   - 运行时（权威）：lib/index.js 的 `viewSchema`，经 sessionProjections 注册，真正用于拒发非法视图；
 *   - 镜像（测试）：tests/schema-check.mjs 的 `viewSchema`，断言投影输出符合该契约。
 * 二者必须同构。2026-09 的真实事故正是镜像比 runtime **宽**：镜像对 windows 的 tuple 多写了
 * `.rest(z.any())`，于是「投影多输出一个窗口元素」时测试全绿、真实 host 却会拒发整个视图 —— 假绿。
 * 当时靠人工归一化审计才定位（唯一分叉、字符数差 14），不可持续，故固化为本门禁。
 *
 * 判定口径（不因「凑绿」而放宽）：
 *   1) 两份声明在「抹注释 + 归一空白 + 别名归一（zod. → z.）」后必须**逐字相同** —— 最严口径，
 *      连本脚本未建模的新写法也一样会被判为分叉；
 *   2) 另做结构化解析，把差异定位到字段路径（如 billing.windows[]）；
 *   3) 共用常量 costsRecord 的定义一并比对。
 * 退出码：0 = 一致；1 = 检出分叉；2 = 无法取信（找不到/重复声明、解析异常等），绝不静默放行。
 *
 * 零依赖：只用 node: 内置模块，任意 cwd 均可运行（路径从脚本自身位置推导）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MIRROR = { label: '镜像（测试）', file: join(ROOT, 'tests', 'schema-check.mjs') }
const RUNTIME = { label: '运行时（权威）', file: join(ROOT, 'lib', 'index.js') }

/** 「无法取信」类错误：一律以非 0 退出，绝不降级为「通过」。 */
class Untrusted extends Error {}

/* ------------------------------------------------------------------ *
 * 取源码：把注释原地抹成空格（长度与行号不变），使花括号配对不受注释/字符串干扰
 * ------------------------------------------------------------------ */
function blankOutComments(source) {
  const out = source.split('')
  let i = 0
  let quote = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote !== null) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') out[i] = ' '
        i += 1
      }
      if (i < source.length) {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
      }
      continue
    }
    i += 1
  }
  return out.join('')
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length

function matchBalanced(text, openIndex, open, close) {
  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === open) depth += 1
    else if (text[i] === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Untrusted(`括号不配对：位置 ${openIndex} 的 ${open} 未闭合`)
}

const skipSpaces = (text, index) => {
  let i = index
  while (i < text.length && /\s/.test(text[i])) i += 1
  return i
}

/**
 * 从别名处消费整条链式表达式：`z.object({…}).strict()` / `z…().nullable()` …
 * 必须把 `z.object(` 的闭括号与其后的链式调用一起吃掉 —— 只截到对象字面量的 `}` 会漏掉
 * 尾部修饰符（.strict()/.nullable() 等），从而把两份「被同等截断」的文本误判为一致。
 */
function consumeChainExpression(source, start) {
  let i = start
  for (;;) {
    const m = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))
    if (!m) throw new Untrusted(`表达式解析失败：位置 ${i} 处期望标识符`)
    i += m[0].length
    const afterName = skipSpaces(source, i)
    if (source[afterName] === '(') i = matchBalanced(source, afterName, '(', ')') + 1
    const afterCall = skipSpaces(source, i)
    if (source[afterCall] === '.') {
      i = afterCall + 1
      continue
    }
    return i
  }
}

/**
 * 抽出 `viewSchema = <alias>.object({ … })` 及其后续链式调用。
 * 只认「viewSchema 声明」这**一个锚点**，绝不扫描同文件里的自检用例
 * （tests/schema-check.mjs 的 `z.array(z.tuple(...))`、`safeParse` 等与本 schema 无关）。
 */
function extractSchemaExpression(rawSource, { label, file }) {
  const source = blankOutComments(rawSource)
  const declRe = /(?:const\s+)?viewSchema\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*object\s*\(/dg
  const hits = [...source.matchAll(declRe)]
  if (hits.length === 0) throw new Untrusted(`${label} ${relative(ROOT, file)} 中找不到 \`viewSchema = <alias>.object({…})\` 声明`)
  if (hits.length > 1) throw new Untrusted(`${label} ${relative(ROOT, file)} 中出现 ${hits.length} 处 viewSchema 声明（应恰好 1 处）`)

  const hit = hits[0]
  const aliasStart = hit.indices[1][0]
  const end = consumeChainExpression(source, aliasStart)
  const text = source.slice(hit.index, end)
  const expression = source.slice(aliasStart, end)
  if (text.includes('safeParse')) throw new Untrusted(`${label} 抽出的片段含 safeParse，疑为误取自检代码，拒绝据此判定`)
  return { alias: hit[1], text, expression, declLine: lineOf(source, hit.index), endLine: lineOf(source, end) }
}

function extractConstExpression(rawSource, name, { label, file }) {
  const source = blankOutComments(rawSource)
  const re = new RegExp(`^\\s*const\\s+${name}\\s*=\\s*(.+?)\\s*$`, 'm')
  const m = re.exec(source)
  if (!m) throw new Untrusted(`${label} ${relative(ROOT, file)} 中找不到 \`const ${name} = …\` 定义`)
  return { expression: m[1], declLine: lineOf(source, m.index) }
}

/* ------------------------------------------------------------------ *
 * 归一化与文本比对（判定口径）
 * ------------------------------------------------------------------ */
const canonical = (text) =>
  text
    .replace(/\s+/g, '')
    .replace(/\bzod\./g, 'z.')
    .replace(/\bz\./g, 'z.')
    .replace(/;+$/, '')

const compact = (text) => canonical(text).replace(/\s+/g, '')

function firstDifference(a, b) {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[i] === b[i]) i += 1
  return i
}

function around(text, index, span = 70) {
  const from = Math.max(0, index - span)
  return `${from > 0 ? '…' : ''}${text.slice(from, index + span)}${index + span < text.length ? '…' : ''}`
}

/* ------------------------------------------------------------------ *
 * 结构化解析（把差异定位到字段路径；判定仍以归一化文本为准）
 * ------------------------------------------------------------------ */
function tokenize(text) {
  const re = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^\sA-Za-z_$\d]/g
  return [...text.matchAll(re)].map((m) => m[0])
}

function parseSchema(tokens, pos) {
  const expect = (tok) => {
    if (tokens[pos.i] !== tok) throw new Untrusted(`结构化解析失败：位置 ${pos.i} 期望 ${tok} 实际 ${String(tokens[pos.i])}`)
    pos.i += 1
  }
  if (tokens[pos.i] !== 'z' || tokens[pos.i + 1] !== '.') {
    // 裸引用（如 `costs: costsRecord`）——不展开，仅按名字比对
    const name = tokens[pos.i]
    if (typeof name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(name)) {
      throw new Untrusted(`结构化解析失败：位置 ${pos.i} 期望 z.<type>() 或标识符引用，实际 ${String(name)}`)
    }
    pos.i += 1
    return { kind: 'ref', name, fields: null, args: [], mods: [] }
  }
  pos.i += 2
  const kind = tokens[pos.i]
  pos.i += 1
  expect('(')
  const node = { kind, fields: null, args: [], mods: [] }

  if (kind === 'object') {
    expect('{')
    node.fields = []
    while (tokens[pos.i] !== '}') {
      const key = tokens[pos.i]
      pos.i += 1
      expect(':')
      node.fields.push([key, parseSchema(tokens, pos)])
      if (tokens[pos.i] === ',') pos.i += 1
    }
    expect('}')
  } else if (kind === 'array') {
    node.args.push(parseSchema(tokens, pos))
  } else if (kind === 'tuple') {
    expect('[')
    while (tokens[pos.i] !== ']') {
      node.args.push(parseSchema(tokens, pos))
      if (tokens[pos.i] === ',') pos.i += 1
    }
    expect(']')
  } else if (kind === 'record') {
    node.args.push(parseSchema(tokens, pos))
    if (tokens[pos.i] === ',') pos.i += 1
    node.args.push(parseSchema(tokens, pos))
  }
  expect(')')

  while (tokens[pos.i] === '.') {
    pos.i += 1
    const name = tokens[pos.i]
    pos.i += 1
    const entry = { name, value: null }
    if (tokens[pos.i] === '(') {
      pos.i += 1
      if (tokens[pos.i] === ')') {
        pos.i += 1 // 无参修饰符：.strict() / .nonnegative() / .int() …
        entry.value = null
      } else if (name === 'rest') {
        entry.value = parseSchema(tokens, pos)
        expect(')')
      } else {
        // 带字面量参数的修饰符（如 .default(true)）：按 token 原样收集，不做 schema 解析
        const start = pos.i
        let depth = 1
        while (depth > 0) {
          if (tokens[pos.i] === '(') depth += 1
          else if (tokens[pos.i] === ')') depth -= 1
          if (depth === 0) break
          pos.i += 1
        }
        entry.value = tokens.slice(start, pos.i).join('')
        expect(')')
      }
    }
    node.mods.push(entry)
  }
  return node
}

const modSignature = (node) =>
  node.mods.map((m) => (m.value === null ? m.name : `${m.name}(${typeof m.value === 'string' ? m.value : shapeOf(m.value)})`)).join('.')

function shapeOf(node) {
  if (node.kind === 'ref') return node.name
  const head =
    node.kind === 'object'
      ? `{${node.fields.map(([k, v]) => `${k}:${shapeOf(v)}`).join(',')}}`
      : node.kind === 'array'
        ? `[${shapeOf(node.args[0])}]`
        : node.kind === 'tuple'
          ? `(${node.args.map(shapeOf).join(',')})`
          : node.kind === 'record'
            ? `{${shapeOf(node.args[1])}}`
            : node.kind
  return head + (node.mods.length > 0 ? `.${modSignature(node)}` : '')
}

function diffShape(a, b, path, out) {
  if (a.kind === 'ref' || b.kind === 'ref') {
    if (a.kind !== b.kind || a.name !== b.name) {
      out.push(`${path}: 引用不同（镜像 ${shapeOf(a)} / 运行时 ${shapeOf(b)}）`)
    }
    return
  }
  if (a.kind !== b.kind) {
    out.push(`${path}: 类型不同（镜像 ${a.kind} / 运行时 ${b.kind}）`)
    return
  }
  if (a.kind === 'object') {
    const ka = new Map(a.fields)
    const kb = new Map(b.fields)
    for (const k of ka.keys()) if (!kb.has(k)) out.push(`${path}.${k}: 镜像有、运行时无的键`)
    for (const k of kb.keys()) if (!ka.has(k)) out.push(`${path}.${k}: 运行时有、镜像缺的键`)
    for (const k of ka.keys()) if (kb.has(k)) diffShape(ka.get(k), kb.get(k), `${path}.${k}`, out)
  } else if (a.kind === 'array') {
    diffShape(a.args[0], b.args[0], `${path}[]`, out)
  } else if (a.kind === 'tuple') {
    if (a.args.length !== b.args.length) out.push(`${path}: tuple 元素数不同（镜像 ${a.args.length} / 运行时 ${b.args.length}）`)
    for (let i = 0; i < Math.min(a.args.length, b.args.length); i += 1) diffShape(a.args[i], b.args[i], `${path}[${i}]`, out)
  } else if (a.kind === 'record' && a.args.length === 2 && b.args.length === 2) {
    diffShape(a.args[1], b.args[1], `${path}{}`, out)
  }
  if (modSignature(a) !== modSignature(b)) {
    out.push(`${path}: 修饰符不同（镜像 .${modSignature(a) || '(无)'} / 运行时 .${modSignature(b) || '(无)'}）`)
    return
  }
  for (let i = 0; i < a.mods.length; i += 1) {
    const va = a.mods[i].value
    const vb = b.mods[i].value
    if (va !== null && vb !== null && typeof va === 'object' && typeof vb === 'object') {
      diffShape(va, vb, `${path}.${a.mods[i].name}`, out)
    }
  }
}

/** 解析「从别名开始」的表达式（已去掉 `const viewSchema = ` 前缀）。 */
function parseRoot(expression) {
  const pos = { i: 0 }
  const node = parseSchema(tokenize(canonical(expression)), pos)
  if (node.kind !== 'object') throw new Untrusted('viewSchema 顶层不是 object')
  return node
}

/**
 * 承重自检（t8/t10）：
 * 「无 .rest() 的二元 tuple 拒绝多余元素」—— windows 收紧后，这条用例是**唯一**挡住
 * 「投影多输出一个窗口元素 → 真实 host 拒发整个视图」的关卡；而校验器是手写替代 zod 的，
 * 若它在 tuple 原语上回归放行多余元素，只靠人工审计发现不了。故本门禁硬断言它存在。
 * 判定用语义锚点（不是整行硬编码）：规范化后必须同时出现
 *   safeParse([[1,2,3]]).success 与期望 false
 * 即 `safeParse([[1,2,3]]).success,false` 这一规范化片段。
 * 注意：**不以「项数 == 16」作硬断言**（那会阻止将来合法新增自检项），项数只作信息输出。
 */
const LOAD_BEARING_ANCHOR = 'safeParse([[1,2,3]]).success,false'

function extractCasesArray(source) {
  const blanked = blankOutComments(source)
  const at = blanked.indexOf('const cases = [')
  if (at < 0) throw new Untrusted('testes/schema-check.mjs 中找不到 `const cases = [` 自检数组')
  const open = blanked.indexOf('[', at)
  const close = matchBalanced(blanked, open, '[', ']')
  return { text: blanked.slice(open, close + 1), line: lineOf(blanked, at) }
}

/** 用 token 深度计数 cases 数组的顶层条目（字符串内的括号不会被误计）。 */
function countCases(casesText) {
  const tokens = tokenize(casesText)
  let depth = 0
  let count = 0
  for (const t of tokens) {
    if (t === '[') {
      if (depth === 1) count += 1
      depth += 1
    } else if (t === ']') {
      depth -= 1
    } else if (t === '{') {
      depth += 1
    } else if (t === '}') {
      depth -= 1
    }
  }
  return count
}

/** 取 `billing.windows` 节点（viewSchema → billing → windows）。 */
function windowsNode(root) {
  const billing = (root.fields ?? []).find(([k]) => k === 'billing')
  if (billing === undefined) return null
  const windows = (billing[1].fields ?? []).find(([k]) => k === 'windows')
  return windows === undefined ? null : windows[1]
}

/** 断言 windows 是「无 .rest() 的二元 number tuple」。返回问题描述数组。 */
function checkWindowsShape(node, side) {
  const problems = []
  if (node === null) return [`${side} 缺少 billing.windows 字段`]
  if (node.kind !== 'array') problems.push(`${side} billing.windows 不是 array（实际 ${node.kind}）`)
  const inner = node.kind === 'array' ? node.args[0] : null
  if (inner === null || inner.kind !== 'tuple') {
    problems.push(`${side} billing.windows 的元素不是 tuple（实际 ${inner === null ? '无' : inner.kind}）`)
    return problems
  }
  if (inner.args.length !== 2) problems.push(`${side} billing.windows 元素不是二元 tuple（实际 ${inner.args.length} 元）`)
  if (inner.args.some((a) => a.kind !== 'number')) problems.push(`${side} billing.windows 元素含非 number 成员（${inner.args.map(shapeOf).join(', ')}）`)
  if (inner.mods.length > 0) problems.push(`${side} billing.windows 元素带修饰符 .${modSignature(inner)}（应为无 .rest() 的裸二元 tuple）`)
  return problems
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
function main() {
  const mirrorSource = readFileSync(MIRROR.file, 'utf8')
  const runtimeSource = readFileSync(RUNTIME.file, 'utf8')
  const mirror = extractSchemaExpression(mirrorSource, MIRROR)
  const runtime = extractSchemaExpression(runtimeSource, RUNTIME)

  const mirrorText = compact(mirror.text)
  const runtimeText = compact(runtime.text)
  const textIdentical = mirrorText === runtimeText

  const mirrorCosts = compact(extractConstExpression(mirrorSource, 'costsRecord', MIRROR).expression)
  const runtimeCosts = compact(extractConstExpression(runtimeSource, 'costsRecord', RUNTIME).expression)
  const costsIdentical = mirrorCosts === runtimeCosts

  const problems = []
  if (!textIdentical) {
    const at = firstDifference(mirrorText, runtimeText)
    problems.push(
      `viewSchema 归一化文本不一致（第 ${at} 个字符起）\n` +
        `      镜像  : ${around(mirrorText, at)}\n` +
        `      运行时: ${around(runtimeText, at)}`,
    )
  }
  if (!costsIdentical) {
    const at = firstDifference(mirrorCosts, runtimeCosts)
    problems.push(
      `costsRecord 定义不一致（第 ${at} 个字符起）\n      镜像  : ${around(mirrorCosts, at)}\n      运行时: ${around(runtimeCosts, at)}`,
    )
  }

  let keySummary = '（结构化定位不可用）'
  let selfTestInfo = '（未读取）'
  let mirrorRoot = null
  let runtimeRoot = null
  try {
    mirrorRoot = parseRoot(mirror.expression)
    runtimeRoot = parseRoot(runtime.expression)
    const mirrorKeys = mirrorRoot.fields.map(([k]) => k)
    const runtimeKeys = runtimeRoot.fields.map(([k]) => k)
    const onlyRuntime = runtimeKeys.filter((k) => !mirrorKeys.includes(k))
    const onlyMirror = mirrorKeys.filter((k) => !runtimeKeys.includes(k))
    if (onlyRuntime.length > 0) problems.push(`根级键缺失（运行时有、镜像无）: ${onlyRuntime.join(', ')}`)
    if (onlyMirror.length > 0) problems.push(`根级键多余（镜像有、运行时无）: ${onlyMirror.join(', ')}`)

    const shapeDiffs = []
    diffShape(mirrorRoot, runtimeRoot, 'viewSchema', shapeDiffs)
    for (const line of shapeDiffs) if (!problems.includes(line)) problems.push(line)

    keySummary = mirrorKeys.length === runtimeKeys.length && onlyRuntime.length === 0 && onlyMirror.length === 0
      ? `一致（${mirrorKeys.length} 键: ${mirrorKeys.join(', ')}）`
      : `不一致（镜像 ${mirrorKeys.length} 键 / 运行时 ${runtimeKeys.length} 键）`

    // 硬断言：windows 必须是「无 .rest() 的二元 number tuple」（两侧各查）
    for (const p of checkWindowsShape(windowsNode(mirrorRoot), '镜像')) problems.push(p)
    for (const p of checkWindowsShape(windowsNode(runtimeRoot), '运行时')) problems.push(p)
  } catch (err) {
    problems.push(`结构化定位失败：${err.message}`)
  }

  // 硬断言：承重自检用例必须存在且期望值为 false（语义锚点，不硬编码整行）
  let caseCount = null
  try {
    const cases = extractCasesArray(mirrorSource)
    caseCount = countCases(cases.text)
    const casesCanonical = compact(cases.text)
    const anchor = LOAD_BEARING_ANCHOR.replace(/\s+/g, '')
    if (!casesCanonical.includes(anchor)) {
      const where = `${relative(ROOT, MIRROR.file)}:${cases.line} 的自检数组`
      const why = '（「无 .rest() 的二元 tuple 拒绝多余元素」——windows 收紧后唯一挡住「投影多输出一个窗口元素 → host 拒发视图」的关卡）'
      if (casesCanonical.includes('safeParse([[1,2,3]])')) {
        problems.push(`承重自检用例被篡改：${where} 里存在 \`safeParse([[1,2,3]])\` 用例，但期望值不是 false（锚点 \`${LOAD_BEARING_ANCHOR}\` 不成立）${why}`)
      } else {
        problems.push(`承重自检用例缺失：${where} 中找不到语义锚点 \`${LOAD_BEARING_ANCHOR}\` ${why}`)
      }
    }
    selfTestInfo = `${caseCount} 项（信息性，不参与判定）`
  } catch (err) {
    problems.push(`无法读取校验器自检数组：${err.message}`)
  }

  console.log('schema 同构门禁：tests/schema-check.mjs 镜像 ≡ lib/index.js 运行时 viewSchema')
  console.log(`  镜像  : ${relative(ROOT, MIRROR.file)}:${mirror.declLine}（别名 ${mirror.alias}）`)
  console.log(`  运行时: ${relative(ROOT, RUNTIME.file)}:${runtime.declLine}（别名 ${runtime.alias}）`)
  console.log(`  归一化文本: ${textIdentical ? `一致（${mirrorText.length} 字符）` : '不一致'}`)
  console.log(`  根级键集合: ${keySummary}`)
  console.log(`  costsRecord: ${costsIdentical ? '一致' : '不一致'}`)
  console.log(`  windows 形态: 二元 number tuple 且无 .rest()（镜像/运行时各自硬断言）`)
  console.log(`  承重自检存在性: ${problems.some((p) => p.startsWith('承重自检用例')) ? '缺失/被篡改' : '存在且期望 false'}（硬断言）`)
  console.log(`  校验器自检项数: ${selfTestInfo}`)

  if (problems.length === 0) {
    console.log('\n结论: 一致 —— 镜像 schema 与运行时 wire schema 同构（含根级键集合与嵌套形状）')
    return 0
  }
  console.log('\n✗ 检出分叉（不放宽判定，按真实问题处理）:')
  for (const p of problems) console.log(`  - ${p}`)
  console.log(`\n结论: 分叉 ${problems.length} 处 —— 应把镜像收敛到运行时，而不是放宽运行时`)
  return 1
}

try {
  process.exit(main())
} catch (err) {
  if (err instanceof Untrusted) {
    console.error(`✗ 无法完成同构判定（拒绝静默放行）: ${err.message}`)
    process.exit(2)
  }
  throw err
}
