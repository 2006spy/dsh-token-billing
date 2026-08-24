// 临时脚本：为 dsh-token-billing 创建 GitHub Release
// 用法：REPO_PAT=<token> node github-release.mjs
const token = process.env.REPO_PAT
if (!token) {
  console.error('缺少 REPO_PAT')
  process.exit(1)
}

const body = `## 🛠 v0.7.1 — 修复 DSH 桌面端 2.0.2（核心 0.1.1-rc.1+）费用行不显示

**这是桌面端 2.0.2 用户的必更版本。** 升级桌面端后如果输入框下方的实时费用行消失、
统计账本停止累积，就是本修复针对的问题。

### 根因
核心 0.1.1-rc.1 起，\`sessionProjections.register()\` 改为只读 \`wire: { viewSchema, view }\` 块，
旧顶层 \`schema\` / \`view\` 字段被忽略，投影被当成「仅宿主内部」：宿主照常计费，但浏览器端
永远收不到数据——费用行隐藏，账本（靠变更通知记账）自升级起静默冻结，且无任何日志报错。

### 修复
- 按官方 dsh-context 插件的兼容写法，注册时同时提供新旧两套字段
  （\`wire\` 块 + \`stateSchema: zod.json()\` + 保留顶层 \`schema\`/\`view\`），**rc.8 与 rc.1+ 双核心通用**，
  安装方式不变，更新插件后重启 DSH 即可
- \`blocks\` 初始化从数组改为对象，修复宿主 plain-JSON 序列化契约告警
- \`usage.inputTokens/outputTokens\` 缺失时回退 0
- 费用行在投影缺失/hook 异常时静默隐藏（不再显示诊断文本）

### 其他
- 新增诊断工具：\`tests/debug-*.mjs\`（投影序列化检查 / 缓存状态体检 / 真实会话分帧解压全量重放）
- 新增 \`scripts/fix-deps.ps1\`：pnpm install 清空 link 包依赖后一键重建 Junction 链接

**Full Changelog**: https://github.com/2006spy/dsh-token-billing/compare/v0.7.0...v0.7.1`

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
    tag_name: 'v0.7.1',
    name: 'v0.7.1',
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
