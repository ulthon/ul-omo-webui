/**
 * SenpiAdapter —— EngineAdapter 的官方 RpcClient 实现（首选引擎）。
 *
 * spawn 规范（实证，逐条遵守；docs/verification/01/03/04）：
 * - cliPath 用引擎 cli 本体：realpath(<repo>/node_modules/.bun/omo-ai@5.1.0/node_modules/
 *   @code-yeongyu/senpi/dist/bundle/cli.js)。禁止 omo.js 包装器（re-exec 换 PID）；
 *   禁止直解析根级 2026.10.10（bun isolated 布局下官配对在 .bun 旁路目录）。
 * - 参数：--extension <repo>/server/node_modules/omo-ai/plugin --mode rpc --multi-session
 *   （--mode rpc 由 RpcClient 自附；classic 模式 open_session 报 multi_session_disabled）。
 * - env：OMO_CODING_AGENT_DIR 与 SENPI_CODING_AGENT_DIR 同值、OMO_NATIVE=1；HOME 继承宿主
 *   （RpcClient 以 {...process.env, ...env} 合并，不传 HOME 即继承）。
 * - cwd=项目目录（决定会话库落点：<agentDir>/sessions/<cwd 编码>/）。
 * - 就绪时序：冷启动可超单请求 30s deadline——先轮询 get_protocol_info 成功再 open_session
 *   （docs/verification/03 坑 1；超时只 reject pending，进程仍可用）。
 *
 * 会话模型（docs/verification/01 结论 4 / 05 P2-11）：单连接同一时刻驾驶一个活跃会话；
 * 引擎无跨进程排他锁（双驾驶会交错写同一 JSONL），单驱动纪律由上层强制。
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { RpcClient, SessionManager } from "@code-yeongyu/senpi"
import type { SessionInfo } from "@code-yeongyu/senpi"
import {
  EngineAdapterError,
  type EngineAdapter,
  type EngineActiveSession,
  type EngineCapabilities,
  type EngineEntry,
  type EngineEvent,
  type EngineEventSubscription,
  type EngineMessagesPage,
  type EngineModelInfo,
  type EngineOpenSessionOptions,
  type EngineOpenSessionResult,
  type EnginePermissionReply,
  type EnginePromptInput,
  type EngineSessionSummary,
  type EngineThinkingLevel,
  type EngineTodoState,
  type EngineUsageStats,
} from "./engine-adapter"

/** 宿主仓库根（server/src/adapter -> 上三级） */
const REPO_ROOT = realpathSync(join(import.meta.dir, "..", "..", ".."))

export interface SenpiAdapterOptions {
  /** 引擎服务的项目目录（spawn cwd） */
  projectDir: string
  /** OMO_CODING_AGENT_DIR / SENPI_CODING_AGENT_DIR（实证规范：两 env 同值） */
  agentDir: string
  provider?: string
  modelId?: string
  /** 引擎 cli 本体路径覆盖；默认按 .bun 旁路布局解析官配对 */
  engineCliPath?: string
  /** omo 扩展插件目录覆盖 */
  pluginDir?: string
  /** omo-ai 精确版本（.bun 目录名用），默认 5.1.0（package.json 锁定版） */
  omoAiVersion?: string
  /** 就绪探测参数覆盖（单测用；默认 15 次 x 2s，实证冷启动可超 30s） */
  readyProbeMax?: number
  readyProbeIntervalMs?: number
  /** 测试缝隙：替换 RpcClient 构造（单测用 fixture mock，零 token） */
  clientFactory?: (options: RpcClientOptions) => SenpiRpcClient
}

/** RpcClientOptions 的结构子集（避免测试环境拉完整类型） */
export interface RpcClientOptions {
  cliPath?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  provider?: string
  model?: string
}

/**
 * 适配器用到的 RpcClient 方法面（结构类型：官方 RpcClient 天然满足）。
 * 单 RpcClient 同一时刻只驾驶一个活跃会话——这是引擎协议约束（verification/01 结论 4），
 * SenpiAdapter 的活跃会话语义（openSession 切换、其余方法作用于当前活跃）由此而来。
 */
