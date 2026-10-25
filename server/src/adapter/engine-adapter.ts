/**
 * EngineAdapter —— 宿主与引擎之间的薄接口（docs/03「EngineAdapter」）。
 *
 * 设计依据：docs/verification/01-05 的实证结论，不照类型定义猜。
 * 关键实证事实（实现必须遵守，见各处注释）：
 * - 引擎多会话模式（--multi-session）下，单个 RpcClient 连接同一时刻只驾驶一个活跃会话
 *   （prompt 自动路由到最近 open 的会话句柄）；并发驾驶 N 个会话需要 N 条连接（--listen 形态）。
 * - extension_ui_request（权限/表单/状态推送）必须从事件流接收：prompt 响应不是同步点，
 *   命令类 prompt 的响应会拖到对话框落定之后才返回（verification/02 结论 4）。
 * - RPC list_sessions 只返回本进程的活动会话；项目全量历史会话由 SDK 侧
 *   SessionManager.list(cwd, 显式 sessionDir) 直读会话库获得（verification/05 P1-1：
 *   不传显式 sessionDir 时按裸包默认目录解析，读不到 omo 品牌目录，恒为空）。
 * - thinking 档实测 glm-5.3-flash 为 ["low","high","max"]，无 off（verification/01 结论 2）。
 */

/** 引擎事件（wire 原样透传，不做深规范化；sessionId 字段是 routing handle 而非 durable id） */
export interface EngineEvent {
  type: string
  [key: string]: unknown
}

/** 事件订阅句柄 */
export interface EngineEventSubscription {
  unsubscribe(): void
}

/** 会话条目（getEntries 原样透传：{type,id,parentId,timestamp,...}，形态见 verification/01 结论 3） */
export interface EngineEntry {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  [key: string]: unknown
}

/** 消息分页结果：getEntries(since) 游标语义（verification/01：since=leafId 时增量为 0 条） */
export interface EngineMessagesPage {
  entries: EngineEntry[]
  leafId: string | null
  /** 下一页游标（= 本页 leafId；传回 messages(cursor) 取增量） */
  cursor: string | null
}

/**
 * 项目历史会话摘要（SDK SessionManager.list 行，字段如实反映实证形态）。
 * 注意：RPC list_sessions 行（活动会话）没有 parent/agent 字段；fork 血缘只在 SDK 行
 * 与磁盘 header 上以 parentSession(Path) 出现（verification/05 P1-1）。
 */
export interface EngineSessionSummary {
  /** 会话 JSONL 绝对路径 */
  path: string
  /** durable 会话 id */
  id: string
  cwd: string
  /** 用户设置的会话名（session_info 条目） */
  name?: string
  /** 父会话路径——仅 fork 场景写入（verification/05 P1-1 实测）；omo task 子会话不落盘，无血缘 */
  parentSessionPath?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
}

/** 引擎进程当前活动会话（RPC list_sessions 行，字段如实反映实证形态，无 parent/agent 字段） */
export interface EngineActiveSession {
  /** routing handle（进程生命周期内，如 "rpc-1"） */
  sessionId: string
  durableSessionId?: string
  sessionPath?: string
  cwd: string
  name?: string
  kind?: string
  status: "opening" | "open" | "closing" | "closed"
  attachments?: number
}

/** thinking 档：引擎实测无 off（glm 系为 low/high/max） */
export type EngineThinkingLevel = "low" | "high" | "max"

/** prompt 输入 */
export interface EnginePromptInput {
  text: string
  /** 多模态图片（ImageContent：{type:"image", data: base64, mimeType}；落盘为 message content 内联 base64，verification/05 P1-3） */
  images?: Array<{ type: "image"; data: string; mimeType: string }>
  thinkingLevel?: EngineThinkingLevel
  /**
   * 回合进行中排队语义（docs08-r4 任务 11，spike 实证 .omo/evidence/docs08-r4/task-2-spike.md）：
   * "steer"=下一 turn 边界并入当前工作；"followUp"=当前回合做完后继续。
   * 携带该字段时回合中 prompt 不再 409 而是入队（回执 disposition="queued"）。
   * 铁律：排队调用不得携带 thinkingLevel（引擎直接拒绝，spike (b)-8 实测）。
   */
  streamingBehavior?: "steer" | "followUp"
}

