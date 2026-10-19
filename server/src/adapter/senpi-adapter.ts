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
import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { isCompiledBinary, releaseRoot } from "../runtime-paths"
import { resolveEnginePaths } from "../engine/process-manager"
import { RpcClient, SessionManager } from "@code-yeongyu/senpi"
import type { SessionInfo } from "@code-yeongyu/senpi"
import {
  EngineAdapterError,
  type EngineAdapter,
  type EngineActiveSession,
  type EngineCapabilities,
  type EngineCommandInfo,
  type EngineCompactResult,
  type EngineEntry,
  type EngineEvent,
  type EngineEventSubscription,
  type EngineMessagesPage,
  type EngineModelInfo,
  type EngineOpenSessionOptions,
  type EngineOpenSessionResult,
  type EnginePermissionReply,
  type EnginePromptInput,
  type EngineQueueSnapshot,
  type EngineQuestionFrame,
  type EngineSessionSummary,
  type EngineThinkingLevel,
  type EngineTodoState,
  type EngineUsageStats,
} from "./engine-adapter"

/** 宿主仓库根（源码形态 server/src/adapter -> 上三级，realpath 解析符号链接）；
 * 编译形态 = 可执行文件所在目录（发行包根）。 */
const REPO_ROOT = releaseRoot()

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
  /** 从指定条目 fork 新会话（verification/05 P1-1 实证可用；"before" 仅接受 user 消息条目） */
  fork(entryId: string, options?: { position?: "before" | "at" }): Promise<{ text: string; cancelled: boolean }>
  prompt(
    message: string,
    options?: {
      thinkingLevel?: string
      images?: EnginePromptInput["images"]
      /** 回合中排队语义（docs08-r4 任务 11）：steer/followUp，引擎回合中接受并回 "queued" */
      streamingBehavior?: "steer" | "followUp"
    },
  ): Promise<unknown>
  abort(): Promise<void>
  /** 队列协议面（spike 实证生产运行时全 75 方法含此三项；无单条撤单，clearQueue 整队清空并返回被撤项） */
  clearQueue(options?: { abortWillFollow?: boolean }): Promise<unknown>
  getSteeringMessages(): Promise<string[]>
  getFollowUpMessages(): Promise<string[]>
  onEvent(listener: (event: EngineEvent) => void): () => void
  sendExtensionUIResponse(response: Record<string, unknown>): Promise<void>
  /** 会话状态快照（get_state；pendingQuestions 为未决提问数组，q1 提问卡片对账源） */
  getState(): Promise<Record<string, unknown>>
  /** 手动压缩会话上下文（协议面 compact；官方 RpcClient.compact 类型化方法，
   *  docs08-r5 任务 8 spike 实证） */
  compact(): Promise<unknown>
  getAvailableModels(): Promise<Array<Record<string, unknown>>>
  getAvailableThinkingLevels(): Promise<string[]>
  /** 斜杠命令面（get_commands，宿主 RpcClient 已解包 data.commands；需活跃会话） */
  getCommands(): Promise<Array<Record<string, unknown>>>
  getSessionStats(): Promise<Record<string, unknown>>
  getMedia(toolCallId: string, contentIndex: number): Promise<{ type: "image"; data: string; mimeType: string }>
}

/** 官配引擎 cli 解析：统一委托 process-manager 的三形态解析
 * （npm 安装 require.resolve 首选 / .bun 旁路 / 嵌套布局候选，详见其注释）。
 * 参数保留仅为兼容旧签名，实际忽略——官配对由解析顺序保证。 */
export function resolveEngineCliPath(_omoAiVersion = "5.1.0"): string {
  return resolveEnginePaths().cliPath
}

