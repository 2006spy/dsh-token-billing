<div align="center">

# 💸 dsh-token-billing

**DeepSeek Harness (dsh) 实时 token 计费插件** · Real-time token billing for DSH

官网人民币价直接计费 · 高峰/错峰自动切换 · 价格实时跟随官网 · 可视化自定义模型价格 · 订阅/免费/本地收费形式分类 · 统计仪表盘（趋势折线图 + 占比环形图 + 预算预警）

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)
[![Version](https://img.shields.io/badge/version-0.7.0-green.svg)](package.json)

</div>

---

## ✨ 这是什么

为 DeepSeek Harness（dsh）Web 提供**实时费用统计**：按本次会话实际的 token 用量（输入 / 输出 / 缓存读 / 缓存写四个桶）乘以模型单价，换算成费用，在输入框上方实时显示。

- **估算 → 精确自动修正**：流式生成期间用字符/4 启发式**估算**（标注「估」），收到模型的精确 usage 后**自动修正**；被中断（abort）的估算步骤**不会落地计费**。
- **零构建依赖**：手写 ESM 宿主 + `__ModuleLoader__` 客户端 bundle，与 modlens 同款立场。

> 输入框上方一行实时显示（与 TPS 同款样式）：
>
> ```
> 💸 ¥0.0302 · 12.3k in / 1.2k out · 本轮(估) ¥0.0011 · deepseek-v4-flash ¥4.5/M · 空闲
> ```

---

## 🚀 安装

### 方式一：DSH 插件市场（推荐，待上架）

1. 打开 DSH → **设置 → 插件 → 市场**
2. 搜索 `dsh-token-billing`，点 **安装**
3. 重启 DSH Web

### 方式二：GitHub 直接安装

```bash
# 在 web profile 目录下执行
cd ~/.dsh/profiles/web
pnpm add github:2006spy/dsh-token-billing#main
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: token-billing
      name: dsh-token-billing
```

重启 dsh web 即可。

### 方式三：本地源码链接（开发）

```bash
git clone https://github.com/2006spy/dsh-token-billing.git
# ~/.dsh/profiles/web/package.json → dependencies:
#   "dsh-token-billing": "link:<绝对路径>"
# ~/.dsh/profiles/web/cordis.patch.yml → 挂载行同上
```

---

## 🎯 核心特性

### 官网人民币价格直接计费
默认抓取 [DeepSeek 官网中文页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)（`¥` 标价，如 flash 平峰 0.02/1/2 元、高峰 0.10/3.0/9.0 元），**无需汇率换算**；英文页（USD）兜底，可用「外币自动折算人民币」按汇率折算。

### 价格实时跟随官网
默认 **1 小时**自动检查并重抓官网价格表（后台周期定时器 + 缓存过期重抓 + 卡片手动刷新）；**高峰/错峰生效时刻到达后 1 分钟内自动切换**，无需重启。

### DeepSeek 高峰/错峰计费（官方口径）
- 高峰：**北京时间 09:00-12:00 与 14:00-18:00**，其余为空闲时段（半价）
- 新价自**北京时间 2026-08-17 00:00** 生效
- 插件自动解析官网的窗口（北京时间）与时区，按请求发生时刻自动切换计价
- 费用行实时显示当前「高峰 / 空闲」徽标

### 可视化自定义模型价格
设置卡「基础」里用表格可视化添加/删除自定义模型与价格（模型 ID + 输入/输出/缓存读/缓存写/币种），替代手写 JSON，实时生效。

### 多币种兜底
非人民币的外币价按汇率折算为目标货币；不同币种分别累计显示。

### 持久化历史账本 + 多维统计（v0.5）
每条结算 step 幂等落盘 `~/.dsh/storages/token-billing-ledger.json`，**跨会话累计、重启不丢**。
「统计」卡展示 **今日 / 本月 / 累计 / 按模型 / 按天**（本地时区）。

### 账户余额查询（v0.5）
调官方 `GET /user/balance`（复用 `DEEPSEEK_API_KEY`），统计卡实时显示余额（60s 缓存，失败静默降级，key 不下发浏览器）。

### CSV / JSON 导出（v0.5）
统计卡一键导出账本：CSV（带 BOM，Excel 友好）或 JSON。

### 本地模型节省统计（v0.5）
配置 `localProviders`（如 `local*`）与 `localCostPerM`（实际成本，默认 0 = 免费）后，
本地（自托管）模型调用按官方价计**名义价值** - 实际成本 = **已节省**，统计卡实时显示。

### Provider 收费形式（v0.6，参考 dsh-web-billing）
配置 `providerModes`（JSON，如 `{"opencode-go":"subscription","local*":"local","*free*":"free"}`）后，
订阅制 / 免费 / 本地 provider 的调用**实际花费按 0 计**，官方名义价折算为「节省/回本」：

| 模式 | 说明 |
| --- | --- |
| `usage` | 按量：按官方/配置价实算花费（默认） |
| `subscription` | 订阅（如 opencode-go $10/月）：实际花费 0，名义价值计「回本」 |
| `free` | 活动免费：实际花费 0（真正白嫖） |
| `local` | 本地部署：实际花费 0（或按 `localCostPerM`），省的是 API 钱 |

- 支持 glob 匹配（`local*` / `*free*`）；精确匹配优先于 glob
- 统计卡「按 provider」按此分类显示实际花费 / 名义价值 / 节省（徽标着色：按量灰 / 订阅紫 / 免费天蓝 / 本地绿）
- **历史重估**：配置后，账本中未带 mode 的旧记录按当前配置重新分类统计，无需改账本
- 每条结算 step 会把当时的收费形式（mode）持久化进账本，导出 CSV/JSON 可见

### Token 用量与缓存命中统计（v0.6）
统计卡新增「Token 用量与缓存命中」：未缓存输入 / 缓存读 / 缓存写 / 输出 / 总 Token / 缓存命中率。

### 统计仪表盘（v0.7，参考中转站 one-api / new-api 首页 + dsh-web-billing 费用页）
统计页升级为**仪表盘**，纯手写 SVG 图表（零构建依赖，深浅主题自适应，hover 查看明细）：

- **KPI 概览卡**：今日 / 昨日 / 本月 / 累计 / 调用次数；今日卡带 **vs 昨日环比**（▲ 红 = 花多了，▼ 绿 = 省了）；本月卡带**预算进度环**
- **📈 费用趋势折线图**：近 14 天每日费用（面积渐变 + hover 竖线与明细 tooltip）
- **📊 Token 用量趋势折线图**：近 14 天输入 / 输出 / 缓存读三条线 + 图例
- **🍩 按模型费用占比环形图**：扇形占比 + 中心合计 + 图例（超 8 项自动合并「其他」）
- **🍩 按 Provider 实际花费占比环形图**：按量实付分布；全为订阅/免费/本地时给出提示
- **月度预算预警**：`monthlyBudget` 配置后显示进度条（绿 → 琥珀 → 红，超支红色高亮并显示超支金额）
- 仪表盘顶部「↻ 刷新」一键重拉统计与余额；按天明细表新增每日 token 总量

---

## ⚙️ 配置

「设置 → 插件 → Web UI 插件 → **Token 计费**」卡片，保存即时生效（重建投影）。

### 基础

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| 启用实时计费 | 开 | 总开关 |
| 默认货币符号 | `¥` | 目标计费货币；官网人民币价直接使用，其他外币价按汇率折算 |
| 未知模型 · 输入/输出/缓存读/缓存写价 | 2 / 8 / 0.5 / 2 | 未覆盖模型的默认价（每 1M token） |
| 模型价格覆盖 | `{}` | **可视化编辑器**：逐格填「模型 ID + 输入/输出/缓存读/缓存写/币种」，可增删行；也可直接写 JSON `{ "deepseek-chat": {"input":2,"output":8} }`；优先级最高，不参与高峰/错峰 |
| 本地模型提供方（glob） | — | 本地/自托管 provider 名单（如 `local*`），按官方价计名义价值；逗号分隔 |
| 本地模型实际单价 | `0` | 本地模型每 1M token 实际成本（默认 0 = 免费，可填电费/算力成本）；名义价值 − 实际成本 = 已节省 |
| 月度预算（默认货币） | `0` | 0 = 不设预算；设置后统计页显示预算进度环与进度条预警（绿 → 琥珀 → 红，超支红色高亮） |
| Provider 收费形式（JSON） | `{}` | 如 `{"opencode-go":"subscription","local*":"local","*free*":"free"}`；订阅/免费/本地按 0 实付、名义价计节省（见上） |

### 价格来源

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| 价格来源 | DeepSeek 官网 | `deepseek`（**中文页·人民币**，自动抓取，英文页兜底）/ `custom-json`（自定义端点）/ `builtin`（仅内置表） |
| 自定义价格 URL | — | 返回 `{ "模型id": {"input":..,"output":..,"cacheRead":..,"cacheWrite":..} }` 或 `{ "currency":"CNY", "models":{...} }` |
| 自动刷新间隔 | 1h | 后台周期检查，价格表跟随官网实时更新 |

### 汇率折算

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| 外币自动折算人民币 | 开 | 抓取到外币价（如 $）时按汇率折算为目标货币 |
| 汇率（1 外币 = N 元） | `7.2` | 仅对外币价生效（官网人民币价直接使用） |

### 高峰/错峰（DeepSeek 官方计费）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| 启用高峰/错峰 | 开 | 总开关（需抓取到官方高峰价表才生效） |
| 高峰窗口 | 跟随官网 | 官网自动解析为**北京时间 09:00-12:00 与 14:00-18:00**（Asia/Shanghai）；留空自动跟随，自定义时覆盖 |
| 错峰折扣率 | `0.5` | 官方空闲 = 高峰 × 0.5 |
| 适用模型 | `deepseek-*` | glob，逗号分隔 |
| 窗口时区 | 跟随官网 | 默认 Asia/Shanghai（北京时间）；自定义窗口时生效 |
| 忽略生效日期 | 关 | 官方峰谷价自**北京时间 2026-08-17 00:00** 生效；勾选后立即启用 |

### 状态（实时查看）

- **价格抓取状态**：来源、最近更新时间、覆盖模型数、高峰/错峰窗口与生效时刻；「立即刷新价格」按钮手动抓取并重建投影。
- **当前生效单价表**：列出所有模型当前生效价（含高峰/错峰，按此刻计价），切换模型/时段变化后实时刷新。

### 统计（仪表盘 · 历史账本 · 余额 · 导出 · 节省 · 收费形式 · 缓存命中）

- **仪表盘概览**：KPI 卡（今日 / 昨日环比 / 本月·预算环 / 累计 / 调用次数）+ 近 14 天**费用趋势折线图** + **Token 用量趋势折线图** + **按模型 / 按 Provider 占比环形图**（hover 查看明细，详见上方 v0.7 一节）
- **月度预算**：`monthlyBudget` 配置后显示进度条预警（超支红色高亮）
- **费用汇总**：今日 / 本月 / 累计（多币种，本地时区）
- **账户余额**：官方余额实时显示（需 `DEEPSEEK_API_KEY`）
- **按模型 / 按天**：历史明细（按天最近 14 天，含每日 token 总量）
- **按 provider**：每个 provider 的实际花费 / 名义价值 / 节省与收费形式徽标（按量灰 / 订阅紫 / 免费天蓝 / 本地绿）
- **Token 用量与缓存命中**：未缓存输入 / 缓存读 / 缓存写 / 输出 / 总 Token / 缓存命中率
- **本地模型节省**：已节省 / 名义价值 / 实际成本
- **导出**：CSV / JSON 一键下载账本

---

## 📊 显示

输入框上方一行（与 TPS 同款样式）：

```
💸 ¥0.0302 · 12.3k in / 1.2k out · 本轮(估) ¥0.0011 · deepseek-v4-flash ¥4.5/M · 空闲
```

- 第一段：本会话累计费用（默认人民币；多币种时按币种分别显示）
- 中间：输入 / 输出 token 累计
- 第三段：当前一轮（turn）费用，进行中显示「(估)」，结算后自动变精确
- 当前模型段：`<模型id> <当前生效输出单价>/M`，随模型切换实时更新（含高峰/错峰）
- 尾部徽标：峰谷计费生效时显示当前是「高峰」还是「空闲」
- 悬停（title）：按模型的费用明细（含币种）、价格来源、高峰窗口

---

## 🧮 计费口径

- 价格 = 每 1M token 单价；`费用 = 未缓存输入×in + 输出×out + 缓存读×read + 缓存写×write`（除以 1M）
- 精确 usage 到达前，输出按 `ceil(字符/4)+4` 估算，输入按系统提示 + 工具 schema + 会话表面估算
- `assistant/message` 或 `usage` chunk 携带精确用量时，该步立即换成精确值
- 结算时刻（step/end）决定该步落在高峰还是空闲；用户覆盖的价格不参与高峰/错峰
- 非 `completed` 结束（abort/error）的估算步骤自动退款，不计入总计
- **收费形式**：`providerModes` 配置的订阅/免费/本地 provider，结算仍按名义价记入账本（含 mode 字段），统计层把实际花费归 0、名义价值计入节省/回本；未配置时全部按 `usage` 按量计
- **实时跟随官网**：价格表默认每小时自动重抓（可配置）；峰谷价在生效时刻到达后 1 分钟内自动切换，无需重启

---

## ✅ 验证

```sh
node tests/simulate.mjs      # 101 项：计价/估算/多币种/退款/中英文官网解析/峰谷时段/生效切换/折算/序列化
node tests/schema-check.mjs  # 视图 wire schema 校验（内置 + 官网高峰两场景）
node tests/ledger-test.mjs   # 账本：幂等合并/统计/本地节省/CSV 导出/perDay 分桶与 days 键
node tests/bundle-smoke.mjs  # 浏览器 bundle：工厂执行 + 依赖契约（React shim）
```

真实联网端到端（抓官方页 → 解析 → 高峰/错峰计价）已实测通过。

> 开发预览：`node scripts/render-preview.mjs` 生成 `tests/preview.html`（内联 React + 模拟账本数据），
> 用本地 Chrome 渲染统计页仪表盘截图，可快速核对图表效果（该文件已 gitignore，不入库）。

---

## 📁 文件

| 文件 | 说明 |
| --- | --- |
| `lib/index.js` | 宿主端：注册投影 + settings 命名空间 + 价格抓取/缓存管理 + 账本/余额/导出/统计路由 |
| `lib/projection.js` | 纯计费数学与投影状态机（零依赖，可独立测试） |
| `lib/prices.js` | 价格源：DeepSeek 官方页解析 / 自定义 JSON / 缓存 / 币种符号映射 |
| `lib/ledger.js` | 持久化账本：幂等合并 / 多维统计（含 perDay token 分桶、days 键）/ 本地节省 / CSV·JSON 导出 |
| `lib/client.js` | 浏览器端：费用行 + 设置卡片 + 统计仪表盘（手写 SVG 图表，`__ModuleLoader__` bundle） |
| `cordis.patch.yml` | bundle 层挂载行 |
| `scripts/render-preview.mjs` | 开发工具：生成统计页仪表盘预览 HTML |
| `tests/` | 验证脚本 + 官方页 fixture |

---

## 📜 License

MIT
