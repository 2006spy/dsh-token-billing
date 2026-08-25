// 临时脚本：为 dsh-token-billing 创建 GitHub Release
// 用法：REPO_PAT=<token> node github-release.mjs
const token = process.env.REPO_PAT
if (!token) {
  console.error('缺少 REPO_PAT')
  process.exit(1)
}

const body = `## 🛠 v0.7.2 — 高峰窗口支持星期几维度：2026-08-23 起官方高峰仅限周一至周五，周末全天空闲价

官方于 2026-08-23（北京时间）起调整峰谷规则：高峰时段只落在**周一至周五**，周六周日全天按空闲价（半价）。
旧版窗口数据结构只有 \`[起分, 止分]\`（一天里的分钟），抓下来的「周一至周五」没处放，周末请求仍按高峰价计费（每周约 14 小时多计一倍）。本版为窗口增加星期几维度：

### 修复
- **窗口支持第三维 days**：\`[起分, 止分, [1,2,3,4,5]]\`（0=周日…6=周六，缺省 = 每天）；新增 \`weekdayInTz(atMs, tz)\` 按同一 tz 读星期几（不退回 \`getUTCDay()\`，规避 UTC/北京两本日历在周五/周日 16:00-24:00 UTC 的分歧）
- **官网解析**：中文页识别「周一至周五 / 工作日」，英文页识别 "Monday through Friday" / "weekdays"，自动写入 days；英文页窗口 +8h 折算为北京时间，与中文页同一日历
- **历史回看不减半**：周末空闲规则加 effectiveAt 门控（生效时刻 \`2026-08-22T16:00:00Z\`），生效前的周末仍按高峰价计费——回看旧账不会少算一半
- **默认窗口/时区**改为北京时间（Asia/Shanghai）+ 工作日限定

### 验证
用 [deepseek-peak-hours](https://github.com/xyzs996/deepseek-peak-hours) 的 15 条边界向量验证：**15/15 通过**（修复前 10/15）；本地测试套件 123 通过 / 0 失败。

**Full Changelog**: https://github.com/2006spy/dsh-token-billing/compare/v0.7.1...v0.7.2`

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
    tag_name: 'v0.7.2',
    name: 'v0.7.2',
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