/** omo 扩展插件目录：同 resolveEngineCliPath，随引擎路径一并解析 */
export function resolvePluginDir(): string {
  return resolveEnginePaths().pluginDir
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

/** get_commands 行 -> 斜杠命令行（docs/verification/06 实测字段面：name/description/
 * source/syntax/sourceInfo；下拉只需要 name/description/source 三元组，其余不透传） */
export function mapCommandInfo(raw: Record<string, unknown>): EngineCommandInfo | null {
  const name = String(raw.name ?? "")
  if (!name) return null
  const info: EngineCommandInfo = { name, source: String(raw.source ?? "") }
  if (typeof raw.description === "string" && raw.description) info.description = raw.description
  return info
}

/** 引擎 CompactionResult -> 压缩结果（字段面 spike 实证：summary/firstKeptEntryId/
 *  tokensBefore/estimatedTokensAfter?/usage?/details?；后两者宿主不透传） */
export function mapCompactResult(raw: unknown): EngineCompactResult {
  const r = (raw ?? {}) as Record<string, unknown>
  const result: EngineCompactResult = {
    summary: String(r.summary ?? ""),
    firstKeptEntryId: String(r.firstKeptEntryId ?? ""),
    tokensBefore: Number(r.tokensBefore ?? 0),
  }
  if (typeof r.estimatedTokensAfter === "number") result.estimatedTokensAfter = r.estimatedTokensAfter
  return result
}

/** 权限应答帧（verification/02：{type:"extension_ui_response", id, value|confirmed}，取消 {cancelled:true}） */
export function buildPermissionResponse(requestId: string, reply: EnginePermissionReply): Record<string, unknown> {
  return { type: "extension_ui_response", id: requestId, ...reply }
}

/** 队列快照归一：引擎回执字段从宽甄别（string[] 与 ordered 项三字段），异常形态容错为空 */
export function normalizeQueueSnapshot(raw: unknown): EngineQueueSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>
  const stringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
  const ordered = Array.isArray(r.ordered)
    ? r.ordered
        .map((item) => item as Record<string, unknown>)
        .filter(
          (item): item is { text: string; mode: string; enqueueOrder: number } =>
            typeof item.text === "string" && typeof item.mode === "string" && typeof item.enqueueOrder === "number",
        )
        .map((item) => ({ text: item.text, mode: item.mode, enqueueOrder: item.enqueueOrder }))
    : []
  return { steering: stringArray(r.steering), followUp: stringArray(r.followUp), ordered }
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
        // stdio 宿主的客户端能力通道（rpc-mode.js:130，逗号分隔）：set_client_info
        // 对 stdio 连接是静默空操作（session-command-router 无 currentConnection），
        // 能力必须经 env 下发。question（q1 提问卡片）使 ask-user 走结构化
        // method:"question" 帧；不声明则引擎 degradeQuestion 降级为 select/input
        // 对话框链（multiSelect 与逐问自由文本在降级中丢失）。
        SENPI_RPC_CLIENT_CAPABILITIES: "extension_events,question",
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
      // 能力协商（q1 提问卡片）：声明 "question" 后 ask-user 工具走结构化
      // method:"question" 帧（waitForAnswer/questions/deadline 一体下发）；
      // 不声明则引擎 degradeQuestion 降级为 select/input 对话框链（multiSelect
      // 与逐问自由文本在降级中丢失）。前端 QuestionCard 与本能力必须同版本上线。
      await withTimeout(client.setClientInfo(80, ["extension_events", "question"]), 20000, "set_client_info")
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
    try {
      const page = await this.rpc().getEntries(cursor)
      // getEntries(since) 游标语义（verification/01：since=leafId 时增量为 0 条）
      return { entries: page.entries, leafId: page.leafId, cursor: page.leafId }
    } catch (err) {
      // 引擎对未知 since 报 "Entry not found: <id>"——游标失效（如引擎重启后会话态
      // 重建）属异常路径，降级全量让客户端按条目 id 幂等收敛，历史完整性优先
      if (err instanceof Error && err.message.includes("Entry not found")) {
        const page = await this.rpc().getEntries()
        return { entries: page.entries, leafId: page.leafId, cursor: page.leafId }
      }
      throw err
    }
  }

  async prompt(input: EnginePromptInput): Promise<{ disposition: string }> {
    this.requireActive()
    // spike 铁律（task-2-spike (b)-8 实测）：排队 prompt 不得携带 thinkingLevel，
    // 引擎直接拒绝（"Cannot set thinkingLevel on a queued prompt…"）——边界处剥除
    const res = await this.rpc().prompt(input.text, {
      thinkingLevel: input.streamingBehavior ? undefined : input.thinkingLevel,
      images: input.images,
      streamingBehavior: input.streamingBehavior,
    })
    // disposition="handled" 表示无回合（如 /命令），调用方不要等 agent_settled（verification/02 结论 4）；
    // disposition="queued" 表示回合中入队（streamingBehavior 生效），同一 run 尾才 settle
    return { disposition: String(res ?? "") }
  }

  /** 排队对账（spike 指引 2）：两查询只回挂起文本数组（steering/followUp 分列），无 enqueueOrder */
  async queueList(): Promise<EngineQueueSnapshot> {
    this.requireActive()
    const [steering, followUp] = await Promise.all([this.rpc().getSteeringMessages(), this.rpc().getFollowUpMessages()])
    return normalizeQueueSnapshot({ steering, followUp, ordered: [] })
  }

  /** 整队清空（spike 实测撤单干净：不落盘、不起回合），返回被撤项（ordered 含 enqueueOrder） */
  async queueClear(): Promise<EngineQueueSnapshot> {
    this.requireActive()
    return normalizeQueueSnapshot(await this.rpc().clearQueue())
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

  /** 未决提问快照（get_state.pendingQuestions，q1 对账：REST 拉取口径同 queue）。
   *  引擎从宽甄别：仅收窄为 question 帧（method=question + string id），异形跳过。 */
  async pendingQuestions(): Promise<EngineQuestionFrame[]> {
    this.requireActive()
    const state = await this.rpc().getState()
    const raw = (state as { pendingQuestions?: unknown }).pendingQuestions
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (f): f is EngineQuestionFrame =>
        typeof f === "object" &&
        f !== null &&
        (f as { method?: unknown }).method === "question" &&
        typeof (f as { id?: unknown }).id === "string",
    )
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

  async commands(): Promise<EngineCommandInfo[]> {
    // 活跃会话硬约束：multi-session 下 open_session 前调用被拒 missing_session_id
    // （docs/verification/06 实证），与 usage/todoState 同款 requireActive 前置
    this.requireActive()
    const rows = await this.rpc().getCommands()
    const out: EngineCommandInfo[] = []
    for (const row of rows) {
      const mapped = mapCommandInfo(row)
      if (mapped) out.push(mapped)
    }
    return out
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

  async compactSession(): Promise<EngineCompactResult> {
    this.requireActive()
    // 协议面 compact（connection-handler case "compact" -> session.compact()）。
    // 引擎侧失败形态（spike 实证）：无更多可压缩内容时 RpcCommandError（"Already
    // compacted" / "Nothing to compact (session too small)"），由运行时层映射业务码。
    return mapCompactResult(await this.rpc().compact())
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
    // omo-ai 锚点随引擎解析（pluginDir 的上级即 omo-ai 包根）
    const omoBin = isCompiledBinary()
      ? join(releaseRoot(), "engine", "node_modules", "omo-ai", "bin", "omo.js")
      : join(dirname(resolveEnginePaths().pluginDir), "bin", "omo.js")
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
