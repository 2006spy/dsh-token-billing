/**
 * CODING_PLAN_PRICING — 随包分发的 provider 官方美元价表（$ / 1M tokens）。
 *
 * ⚠️ **生成物，勿手改**。由 `node scripts/sync-coding-plans.mjs` 从本机 DeepSeek Harness
 * 内置/打包的 `@earendil-works/pi-ai` catalog 生成；DSH 升级后重跑该脚本即可同步。
 *
 * 数据源：asar — resources/app.asar!/node_modules/@earendil-works/pi-ai/dist/providers/data
 * pi-ai 版本：0.85.1
 * catalog generatedAt：2026-09-05T11:58:56.761Z
 * catalog schemaVersion：3
 * catalog structureHash：ff87cfcb3c1decb7ceeb4a5d71282696e108d093b7098f372d6f8a442dfed40d
 * 生成时间：2026-09-11T15:12:03.819Z
 *
 * 覆盖范围：9 个 provider（coding plan 平台量价 + 订阅 token 包）。
 * **不含 first-party `deepseek`** —— 见下方裁决说明。
 *
 * 语义：
 * - kind "coding"       平台公开的官方量价（$ / 1M tokens）。
 * - kind "subscription" 订阅制 token 包。**本表仍如实保留 catalog 里的挂牌价，不在此处抹 0** ——
 *   订阅用户的「实际花费归零」由 providerModes 配置（{"<provider>":"subscription"}）在结算层完成；
 *   抹 0 会让名义价值 / 回本无法计算。（zai-coding-cn 在本机 catalog 里带真实挂牌价，即按此处理。）
 * - 人民币展示价 = usd × 配置 fxRate（fxEnabled 时由折算层完成，见 lib/projection.js convertEntry）。
 * - 用户 `prices` 覆盖与 provider 级单价仍优先于此表（见 lib/projection.js priceAt 的优先级）。
 *
 * ⚠️ **裁决：不收录 first-party `deepseek` 快照**（t7 评审 F1 / 队长裁决：发布前必须处理）
 * - DeepSeek 官方模型由**时间感知的官方价格政策链权威定价**：
 *   `lib/projection.js` 的 `PRICE_POLICY_TIMELINE` + `BUILTIN_PRICES` / `BUILTIN_PEAK_PRICES`
 *   （2026-08-17 峰谷起点 / 2026-08-23 周末空闲 / 2026-09-10 12:00 flash 调价）。
 * - pi-ai catalog 的 `deepseek.json` 是 **pre-2026-08-17 的静态快照（USD）**：时间无关、
 *   不知道任何一次调价、cacheWrite 记为 0，且完全不参与峰谷 —— 它**没有资格**按 priceAt 的
 *   「provider 表优先」语义盖住政策链。故生成器**排除该 provider**。
 * - 逃生口保留：用户经设置卡「按路由」编辑器 / `providerPriceUrls` 显式写入的 provider 价
 *   仍优先于政策链（用户明确意图 ≠ 快照越权）。
 */
export const CODING_PLAN_SOURCE = Object.freeze({
  "package": "@earendil-works/pi-ai",
  "version": "0.85.1",
  "catalogSource": "asar",
  "generatedAt": "2026-09-05T11:58:56.761Z",
  "structureHash": "ff87cfcb3c1decb7ceeb4a5d71282696e108d093b7098f372d6f8a442dfed40d",
  "syncedAt": "2026-09-11T15:12:03.820Z"
})

