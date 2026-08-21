// 临时脚本：为 dsh-token-billing 创建 GitHub Release v0.7.0
// 用法：REPO_PAT=<token> NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:12450 node github-release.mjs
const token = process.env.REPO_PAT
if (!token) {
  console.error('缺少 REPO_PAT')
  process.exit(1)
}

const body = `## 🎉 v0.7.0 — 统计页仪表盘

参考中转站（one-api / new-api）首页与 dsh-web-billing 费用页，统计页升级为**仪表盘**，纯手写 SVG 图表（零构建依赖，深浅主题自适应，hover 查看明细）：

- **KPI 概览卡**：今日 / 昨日 / 本月 / 累计 / 调用次数；今日卡带 **vs 昨日环比**（▲ 红 = 花多，▼ 绿 = 省了）；本月卡带**预算进度环**
- **📈 费用趋势折线图**：近 14 天每日费用（面积渐变 + hover 竖线与明细 tooltip）
- **📊 Token 用量趋势折线图**：近 14 天输入 / 输出 / 缓存读三条线 + 图例
- **🍩 按模型费用占比环形图**：扇形占比 + 中心合计 + 图例（超 8 项自动合并「其他」）
- **🍩 按 Provider 实际花费占比环形图**：按量实付分布；全为订阅/免费/本地时给出提示
- **月度预算预警**：新增 \`monthlyBudget\` 配置（基础选项卡），进度条绿 → 琥珀 → 红，超支红色高亮并显示超支金额
- 仪表盘顶部「↻ 刷新」；按天明细表新增每日 token 总量

### 数据层
- 账本 \`perDay\` 增加 token 分桶（uncachedInput / output / cacheRead / cacheWrite）
- \`computeStats\` 返回 \`days\`（today / yesterday 本地时区键）；stats 路由附带近 14 天时间轴 \`seriesLabels\` 与 \`budget\`

### 验证
- \`simulate.mjs\` 101 项、\`schema-check\`、\`ledger-test\`（新增 perDay/days 断言）、\`bundle-smoke\`（新增）全部通过
- 新增 \`scripts/render-preview.mjs\` 开发预览工具`

const res = await fetch('https://api.github.com/repos/2006spy/dsh-token-billing/releases', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'dsh-token-billing-release-script',
    'x-github-api-version': '2022-11-28',
  },
  body: JSON.stringify({
    tag_name: 'v0.7.0',
    name: 'v0.7.0',
    body,
    draft: false,
    prerelease: false,
  }),
})

const text = await res.text()
console.log(`HTTP ${res.status}`)
if (res.status >= 200 && res.status < 300) {
  const json = JSON.parse(text)
  console.log(`✅ Release 已创建: ${json.html_url}`)
} else {
  console.log(text)
  process.exit(1)
}
