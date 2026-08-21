/**
 * dsh-token-billing — 生成统计页仪表盘预览页（开发工具，非发布产物）。
 *
 * 把 React 18 cjs 源码 + 插件 client.js + 模拟账本数据内联进一个独立 HTML，
 * 用本地 Chrome（vision_html_screenshot）渲染截图，用于人工核对图表效果：
 *   - 折线图（费用趋势 / Token 趋势）
 *   - 环形图（按模型 / 按 Provider 占比）
 *   - KPI 概览卡（今日 vs 昨日环比、本月预算环）
 *   - 月度预算进度条
 *
 * 用法：node scripts/render-preview.mjs  →  生成 tests/preview.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const read = (p) => readFileSync(join(root, p), 'utf8')
const reactSrc = read('node_modules/.preview-react/react.production.min.js')
const schedulerSrc = read('node_modules/.preview-react/scheduler.production.min.js')
const reactDomSrc = read('node_modules/.preview-react/react-dom.production.min.js')
const clientSrc = read('lib/client.js')

// 近 14 天时间轴（本地时区键）
const labels = []
const base = new Date(2026, 7, 21, 10) // 2026-08-21
for (let i = 13; i >= 0; i--) {
  const d = new Date(base)
  d.setDate(d.getDate() - i)
  const p = (n) => String(n).padStart(2, '0')
  labels.push(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()))
}

const dayCost = (i) => {
  const seed = [2.4, 3.1, 1.8, 4.2, 2.9, 5.6, 3.4, 2.2, 6.1, 4.4, 3.8, 7.2, 5.1, 3.9]
  return seed[i] + (i === 13 ? 0.42 : 0) // 今日额外 0.42
}
const dayIn = (i) => [120, 180, 96, 210, 140, 260, 170, 110, 300, 220, 190, 340, 250, 190][i] * 1000
const dayOut = (i) => [28, 42, 20, 48, 32, 60, 38, 25, 66, 48, 40, 74, 52, 41][i] * 1000
const dayCache = (i) => [40, 60, 30, 80, 50, 100, 60, 35, 110, 70, 60, 120, 80, 62][i] * 1000

const perDay = {}
for (let i = 0; i < 14; i++) {
  perDay[labels[i]] = {
    costs: { '¥': Number(dayCost(i).toFixed(4)) },
    calls: 20 + i * 3,
    uncachedInput: dayIn(i),
    output: dayOut(i),
    cacheRead: dayCache(i),
    cacheWrite: 2000 + i * 500,
  }
}

const CONFIG = {
  enabled: true,
  currency: '¥',
  priceSource: 'deepseek',
  customPriceUrl: '',
  providerPriceUrls: '{}',
  providerModes: '{"opencode-go":"subscription","local*":"local"}',
  refreshHours: 1,
  fxEnabled: true,
  fxRate: 7.2,
  fallbackInput: 2,
  fallbackOutput: 8,
  fallbackCacheRead: 0.5,
  fallbackCacheWrite: 2,
  prices: '{}',
  offPeakEnabled: true,
  offPeakWindows: '[["09:00","12:00"],["14:00","18:00"]]',
  offPeakRate: 0.5,
  offPeakModels: 'deepseek-*',
  offPeakTz: 'Asia/Shanghai',
  offPeakForce: false,
  localProviders: 'local*',
  localCostPerM: 0,
  monthlyBudget: 30,
}

const STATS = {
  today: { costs: { '¥': 0.4231 }, calls: 12 },
  month: { costs: { '¥': 8.94 }, calls: 156 },
  total: { costs: { '¥': 41.72 }, calls: 902 },
  perModel: {
    'deepseek-v4-flash': { costs: { '¥': 22.41 }, calls: 480 },
    'deepseek-v4-pro': { costs: { '¥': 15.08 }, calls: 310 },
    'glm-5.1': { costs: { '¥': 3.02 }, calls: 87 },
    'gpt-5.6-terra': { costs: { '¥': 1.21 }, calls: 25 },
  },
  perDay,
  perProvider: {
    'deepseek': { costs: { '¥': 30.21 }, calls: 600, mode: 'usage', nominal: { '¥': 30.21 }, actual: { '¥': 30.21 }, saved: {} },
    'opencode-go': { costs: { '¥': 5.2 }, calls: 120, mode: 'subscription', nominal: { '¥': 5.2 }, actual: {}, saved: { '¥': 5.2 } },
    'local': { costs: { '¥': 6.31 }, calls: 182, mode: 'local', nominal: { '¥': 6.31 }, actual: {}, saved: { '¥': 6.31 } },
  },
  savings: { nominal: { '¥': 11.51 }, actual: { '¥': 0 }, total: { '¥': 11.51 } },
  local: { enabled: true, providers: ['local*'], costPerM: 0 },
  metering: {
    byMode: {
      usage: { calls: 600, costs: { '¥': 30.21 }, nominal: { '¥': 30.21 }, actual: { '¥': 30.21 }, saved: {} },
      subscription: { calls: 120, costs: { '¥': 5.2 }, nominal: { '¥': 5.2 }, actual: {}, saved: { '¥': 5.2 } },
      local: { calls: 182, costs: { '¥': 6.31 }, nominal: { '¥': 6.31 }, actual: {}, saved: { '¥': 6.31 } },
    },
  },
  cacheStats: {
    uncachedInput: 1830000,
    output: 412000,
    cacheRead: 720000,
    cacheWrite: 24000,
    calls: 902,
    hitRate: 0.2824,
  },
  days: { today: labels[13], yesterday: labels[12] },
  seriesLabels: labels,
  budget: { monthly: 30, currency: '¥' },
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-token-billing 统计页预览</title>
<style>
  :root {
    --dsw-alias-bg-layer-2: #1c2128;
    --dsw-alias-bg-layer-3: #151a20;
    --dsw-alias-bg-module-platform: #232932;
    --dsw-alias-border-l2: #2f3742;
    --dsw-alias-label-primary: #e6eaf0;
    --dsw-alias-label-secondary: #b3bcc9;
    --dsw-alias-label-tertiary: #7d8896;
    --dsw-alias-label-dimmed: #4d5663;
    --dsw-alias-label-error: #f87171;
    --dsw-alias-brand-primary: #7c5cff;
    --dsw-alias-state-warn-primary: #fbbf24;
    --dsw-alias-state-success-primary: #34d399;
    --dsw-alias-state-error-primary: #f87171;
    --dsh-chat-content-width: 760px;
    --dsh-composer-side-clearance: 16px;
  }
  body { margin: 0; background: #10141a; color: var(--dsw-alias-label-primary); font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; padding: 24px; }
  #root { max-width: 820px; margin: 0 auto; }
  .preview-head { font-size: 14px; color: var(--dsw-alias-label-tertiary); margin-bottom: 14px; }
</style>
</head>
<body>
<div class="preview-head">dsh-token-billing · 统计页仪表盘预览（模拟数据）</div>
<div id="root"></div>
<script>
"use strict";
// ---- 迷你 CommonJS 加载器：内联 react / scheduler / react-dom ----
var __mods = {};
function __cjsLoad(id, src) {
  var module = { exports: {} };
  var localRequire = function (name) {
    if (__mods[name]) return __mods[name].exports;
    throw new Error('preview: 未内联的模块 ' + name);
  };
  new Function('module', 'exports', 'require', src)(module, module.exports, localRequire);
  __mods[id] = module;
}
__cjsLoad('scheduler', ${JSON.stringify(schedulerSrc)});
__cjsLoad('react', ${JSON.stringify(reactSrc)});
__cjsLoad('react-dom', ${JSON.stringify(reactDomSrc)});
var React = __mods['react'].exports;
var ReactDOM = __mods['react-dom'].exports;
window.React = React;

// ---- 模拟 DSH 运行时：__ModuleLoader__ + 宿主路由 fetch + slots ----
var CONFIG = ${JSON.stringify(CONFIG)};
var STATS = ${JSON.stringify(STATS)};
window.fetch = function (url) {
  var respond = function (obj) { return Promise.resolve({ ok: true, json: function () { return Promise.resolve(obj); } }); };
  var u = String(url);
  if (u.indexOf('/token-billing/config') >= 0) return respond({ ok: true, value: CONFIG, base: {}, user: {}, revision: 1, writable: true });
  if (u.indexOf('/token-billing/stats') >= 0) return respond({ ok: true, stats: STATS });
  if (u.indexOf('/token-billing/balance') >= 0) return respond({ ok: true, balanceInfos: [{ currency: 'CNY', total_balance: 88.66, granted_balance: 12.0, topped_up_balance: 76.66 }] });
  if (u.indexOf('/token-billing/prices') >= 0) return respond({ ok: true, source: 'deepseek', fetchedAt: Date.now(), flatModels: 3, peak: { models: 2, windows: [[540, 720], [840, 1080]], effectiveAt: Date.UTC(2026, 7, 16, 16) }, fx: { enabled: true, rate: 7.2, target: '¥' }, effective: {}, providerEffective: {} });
  return respond({ ok: false });
};

var __captured = { desc: null, render: null, scope: null };
var fakeSlots = {
  inject: function (name, cb) {
    if (name !== 'settings.section') return;
    var out = cb();
    if (out && out.desc) { __captured.desc = out.desc; __captured.render = out.render; }
  },
  register: function (desc, render) { return { desc: desc, render: render }; },
};
var fakeCtx = { slots: fakeSlots };

var __entry = null;
window.__ModuleLoader__ = {
  load: function (e) { __entry = e; },
};
</script>
<script>
${clientSrc}
</script>
<script>
"use strict";
// ---- 执行插件 apply，捕获注册，挂载到预览页并自动切到「统计」选项卡 ----
var plugin = __entry.factory(function (id) {
  if (id === 'react') return React;
  throw new Error('client.js 依赖未知模块 ' + id);
});
plugin.apply(fakeCtx);

function AutoStats(props) {
  var [tick, setTick] = React.useState(0);
  React.useEffect(function () {
    // 从 document 直接找「统计」选项卡按钮（ref 无法穿透到设置卡函数组件）
    var btn = Array.prototype.find.call(document.querySelectorAll('button[role="tab"]'), function (b) { return b.textContent.indexOf('统计') >= 0; });
    if (btn) btn.click();
  }, []);
  React.useEffect(function () {
    var t = setTimeout(function () { setTick(function (v) { return v + 1; }); }, 600);
    return function () { clearTimeout(t); };
  }, []);
  return React.createElement(__captured.render, { scope: __captured.desc.inject().scope });
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AutoStats, null));
</script>
</body>
</html>
`

mkdirSync(join(root, 'tests'), { recursive: true })
writeFileSync(join(root, 'tests', 'preview.html'), html, 'utf8')
console.log('已生成 tests/preview.html（' + Math.round(html.length / 1024) + ' KB）')