/** prompt 接受结果。disposition="handled" 表示没有开启回合（如 /命令），不要等 agent_settled */
export interface EnginePromptReceipt {
  disposition: string
}

/** 排队单项（queue_update.ordered / clearQueue 回执同构；enqueueOrder 为引擎实例内单调序号） */
export interface EngineQueueItem {
  text: string
  mode: string
  enqueueOrder: number
}

/** 排队快照：getSteeringMessages/getFollowUpMessages 对账（无 enqueueOrder，ordered 为空）
 * 与 clearQueue 整队回执（ordered 完整）两种来源的统一形态 */
export interface EngineQueueSnapshot {
  steering: string[]
  followUp: string[]
  ordered: EngineQueueItem[]
}

/** 回合速度样本（A5：单条 assistant 消息 message_start→message_end 配对；
 * tokPerSec = 该消息 output tokens / 持续秒数。"回合样本"口径 = 每条 assistant 消息一个样本） */
export interface EngineTurnSample {
  tokPerSec: number
  endedAt: string
}

/** 最近 N 回合速度（每项目内存速度环快照，不落库；N=20 按 endedAt 滑动） */
export interface EngineTurnSpeed {
  turns: EngineTurnSample[]
  averageTokPerSec: number
}

/** 会话级 usage 统计（getSessionStats 映射；verification/05 P1-4：事件级 usage 在 message_end/assistant 消息上） */
export interface EngineUsageStats {
  sessionId: string
  sessionFile: string | undefined
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  contextUsage?: { tokens: number; contextWindow: number; percent: number }
  /** A5 回合速度（非 getSessionStats 字段，由运行时层从内存速度环附加；无环数据时不下发） */
  turnSpeed?: EngineTurnSpeed
}

/** 可用模型（get_available_models 映射） */
export interface EngineModelInfo {
  provider: string
  id: string
  contextWindow?: number
  reasoning?: boolean
  supportedThinkingLevels?: string[]
  /** 变体上游模型 id（docs08 2026-10-22 批次任务 18）：models.json 自定义条目的
   *  upstreamModelId（如 glm-5.3-4k → glm-5.3）。目录行与协议面行不携带，server 侧
   *  按 provider/id 从自定义模型合并补齐；缺席 = 非变体（裸基础模型），消费侧判空。 */
  upstreamId?: string
  /** 是否支持读图（docs08 2026-10-23/24 批次任务 19）：models.json 自定义条目的
   *  supportsImages === true 才内联；缺席 = 不确定（消费侧保守回退附件）。 */
  supportsImages?: boolean
}

/**
 * 斜杠命令行（get_commands 映射，docs08-r3 任务 19；通道实证 docs/verification/06）：
 * source 三值分段——extension=引擎命令、skill=技能（name 固定 "skill:" 前缀）、
 * prompt=用户提示模板；三组调用契约均为命令直发（引擎侧展开/装载），客户端不插展开文本。
 */
export interface EngineCommandInfo {
  name: string
  source: string
  description?: string
}

/** 手动压缩结果（RPC compact -> session.compact() 的 CompactionResult 映射；
 *  docs08-r5 任务 8 spike 实证：连接层 case "compact" 直调会话级入口，无 UI 依赖） */
export interface EngineCompactResult {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  estimatedTokensAfter?: number
}

/** todo 状态（senpi.todo-state custom entry 的 data.phases，verification/03/05 P1-2） */
export interface EngineTodoState {
  phases: Array<{
    name: string
    tasks: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "abandoned" }>
  }>
}

