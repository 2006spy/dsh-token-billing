// dsh-token-billing — 浏览器端：输入框上方的实时费用行 + 「Token 计费」设置卡片。
//
// v0.2：多币种费用显示（DeepSeek 官网为 USD、内置表为 ¥），高峰/错峰徽标；
// 设置卡片新增「价格来源 / 高峰错峰」配置与手动刷新价格按钮（走宿主路由）。
//
// 手写 lazy-CJS bundle（window.__ModuleLoader__.load），零构建依赖：
// React 经 loader 的 require 解析（与家族插件的打包产物一致）。不依赖任何
// dsh 客户端包 —— 插槽名与 settings scope 均为运行时字符串/服务。
window.__ModuleLoader__.load({
  id: 'dsh-token-billing',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useSyncExternalStore = React.useSyncExternalStore
    var memo = React.memo
    var h = React.createElement

    /* ------------------------------------------------------------------ */
    /* 格式化                                                             */
    /* ------------------------------------------------------------------ */

    /** 金额格式化：自适应精度 + 去除多余尾零（¥2.5239 / ¥0.41 / ¥0.0009）。 */
    function formatCost(cost, currency) {
      if (!Number.isFinite(cost) || cost <= 0) return (currency || '¥') + '0'
      var digits
      if (cost >= 1000) digits = 0
      else if (cost >= 1) digits = 2
      else if (cost >= 0.01) digits = 4
      else digits = 6
      var s = cost.toFixed(digits)
      if (s.indexOf('.') >= 0) {
        s = s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
      }
      return (currency || '¥') + s
    }

    /** 价格显示：自适应精度 + 去尾零（每 1M token）。 */
    function formatPrice(n, currency) {
      var sym = currency || '¥'
      if (!Number.isFinite(n)) return sym + '—'
      var digits = n >= 100 ? 2 : n >= 1 ? 3 : n >= 0.1 ? 3 : 4
      var s = n.toFixed(digits)
      if (s.indexOf('.') >= 0) s = s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
      return sym + s
    }

    /** 多币种费用 map → "¥0.0042 + $0.0001"（按金额降序）。 */
    function formatCosts(costs, fallbackCurrency) {
      var entries = Object.entries(costs || {}).filter(function (e) { return Number(e[1]) > 0 })
      entries.sort(function (a, b) { return b[1] - a[1] })
      if (entries.length === 0) return formatCost(0, fallbackCurrency)
      return entries.map(function (e) { return formatCost(e[1], e[0]) }).join(' + ')
    }

    function formatTokens(n) {
      if (!Number.isFinite(n) || n <= 0) return '0'
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(Math.round(n))
    }

    /** 分钟 → "HH:MM"（分钟数可能是 540 → "9:00"，720 → "12:00"）。 */
    function toHHMM(mins) {
      if (typeof mins !== 'number' || !Number.isFinite(mins)) return String(mins ?? '')
      var total = Math.floor(mins)
      var hh = Math.floor(total / 60)
      var mm = total % 60
      return hh + ':' + (mm < 10 ? '0' : '') + mm
    }

    /* ------------------------------------------------------------------ */
    /* 实时费用行（conversation.composer.dock）                            */
    /* ------------------------------------------------------------------ */

    var LINE_STYLE = {
      boxSizing: 'border-box',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '12px',
      fontVariantNumeric: 'tabular-nums',
      lineHeight: '20px',
      margin: '0 auto',
      maxWidth: 'var(--dsh-chat-content-width)',
      overflow: 'hidden',
      padding: '0 var(--dsh-composer-side-clearance)',
      textAlign: 'center',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      width: '100%',
    }

    /** tooltip：按模型的费用明细 + 计费来源。 */
    function tooltipText(view) {
      var lines = ['会话合计 ' + formatCosts(view.totals.costs, view.currency) + ' · ' + view.totals.calls + ' 次调用']
      for (var i = 0; i < view.perModel.length; i++) {
        var m = view.perModel[i]
        lines.push(
          m.model + ' ×' + m.calls + ' · ' + formatCost(m.cost, m.currency)
          + '（' + formatTokens(m.uncachedInputTokens) + ' in / ' + formatTokens(m.outputTokens) + ' out）',
        )
      }
      lines.push('输入 ' + formatTokens(view.totals.uncachedInputTokens) + ' · 输出 ' + formatTokens(view.totals.outputTokens))
      if (view.totals.cacheReadTokens > 0 || view.totals.cacheWriteTokens > 0) {
        lines.push('缓存读 ' + formatTokens(view.totals.cacheReadTokens) + ' · 缓存写 ' + formatTokens(view.totals.cacheWriteTokens))
      }
      if (view.totals.estimatedSteps > 0) {
        lines.push('（含 ' + view.totals.estimatedSteps + ' 条估算步骤，收到精确用量后自动修正）')
      }
      if (view.billing) {
        var src = { builtin: '内置表', deepseek: 'DeepSeek 官网', 'custom-json': '自定义 JSON' }[view.billing.source] || view.billing.source
        lines.push('价格来源：' + src)
        if (view.billing.peakBilling) {
          var win = (view.billing.windows || [])
            .map(function (w) { return toHHMM(w[0]) + '-' + toHHMM(w[1]) })
            .join(' / ')
          lines.push('高峰/错峰：' + (view.billing.peakActive ? '当前高峰' : '当前错峰') + '（窗口 ' + win + '）')
        }
      }
      return lines.join('\n')
    }

    /** 从模型选择器读取当前选中的模型显示名（如 "deepseek-v4-pro" 或 "DeepSeek-V4-Pro"）。 */
    function readSelectedModel() {
      var btn = document.querySelector('button[aria-label^="选择模型"]')
      var aria = btn ? btn.getAttribute('aria-label') || '' : ''
      var m = /当前(?:\s*模型)?\s*([^，,]+)/.exec(aria)
      if (m === null) return ''
      // 剥离可能的「模型」前缀（aria 可能是「当前模型 DeepSeek-V4-Pro」）
      var name = m[1].trim().replace(/^模型\s*/, '')
      return name
    }

    /** 模型名归一化（小写、去空格/连字符等非字母数字），用于显示名 ↔ 价格表键匹配。 */
    function normalizeModel(name) {
      return String(name).toLowerCase().replace(/[^a-z0-9]/g, '')
    }

    /** 显示名 → 价格表条目（归一化后相等或互相包含即命中）。 */
    function findPrice(modelLabel, prices) {
      if (!modelLabel || !prices || prices.length === 0) return null
      var label = normalizeModel(modelLabel)
      for (var i = 0; i < prices.length; i++) {
        var key = normalizeModel(prices[i].model)
        if (label === key || label.indexOf(key) >= 0 || key.indexOf(label) >= 0) return prices[i]
      }
      return null
    }

    /** 组装一行费用文本（分段渲染：费用强调、token 常规、本轮次强调、当前模型单价、高峰/空闲徽标）。 */
    function CostLine(props) {
      var view = props.useProjection('tokenBilling')
      var [selectedModel, setSelectedModel] = useState('')
      // 轮询模型选择器（1s），切换模型时价格实时刷新
      useEffect(function () {
        var read = function () {
          setSelectedModel(function (prev) {
            var next = readSelectedModel()
            return next === prev ? prev : next
          })
        }
        read()
        var timer = setInterval(read, 1000)
        return function () { clearInterval(timer) }
      }, [])
      if (view === null || view === undefined) return null
      var nodes = []
      nodes.push(h('span', {
        key: 'cost',
        style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 600 },
      }, '💸 ' + formatCosts(view.totals.costs, view.currency)))
      nodes.push(h('span', { key: 'sep1', style: { margin: '0 8px', color: 'var(--dsw-alias-border-l2)' } }, '·'))
      nodes.push(h('span', { key: 'tokens' },
        formatTokens(view.totals.uncachedInputTokens) + ' in / ' + formatTokens(view.totals.outputTokens) + ' out'))
      if (view.turn.steps > 0 || view.active !== null) {
        nodes.push(h('span', { key: 'sep2', style: { margin: '0 8px', color: 'var(--dsw-alias-border-l2)' } }, '·'))
        nodes.push(h('span', {
          key: 'turn',
          style: {
            color: view.turn.estimated ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-secondary)',
            fontStyle: view.turn.estimated ? 'italic' : 'normal',
          },
        }, (view.turn.estimated ? '本轮≈' : '本轮') + ' ' + formatCosts(view.turn.costs, view.currency)))
      }
      // 当前模型 + 当前生效单价（随切换实时刷新）
      var current = findPrice(selectedModel, view.prices)
      if (current) {
        nodes.push(h('span', { key: 'sep4', style: { margin: '0 8px', color: 'var(--dsw-alias-border-l2)' } }, '·'))
        nodes.push(h('span', { key: 'current', style: { color: 'var(--dsw-alias-label-secondary)' } },
          current.model + ' ' + formatCost(current.output, current.currency) + '/M'))
      }
      if (view.billing && view.billing.peakBilling) {
        nodes.push(h('span', { key: 'sep3', style: { margin: '0 8px', color: 'var(--dsw-alias-border-l2)' } }, '·'))
        nodes.push(h('span', {
          key: 'phase',
          style: {
            color: view.billing.peakActive ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)',
            fontWeight: 500,
          },
        }, '● ' + (view.billing.peakActive ? '高峰' : '空闲')))
      }
      return h(
        'div',
        { style: LINE_STYLE, title: tooltipText(view), 'data-token-billing': '' },
        nodes,
      )
    }

    var CostLineDockEntry = memo(function CostLineDockEntry(props) {
      return h(CostLine, { useProjection: props.useProjection })
    })

    /* ------------------------------------------------------------------ */
    /* 设置卡片（web-ui.plugin.item）                                      */
    /* ------------------------------------------------------------------ */

    /* 与家族插件设置卡（PluginSettingsCard / settings-card.module.css）同款样式。 */
    var CARD_CSS = {
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-3)',
        borderRadius: '12px',
        listStyle: 'none',
        transition: 'border-color 0.16s, background 0.16s',
        margin: 0,
        padding: 0,
      },
      cardOpen: {
        background: 'var(--dsw-alias-bg-layer-2)',
        borderColor: 'var(--dsw-alias-label-dimmed)',
      },
      header: {
        appearance: 'none',
        width: '100%',
        font: 'inherit',
        color: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        background: 'transparent',
        border: 0,
        borderRadius: '12px',
        alignItems: 'center',
        gap: '12px',
        padding: '14px 16px',
        display: 'flex',
      },
      headText: { flexDirection: 'column', flex: 1, gap: '4px', minWidth: 0, display: 'flex' },
      name: { color: 'var(--dsw-alias-label-primary)', fontSize: '15px', fontWeight: 600, lineHeight: 1.4 },
      description: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px', lineHeight: 1.5 },
      pending: {
        whiteSpace: 'nowrap',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: '999px',
        flex: 'none',
        padding: '1px 8px',
        fontSize: '11px',
        fontWeight: 500,
        lineHeight: '17px',
      },
      chevron: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none', transition: 'transform 0.16s' },
      body: { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', paddingBottom: '8px' },
      note: { color: 'var(--dsw-alias-label-tertiary)', margin: '12px 0 0', fontSize: '12px', lineHeight: 1.5 },
      section: {
        color: 'var(--dsw-alias-label-secondary)',
        margin: '16px 0 4px',
        fontSize: '12px',
        fontWeight: 600,
        lineHeight: 1.5,
        borderLeft: '2px solid var(--dsw-alias-brand-primary)',
        paddingLeft: '8px',
      },
      field: { flexDirection: 'column', gap: '6px', padding: '12px 0', display: 'flex' },
      fieldSep: { borderTop: '1px solid var(--dsw-alias-border-l2)' },
      fieldHead: { alignItems: 'center', gap: '8px', display: 'flex' },
      label: { minWidth: 0, color: 'var(--dsw-alias-label-primary)', flex: 1, fontSize: '13px', fontWeight: 500, lineHeight: 1.5 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-3)',
        height: '34px',
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '0 12px',
        fontSize: '13px',
        lineHeight: 1.5,
        boxSizing: 'border-box',
        width: '100%',
      },
      textarea: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-3)',
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '8px 12px',
        fontSize: '13px',
        lineHeight: 1.5,
        boxSizing: 'border-box',
        width: '100%',
        fontFamily: 'monospace',
      },
      hint: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: '12px', lineHeight: 1.5 },
      invalid: { color: 'var(--dsw-alias-label-error)', margin: 0, fontSize: '12px', lineHeight: 1.5 },
      footer: {
        borderTop: '1px solid var(--dsw-alias-border-l2)',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: '8px',
        padding: '12px 0 4px',
        display: 'flex',
      },
      save: {
        appearance: 'none',
        font: 'inherit',
        cursor: 'pointer',
        border: '1px solid transparent',
        borderRadius: '8px',
        padding: '5px 14px',
        fontSize: '13px',
        lineHeight: 1.5,
        background: 'var(--dsw-alias-label-primary)',
        color: 'var(--dsw-alias-bg-layer-3)',
      },
      discard: {
        appearance: 'none',
        font: 'inherit',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        padding: '5px 14px',
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
      },
      disabled: { opacity: 0.4, cursor: 'default' },
    }

    /** 字段定义：key 与命名空间一致；section 分组；defaultBool 仅 bool 字段。 */
    var FIELDS = [
      { key: 'enabled', label: '启用实时计费', type: 'bool', defaultBool: true, section: '基础' },
      { key: 'currency', label: '默认货币符号', type: 'text', section: '基础', hint: '目标计费货币；官网 DeepSeek 人民币价直接使用，其他外币价按下方汇率折算' },
      { key: 'fallbackInput', label: '未知模型 · 输入价', type: 'number', section: '基础', hint: '每 1M token（下同）' },
      { key: 'fallbackOutput', label: '未知模型 · 输出价', type: 'number', section: '基础' },
      { key: 'fallbackCacheRead', label: '未知模型 · 缓存读价', type: 'number', section: '基础' },
      { key: 'fallbackCacheWrite', label: '未知模型 · 缓存写价', type: 'number', section: '基础' },
      {
        key: 'prices', label: '模型价格覆盖', type: 'textarea', section: '基础',
        hint: 'JSON：{ "模型id": {"input":2,"output":8,"cacheRead":0.5,"cacheWrite":2, "currency":"¥"} }；优先级最高，不参与高峰/错峰',
      },
      {
        key: 'priceSource', label: '价格来源', type: 'select', section: '价格来源',
        options: [
          { value: 'deepseek', label: 'DeepSeek 官网（中文页·人民币，自动抓取）' },
          { value: 'custom-json', label: '自定义 JSON 端点' },
          { value: 'builtin', label: '仅内置表' },
        ],
        hint: '官网抓取 > 内置表；抓取失败自动回退内置表。价格表按刷新间隔自动跟随官网更新',
      },
      { key: 'customPriceUrl', label: '自定义价格 URL', type: 'text', section: '价格来源', hint: '返回 { "模型id": {"input":..,"output":..,"cacheRead":..,"cacheWrite":..} } 或 { "currency":"CNY", "models":{...} }' },
      { key: 'refreshHours', label: '自动刷新间隔（小时）', type: 'number', section: '价格来源', hint: '默认 1 小时：后台周期检查并重抓官网价格，跟随官方调整' },
      {
        key: 'offPeakEnabled', label: '启用高峰/错峰计费', type: 'bool', defaultBool: true, section: '高峰/错峰',
        hint: 'DeepSeek 官方：高峰为北京时间 09:00-12:00 与 14:00-18:00，其余为空闲时段（半价）；窗口自动跟随官网解析',
      },
      { key: 'offPeakWindows', label: '高峰窗口（JSON）', type: 'text', section: '高峰/错峰', hint: '留空跟随官网；自定义如 [["09:00","12:00"],["14:00","18:00"]]，按 offPeakTz 时区解释' },
      { key: 'offPeakRate', label: '错峰折扣率', type: 'number', section: '高峰/错峰', hint: '0~1，官方为 0.5' },
      { key: 'offPeakModels', label: '适用模型（glob）', type: 'text', section: '高峰/错峰', hint: 'deepseek-* 等，逗号分隔' },
      { key: 'offPeakTz', label: '窗口时区', type: 'text', section: '高峰/错峰', hint: '跟随官网为 Asia/Shanghai（北京时间）；自定义时生效' },
      { key: 'offPeakForce', label: '忽略生效日期', type: 'bool', defaultBool: false, section: '高峰/错峰', hint: '官方新计费自北京时间 2026-08-17 00:00 生效；勾选后立即启用峰谷价' },
      { key: 'fxEnabled', label: '外币自动折算人民币', type: 'bool', defaultBool: true, section: '汇率折算', hint: '官网人民币价直接使用；若抓取到美元价则按下方汇率折算' },
      { key: 'fxRate', label: '汇率（1 外币 = N 元）', type: 'number', section: '汇率折算', hint: '默认 1 USD = 7.2 CNY，仅对外币价生效' },
    ]

    /** 选项卡元数据：id → { 图标, 描述 }。切换时先渲染描述，字段实时刷新。 */
    var SECTIONS = ['基础', '价格来源', '汇率折算', '高峰/错峰', '状态']
    var SECTION_META = {
      '基础': { icon: '⚙️', desc: '基础计费开关与默认费率', badge: function (d) { return null } },
      '价格来源': { icon: '📡', desc: '价格从哪抓取、多久自动跟随官网更新', badge: function (d) { return d.priceSource === 'custom-json' ? '自定义' : d.priceSource === 'deepseek' ? '官网' : '内置' } },
      '汇率折算': { icon: '💱', desc: '外币（美元等）自动折算成人民币计费', badge: function (d) { return d.fxEnabled ? '开' : '关' } },
      '高峰/错峰': { icon: '⏱️', desc: 'DeepSeek 官方高峰/错峰计费（峰值半价）', badge: function (d) { return d.offPeakEnabled ? '开' : '关' } },
      '状态': { icon: '📊', desc: '价格抓取状态与当前生效单价（实时刷新）', badge: function () { return null } },
    }

    /** 布尔字段的默认值（schema 默认一致）。 */
    function boolDefault(f) {
      return f.defaultBool !== false
    }

    /** 当前值（含默认）中的布尔取值。 */
    function boolCurrent(f, raw) {
      return raw === undefined ? boolDefault(f) : raw === true
    }

    /** 把 resolved value 转成可编辑草稿（数字转字符串，便于输入框编辑）。 */
    function valueToDraft(value) {
      var draft = {}
      for (var i = 0; i < FIELDS.length; i++) {
        var f = FIELDS[i]
        var raw = value === undefined ? undefined : value[f.key]
        if (f.type === 'bool') draft[f.key] = boolCurrent(f, raw)
        else if (f.type === 'number') draft[f.key] = raw === undefined ? '' : String(raw)
        else draft[f.key] = raw === undefined ? '' : String(raw)
      }
      return draft
    }

    /** 草稿是否与当前值一致（按字段逐一比较）。 */
    function dirtyFields(value, draft) {
      var dirty = []
      for (var i = 0; i < FIELDS.length; i++) {
        var f = FIELDS[i]
        var raw = value === undefined ? undefined : value[f.key]
        if (f.type === 'bool') {
          if (boolCurrent(f, raw) !== draft[f.key]) dirty.push(f.key)
        } else {
          var current = raw === undefined ? '' : String(raw)
          if (current !== draft[f.key]) dirty.push(f.key)
        }
      }
      return dirty
    }

    function validateDraft(draft) {
      var errors = []
      for (var i = 0; i < FIELDS.length; i++) {
        var f = FIELDS[i]
        if (f.type === 'number' && draft[f.key] !== '') {
          var n = Number(draft[f.key])
          if (!Number.isFinite(n) || n < 0) errors.push(f.label + ' 需要 ≥ 0 的数字')
        }
      }
      if (draft.offPeakRate !== '') {
        var r = Number(draft.offPeakRate)
        if (!Number.isFinite(r) || r < 0 || r > 1) errors.push('错峰折扣率需要 0~1 之间的数字')
      }
      var prices = draft.prices.trim()
      if (prices !== '' && prices !== '{}') {
        try {
          var parsed = JSON.parse(prices)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) errors.push('模型价格覆盖必须是对象')
        } catch (e) { errors.push('模型价格覆盖不是合法 JSON') }
      }
      var windows = draft.offPeakWindows.trim()
      if (windows !== '') {
        try {
          var w = JSON.parse(windows)
          if (!Array.isArray(w)) errors.push('高峰窗口必须是二维数组')
        } catch (e) { errors.push('高峰窗口不是合法 JSON') }
      }
      if (draft.priceSource === 'custom-json' && draft.customPriceUrl.trim() === '') {
        errors.push('选择自定义 JSON 端点时需填写 URL')
      }
      return errors
    }

    /** 价格状态显示（来自宿主路由），渲染为浅色信息面板。 */
    function PriceStatus(props) {
      var status = props.status
      if (status === null) return null
      var panel = {
        background: 'var(--dsw-alias-bg-module-platform)',
        borderRadius: '8px',
        padding: '10px 12px',
        margin: '8px 0 0',
        fontSize: '12px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
      }
      if (status.ok === false) {
        return h('div', { style: Object.assign({}, panel, { color: 'var(--dsw-alias-state-error-primary)' }) },
          '价格抓取：' + (status.error || '失败'))
      }
      var src = { builtin: '内置表', deepseek: 'DeepSeek 官网', 'custom-json': '自定义 JSON' }[status.source] || status.source
      var when = status.fetchedAt ? new Date(status.fetchedAt).toLocaleString() : '尚未抓取'
      var lines = ['来源 ' + src + ' · 更新于 ' + when]
      if (status.flatModels !== undefined) lines.push('覆盖 ' + status.flatModels + ' 个模型')
      if (status.peak) {
        var win = (status.peak.windows || []).map(function (w) { return w.join('-') }).join(' / ')
        lines.push('高峰/错峰已启用（' + win + '）')
        if (status.peak.effectiveAt) lines.push('生效于 ' + new Date(status.peak.effectiveAt).toLocaleString())
      }
      return h('div', { style: panel }, lines.join(' · '))
    }

    /* ------------------------------------------------------------------ */
    /* 可视化「自定义模型与价格」编辑器（读写 prices JSON 字符串）          */
    /* ------------------------------------------------------------------ */

    /** 解析 prices JSON 字符串 → 行数组（$ 每项含 input/output/cacheRead/cacheWrite/currency）。 */
    function parsePricesRows(value) {
      var text = String(value == null ? '' : value).trim()
      if (text === '' || text === '{}') return { rows: [], ok: true, error: null }
      var obj
      try {
        obj = JSON.parse(text)
      } catch (err) {
        return { rows: null, ok: false, error: 'JSON 解析失败：' + err.message }
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        return { rows: null, ok: false, error: '需为 { "模型id": { "input":..., "output":..., "cacheRead":..., "cacheWrite":..., "currency":"¥" } } 对象' }
      }
      var rows = Object.keys(obj).map(function (id) {
        var e = obj[id] || {}
        return {
          id: id,
          input: e.input === undefined ? '' : String(e.input),
          output: e.output === undefined ? '' : String(e.output),
          cacheRead: e.cacheRead === undefined ? '' : String(e.cacheRead),
          cacheWrite: e.cacheWrite === undefined ? '' : String(e.cacheWrite),
          currency: e.currency === undefined ? '¥' : String(e.currency),
        }
      })
      return { rows: rows, ok: true, error: null }
    }

    /** 行数组 → prices JSON 字符串（模型名留空/非法价自动剔除）。 */
    function serializePricesRows(rows) {
      var obj = {}
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i]
        var id = String(r.id == null ? '' : r.id).trim()
        if (id === '') continue
        var e = {}
        var keys = ['input', 'output', 'cacheRead', 'cacheWrite']
        for (var k = 0; k < keys.length; k++) {
          var key = keys[k]
          var v = String(r[key] == null ? '' : r[key]).trim()
          if (v === '') continue
          var n = Number(v)
          if (Number.isFinite(n) && n >= 0) e[key] = n
        }
        var cur = String(r.currency == null ? '¥' : r.currency).trim()
        if (cur !== '' && cur !== '¥') e.currency = cur
        obj[id] = e
      }
      return Object.keys(obj).length > 0 ? JSON.stringify(obj) : '{}'
    }

    /** 校验单行：可选；返回 { input, output, cacheRead, cacheWrite, currency } 的规范化草稿。 */
    function emptyPriceRow() {
      return { id: '', input: '', output: '', cacheRead: '', cacheWrite: '', currency: '¥' }
    }

    /**
     * 可视化模型价格编辑器（半受控）。
     * @param props.value - prices JSON 字符串（来自 draft，外部权威值）。
     * @param props.onChange - (newJsonString) => void。
     *
     * 以本地 rows 数组为编辑源（保留用户正在输入但尚不完整的空白行/半值），
     * 仅当外部 value 与「上次本组件 emit 的值」不一致时才回灌 rows —— 这样
     * 用户逐格输入不会因序列化-回解析而丢空白行或跳动光标。
     */
    function ModelPriceEditor(props) {
      var value = props.value
      var disabled = props.disabled
      var [rows, setRows] = useState(function () {
        var p = parsePricesRows(value)
        return p.ok ? p.rows : []
      })
      var lastEmitted = useRef(null)
      var [error, setError] = useState(null)

      // 外部 value 变更（非本组件 emit）→ 回灌本地 rows（如保存/放弃后的重置）。
      useEffect(function () {
        if (value === lastEmitted.current) return
        var p = parsePricesRows(value)
        if (p.ok) { setRows(p.rows); setError(null) }
        else setError(p.error || null)
      }, [value])

      function emit(nextRows) {
        var json = serializePricesRows(nextRows)
        lastEmitted.current = json
        setRows(nextRows)
        setError(null)
        props.onChange(json)
      }
      function updateRow(index, field, next) {
        var copy = rows.map(function (r) { return Object.assign({}, r) })
        copy[index][field] = next
        emit(copy)
      }
      function addRow() {
        emit(rows.concat([emptyPriceRow()]))
      }
      function removeRow(index) {
        var copy = rows.map(function (r) { return Object.assign({}, r) })
        copy.splice(index, 1)
        emit(copy)
      }

      var E = {
        table: {
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          marginTop: '8px',
        },
        row: {
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr .6fr auto',
          gap: '8px',
          alignItems: 'center',
        },
        head: Object.assign({}, CARD_CSS.hint, { margin: '4px 0 -2px' }),
        input: Object.assign({}, CARD_CSS.input, { width: '100%', padding: '0 10px', height: '32px', fontSize: '12px' }),
        del: {
          appearance: 'none',
          font: 'inherit',
          cursor: 'pointer',
          border: 'none',
          background: 'transparent',
          color: 'var(--dsw-alias-state-error-primary)',
          padding: '4px 6px',
          fontSize: '15px',
          lineHeight: 1,
          borderRadius: '6px',
        },
        add: Object.assign({}, CARD_CSS.discard, { flexShrink: 0 }),
      }

      var headerCells = ['模型 ID', '输入价', '输出价', '缓存读', '缓存写', '币种', '']
      var head = h('div', { style: Object.assign({}, E.row, { gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr .6fr auto', marginBottom: '2px' }) },
        headerCells.map(function (c, i) {
          return h('span', { key: i, style: Object.assign({}, CARD_CSS.hint, { textAlign: 'left' }) }, c)
        }),
      )

      var rowEls = rows.map(function (r, i) {
        var fields = [
          { key: 'id', type: 'text', ph: '如 glm-5.1' },
          { key: 'input', type: 'number', ph: '2' },
          { key: 'output', type: 'number', ph: '8' },
          { key: 'cacheRead', type: 'number', ph: '0.5' },
          { key: 'cacheWrite', type: 'number', ph: '2' },
          { key: 'currency', type: 'text', ph: '¥' },
        ]
        var cells = fields.map(function (f, j) {
          return h('input', {
            key: j,
            type: 'text',
            inputMode: f.type === 'number' ? 'decimal' : undefined,
            value: String(r[f.key] == null ? '' : r[f.key]),
            disabled: disabled,
            placeholder: f.ph,
            style: E.input,
            onChange: (function (idx, field) {
              return function (ev) { updateRow(idx, field, ev.target.value) }
            })(i, f.key),
          })
        })
        cells.push(h('button', {
          key: 'del',
          type: 'button',
          style: E.del,
          disabled: disabled,
          onClick: (function (idx) { return function () { removeRow(idx) } })(i),
          title: '删除该模型',
        }, '✕'))
        return h('div', { key: i, style: E.row }, cells)
      })

      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
          h('span', { style: CARD_CSS.hint }, '优先级最高 · 不参与高峰/错峰 · 每 1M token'),
          h('button', {
            type: 'button',
            style: E.add,
            disabled: disabled,
            onClick: addRow,
          }, '+ 添加模型'),
        ),
        head,
        rowEls,
        error ? h('p', { style: Object.assign({}, CARD_CSS.invalid, { marginTop: '6px' }) }, error) : null,
        rows.length === 0 && !error ? h('p', { style: Object.assign({}, CARD_CSS.hint, { marginTop: '8px' }) }, '尚未自定义任何模型。点击「+ 添加模型」开始。') : null,
      )
    }

    function BillingSettingsCard(props) {
      var scope = props.scope
      var snapshot = useSyncExternalStore(
        function (listener) { return scope.subscribe(listener) },
        function () { return scope.getSnapshot() },
      )
      var value = snapshot.value
      var ready = snapshot.status === 'ready'
      var writable = snapshot.writable === true
      var [open, setOpen] = useState(true)
      var [activeSection, setActiveSection] = useState(SECTIONS[0])
      var [draft, setDraft] = useState(function () { return valueToDraft(value) })
      var touchedRef = useRef({})
      var [saving, setSaving] = useState(false)
      var [error, setError] = useState('')
      var [saved, setSaved] = useState(false)
      var [status, setStatus] = useState(null)
      var [refreshing, setRefreshing] = useState(false)

      // 实时跟随最新设置：未手动编辑过的字段总是用最新 value；被用户手动改过的字段
      // 保留草稿（touched），直至保存或放弃。这样切换选项卡/外部更新时，未编辑项即时刷成最新值。
      useEffect(function () {
        if (!ready) return
        var t = touchedRef.current
        setDraft(function (prev) {
          var next = Object.assign({}, prev)
          var changed = false
          for (var i = 0; i < FIELDS.length; i++) {
            var f = FIELDS[i]
            var raw = value === undefined ? undefined : value[f.key]
            var resolved
            if (f.type === 'bool') resolved = boolCurrent(f, raw)
            else resolved = raw === undefined ? '' : String(raw)
            if (t[f.key]) {
              if (next[f.key] === undefined) { next[f.key] = resolved; changed = true }
              continue
            }
            if (next[f.key] !== resolved) { next[f.key] = resolved; changed = true }
          }
          return changed ? next : prev
        })
      }, [ready, value])

      // 查询价格状态（GET，不强制抓取）
      function loadPriceStatus() {
        return fetch('/token-billing/prices', { headers: { accept: 'application/json' } })
          .then(function (res) { return res.json() })
          .then(function (data) { setStatus(data); return data })
          .catch(function () { /* 路由不可用（headless）则静默 */ })
      }
      // 初次进入：查询价格状态
      useEffect(function () {
        loadPriceStatus()
      }, [])
      // 切换到「状态」选项卡时实时刷新状态与当前生效单价（模型/时段变化后打开即刻更新）
      useEffect(function () {
        if (activeSection !== '状态') return
        loadPriceStatus()
      }, [activeSection])

      function onRefresh() {
        setRefreshing(true)
        setError('')
        fetch('/token-billing/refresh', { method: 'POST', headers: { accept: 'application/json' } })
          .then(function (res) { return res.json() })
          .then(function (data) { setStatus(data) })
          .catch(function (err) { setError('刷新失败：' + err.message) })
          .finally(function () { setRefreshing(false) })
      }

      var dirty = dirtyFields(value, draft).length > 0
      var errors = validateDraft(draft)

      function setField(key, next) {
        setSaved(false)
        setError('')
        touchedRef.current[key] = true
        setDraft(function (prev) {
          var copy = {}
          for (var k in prev) copy[k] = prev[k]
          copy[key] = next
          return copy
        })
      }

      function onSave() {
        if (!writable || errors.length > 0) return
        setSaving(true)
        setError('')
        setSaved(false)
        // 整段提交（缺省字段回退默认值）；经宿主 /token-billing/config/save 写入 settings 文档
        var section = {}
        for (var i = 0; i < FIELDS.length; i++) {
          var f = FIELDS[i]
          var next
          if (f.type === 'bool') next = draft[f.key]
          else if (f.type === 'number') next = draft[f.key] === '' ? undefined : Number(draft[f.key])
          else next = draft[f.key]
          // 空字符串/undefined 一律不写入用户层，回退到默认值（避免把空串持久化）
          if (next === undefined || next === '') continue
          section[f.key] = next
        }
        scope.save(section)
          .then(function () { touchedRef.current = {}; setSaved(true) })
          .catch(function (err) { setError('保存失败：' + (err && err.message ? err.message : String(err))) })
          .finally(function () { setSaving(false) })
      }

      function onDiscard() {
        setError('')
        setSaved(false)
        touchedRef.current = {}
        setDraft(valueToDraft(value))
      }

      // 横向选项卡（优雅两段式：图标+标题 / 描述），活动态用主色下划线与浅色底
      var TABS_STYLE = {
        display: 'flex',
        gap: '6px',
        flexWrap: 'wrap',
        padding: '8px 0 6px',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
        marginBottom: '10px',
      }
      var TAB_BASE_STYLE = {
        appearance: 'none',
        font: 'inherit',
        cursor: 'pointer',
        border: '1px solid transparent',
        borderBottom: '2px solid transparent',
        background: 'transparent',
        padding: '7px 12px',
        borderRadius: '10px',
        lineHeight: 1.4,
        textAlign: 'left',
        color: 'var(--dsw-alias-label-tertiary)',
        transition: 'background 0.16s, color 0.16s',
      }
      var TAB_TITLE_STYLE = { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600 }
      var TAB_BADGE_STYLE = {
        flex: 'none',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: '999px',
        padding: '0 6px',
        fontSize: '10px',
        fontWeight: 500,
        lineHeight: '15px',
      }
      var TAB_DESC_STYLE = { display: 'block', marginTop: '1px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', opacity: 0.9 }
      var tabs = h('div', { key: 'tabs', style: TABS_STYLE, role: 'tablist' },
        SECTIONS.map(function (sec) {
          var active = sec === activeSection
          var meta = SECTION_META[sec] || { icon: '•', desc: '', badge: function () { return null } }
          var tabStyle = Object.assign({}, TAB_BASE_STYLE)
          var badge = null
          try { badge = meta.badge ? meta.badge(draft) : null } catch (e) { badge = null }
          if (active) {
            tabStyle.background = 'var(--dsw-alias-bg-layer-2)'
            tabStyle.color = 'var(--dsw-alias-label-primary)'
            tabStyle.borderBottomColor = 'var(--dsw-alias-brand-primary)'
          }
          return h('button', {
            key: sec,
            type: 'button',
            role: 'tab',
            'aria-selected': active,
            'aria-controls': 'token-billing-panel',
            style: tabStyle,
            onClick: (function (name) { return function () { setActiveSection(name) } })(sec),
            title: meta.desc,
          },
            h('span', { style: TAB_TITLE_STYLE },
              h('span', { 'aria-hidden': 'true' }, meta.icon),
              sec,
              badge ? h('span', { style: TAB_BADGE_STYLE }, badge) : null,
            ),
            h('span', { style: TAB_DESC_STYLE }, meta.desc),
          )
        }),
      )

      // 只渲染当前选项卡的分组字段（横向行：标签在左、控件在右，互不遮挡）
      var FIELD_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '12px' }
      var FIELD_LABEL_STYLE = Object.assign({}, CARD_CSS.label, {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      })
      var CONTROL_FIXED_STYLE = { width: '220px', flexShrink: 0 }
      var nodes = []
      var section = activeSection
      for (var i = 0; i < FIELDS.length; i++) {
        var f = FIELDS[i]
        if (f.section !== section) continue
        // 条件显示：customPriceUrl 只在 custom-json 时显示
        if (f.key === 'customPriceUrl' && draft.priceSource !== 'custom-json') continue
        var control
        if (f.type === 'bool') {
          control = h('input', {
            type: 'checkbox',
            checked: draft[f.key] === true,
            disabled: !writable,
            style: { flexShrink: 0 },
            onChange: (function (key) { return function (ev) { setField(key, ev.target.checked) } })(f.key),
          })
        } else if (f.type === 'select') {
          control = h('select', {
            value: draft[f.key],
            disabled: !writable,
            style: Object.assign({}, CARD_CSS.input, CONTROL_FIXED_STYLE),
            onChange: (function (key) { return function (ev) { setField(key, ev.target.value) } })(f.key),
          }, (f.options || []).map(function (opt) {
            return h('option', { key: opt.value, value: opt.value }, opt.label)
          }))
        } else if (f.type === 'textarea' && f.key === 'prices') {
          // 可视化「自定义模型与价格」编辑器（读写字面量 prices JSON，占整行）
          control = h('div', { style: { flex: 1, minWidth: 0, width: '100%', marginTop: '4px' } },
            h(ModelPriceEditor, {
              value: draft[f.key],
              disabled: !writable,
              onChange: (function (key) { return function (next) { setField(key, next) } })(f.key),
            }),
          )
        } else if (f.type === 'textarea') {
          control = h('textarea', {
            value: draft[f.key],
            disabled: !writable,
            placeholder: f.placeholder || '',
            rows: 3,
            style: Object.assign({}, CARD_CSS.textarea, { flex: 1, minWidth: 0 }),
            onChange: (function (key) { return function (ev) { setField(key, ev.target.value) } })(f.key),
          })
        } else {
          control = h('input', {
            type: 'text',
            inputMode: f.type === 'number' ? 'decimal' : undefined,
            value: draft[f.key],
            disabled: !writable,
            placeholder: f.placeholder || '',
            style: Object.assign({}, CARD_CSS.input, CONTROL_FIXED_STYLE),
            onChange: (function (key) { return function (ev) { setField(key, ev.target.value) } })(f.key),
          })
        }
        var children
        if (f.key === 'prices') {
          // 自定义模型编辑器：标签在上、编辑器独占整行
          children = [
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' } },
              h('label', { style: Object.assign({}, FIELD_LABEL_STYLE, { flex: 1 }), title: f.label }, f.label),
            ),
            control,
          ]
        } else {
          children = [
            h('div', { style: FIELD_ROW_STYLE },
              h('label', { style: FIELD_LABEL_STYLE, title: f.label }, f.label),
              control,
            ),
          ]
        }
        if (f.hint) children.push(h('p', { style: CARD_CSS.hint }, f.hint))
        nodes.push(h('div', { key: f.key, style: Object.assign({}, CARD_CSS.field, CARD_CSS.fieldSep) }, children))
      }
      nodes.unshift(tabs)
      // 命中「状态」页：抓取状态 + 当前生效单价（实时刷新，随切换更新）
      if (section === '状态') {
        var STATE_BLOCK = Object.assign({}, CARD_CSS.field, CARD_CSS.fieldSep)
        var STATE_TABLE = {
          display: 'flex',
          flexDirection: 'column',
          marginTop: '8px',
          borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border-l2)',
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-layer-2)',
        }
        var STATE_CELL = { padding: '7px 12px', fontSize: '12px', lineHeight: 1.5 }
        var STATE_HEADER = Object.assign({}, STATE_CELL, {
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: '10px',
          paddingTop: '6px',
          paddingBottom: '6px',
          fontSize: '11px',
          color: 'var(--dsw-alias-label-tertiary)',
          background: 'var(--dsw-alias-bg-module-platform)',
        })
        var effective = (status && status.ok && status.effective) || {}
        var effNames = Object.keys(effective).sort()
        var effRows = []
        for (var ei = 0; ei < effNames.length; ei++) {
          var en = effNames[ei]
          var ep = effective[en]
          var sym = ep.currency || '¥'
          var priceText = '入 ' + formatPrice(ep.input, sym)
            + ' · 出 ' + formatPrice(ep.output, sym)
            + ' · 读 ' + formatPrice(ep.cacheRead, sym)
            + ' · 写 ' + formatPrice(ep.cacheWrite, sym)
          effRows.push(h('div', {
            key: en,
            style: Object.assign({
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: '10px',
              alignItems: 'center',
              borderTop: '1px solid var(--dsw-alias-border-l2)',
            }, STATE_CELL),
          },
            h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: en }, en),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, priceText),
          ))
        }
        if (effNames.length === 0) {
          effRows.push(h('p', { key: 'empty', style: Object.assign({}, CARD_CSS.hint, { padding: '8px 12px' }) }, '暂无价格缓存。点击「立即刷新价格」从官网抓取。'))
        }
        nodes.push(h('div', { key: 'state-refresh', style: STATE_BLOCK },
          h('div', { style: FIELD_ROW_STYLE },
            h('label', { style: FIELD_LABEL_STYLE }, '价格抓取状态'),
            h('button', {
              style: Object.assign({}, CARD_CSS.discard, refreshing || status === null ? CARD_CSS.disabled : {}, { flexShrink: 0 }),
              disabled: refreshing || status === null,
              onClick: onRefresh,
            }, refreshing ? '刷新中…' : '立即刷新价格'),
          ),
          h(PriceStatus, { status: status }),
        ))
        nodes.push(h('div', { key: 'state-effective', style: STATE_BLOCK },
          h('label', { style: Object.assign({}, CARD_CSS.label, { display: 'block', marginBottom: '4px' }) }, '当前生效单价（每 1M token）'),
          h('div', { style: STATE_TABLE },
            h('div', { style: STATE_HEADER }, h('span', {}, '模型'), h('span', {}, '输入 · 输出 · 缓存读 · 缓存写')),
            effRows,
          ),
        ))
      }

      var statusLine
      if (snapshot.status === 'unavailable') statusLine = h('p', { style: CARD_CSS.invalid }, '当前部署未暴露该设置命名空间（可能宿主插件未加载）；价格可在挂载配置（cordis.patch.yml）中填写，重启后生效。')
      else if (!ready) statusLine = h('p', { style: CARD_CSS.hint }, '读取设置中…')
      else if (!writable) statusLine = h('p', { style: CARD_CSS.hint }, '当前部署设置只读，请在挂载配置中填写。')
      else if (saved) statusLine = h('p', { style: CARD_CSS.hint }, '✓ 已保存，即时生效。')
      else if (error) statusLine = h('p', { style: CARD_CSS.invalid }, error)
      else if (errors.length > 0) statusLine = h('p', { style: CARD_CSS.invalid }, errors.join('；'))

      // 卡片 chrome（家族 PluginSettingsCard 同款结构）
      var CHEVRON_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'
      var header = h('button', {
        type: 'button',
        style: CARD_CSS.header,
        'aria-expanded': open,
        'aria-label': (open ? '收起' : '展开') + '：Token 计费',
        onClick: function () { setOpen(!open) },
      },
        h('span', { style: CARD_CSS.headText },
          h('span', { style: CARD_CSS.name, title: 'Token 计费' }, 'Token 计费'),
          h('span', { style: CARD_CSS.description, title: '实时 token 费用统计（官网人民币价 · 高峰错峰）' }, '实时 token 费用统计（官网人民币价 · 高峰错峰）'),
        ),
        dirty ? h('span', { style: CARD_CSS.pending, title: '有未保存的修改' }, '有未保存的修改') : null,
        h('svg', {
          width: '14', height: '14', viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
          style: Object.assign({}, CARD_CSS.chevron, open ? { transform: 'rotate(180deg)' } : {}),
        }, h('path', { d: CHEVRON_PATH, fill: 'currentColor' })),
      )

      var cardStyle = open ? Object.assign({}, CARD_CSS.card, CARD_CSS.cardOpen) : CARD_CSS.card
      return h('li', { style: cardStyle },
        header,
        open ? h('div', { id: 'token-billing-panel', role: 'tabpanel', style: CARD_CSS.body },
          h('p', { style: CARD_CSS.note },
            '按本次会话实际 token 用量（输入/输出/缓存）实时换算费用。默认抓取 DeepSeek 官网中文页的'
            + '人民币价格（含高峰/错峰，按北京时间窗口），价格表自动跟随官网更新（默认每小时检查）。'),
          nodes,
          statusLine,
          h('div', { style: CARD_CSS.footer },
            h('button', {
              type: 'button',
              style: Object.assign({}, CARD_CSS.discard, !dirty || saving ? CARD_CSS.disabled : {}),
              disabled: !dirty || saving,
              onClick: onDiscard,
            }, '放弃修改'),
            h('button', {
              type: 'button',
              style: Object.assign({}, CARD_CSS.save, (!writable || saving || errors.length > 0 || !dirty) ? CARD_CSS.disabled : {}),
              disabled: !writable || saving || errors.length > 0 || !dirty,
              onClick: onSave,
            }, saving ? '保存中…' : '保存'),
          ),
        ) : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* 插件入口                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * 路由式配置 scope：读写都走插件自己的宿主路由（/token-billing/config），
     * 不依赖家族 webUiSettings 白名单或官方 settings 暴露名单。
     * 接口形状与 SettingsScope 兼容（getSnapshot/subscribe/save）。
     */
    function makeConfigScope() {
      var snapshot = { status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: true, mode: 'host' }
      var listeners = new Set()
      function publish(next) {
        snapshot = next
        listeners.forEach(function (l) { l() })
        return snapshot
      }
      function refresh() {
        return fetch('/token-billing/config', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (data) {
            if (data && data.ok) {
              return publish({
                status: 'ready',
                value: data.value,
                base: data.base,
                user: data.user,
                revision: data.revision,
                writable: data.writable !== false,
                mode: 'host',
              })
            }
            return publish({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' })
          })
          .catch(function () {
            return publish({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' })
          })
      }
      return {
        getSnapshot: function () { return snapshot },
        subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener) } },
        refresh: refresh,
        save: function (section) {
          return fetch('/token-billing/config/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ section: section, expectedRevision: snapshot.revision }),
          })
            .then(function (r) { return r.json() })
            .then(function (data) {
              if (!data || !data.ok) throw new Error((data && data.error) || '保存失败')
              return refresh()
            })
        },
      }
    }

    function apply(ctx) {
      var scope = makeConfigScope()
      scope.refresh()

      ctx.slots.inject('web-ui.plugin.item', function () {
        return ctx.slots.register({
          name: 'web-ui.plugin.item',
          id: 'token-billing',
          order: 120,
          locale: 'token-billing',
          inject: function () { return { scope: scope } },
        }, BillingSettingsCard)
      })

      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'token-billing',
          order: 101,
          inject: function () { return {} },
        }, CostLineDockEntry)
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
