/**
 * dsh-token-billing — 账本模块测试（node:test 风格，零依赖）。
 * 覆盖：幂等合并、统计（今日/本月/累计/按模型/按天/节省）、CSV 导出。
 */
import assert from 'node:assert/strict'
import {
  emptyLedger,
  mergeSteps,
  computeStats,
  ledgerToCsv,
} from '../lib/ledger.js'

const run = async () => {
  // 1. 幂等合并：相同 (sessionId, turn, step) 只保留首条
  const ledger = emptyLedger()
  const steps1 = [
    { turn: 1, step: 0, at: Date.UTC(2026, 7, 15, 10, 0), model: 'deepseek-v4-flash', provider: 'opencode-go', uncachedInputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01, currency: '¥', estimated: false },
    { turn: 1, step: 1, at: Date.UTC(2026, 7, 15, 10, 30), model: 'deepseek-v4-pro', provider: 'opencode-go', uncachedInputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.02, currency: '¥', estimated: false },
  ]
  const steps2 = [
    { turn: 1, step: 0, at: Date.UTC(2026, 7, 15, 10, 0), model: 'deepseek-v4-flash', provider: 'opencode-go', uncachedInputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.99, currency: '¥', estimated: false }, // 重复键，忽略
    { turn: 2, step: 0, at: Date.UTC(2026, 7, 16, 9, 0), model: 'glm-5.1', provider: 'local', uncachedInputTokens: 800, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.03, currency: '¥', estimated: true },
  ]
  mergeSteps(ledger, 'sess-1', steps1)
  mergeSteps(ledger, 'sess-1', steps2)
  assert.equal(ledger.steps.length, 3, '幂等合并：应只有 3 条')
  assert.equal(ledger.steps[0].cost, 0.01, '重复键不覆盖')

  // 2. 统计（Asia/Shanghai：UTC+8）
  const now = Date.UTC(2026, 7, 16, 2, 0) // 上海 8/16 10:00
  const stats = computeStats(ledger, { now, tz: 'Asia/Shanghai', currency: '¥' })
  // 今日（8/16）：step turn2 step0 → 0.03
  assert.equal(stats.today.calls, 1, '今日调用数')
  assert.ok(Math.abs(stats.today.costs['¥'] - 0.03) < 1e-9, '今日费用')
  // 本月（2026-08）：3 条
  assert.equal(stats.month.calls, 3, '本月调用数')
  assert.ok(Math.abs(stats.month.costs['¥'] - 0.06) < 1e-9, '本月费用')
  // 累计
  assert.equal(stats.total.calls, 3, '累计调用数')
  // 按模型
  assert.ok(stats.perModel['deepseek-v4-flash'].calls === 1, 'flash 调用数')
  assert.ok(stats.perModel['deepseek-v4-pro'].calls === 1, 'pro 调用数')
  assert.ok(stats.perModel['glm-5.1'].calls === 1, 'glm 调用数')
  // 按天
  assert.ok(stats.perDay['2026-08-15'] !== undefined, '8/15 存在')
  assert.ok(stats.perDay['2026-08-16'] !== undefined, '8/16 存在')
  // 按 provider
  assert.equal(stats.perProvider['opencode-go'].calls, 2, 'opencode-go 调用数')
  assert.equal(stats.perProvider['local'].calls, 1, 'local 调用数')

  // 3. 本地节省：glm-5.1 在 localProviders，localCostPerM=0 → 节省 = 名义 0.03
  const stats2 = computeStats(ledger, { now, tz: 'Asia/Shanghai', localProviders: ['local*'], localCostPerM: 0, currency: '¥' })
  assert.ok(stats2.savings.total['¥'] !== undefined, '有节省')
  assert.ok(Math.abs(stats2.savings.total['¥'] - 0.03) < 1e-9, '节省 = 名义价 0.03（本地免费）')
  assert.ok(Math.abs(stats2.savings.nominal['¥'] - 0.03) < 1e-9, '名义价值')

  // localCostPerM 非零：glm-5.1 tokens=1100 → 实际 1100*0.5/1e6 = 0.00055
  const stats3 = computeStats(ledger, { now, tz: 'Asia/Shanghai', localProviders: ['local'], localCostPerM: 0.5, currency: '¥' })
  assert.ok(Math.abs(stats3.savings.actual['¥'] - 0.00055) < 1e-9, '实际成本按 localCostPerM')

  // 4. CSV 导出
  const csv = ledgerToCsv(ledger)
  const lines = csv.split('\n')
  assert.equal(lines[0], 'sessionId,turn,step,at,model,provider,input,output,cacheRead,cacheWrite,cost,currency,estimated', 'CSV 表头')
  assert.equal(lines.length, 4, 'CSV 行数（表头+3）')
  assert.ok(lines[1].includes('sess-1,1,0'), 'CSV 首行数据')

  console.log('ledger 测试全部通过')
  return true
}

run().catch((err) => {
  console.error('ledger 测试失败：', err)
  process.exit(1)
})
