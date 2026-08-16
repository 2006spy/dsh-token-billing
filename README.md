<div align="center">

# 💸 dsh-token-billing

**DeepSeek Harness (dsh) 实时 token 计费插件** · Real-time token billing for DSH

官网人民币价直接计费 · 高峰/错峰自动切换 · 价格实时跟随官网 · 可视化自定义模型价格

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)
[![Version](https://img.shields.io/badge/version-0.5.0-green.svg)](package.json)

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

### 统计（历史账本 · 余额 · 导出 · 节省）

- **费用汇总**：今日 / 本月 / 累计（多币种，本地时区）
- **账户余额**：官方余额实时显示（需 `DEEPSEEK_API_KEY`）
- **按模型 / 按天**：历史明细（按天最近 14 天）
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
- **实时跟随官网**：价格表默认每小时自动重抓（可配置）；峰谷价在生效时刻到达后 1 分钟内自动切换，无需重启

---

## ✅ 验证

```sh
node tests/simulate.mjs      # 91 项：计价/估算/多币种/退款/中英文官网解析/峰谷时段/生效切换/折算/序列化
node tests/schema-check.mjs  # 视图 wire schema 校验（内置 + 官网高峰两场景）
node tests/ledger-test.mjs   # 账本：幂等合并/统计/本地节省/CSV 导出
```

真实联网端到端（抓官方页 → 解析 → 高峰/错峰计价）已实测通过。

---

## 📁 文件

| 文件 | 说明 |
| --- | --- |
| `lib/index.js` | 宿主端：注册投影 + settings 命名空间 + 价格抓取/缓存管理 + 账本/余额/导出路由 |
| `lib/projection.js` | 纯计费数学与投影状态机（零依赖，可独立测试） |
| `lib/prices.js` | 价格源：DeepSeek 官方页解析 / 自定义 JSON / 缓存 / 币种符号映射 |
| `lib/ledger.js` | 持久化账本：幂等合并 / 多维统计 / 本地节省 / CSV·JSON 导出 |
| `lib/client.js` | 浏览器端：费用行 + 设置卡片（手写 `__ModuleLoader__` bundle） |
| `cordis.patch.yml` | bundle 层挂载行 |
| `tests/` | 验证脚本 + 官方页 fixture |

---

## 📜 License

MIT