export const CODING_PLAN_PRICING = {
  "opencode-go": {
    "label": "OpenCode GO",
    "kind": "coding",
    "models": {
      "deepseek-v4-flash": {
        "input": 0.22,
        "output": 0.66,
        "cacheRead": 0.007,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-flash-vision-exp": {
        "input": 0.22,
        "output": 0.66,
        "cacheRead": 0.007,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-pro": {
        "input": 0.66,
        "output": 1.98,
        "cacheRead": 0.022,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.1": {
        "input": 1.4,
        "output": 4.4,
        "cacheRead": 0.26,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.2": {
        "input": 1.4,
        "output": 4.4,
        "cacheRead": 0.26,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.3": {
        "input": 1.4,
        "output": 4.4,
        "cacheRead": 0.26,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.3-flash": {
        "input": 0.075,
        "output": 0.25,
        "cacheRead": 0.015,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.6-luna": {
        "input": 0.2,
        "output": 1.2,
        "cacheRead": 0.02,
        "cacheWrite": 0.25,
        "currency": "USD"
      },
      "grok-4.6": {
        "input": 2,
        "output": 6,
        "cacheRead": 0.5,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "hy3": {
        "input": 0.14,
        "output": 0.58,
        "cacheRead": 0.035,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "hy4-preview": {
        "input": 0.834,
        "output": 2.501,
        "cacheRead": 0.042,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k2.6": {
        "input": 0.95,
        "output": 4,
        "cacheRead": 0.16,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k2.7-code": {
        "input": 0.95,
        "output": 4,
        "cacheRead": 0.19,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k3": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "longcat-2.0": {
        "input": 0.3,
        "output": 1.2,
        "cacheRead": 0.006,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "mimo-v2.5": {
        "input": 0.14,
        "output": 0.28,
        "cacheRead": 0.0028,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "mimo-v2.5-pro": {
        "input": 0.435,
        "output": 0.87,
        "cacheRead": 0.003625,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "minimax-m2.7": {
        "input": 0.3,
        "output": 1.2,
        "cacheRead": 0.06,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "minimax-m3": {
        "input": 0.3,
        "output": 1.2,
        "cacheRead": 0.06,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "muse-spark-1.2-contributor": {
        "input": 0.1,
        "output": 0.2,
        "cacheRead": 0.002,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "muse-spark-1.3-contributor": {
        "input": 0.1,
        "output": 0.2,
        "cacheRead": 0.002,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "omen-alpha": {
        "input": 0.2,
        "output": 0.66,
        "cacheRead": 0.04,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.6-plus": {
        "input": 0.5,
        "output": 3,
        "cacheRead": 0.05,
        "cacheWrite": 0.625,
        "currency": "USD"
      },
      "qwen3.7-max": {
        "input": 2.5,
        "output": 7.5,
        "cacheRead": 0.5,
        "cacheWrite": 3.125,
        "currency": "USD"
      },
      "qwen3.7-plus": {
        "input": 0.4,
        "output": 1.6,
        "cacheRead": 0.04,
        "cacheWrite": 0.5,
        "currency": "USD"
      },
      "qwen3.8-flash": {
        "input": 0.15,
        "output": 0.47,
        "cacheRead": 0.016,
        "cacheWrite": 0.2,
        "currency": "USD"
      },
      "qwen3.8-max": {
        "input": 2,
        "output": 6,
        "cacheRead": 0.25,
        "cacheWrite": 2.5,
        "currency": "USD"
      }
    }
  },
  "opencode": {
    "label": "OpenCode Zen",
    "kind": "coding",
    "models": {
      "big-pickle": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "claude-fable-5": {
        "input": 10,
        "output": 50,
        "cacheRead": 1,
        "cacheWrite": 12.5,
        "currency": "USD"
      },
      "claude-fable-5-1": {
        "input": 10,
        "output": 50,
        "cacheRead": 0.25,
        "cacheWrite": 12.5,
        "currency": "USD"
      },
      "claude-haiku-4-5": {
        "input": 1,
        "output": 5,
        "cacheRead": 0.1,
        "cacheWrite": 1.25,
        "currency": "USD"
      },
      "claude-opus-4-5": {
        "input": 5,
        "output": 25,
        "cacheRead": 0.5,
        "cacheWrite": 6.25,
        "currency": "USD"
      },
      "claude-opus-4-6": {
        "input": 5,
        "output": 25,
        "cacheRead": 0.5,
        "cacheWrite": 6.25,
        "currency": "USD"
      },
      "claude-opus-4-7": {
        "input": 5,
        "output": 25,
        "cacheRead": 0.5,
        "cacheWrite": 6.25,
        "currency": "USD"
      },
      "claude-opus-4-8": {
        "input": 5,
        "output": 25,
        "cacheRead": 0.5,
        "cacheWrite": 6.25,
        "currency": "USD"
      },
      "claude-opus-5": {
        "input": 5,
        "output": 25,
        "cacheRead": 0.5,
        "cacheWrite": 6.25,
        "currency": "USD"
      },
      "claude-sonnet-4": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75,
        "currency": "USD"
      },
      "claude-sonnet-4-5": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75,
        "currency": "USD"
      },
      "claude-sonnet-4-6": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75,
        "currency": "USD"
      },
      "claude-sonnet-5": {
        "input": 2,
        "output": 10,
        "cacheRead": 0.2,
        "cacheWrite": 2.5,
        "currency": "USD"
      },
      "deepseek-v4-flash": {
        "input": 0.14,
        "output": 0.28,
        "cacheRead": 0.028,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-flash-vision-exp": {
        "input": 0.14,
        "output": 0.28,
        "cacheRead": 0.028,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-pro": {
        "input": 1.74,
        "output": 3.84,
        "cacheRead": 0.145,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gemini-3-flash": {
        "input": 0.5,
        "output": 3,
        "cacheRead": 0.05,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gemini-3.1-pro": {
        "input": 2,
        "output": 12,
        "cacheRead": 0.2,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gemini-3.5-flash": {
        "input": 1.5,
        "output": 9,
        "cacheRead": 0.15,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gemini-3.5-flash-lite": {
        "input": 0.3,
        "output": 2.5,
        "cacheRead": 0.03,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gemini-3.6-flash": {
        "input": 1.5,
        "output": 7.5,
        "cacheRead": 0.15,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gemini-3.7-flash": {
        "input": 1.5,
        "output": 7.5,
        "cacheRead": 0.15,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gemini-3.8-flash": {
        "input": 1.5,
        "output": 7.5,
        "cacheRead": 0.15,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5": {
        "input": 1,
        "output": 3.2,
        "cacheRead": 0.2,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.1": {
        "input": 1.4,
        "output": 4.4,
        "cacheRead": 0.26,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.2": {
        "input": 1.4,
        "output": 4.4,
        "cacheRead": 0.26,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.3": {
        "input": 1.4,
        "output": 4.4,
        "cacheRead": 0.26,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.3-flash": {
        "input": 0.15,
        "output": 0.5,
        "cacheRead": 0.03,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5": {
        "input": 1.07,
        "output": 8.5,
        "cacheRead": 0.107,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5-codex": {
        "input": 1.07,
        "output": 8.5,
        "cacheRead": 0.107,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5-nano": {
        "input": 0.05,
        "output": 0.4,
        "cacheRead": 0.005,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.1": {
        "input": 1.07,
        "output": 8.5,
        "cacheRead": 0.107,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.1-codex": {
        "input": 1.07,
        "output": 8.5,
        "cacheRead": 0.107,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.1-codex-max": {
        "input": 1.25,
        "output": 10,
        "cacheRead": 0.125,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.1-codex-mini": {
        "input": 0.25,
        "output": 2,
        "cacheRead": 0.025,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.2": {
        "input": 1.75,
        "output": 14,
        "cacheRead": 0.175,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.2-codex": {
        "input": 1.75,
        "output": 14,
        "cacheRead": 0.175,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.3-codex": {
        "input": 1.75,
        "output": 14,
        "cacheRead": 0.175,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.4": {
        "input": 2.5,
        "output": 15,
        "cacheRead": 0.25,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.4-mini": {
        "input": 0.75,
        "output": 4.5,
        "cacheRead": 0.075,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.4-nano": {
        "input": 0.2,
        "output": 1.25,
        "cacheRead": 0.02,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.4-pro": {
        "input": 30,
        "output": 180,
        "cacheRead": 30,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.5": {
        "input": 5,
        "output": 30,
        "cacheRead": 0.5,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.5-pro": {
        "input": 30,
        "output": 180,
        "cacheRead": 30,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "gpt-5.6-luna": {
        "input": 0.2,
        "output": 1.2,
        "cacheRead": 0.02,
        "cacheWrite": 0.25,
        "currency": "USD"
      },
      "gpt-5.6-sol": {
        "input": 2,
        "output": 10,
        "cacheRead": 0.2,
        "cacheWrite": 2.5,
        "currency": "USD"
      },
      "gpt-5.6-terra": {
        "input": 2.5,
        "output": 15,
        "cacheRead": 0.25,
        "cacheWrite": 3.125,
        "currency": "USD"
      },
      "gpt-6-astra": {
        "input": 10,
        "output": 50,
        "cacheRead": 1,
        "cacheWrite": 12.5,
        "currency": "USD"
      },
      "grok-4.5": {
        "input": 2,
        "output": 6,
        "cacheRead": 0.3,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "grok-4.6": {
        "input": 2,
        "output": 6,
        "cacheRead": 0.5,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "grok-build-0.1": {
        "input": 1,
        "output": 2,
        "cacheRead": 0.2,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k2.5": {
        "input": 0.6,
        "output": 3,
        "cacheRead": 0.08,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k2.6": {
        "input": 0.95,
        "output": 4,
        "cacheRead": 0.16,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k2.7-code": {
        "input": 0.95,
        "output": 4,
        "cacheRead": 0.19,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k3": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "ling-3.0-flash-fin-free": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "mimo-v2.5-free": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "minimax-m2.5": {
        "input": 0.3,
        "output": 1.2,
        "cacheRead": 0.06,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "minimax-m2.7": {
        "input": 0.3,
        "output": 1.2,
        "cacheRead": 0.06,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "minimax-m3": {
        "input": 0.3,
        "output": 1.2,
        "cacheRead": 0.06,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "muse-spark-1.2": {
        "input": 1.25,
        "output": 4.25,
        "cacheRead": 0.15,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "muse-spark-1.2-contributor-free": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "muse-spark-1.3": {
        "input": 1.25,
        "output": 4.25,
        "cacheRead": 0.15,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "muse-spark-1.3-contributor-free": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "nemotron-3-ultra-free": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "nemotron-3.5-lightning-free": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.5-plus": {
        "input": 0.2,
        "output": 1.2,
        "cacheRead": 0.02,
        "cacheWrite": 0.25,
        "currency": "USD"
      },
      "qwen3.6-plus": {
        "input": 0.5,
        "output": 3,
        "cacheRead": 0.05,
        "cacheWrite": 0.625,
        "currency": "USD"
      }
    }
  },
  "kimi-coding": {
    "label": "Kimi Coding",
    "kind": "coding",
    "models": {
      "k3": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "k3-256k": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-for-coding": {
        "input": 0.95,
        "output": 4,
        "cacheRead": 0.19,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-for-coding-highspeed": {
        "input": 1.9,
        "output": 8,
        "cacheRead": 0.38,
        "cacheWrite": 0,
        "currency": "USD"
      }
    }
  },
  "qwen-token-plan": {
    "label": "Qwen Token Plan",
    "kind": "subscription",
    "models": {
      "MiniMax-M2.5": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v3.2": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-flash": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-flash-0731": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-pro": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-pro-0813": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.1": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.2": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k2.5": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k2.6": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k2.7-code": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.6-flash": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.6-plus": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.7-max": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.7-plus": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.8-flash": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.8-max": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      }
    }
  },
  "qwen-token-plan-cn": {
    "label": "Qwen Token Plan (CN)",
    "kind": "subscription",
    "models": {
      "MiniMax-M2.5": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v3.2": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-flash": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-flash-0731": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-pro": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "deepseek-v4-pro-0813": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.1": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.2": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k2.5": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k2.6": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "kimi-k2.7-code": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.6-flash": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.6-plus": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.7-max": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.7-plus": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.8-flash": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "qwen3.8-max": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      }
    }
  },
  "xiaomi-token-plan-ams": {
    "label": "Xiaomi MiMo Token Plan (AMS)",
    "kind": "subscription",
    "models": {
      "mimo-v2.5": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "mimo-v2.5-pro": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      }
    }
  },
  "xiaomi-token-plan-cn": {
    "label": "Xiaomi MiMo Token Plan (CN)",
    "kind": "subscription",
    "models": {
      "mimo-v2.5": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "mimo-v2.5-pro": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      }
    }
  },
  "xiaomi-token-plan-sgp": {
    "label": "Xiaomi MiMo Token Plan (SGP)",
    "kind": "subscription",
    "models": {
      "mimo-v2.5": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "mimo-v2.5-pro": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      }
    }
  },
  "zai-coding-cn": {
    "label": "Z.ai Coding (CN)",
    "kind": "subscription",
    "models": {
      "glm-4.6v": {
        "input": 0.3,
        "output": 0.9,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-4.7": {
        "input": 0.6,
        "output": 2.2,
        "cacheRead": 0.11,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5-turbo": {
        "input": 1.2,
        "output": 4,
        "cacheRead": 0.24,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.1": {
        "input": 1.4,
        "output": 4.4,
        "cacheRead": 0.26,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.2": {
        "input": 1.4,
        "output": 4.4,
        "cacheRead": 0.26,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.2-highspeed": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.3": {
        "input": 1.4,
        "output": 4.4,
        "cacheRead": 0.26,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.3-flash": {
        "input": 0.075,
        "output": 0.25,
        "cacheRead": 0.015,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5.3-highspeed": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "currency": "USD"
      },
      "glm-5v-turbo": {
        "input": 1.2,
        "output": 4,
        "cacheRead": 0.24,
        "cacheWrite": 0,
        "currency": "USD"
      }
    }
  }
}

/**
 * 由**官方价格政策链**权威定价、其 catalog 静态快照**不得**覆盖政策链的 provider 名单。
 * 宿主装配（lib/index.js 的 attachProviderPrices）按此**以 provider id 为键**跳过 catalog 取数：
 * 只有恰好叫这些名字的路由会命中对应 catalog 文件，因此不会误伤其它 provider 的 catalog 价；
 * 跳过时**不建桶、不登记 providerSources**，让 /token-billing/providers 如实显示 none。
 * 用户显式配置（providerPrices / providerPriceUrls）不受影响 —— 逃生口保留。
 * @see 文件头「裁决：不收录 first-party deepseek 快照」
 */
export const POLICY_PRICED_PROVIDER_IDS = Object.freeze(['deepseek'])