export interface SenpiRpcClient {
  start(): Promise<void>
  stop(): Promise<void>
  setClientInfo(width: number, capabilities?: string[]): Promise<void>
  openSession(options: {
    sessionPath?: string
    provider?: string
    modelId?: string
    thinkingLevel?: string
  }): Promise<{ sessionId: string; state: { sessionId?: string; sessionFile?: string; [k: string]: unknown }; attached?: boolean }>
  closeSession(sessionId?: string): Promise<void>
  listSessions(): Promise<Array<Record<string, unknown>>>
  getEntries(since?: string): Promise<{ entries: EngineEntry[]; leafId: string | null }>
  prompt(message: string, options?: { thinkingLevel?: string; images?: EnginePromptInput["images"] }): Promise<unknown>
  abort(): Promise<void>
  onEvent(listener: (event: EngineEvent) => void): () => void
  sendExtensionUIResponse(response: Record<string, unknown>): Promise<void>
  getAvailableModels(): Promise<Array<Record<string, unknown>>>
  getAvailableThinkingLevels(): Promise<string[]>
  getSessionStats(): Promise<Record<string, unknown>>
  getMedia(toolCallId: string, contentIndex: number): Promise<{ type: "image"; data: string; mimeType: string }>
}

/** 官配引擎 cli 解析：.bun 旁路精确路径 -> .bun 扫描 -> 嵌套布局，全部 realpath（verification/03 坑 2） */
export function resolveEngineCliPath(omoAiVersion = "5.1.0"): string {
  const bunDir = join(REPO_ROOT, "node_modules", ".bun")
  const candidates: string[] = []
  const rel = "node_modules/@code-yeongyu/senpi/dist/bundle/cli.js"
  candidates.push(join(bunDir, `omo-ai@${omoAiVersion}`, rel))
  if (existsSync(bunDir)) {
    for (const dir of readdirSync(bunDir)) {
      if (dir.startsWith("omo-ai@")) candidates.push(join(bunDir, dir, rel))
    }
  }
  candidates.push(join(REPO_ROOT, "server", "node_modules", "omo-ai", "node_modules", "@code-yeongyu", "senpi", "dist", "bundle", "cli.js"))
  candidates.push(join(REPO_ROOT, "node_modules", "omo-ai", "node_modules", "@code-yeongyu", "senpi", "dist", "bundle", "cli.js"))
  for (const c of candidates) {
    if (existsSync(c)) return realpathSync(c)
  }
  throw new EngineAdapterError("engine_cli_not_found", `引擎 cli 本体未找到（ tried ${candidates.length} 个候选路径）`)
}

/** omo 扩展插件目录（server workspace 直依赖） */
export function resolvePluginDir(): string {
  const p = join(REPO_ROOT, "server", "node_modules", "omo-ai", "plugin")
  if (!existsSync(p)) throw new EngineAdapterError("plugin_dir_not_found", `omo 插件目录不存在: ${p}`)
  return p
}

