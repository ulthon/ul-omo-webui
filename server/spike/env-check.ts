/**
 * 环境与凭证确认 spike（todo 2）。
 *
 * 全程只读：绝不写任何引擎存储/凭证文件。输出当前 HOME、引擎 auth 存储存在性、
 * 可用凭证清单（provider + key 指纹，绝无明文），并按 Scope token 预算规则
 * 选定后续所有 spike/QA 使用的测试模型（最便宜可用，排除 reasoning 档）。
 *
 * 运行：bun run server/spike/env-check.ts
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// omo-ai 引擎 agent 目录解析，语义照抄官方 omo-ai/bin/lib/agent-dir.js（单一事实源）：
// env 覆盖优先 OMO_CODING_AGENT_DIR -> SENPI_CODING_AGENT_DIR -> PI_CODING_AGENT_DIR，
// 否则默认 ~/.omo/agent。launcher spawn 时把同一目录写进 OMO_/SENPI_ 两个 env 传给引擎，
// 引擎侧 brandEnvNames 按同序读取——注意裸 import senpi 的 getAgentDir() 无品牌注入，
// 返回 ~/.senpi/agent，与本目录不同，不可混用。
const AGENT_DIR_ENV_NAMES = ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const

function canonicalAgentDir(home = homedir(), env = process.env): string {
  for (const name of AGENT_DIR_ENV_NAMES) {
    const configured = env[name]?.trim()
    if (configured) return configured
  }
  return join(home, ".omo", "agent")
}

interface AuthEntry {
  type?: string
  key?: string
}

interface ModelInfo {
  id: string
  name?: string
  provider: string
  reasoning?: boolean
  cost?: { input?: number; output?: number }
}

/** 对任意字符串取脱敏指纹：仅保留前 8 位 */
function fingerprint(value: string): string {
  return value.length <= 8 ? "***" : `${value.slice(0, 8)}...`
}