/** 权限/表单应答（verification/02）：
 * - select → value=选项原文精确匹配；confirm → confirmed:boolean；
 * - input/editor → value=文本；任意型可 cancelled:true 取消。
 * - question（q1 提问卡片）→ answers: Record<questionId, {selected: label[]}>，
 *   可附 comment 自由文本；引擎侧 settledQuestionStatus 校验应答完整性。
 * "Deny with feedback" 会链出第二个 input 请求，调用方按事件流继续处理。 */
export interface EngineQuestionAnswer {
  selected: string[]
  text?: string
}

export interface EnginePermissionReply {
  value?: string
  confirmed?: boolean
  cancelled?: boolean
  /** question 型应答（wire 形态对齐引擎 RpcQuestionAnswers） */
  answers?: Record<string, EngineQuestionAnswer>
  /** question 型自由文本补充 */
  comment?: string
}

/** question 型 UI 请求的单问规格（wire 原样：RpcQuestionSpec） */
export interface EngineQuestionSpec {
  id: string
  header: string
  question: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

/** question 型 UI 请求帧（wire 原样：RpcQuestionUiRequest，get_state 快照与事件流同构）。
 *  事件流帧经 tagSessionRecord 带 sessionId；get_state 快照帧不带（per-session 存储），
 *  runtime 层对账时注入。 */
export interface EngineQuestionFrame {
  type: "extension_ui_request"
  method: "question"
  id: string
  sessionId?: string
  requestId: string
  toolCallId: string
  waitForAnswer: boolean
  questions: EngineQuestionSpec[]
  timeout: number
  askedAtMs: number
  deadlineAtMs: number
  remainingMs: number
}

/** adapter 能力声明：不支持的界面按 docs/01 预案降级（隐藏/明示），禁止静默砍 */
export interface EngineCapabilities {
  /** agent 枚举：实证无协议面（rpc-client 全方法核对，verification/05 P1-5） */
  agentsList: boolean
  modelsList: boolean
  todoState: boolean
  usageStats: boolean
  /** 引擎图片 part 读取（get_media 协议面，需 image_ref 占位工具才有实例） */
  imagePartRead: boolean
  /** 消息编辑（分支改写）；"编辑后立即重发"（continue_from_leaf）官配引擎不支持，见 editResend */
  messageEdit: boolean
  editResend: boolean
  /** 导出 HTML（omo CLI --export 实证可用，verification/05 P1-7） */
  exportHtml: boolean
}

/** adapter 操作错误：code 供 REST 层映射 HTTP 状态 */
export class EngineAdapterError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "EngineAdapterError"
    this.code = code
  }
}

/** 打开会话的参数：新建（provider/model/thinkingLevel）或按路径打开既有会话（二选一） */
export interface EngineOpenSessionOptions {
  sessionPath?: string
  provider?: string
  modelId?: string
  thinkingLevel?: EngineThinkingLevel
}

/** 已打开会话的描述 */
export interface EngineOpenSessionResult {
  /** durable 会话 id */
  sessionId: string
  sessionPath: string
  /** routing handle（进程生命周期内） */
  routingId: string
}

/**
 * 引擎适配器接口（薄，docs/03）。
 *
 * 会话模型约束（实证）：一个适配器实例绑定一个引擎子进程（per-project，由 process-manager
 * 持有生命周期）；适配器内部单连接同一时刻驾驶一个活跃会话——openSession 切换活跃会话，
 * messages/prompt/abort/permissionRespond/todoState/usage 均作用于当前活跃会话。
 * 对非活跃会话的读取（跨会话消息分页）由上层用「打开-读取-切回」编排或直接读会话文件。
 */
export interface EngineAdapter {
  readonly capabilities: EngineCapabilities

  /** spawn 引擎子进程并完成握手（含冷启动就绪轮询 get_protocol_info，verification/03 坑 1） */
  start(): Promise<void>
  /** 停止引擎子进程（SIGTERM→SIGKILL 策略在内层实现） */
  stop(): Promise<void>

