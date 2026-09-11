# 价格页 fixture 来源

所有 fixture 都是 `https://api-docs.deepseek.com` 官方定价页的真实 HTML 快照（离线回归用，测试不联网）。

| 文件 | 快照内容 | 用途 |
| --- | --- | --- |
| `deepseek-pricing.html` | 2026-08-17 版英文页：模型行首（Layout A），模型名 `deepseek-v4-flash`/`deepseek-v4-pro`，峰谷表美元价，生效时刻 2026-08-16 16:00 UTC | 峰谷解析、美元 fx 折算、历史回归 |
| `deepseek-pricing-zh.html` | 2026-08-17 版中文页：平峰表 + 峰谷表，人民币价，生效时刻 2026-08-17 00:00 北京时间 | 人民币直计、生效时刻切换、工作日窗口 |
| `deepseek-pricing-zh-2026-09.html` | 2026-09-11 抓取的中文现页：模型列在表头 `deepseek-flash(1)` / `deepseek-v4-pro(2)`（**带脚注污染**），价格按空闲/高峰二层行给出；含官方脚注 (1)「模型名请使用 deepseek-flash，旧名 deepseek-v4-flash 等仍可调用并按 Flash 价格计费」 | v0.8.0 脚注归一化、官方现值、政策时间线 |
| `deepseek-pricing-en-2026-09.html` | 2026-09-11 抓取的英文现页（与中文现页同版） | 英文页脚注归一化与美元价解析 |

现页（2026-09 版）官方价格：Flash 空闲 ¥0.02/1/4、高峰 ¥0.04/2/8；V4 Pro 空闲 ¥0.15/4.5/13.5、高峰 ¥0.3/9/27（字段序 `cacheRead(命中)/input(未命中)/output`）。

重新抓取（更新 fixture 时）：

```bash
node -e "fetch('https://api-docs.deepseek.com/zh-cn/quick_start/pricing',{headers:{'user-agent':'dsh-token-billing/0.8 price fetcher'}}).then(r=>r.text()).then(t=>require('fs').writeFileSync('tests/fixtures/deepseek-pricing-zh-2026-09.html',t.replace(/\u0000/g,'')))"
```