/** 解析 auth.json（引擎/pi 系与 opencode v1 同构：{ provider: { type, key } }），只读 */
function readAuthStore(path: string): { providers: Record<string, AuthEntry> | null; error?: string } {
  if (!existsSync(path)) return { providers: null }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { providers: null, error: "格式非对象" }
    }
    return { providers: parsed as Record<string, AuthEntry> }
  } catch (e) {
    return { providers: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 解析 models-store.json（引擎模型目录缓存：{ provider: { models: [...] } }），只读 */
function readModelsStore(path: string): { providerModels: Record<string, ModelInfo[]> } {
  const out: Record<string, ModelInfo[]> = {}
  if (!existsSync(path)) return { providerModels: out }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, { models?: ModelInfo[] }>
    for (const [provider, data] of Object.entries(parsed)) {
      if (data && Array.isArray(data.models)) out[provider] = data.models
    }
  } catch {
    // 解析失败按无模型目录处理，不中断
  }
  return { providerModels: out }
}

function main(): void {
  const home = homedir()
  console.log("=== senpi-webui 环境确认（todo 2，全只读） ===")
  console.log(`HOME:        ${home}`)
  console.log(`bun:         ${process.versions.bun ?? "n/a"}`)
  console.log(`omo-ai 引擎 agent 目录（launcher 语义解析）: ${canonicalAgentDir()}`)

  // ---- 存储存在性 ----
  const agentDir = canonicalAgentDir()
  const candidates = [
    { label: "omo-ai 引擎 canonical（spawn 后引擎将读这里）", authPath: join(agentDir, "auth.json"), storePath: join(agentDir, "models-store.json") },
    { label: "裸 senpi canonical（未用则不存在）", authPath: join(home, ".senpi", "agent", "auth.json"), storePath: join(home, ".senpi", "agent", "models-store.json") },
    { label: "pi 品牌安装（BRAND .pi）", authPath: join(home, ".pi", "agent", "auth.json"), storePath: join(home, ".pi", "agent", "models-store.json") },
    // opencode v1（终端 omo = opencode 1.18.34 + omo 在用）；模型目录在其 db 内，不在此解析
    { label: "opencode v1（终端 omo 当前使用）", authPath: join(home, ".local", "share", "opencode", "auth.json"), storePath: null },
  ]

  // 有 api/api_key 凭证的 provider -> 模型池来源目录
  const credProviders = new Map<string, string>()
  let anyCredential = false

  console.log("\n--- 凭证存储存在性与凭证清单（脱敏） ---")
  for (const c of candidates) {
    const exists = existsSync(c.authPath)
    console.log(`[${exists ? "有" : "无"}] ${c.label}`)
    console.log(`     auth: ${c.authPath}`)
    if (!exists) continue
    const { providers, error } = readAuthStore(c.authPath)
    if (error || !providers) {
      console.log(`     解析失败: ${error ?? "空对象"}`)
      continue
    }
    for (const [provider, entry] of Object.entries(providers)) {
      const type = entry?.type ?? "unknown"
      const isApiKey = type === "api" || type === "api_key"
      console.log(
        `     provider=${provider}  type=${type}` +
          (isApiKey && entry.key ? `  key指纹=${fingerprint(entry.key)}` : type === "oauth" ? "  （oauth，不显示任何 token）" : ""),
      )
      if (isApiKey && entry.key) {
        anyCredential = true
        if (!credProviders.has(provider)) credProviders.set(provider, c.storePath ?? "")
      }
    }
    if (c.storePath) console.log(`     models-store: ${c.storePath}${existsSync(c.storePath) ? "" : "（不存在）"}`)
  }

  if (!anyCredential) {
    console.log("\n无任何可用 API 凭证——按计划停止回报（不应发生：用户终端 omo 在用）。")
    process.exit(1)
  }

  // ---- 模型池 ----
  console.log("\n--- 可用模型目录（仅含持有凭证的 provider） ---")
  const pool: ModelInfo[] = []
  for (const [provider, storePath] of credProviders) {
    const { providerModels } = readModelsStore(storePath)
    const models = providerModels[provider] ?? []
    console.log(`provider=${provider}（models-store: ${storePath || "无"}）模型 ${models.length} 个:`)
    for (const m of models) {
      const cost = m.cost ?? {}
      console.log(
        `  ${m.id.padEnd(20)} reasoning=${String(m.reasoning === true).padEnd(5)} ` +
          `cost in=${cost.input ?? "?"} out=${cost.output ?? "?"}`,
      )
      pool.push(m)
    }
  }

  if (pool.length === 0) {
    console.log("\n有凭证但模型目录为空——停止回报（引擎侧可用内置目录，但本脚本无法确认价格）。")
    process.exit(1)
  }

  // ---- 选型：非 reasoning 且最便宜；零价视为价格数据缺失排除 ----
  const total = (m: ModelInfo) => (m.cost?.input ?? 0) + (m.cost?.output ?? 0)
  const priced = pool.filter((m) => total(m) > 0)
  const nonReasoning = priced.filter((m) => m.reasoning !== true)

  let selected: ModelInfo | undefined
  let basis: string
  if (nonReasoning.length > 0) {
    selected = nonReasoning.reduce((a, b) => (total(a) <= total(b) ? a : b))
    basis = "严格判据：reasoning=false 中 (input+output) 最便宜"
  } else {
    // 本机现实：zai-coding-cn 全系模型被 models.dev 标 reasoning=true（GLM 为 thinking 可分级
    // 的混合模型，flash 为低消耗高速档）。降级：非零价模型中取最便宜，说明原因。
    selected = priced.reduce((a, b) => (total(a) <= total(b) ? a : b))
    basis = "降级判据：候选全部标记 reasoning=true（GLM 混合推理系），取非零价中 (input+output) 最便宜"
  }

  console.log("\n--- 选型判据（Scope token 预算规则：最便宜可用，排除 reasoning 档） ---")
  console.log(`候选池（已排除 cost=0 的条目，其价格数据缺失不可信）: ${priced.length} 个`)
  const sorted = [...priced].sort((a, b) => total(a) - total(b))
  for (const m of sorted) {
    console.log(`  ${m.provider}/${m.id.padEnd(20)} total=${total(m).toFixed(3)} reasoning=${m.reasoning === true}`)
  }

  if (!selected) {
    console.log("\n无可定价模型——停止回报。")
    process.exit(1)
  }

  console.log("\n=== 选定测试模型（后续所有 spike/QA 引用） ===")
  console.log(`${selected.provider}/${selected.id}`)
  console.log(`理由: ${basis}；cost in=${selected.cost?.input}/M out=${selected.cost?.output}/M`)
  console.log("引擎可达性注意：引擎 canonical 目录不存在凭证时，spawn 需设 OMO_CODING_AGENT_DIR 指向")
  console.log("实际持有凭证的 agent 目录（官方 env 覆盖，只读复用，不迁移文件）——见 docs/verification/00-env.md。")
}

main()