  /** 项目历史会话列表（SDK 直读会话库，含 fork 血缘；与活跃无关） */
  sessionsList(projectDir: string): Promise<EngineSessionSummary[]>
  /** 本进程活动会话行（RPC list_sessions；无 parent/agent 字段） */
  activeSessions(): Promise<EngineActiveSession[]>

  /** 打开（或切换）活跃会话 */
  openSession(options: EngineOpenSessionOptions): Promise<EngineOpenSessionResult>
  /** 当前活跃会话；未打开时为 null */
  getActiveSession(): EngineOpenSessionResult | null
  /** 关闭当前活跃会话 */
  closeSession(): Promise<void>

  /** 活跃会话消息分页（getEntries(since=cursor) 游标语义） */
  messages(cursor?: string): Promise<EngineMessagesPage>

  /** 发送 prompt（立即返回接受回执；流式内容走 events()；disposition="handled" 表示无回合） */
  prompt(input: EnginePromptInput): Promise<EnginePromptReceipt>
  /** 中断当前回合 */
  abort(): Promise<void>

  /** 当前活跃会话排队快照（getSteeringMessages/getFollowUpMessages；对账用，无 enqueueOrder） */
  queueList(): Promise<EngineQueueSnapshot>
  /** 整队清空当前活跃会话队列（clearQueue；返回被撤项，ordered 含 enqueueOrder） */
  queueClear(): Promise<EngineQueueSnapshot>

  /** 订阅引擎事件流（权限请求、流式增量、工具事件等全部经此；详见 EngineEvent 注释） */
  events(listener: (event: EngineEvent) => void): EngineEventSubscription

  /** 应答权限/表单请求（请求经 events() 的 extension_ui_request 到达） */
  permissionRespond(requestId: string, reply: EnginePermissionReply): Promise<void>

  /** 当前活跃会话未决提问快照（get_state.pendingQuestions；对账用，REST 拉取口径同 queue） */
  pendingQuestions(): Promise<EngineQuestionFrame[]>

  /** agent 枚举（无协议面：capabilities.agentsList=false 时抛 EngineAdapterError） */
  agentsList(): Promise<Array<{ name: string; description?: string }>>
  /** 可用模型列表 */
  modelsList(): Promise<EngineModelInfo[]>
  /** 当前模型可用 thinking 档 */
  thinkingLevels(): Promise<string[]>

  /**
   * 斜杠命令三段枚举（RPC get_commands；需活跃会话——open_session 前引擎报
   * missing_session_id，docs/verification/06 实证）。作用于当前活跃会话。
   */
  commands(): Promise<EngineCommandInfo[]>

  /** 活跃会话 todo 状态（senpi.todo-state 最新条目） */
  todoState(): Promise<EngineTodoState | null>

  /** 活跃会话 usage 统计（会话级累计；事件级增量走 events()） */
  usage(): Promise<EngineUsageStats>

  /**
   * 手动压缩活跃会话上下文（RPC compact；docs08-r5 任务 8 spike 实证：
   * 官配引擎 RpcClient.compact -> 连接层 case "compact" -> session.compact()，
   * 与 CLI /compact、扩展共用同一入口，无需改引擎源码）。
   * 语义注意：引擎 manual compact 会先中止当前回合（"Aborts the current agent
   * operation first"），调用方须在回合中拒绝（运行时层 streaming 守卫）。
   */
  compactSession(): Promise<EngineCompactResult>

  /** 读取工具产出的图片 part（get_media 协议面；contentIndex 为工具结果 content 数组下标） */
  readImagePart(toolCallId: string, contentIndex: number): Promise<{ type: "image"; data: string; mimeType: string }>

  /** 导出会话 HTML（omo CLI --export；输出到 outPath，返回文件字节数） */
  exportHtml(sessionPath: string, outPath: string): Promise<number>
}