/** cwd -> 会话库目录编码（verification/04 实测：去前导 /，/ 换 -，包 --...--） */
export function encodeCwdToSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`
}

/** SDK 行 -> 会话摘要（字段如实映射；parentSessionPath 仅 fork 场景有值） */
export function mapSessionSummary(row: SessionInfo): EngineSessionSummary {
  const s: EngineSessionSummary = {
    path: row.path,
    id: row.id,
    cwd: row.cwd,
    created: row.created instanceof Date ? row.created.toISOString() : String(row.created),
    modified: row.modified instanceof Date ? row.modified.toISOString() : String(row.modified),
    messageCount: row.messageCount,
    firstMessage: row.firstMessage,
  }
  if (row.name !== undefined) s.name = row.name
  if (row.parentSessionPath !== undefined) s.parentSessionPath = row.parentSessionPath
  return s
}

/** senpi.todo-state custom entry -> todo 状态（verification/05 P1-2；schema v2 phases/tasks） */
export function parseTodoState(entry: EngineEntry | undefined): EngineTodoState | null {
  if (!entry) return null
  const data = entry.data as { phases?: unknown } | undefined
  const phases = data?.phases
  if (!Array.isArray(phases)) return null
  return {
    phases: phases.map((p) => {
      const phase = p as { name?: unknown; tasks?: unknown }
      return {
        name: String(phase.name ?? ""),
        tasks: Array.isArray(phase.tasks)
          ? phase.tasks.map((t) => {
              const task = t as { content?: unknown; status?: unknown }
              return { content: String(task.content ?? ""), status: task.status as EngineTodoState["phases"][number]["tasks"][number]["status"] }
            })
          : [],
      }
    }),
  }
}

/** getSessionStats -> usage 统计（verification/05 P1-4：状态条数据源） */
export function mapUsageStats(raw: Record<string, unknown>): EngineUsageStats {
  const tokens = (raw.tokens ?? {}) as Record<string, number>
  const contextUsage = raw.contextUsage as { tokens?: number; contextWindow?: number; percent?: number } | undefined
  const stats: EngineUsageStats = {
    sessionId: String(raw.sessionId ?? ""),
    sessionFile: typeof raw.sessionFile === "string" ? raw.sessionFile : undefined,
    userMessages: Number(raw.userMessages ?? 0),
    assistantMessages: Number(raw.assistantMessages ?? 0),
    toolCalls: Number(raw.toolCalls ?? 0),
    toolResults: Number(raw.toolResults ?? 0),
    totalMessages: Number(raw.totalMessages ?? 0),
    tokens: {
      input: Number(tokens.input ?? 0),
      output: Number(tokens.output ?? 0),
      cacheRead: Number(tokens.cacheRead ?? 0),
      cacheWrite: Number(tokens.cacheWrite ?? 0),
      total: Number(tokens.total ?? 0),
    },
    cost: Number(raw.cost ?? 0),
  }
  if (contextUsage && typeof contextUsage.tokens === "number") {
    stats.contextUsage = {
      tokens: contextUsage.tokens,
      contextWindow: Number(contextUsage.contextWindow ?? 0),
      percent: Number(contextUsage.percent ?? 0),
    }
  }
  return stats
}

/** 模型行 -> 模型信息（get_available_models；额外字段不透传，形态见 verification/05 P1-5） */
export function mapModelInfo(raw: Record<string, unknown>): EngineModelInfo {
  const info: EngineModelInfo = { provider: String(raw.provider ?? ""), id: String(raw.id ?? "") }
  if (typeof raw.contextWindow === "number") info.contextWindow = raw.contextWindow
  if (typeof raw.reasoning === "boolean") info.reasoning = raw.reasoning
  if (Array.isArray(raw.supportedThinkingLevels)) info.supportedThinkingLevels = raw.supportedThinkingLevels.map(String)
  return info
}

/** 权限应答帧（verification/02：{type:"extension_ui_response", id, value|confirmed}，取消 {cancelled:true}） */
export function buildPermissionResponse(requestId: string, reply: EnginePermissionReply): Record<string, unknown> {
  return { type: "extension_ui_response", id: requestId, ...reply }
}

/** 就绪轮询与握手参数 */
const READY_PROBE_INTERVAL_MS = 2000
const READY_PROBE_MAX = 15
const START_TIMEOUT_MS = 60000
const OPEN_TIMEOUT_MS = 60000

export class SenpiAdapter implements EngineAdapter {
  readonly capabilities: EngineCapabilities = {
    // 实证：agent 枚举无协议面（docs/verification/05 P1-5）；UI 按 docs/01 预案降级
    agentsList: false,
    modelsList: true,
    todoState: true,
    usageStats: true,
    // get_media 协议面在（实例样本缺，失败按占位降级）
    imagePartRead: true,
    // 消息编辑（分支改写）支持；"编辑后重发" continue_from_leaf 官配引擎不支持（05 P1-6）
    messageEdit: true,
    editResend: false,
    // omo CLI --export 实证可用（05 P1-7）
    exportHtml: true,
  }

  private readonly options: SenpiAdapterOptions
  private client: SenpiRpcClient | null = null
  private active: EngineOpenSessionResult | null = null
  private starting: Promise<void> | null = null

  constructor(options: SenpiAdapterOptions) {
    if (!options.projectDir) throw new EngineAdapterError("bad_options", "projectDir 必填")
    if (!options.agentDir) throw new EngineAdapterError("bad_options", "agentDir 必填")
    this.options = options
  }

  private createClient(): SenpiRpcClient {
    const factory = this.options.clientFactory ?? ((o: RpcClientOptions) => new RpcClient(o) as unknown as SenpiRpcClient)
    const cliPath = this.options.engineCliPath ?? resolveEngineCliPath(this.options.omoAiVersion)
    const pluginDir = this.options.pluginDir ?? resolvePluginDir()
    return factory({
      cliPath,
      // --mode rpc 由 RpcClient 自附；多会话必须显式（classic 拒绝 open_session）
      args: ["--extension", pluginDir, "--multi-session"],
      cwd: this.options.projectDir,
      env: {
        OMO_CODING_AGENT_DIR: this.options.agentDir,
        SENPI_CODING_AGENT_DIR: this.options.agentDir,
        OMO_NATIVE: "1",
      },
      provider: this.options.provider,
      model: this.options.modelId,
    })
  }

  private rpc(): SenpiRpcClient {
    if (!this.client) throw new EngineAdapterError("not_started", "adapter 未 start()，引擎子进程不存在")
    return this.client
  }

  private requireActive(): EngineOpenSessionResult {
    if (!this.active) throw new EngineAdapterError("no_active_session", "无活跃会话：先 openSession()")
    return this.active
  }

  async start(): Promise<void> {
    if (this.client) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const client = this.createClient()
      await withTimeout(client.start(), START_TIMEOUT_MS, "引擎启动")
      await withTimeout(client.setClientInfo(80, ["extension_events"]), 20000, "set_client_info")
      // 冷启动就绪轮询（docs/verification/03 坑 1）：get_protocol_info 成功才算就绪
      // send 是 RpcClient 内部方法，spike 已实证此用法（verification/03）。
      const send = (client as unknown as { send: (m: unknown) => Promise<{ success: boolean }> }).send.bind(client)
      const maxProbes = this.options.readyProbeMax ?? READY_PROBE_MAX
      const interval = this.options.readyProbeIntervalMs ?? READY_PROBE_INTERVAL_MS
      for (let i = 1; i <= maxProbes; i++) {
        try {
          if ((await send({ type: "get_protocol_info" })).success) {
            this.client = client
            return
          }
        } catch {
          // 就绪探测超时只 reject 该次 pending，进程仍可用，继续轮询
        }
        await new Promise((r) => setTimeout(r, interval))
      }
      await client.stop().catch(() => undefined)
      throw new EngineAdapterError("engine_not_ready", `引擎就绪探测失败（${maxProbes} 次）`)
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = null
    this.active = null
    if (client) await client.stop()
  }

  async sessionsList(projectDir: string): Promise<EngineSessionSummary[]> {
    // 必须显式传 sessionDir：不传按裸包默认 agentDir 解析，读不到 omo 品牌目录（05 P1-1）
    const sessionsDir = join(this.options.agentDir, "sessions", encodeCwdToSessionDirName(projectDir))
    const rows = await SessionManager.list(projectDir, sessionsDir)
    return rows.map(mapSessionSummary)
  }

  async activeSessions(): Promise<EngineActiveSession[]> {
    const rows = await this.rpc().listSessions()
    return rows.map((r) => {
      const status = String(r.status ?? "closed") as EngineActiveSession["status"]
      const row: EngineActiveSession = {
        sessionId: String(r.sessionId ?? ""),
        cwd: String(r.cwd ?? ""),
        status,
      }
      if (typeof r.durableSessionId === "string") row.durableSessionId = r.durableSessionId
      if (typeof r.sessionPath === "string") row.sessionPath = r.sessionPath
      if (typeof r.name === "string") row.name = r.name
      if (typeof r.kind === "string") row.kind = r.kind
      if (typeof r.attachments === "number") row.attachments = r.attachments
      return row
    })
  }

  async openSession(options: EngineOpenSessionOptions): Promise<EngineOpenSessionResult> {
    const client = this.rpc()
    const res = await withTimeout(
      client.openSession({
        sessionPath: options.sessionPath,
        provider: options.provider ?? this.options.provider,
        modelId: options.modelId ?? this.options.modelId,
        thinkingLevel: options.thinkingLevel,
      }),
      OPEN_TIMEOUT_MS,
      "open_session",
    )
    // open_session 返回的 sessionId 是 routing handle；durable id 在 state.sessionId（verification/01 结论 2）
    const sessionId = String(res.state?.sessionId ?? "")
    const sessionPath = String(res.state?.sessionFile ?? "")
    if (!sessionId || !sessionPath) {
      throw new EngineAdapterError("open_failed", `open_session 响应缺 state.sessionId/sessionFile: ${JSON.stringify(res).slice(0, 200)}`)
    }
    this.active = { sessionId, sessionPath, routingId: res.sessionId }
    return this.active
  }

  getActiveSession(): EngineOpenSessionResult | null {
    return this.active
  }

  async closeSession(): Promise<void> {
    this.requireActive()
    await this.rpc().closeSession()
    this.active = null
  }

  async messages(cursor?: string): Promise<EngineMessagesPage> {
    this.requireActive()
    const page = await this.rpc().getEntries(cursor)
    // getEntries(since) 游标语义（verification/01：since=leafId 时增量为 0 条）
    return { entries: page.entries, leafId: page.leafId, cursor: page.leafId }
  }

  async prompt(input: EnginePromptInput): Promise<{ disposition: string }> {
    this.requireActive()
    const res = await this.rpc().prompt(input.text, {
      thinkingLevel: input.thinkingLevel,
      images: input.images,
    })
    // disposition="handled" 表示无回合（如 /命令），调用方不要等 agent_settled（verification/02 结论 4）
    return { disposition: String(res ?? "") }
  }

  async abort(): Promise<void> {
    this.requireActive()
    await this.rpc().abort()
  }

  events(listener: (event: EngineEvent) => void): EngineEventSubscription {
    const off = this.rpc().onEvent(listener)
    return { unsubscribe: off }
  }

  async permissionRespond(requestId: string, reply: EnginePermissionReply): Promise<void> {
    // 请求必须从事件流接收（extension_ui_request）；prompt 响应不是同步点（verification/02）
    await this.rpc().sendExtensionUIResponse(buildPermissionResponse(requestId, reply))
  }

  async agentsList(): Promise<Array<{ name: string; description?: string }>> {
    throw new EngineAdapterError("unsupported", "agent 枚举无协议面（docs/verification/05 P1-5）；UI 按 capabilities.agentsList=false 降级")
  }

  async modelsList(): Promise<EngineModelInfo[]> {
    const rows = await this.rpc().getAvailableModels()
    return rows.map(mapModelInfo)
  }

  async thinkingLevels(): Promise<string[]> {
    return this.rpc().getAvailableThinkingLevels()
  }

  async todoState(): Promise<EngineTodoState | null> {
    this.requireActive()
    const page = await this.rpc().getEntries()
    const last = [...page.entries].reverse().find((e) => e.customType === "senpi.todo-state")
    return parseTodoState(last)
  }

  async usage(): Promise<EngineUsageStats> {
    this.requireActive()
    return mapUsageStats(await this.rpc().getSessionStats())
  }

  async readImagePart(toolCallId: string, contentIndex: number): Promise<{ type: "image"; data: string; mimeType: string }> {
    this.requireActive()
    try {
      return await this.rpc().getMedia(toolCallId, contentIndex)
    } catch (e) {
      // media_not_found 等（image_ref 占位缺失）——按占位降级，由上层决定渲染
      const message = e instanceof Error ? e.message : String(e)
      throw new EngineAdapterError("media_not_found", `图片 part 读取失败: ${message}`)
    }
  }

  async exportHtml(sessionPath: string, outPath: string): Promise<number> {
    // 实证命令（docs/verification/05 P1-7）：node omo.js --export <in> <out>，env 必须带品牌目录
    const omoBin = join(REPO_ROOT, "server", "node_modules", "omo-ai", "bin", "omo.js")
    if (!existsSync(omoBin)) throw new EngineAdapterError("export_failed", `omo cli 不存在: ${omoBin}`)
    const r = spawnSync("node", [omoBin, "--export", sessionPath, outPath], {
      encoding: "utf8",
      timeout: 120000,
      cwd: this.options.projectDir,
      env: {
        ...process.env,
        OMO_CODING_AGENT_DIR: this.options.agentDir,
        SENPI_CODING_AGENT_DIR: this.options.agentDir,
      },
    })
    if (!existsSync(outPath)) {
      throw new EngineAdapterError("export_failed", `--export 未产出文件（exit=${r.status}）: ${(r.stderr ?? "").slice(-200)}`)
    }
    return statSync(outPath).size
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EngineAdapterError("timeout", `${label} 超时 ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
