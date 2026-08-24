/**
 * 临时诊断脚本：驱动 tokenBilling 投影处理事件流，
 * 每次 apply 后深查 state 是否存在 undefined 属性（JSON 无损序列化检查）。
 * 复现 DSH 日志 "projection checkpoint is not losslessly JSON-serializable"。
 */
import { resolveBillingSpec, createTokenBillingProjectionParts } from '../lib/projection.js'

const spec = resolveBillingSpec({})
const parts = createTokenBillingProjectionParts(spec)
let state = parts.init()

/** 深查对象中的 undefined 属性（JSON.stringify 会丢弃 undefined，直接递归找）。 */
function findUndefined(v, path, out) {
  if (v === null || typeof v !== 'object') return
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (v[i] === undefined) out.push(`${path}[${i}] = undefined`)
      else findUndefined(v[i], `${path}[${i}]`, out)
    }
  } else {
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) out.push(`${path}.${k} = undefined`)
      else findUndefined(v[k], `${path}.${k}`, out)
    }
  }
}

let step = 0
function applyEvent(type, data, extra = {}) {
  step += 1
  state = parts.apply(state, { type, data, time: Date.now(), seq: step, ...extra })
  const bad = []
  findUndefined(state, 'state', bad)
  if (bad.length > 0) {
    console.log(`✗ 事件 #${step} ${type} 后出现 undefined:`)
    bad.slice(0, 15).forEach((b) => console.log('   ', b))
    process.exit(1)
  }
}

const ev = (type, data, extra) => ({ type, data, time: Date.now(), seq: ++step, ...(extra || {}) })

// 场景 1：普通估算流 → 精确 usage → 结算（含 header 更新）
let s = parts.init(); let n = 0
const run = (type, data, extra) => { s = parts.apply(s, ev(type, data, extra)); n += 1; const bad = []; findUndefined(s, 's', bad); if (bad.length) { console.log(`✗ 场景1 #${n} ${type}:`, bad.slice(0, 8)); process.exit(1) } }
run('turn/start', { turn: 1 })
run('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' }, system: 'sys' }, reason: 'initial' })
run('step/start', { turn: 1, step: 0 })
run('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hello world' } })
run('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: ' more text' } })
run('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 800, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0 } } })
run('assistant/message', { turn: 1, step: 0, message: { role: 'assistant', content: [] }, usage: { inputTokens: 800, outputTokens: 50 } }, { surfaceOp: 'append' })
run('step/end', { turn: 1, step: 0 })
run('turn/end', { turn: 1, reason: { kind: 'completed' } })
console.log('✓ 场景1（估算+精确+结算）state 无 undefined')

// 场景 2：估算被中断退款（turn/end 非 completed）
let s2 = parts.init(); let n2 = 0
const run2 = (type, data, extra) => { s2 = parts.apply(s2, ev(type, data, extra)); n2 += 1; const bad = []; findUndefined(s2, 's2', bad); if (bad.length) { console.log(`✗ 场景2 #${n2} ${type}:`, bad.slice(0, 8)); process.exit(1) } }
run2('turn/start', { turn: 2 })
run2('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' }, system: 'sys' }, reason: 'initial' })
run2('step/start', { turn: 2, step: 0 })
run2('assistant/chunk', { turn: 2, step: 0, chunk: { type: 'text-delta', index: 0, text: 'abc' } })
run2('step/end', { turn: 2, step: 0 })
run2('turn/end', { turn: 2, reason: { kind: 'aborted' } })
console.log('✓ 场景2（估算退款）state 无 undefined')

// 场景 3：多块 tool-call + 多 index
let s3 = parts.init(); let n3 = 0
const run3 = (type, data, extra) => { s3 = parts.apply(s3, ev(type, data, extra)); n3 += 1; const bad = []; findUndefined(s3, 's3', bad); if (bad.length) { console.log(`✗ 场景3 #${n3} ${type}:`, bad.slice(0, 8)); process.exit(1) } }
run3('turn/start', { turn: 3 })
run3('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-v4-pro' }, system: 'sys' }, reason: 'initial' })
run3('step/start', { turn: 3, step: 0 })
run3('assistant/chunk', { turn: 3, step: 0, chunk: { type: 'tool-call-delta', index: 0, name: 'read', argumentsDelta: '{"path":"a"}' } })
run3('assistant/chunk', { turn: 3, step: 0, chunk: { type: 'tool-call-delta', index: 1, name: undefined, argumentsDelta: '{"x":1}' } })
run3('assistant/chunk', { turn: 3, step: 0, chunk: { type: 'block-end', index: 0, block: { type: 'tool-call', name: 'read', arguments: '{}' } } })
run3('assistant/message', { turn: 3, step: 0, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 30 } }, { surfaceOp: 'append' })
run3('step/end', { turn: 3, step: 0 })
run3('turn/end', { turn: 3, reason: { kind: 'completed' } })
console.log('✓ 场景3（tool-call 多块）state 无 undefined')

// 场景 4：连续多轮 + header 变化 + 混合
let s4 = parts.init(); let n4 = 0
const run4 = (type, data, extra) => { s4 = parts.apply(s4, ev(type, data, extra)); n4 += 1; const bad = []; findUndefined(s4, 's4', bad); if (bad.length) { console.log(`✗ 场景4 #${n4} ${type}:`, bad.slice(0, 8)); process.exit(1) } }
for (let t = 1; t <= 3; t++) {
  run4('turn/start', { turn: t })
  run4('request/header', { header: { config: { provider: t % 2 ? 'deepseek' : 'opencode-go', model: 'deepseek-v4-flash' }, system: 'sys' }, reason: 'initial' })
  run4('step/start', { turn: t, step: 0 })
  for (let i = 0; i < 3; i++) run4('assistant/chunk', { turn: t, step: 0, chunk: { type: 'text-delta', index: i, text: 'chunk' + i } })
  run4('assistant/message', { turn: t, step: 0, message: { role: 'assistant', content: [] }, usage: { inputTokens: 50 + t * 10, outputTokens: 20 } }, { surfaceOp: 'append' })
  run4('step/end', { turn: t, step: 0 })
  run4('turn/end', { turn: t, reason: { kind: 'completed' } })
}
console.log('✓ 场景4（多轮+header 切换）state 无 undefined')
console.log('\n全部场景通过：常规事件流不会产生 undefined state')
