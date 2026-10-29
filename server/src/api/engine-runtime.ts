// 组合根运行时（todo 9）：引擎子进程管理器单例 + 按项目懒加载的 adapter。
//
// 单驱动纪律（docs/verification/05 P2-11 结论）：引擎无跨进程排他锁——两个驱动方
// open 同一 sessionPath 都会成功且写入交错进同一 JSONL，"already processing" 守卫
// 只在单进程内生效。webui 必须自律单驱动：
// - 每个项目运行时跟踪 streamingSessionId（当前处于 webui 驱动回合中的会话 durable id），
//   对它在回合中的再次 prompt 直接返回 409 already_processing（不等引擎守卫报错）；
//   即使外部因素绕过（事件丢失/外部驱动），引擎 "already processing" 错误也映射为 409。
// - 会话切换（openSession）走 per-project 互斥队列串行化：prompt 的「切换+发送」
//   原子化，防止并发请求把 prompt 路由到错误会话（RpcClient prompt 路由到最近 open
//   的会话，docs/verification/01 结论 4）。回合流式期间互斥已释放（prompt 在接受时
//   返回），读操作不长时间阻塞；/命令 prompt 的 RPC 会拖到对话框落定（verification/02
//   结论 4），期间该项目的会话操作排队等待——单用户产品可接受，已注释。
//
// 会话身份（todo 8 实证约束）：一律用 durable id（磁盘 header id，重启后 open
// sessionPath 不变）。open_session 响应里的 state.sessionId 是 host 侧 holder UUID
// （随进程变化），禁止持久化——仅当新会话尚未落盘、activeSessions 行还没有
// durableSessionId 时，把它作为进程内别名使用（内存 alias map，进程结束即失效）。
//
// 引擎生命周期归 EngineProcessManager（todo 8）：spawn/崩溃重启/退避/空闲回收/
// 孤儿清扫都在管理器内。adapter 通过 clientFactory 挂到管理器已 spawn 的连接上，
// 生命周期钩子（start/stop）为 no-op——引擎崩溃重启后管理器会造新 client，
// ensure() 检测到 client 更换即重建 adapter 并清空会话态。
import type { RpcClient } from "@code-yeongyu/senpi";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  EngineAdapterError,
  type EngineAdapter,
  type EngineMessagesPage,
  type EngineCommandInfo,
  type EngineCompactResult,
  type EngineModelInfo,
  type EngineOpenSessionResult,
  type EnginePermissionReply,
  type EngineQuestionFrame,
  type EnginePromptInput,
  type EngineQueueSnapshot,
  type EngineSessionSummary,
  type EngineThinkingLevel,
  type EngineTurnSample,
  type EngineTurnSpeed,
  type EngineUsageStats,
} from "../adapter/engine-adapter";
import { SenpiAdapter, type SenpiRpcClient } from "../adapter/senpi-adapter";
import type { EngineProcessManager } from "../engine/process-manager";
import { ApiError } from "./http";
import { DEBUG_PERF, logPerfSpan, projHash8, type PerfSpan } from "./perf";

/** 错误 → 业务码（ApiError/EngineAdapterError 带 code；其余归 internal）。埋点 err 段用。 */
function perfErrCode(err: unknown): string {
  if (err instanceof ApiError) return err.code;
  if (err instanceof EngineAdapterError) return err.code;
  return "internal";
}

/** 关闭态共享哑 span（body 的段写入无读者；省去按调用分配，零行为差异） */
const INERT_PERF_SPAN = {} as PerfSpan;

/** 会话运行态（服务端真相源，docs08-r6 任务 11）：GET /api/sessions 行 runState 字段值。
 *  语义与前端 SSE 驱动的 runStates 同口径（agent_start → running；四型权限/阻塞型
 *  question → waiting；落定 → idle），error 属前端独有态（服务端不合成）。
 *  第四态 background_running（docs08-2026-10-23-24-batch 任务 12）：会话 jsonl 内存在
 *  未终局的后台任务 spawn 回执时由路由层叠加（解析见 api/background-tasks.ts，与
 *  web subagent-data.ts dispatched 判定同口径）——纯磁盘派生，服务重启重读 jsonl
 *  即恢复；三态既有语义与 deriveSessionRunState 映射不变。 */
export type ServerSessionRunState = "running" | "waiting" | "idle" | "background_running";

/** runState 三态推导（纯函数，全组合断言见 server/test/run-state.test.ts）：
 *  permission / question 任一非空 → waiting（等待用户输入压制 running——与前端
 *  SSE 语义同口径：权限门挂起回合不结束，强置 running 是语义回退）；否则
 *  streaming 占用 → running；其余 idle。 */
export function deriveSessionRunState(sources: {
  streaming: boolean;
  permission: boolean;
  question: boolean;
}): ServerSessionRunState {
  if (sources.permission || sources.question) return "waiting";
  return sources.streaming ? "running" : "idle";
}

/** 路由层依赖的引擎网关面（真实实现 = EngineRuntimeRegistry；单测注入 fake） */
export interface EngineGateway {
  /** 项目历史会话列表（SDK 直读会话库，不触发引擎 spawn） */
  sessionsList(project: string): Promise<EngineSessionSummary[]>;
  /** 新建会话（需引擎进程）；返回 durable id（未落盘时为进程内别名） */
  createSession(
    project: string,
    opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }>;
  /** 会话消息分页（游标 = 上页 leafId） */
  messages(sessionId: string, cursor?: string): Promise<EngineMessagesPage>;
  /**
   * 会话 jsonl 磁盘路径反查（任务 16：首载尾窗直读）。SDK 直读会话库定位，
   * 不 spawn 引擎不进 runExclusive。可选面：测试装配 fake 可省略——缺省时
   * messages 路由整体回退引擎全量（原行为）。查不到抛 session_not_found。
   */
  sessionPath?(sessionId: string): Promise<string>;
  /**
   * 发送 prompt。单驱动约束：目标会话回合进行中抛 ApiError(409, "already_processing")；
   * 携带 streamingBehavior（docs08-r4 任务 11）时放行改为入队（回执 disposition="queued"，
   * 排队回合与当前回合同一 run，仅在 run 尾 settle 一次）。
   * model 为 "provider/model" 形态（可选，切换当前会话模型）。
   * thinkingLevel 为 low/high/max（可选，W2 todo 7 起逐回合下传引擎）。
   * durableSessionId：未落盘别名会话（新会话）首条消息落盘后回传的真实 id
   * （缺陷修复：新会话首条用户消息不显示——前端以此即时换 key）；已落盘会话不回传。
   * appliedModel（docs08-r6 任务 8 ②）：携带 model 且 setModel 成功时回 "provider/model"
   * （回模型行归一）；排队/未携带 model 不回传。
   */
  prompt(
    sessionId: string,
    input: {
      text: string
      images?: EnginePromptInput["images"]
      model?: string
      thinkingLevel?: EngineThinkingLevel
      streamingBehavior?: EnginePromptInput["streamingBehavior"]
    },
  ): Promise<{ disposition: string; durableSessionId?: string; appliedModel?: string }>
  /** 排队对账快照（getSteeringMessages/getFollowUpMessages；断线重连/初次渲染拉一次） */
  queueList(sessionId: string): Promise<EngineQueueSnapshot>
  /** 整队清空（引擎无单条撤单协议面，单条撤销由前端清空后重排实现），返回被撤项 */
  queueClear(sessionId: string): Promise<EngineQueueSnapshot>;
  abort(sessionId: string): Promise<void>;
  permissionRespond(sessionId: string, requestId: string, reply: EnginePermissionReply): Promise<void>;
  /** 未决提问对账快照（q1；get_state.pendingQuestions 注入会话 id 后返回） */
  questionsList(sessionId: string): Promise<EngineQuestionFrame[]>;
  usage(sessionId: string): Promise<EngineUsageStats>;
  /**
   * 手动压缩会话上下文（docs08-r5 任务 8：POST /api/sessions/:id/compact，
   * 协议面 compact 实证）。目标会话回合进行中抛 ApiError(409, "already_processing")
   * （引擎 manual compact 会先中止当前回合，webui 单驱动纪律下拒绝而非隐式中断）；
   * 返回压缩水位（tokensBefore/estimatedTokensAfter）供前端佐证真实生效。
   * 可选面（favoriteModels 同例）：真实注册表实现之；测试 fake 可省略
   * （路由层降级 501 compact_unsupported）。
   */
  compact?(sessionId: string): Promise<{ result: EngineCompactResult; usage: EngineUsageStats }>;
  modelsList(project: string): Promise<EngineModelInfo[]>;
  /** CLI 收藏（settings.json favoriteModels，归一 "provider/model"）。可选面：
   * 真实注册表实现直读 agent 目录；测试 fake 可省略（路由层降级空数组）。 */
  favoriteModels?(): string[];
  /** 引擎 native 默认模型（settings.json defaultProvider/defaultModel/defaultThinkingLevel，
   * docs08-r5 任务 2）。可选面：真实注册表实现直读 agent 目录；测试 fake 可省略
   * （路由层降级 null——前端回退链跳过引擎默认档，与旧服务端未下发字段同口径）。 */
  defaultModel?(): { provider: string; model: string; thinkingLevel: string | null } | null;
  /**
   * 斜杠命令三段枚举（docs08-r3 任务 19）：引擎就绪且有活跃会话时返回按 source
   * 分组的命令行（extension/skill/prompt）；引擎未就绪（不为此触发 spawn）或无
   * 活跃会话（open_session 前 RPC 报 missing_session_id，docs/verification/06 实证）
   * 返回 null——调用方降级（端点 available=false），绝不崩。
   */
  commandsList(project: string): Promise<EngineCommandInfo[] | null>;
  /**
   * 删除会话：引擎无删除协议面（rpc-client 全方法核对），实行为删磁盘会话文件
   * 与对应 -artifacts 目录（存在才删，删失败不阻塞），元数据行由路由层清理。
   */
  deleteSession(sessionId: string): Promise<{ sessionPath: string; fileExisted: boolean }>;
  /**
   * 导出会话 HTML（omo CLI --export，verification/05 P1-7；CLI 子命令不依赖引擎进程活跃，
   * 但会话文件须已落盘——空会话 409 session_not_persisted）。row 供路由层取导出文件名。
   */
  exportSessionHtml(sessionId: string): Promise<{ html: string; row: EngineSessionSummary }>;
  /**
   * 从指定条目 fork 新会话（重试语义：position="before" 仅接受 user 消息条目，
   * 新会话为该消息之前的上下文，text 返回原消息文本供上层重发）。
   * 返回 durable id（fork 即物化落盘，createBranchedSession 直接写文件；未解析到时退化别名）。
   */
  forkSession(
    sessionId: string,
    entryId: string,
    position?: "before" | "at",
  ): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }>;
  /**
   * 引擎就绪时返回**回合进行中**（webui 驱动的流式回合）会话路径列表；
   * 未就绪返回 null（不触发 spawn），就绪且空闲返回 []。
   * 语义注意：不是引擎 open 会话全集——open 态在回合结束后仍保留，
   * 前端 `active` 字段语义 = 回合进行中（todo 15 实证修复）。
   */
  peekActiveSessionPaths(project: string): Promise<string[] | null>;
  /**
   * 引擎就绪时的运行态三态快照（docs08-r6 任务 11，GET /api/sessions 行 runState 供源）：
   * sessionPath → running|waiting|idle，仅回合进行中会话入表（单驱动至多一条），
   * 就绪且空闲返回空表（未入表 = idle），未就绪返回 null（不触发 spawn，与
   * peekActiveSessionPaths 同口径）。可选面（favoriteModels 同例）：真实注册表实现之；
   * 旧 fake 缺席时路由退回 peekActiveSessionPaths（active 照发，runState 恒 null）。
   */
  peekRunStates?(project: string): Promise<Map<string, ServerSessionRunState> | null>;
  /**
   * 重建项目引擎进程（stop → ensureRunning）：spawn 参数级配置（权限预设等）
   * 变更后的生效口。会话态随之失效（下次访问懒加载重建）。
   */
  restartProject(project: string): Promise<void>;
  stopAll(): Promise<void>;
}

export interface EngineRuntimeOptions {
  /** 已知项目列表（组合根注入，通常来自 meta_project），供会话 id 反查扫描 */
  listProjects(): string[];
  /** OMO_CODING_AGENT_DIR / SENPI_CODING_AGENT_DIR（缺省 ~/.pi/agent，W1 spawn 规范） */
  agentDir?: string;
  /**
   * 合成收尾事件出口（组合根接 EventBus.publish，进同一 SSE 信封管道）。
   * 仅在「prompt 已接受、引擎 get_state 复核已空闲、真实收尾事件宽限期内仍未到」
   * 时调用（todo 16 实证的收尾事件缺席缺陷的权威空闲判定回退），严禁常态化轮询。
   */
  publishSyntheticEvent?(projectPath: string, event: Record<string, unknown>): void;
  /** 新 assistant 消息落地回调（组合根接 meta.incrementUnread；未读计数服务端接线） */
  recordUnread?(projectPath: string, durableSessionId: string): void;
  /**
   * 回合落定回调（W2 todo 8，组合根接 title-gen）：正常事件路径（agent_end/
   * settled/idle）与 watchdog 合成路径触发，**crashSettle 排除**（崩溃回合内容
   * 可能不完整）。settleInfo 在清位前捕获——sessionId 可能是未落盘 holder 别名
   * （新会话首回合），消费方以 sessionPath 反查解析 durable id 后再读写 meta。
   * 组合根接线必须 .catch 包裹（Bun 未处理 rejection 默认退出进程）。
   */
  onRoundSettled?(
    projectPath: string,
    settleInfo: { sessionId: string; sessionPath: string },
    reason: string,
  ): void;
  /** 收尾监视轮询间隔毫秒（默认 2000，仅回合进行中运行）。 */
  settlePollMs?: number;
  /** 引擎空闲观察到真实收尾事件缺席时，合成前的宽限毫秒（默认 5000）。 */
  settleGraceMs?: number;
}

function defaultAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

/** 权限预设 meta_kv 键名（值如 "read-only"；todo 18 权限卡片端到端 QA 依赖）。 */
export function permissionPresetKey(projectPath: string): string {
  return `permission-preset:${projectPath}`;
}

/**
 * 引擎合法权限预设档位（以引擎包 @code-yeongyu/senpi 的 PERMISSION_PRESET_NAMES
 * 为准，2026.10.10 版 bundle 实证；校验即镜像，不猜不造）：
 * - full-access：全部自动放行（无预设时引擎缺省回落档）
 * - workspace：项目内读/写/命令自动放行，项目外目录访问询问
 * - accept-edits：文件编辑自动放行，执行命令与项目外访问询问
 * - auto：引擎逐次判定，安全操作自动放行，其余询问
 * - read-only：只读放行，编辑、命令、项目外访问均询问
 * - ask：全部询问
 */
export const PERMISSION_PRESET_NAMES: readonly string[] = [
  "full-access",
  "workspace",
  "accept-edits",
  "auto",
  "read-only",
  "ask",
];

/**
 * 项目权限预设 → 引擎 spawn 附加参数（--permission-preset <值>）。
 * 无预设返回空数组，spawn 行为与从前完全一致。
 * 预设是 spawn 参数级：变更需让项目引擎重启（服务重启或 POST /api/projects/restart）。
 * todo 6 起取值来源 = 项目 .ul-omo-webui.json（合并读取与迁移过渡态见 config-migration.ts）。
 */
export function permissionPresetArgs(preset: string | null | undefined): string[] {
  const value = preset?.trim();
  return value ? ["--permission-preset", value] : [];
}

/** 内置工具静态目录（r10 todo 17）：与引擎 CLI help "Built-in Tool Names" 段同源
 * （spike-16 实证：引擎无工具列表 RPC，逐工具开关的枚举源取此静态清单）。
 * builtin = 默认启用四件 + grep（默认关闭但在内置名单内）；find/ls/powershell
 * 引擎默认关闭，一并列出供显式开启/关闭（黑白名单按名字透传，引擎按名单匹配）。 */
export const BUILTIN_TOOL_CATALOG: ReadonlyArray<{ name: string; builtin: boolean }> = [
  { name: "read", builtin: true },
  { name: "bash", builtin: true },
  { name: "edit", builtin: true },
  { name: "write", builtin: true },
  { name: "grep", builtin: true },
  { name: "find", builtin: false },
  { name: "ls", builtin: false },
  { name: "powershell", builtin: false },
];

/** 项目工具启停配置 → 引擎 spawn 附加参数（r10 todo 17，CLI 同源参数）。
 * - tools 白名单非空 → --tools <逗号连接>（未列即禁，含扩展工具）；
 * - tools 显式空数组 → --no-tools（降级：引擎零工具，调用方须向 UI 出降级提示）；
 * - excludedTools 黑名单非空 → --exclude-tools <逗号连接>；
 * - 两者同给时引擎侧黑名单在白名单之后生效（引擎 sdk 语义），按序透传；
 * - 均未配置（null）→ 空数组，spawn 行为与从前完全一致。
 * 参数是 spawn 级：变更需项目引擎重启（POST /api/projects/restart）生效。 */
export function toolsSpawnArgs(config: { tools: string[] | null; excludedTools: string[] | null }): string[] {
  const { tools, excludedTools } = config;
  if (tools !== null) {
    if (tools.length === 0) return ["--no-tools"];
    const out = ["--tools", tools.join(",")];
    if (excludedTools !== null && excludedTools.length > 0) out.push("--exclude-tools", excludedTools.join(","));
    return out;
  }
  if (excludedTools !== null && excludedTools.length > 0) return ["--exclude-tools", excludedTools.join(",")];
  return [];
}

/** models-store.json 直读降级（形态见 docs/verification/00-env.md；读取失败返回空列表） */
function readModelsStore(agentDir: string): EngineModelInfo[] {
  const file = join(agentDir, "models-store.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      { models?: Array<{ id?: unknown; reasoning?: unknown; contextWindow?: unknown; thinkingLevelMap?: unknown }> }
    >;
    const out: EngineModelInfo[] = [];
    for (const [provider, entry] of Object.entries(parsed)) {
      for (const model of entry.models ?? []) {
        const info: EngineModelInfo = { provider, id: String(model.id ?? "") };
        if (!info.id) continue;
        if (typeof model.contextWindow === "number") info.contextWindow = model.contextWindow;
        if (typeof model.reasoning === "boolean") info.reasoning = model.reasoning;
        if ((model as { supportsImages?: unknown }).supportsImages === true) info.supportsImages = true;
        if (model.thinkingLevelMap && typeof model.thinkingLevelMap === "object") {
          info.supportedThinkingLevels = Object.keys(model.thinkingLevelMap);
        }
        out.push(info);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** models.json 自定义模型直读（{providers:{name:{models:[{id,reasoning,contextWindow,thinkingLevelMap,upstreamModelId,...}]}}}；
 * 读取失败返回空列表）。 */
function readCustomModels(agentDir: string): EngineModelInfo[] {
  const file = join(agentDir, "models.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      providers?: Record<string, { models?: unknown }>;
    };
    const out: EngineModelInfo[] = [];
    for (const [provider, entry] of Object.entries(parsed.providers ?? {})) {
      if (!entry || !Array.isArray(entry.models)) continue;
      for (const model of entry.models) {
        const m = model as {
          id?: unknown;
          reasoning?: unknown;
          contextWindow?: unknown;
          thinkingLevelMap?: unknown;
          upstreamModelId?: unknown;
        };
        const info: EngineModelInfo = { provider, id: String(m.id ?? "") };
        if (!info.id) continue;
        if (typeof m.contextWindow === "number") info.contextWindow = m.contextWindow;
        if (typeof m.reasoning === "boolean") info.reasoning = m.reasoning;
        if ((m as { supportsImages?: unknown }).supportsImages === true) info.supportsImages = true;
        if (typeof m.upstreamModelId === "string" && m.upstreamModelId !== "") {
          // 变体上游映射（docs08 2026-10-22 批次任务 18）：glm-5.3-4k → glm-5.3。
          // 仅非空字符串收下，非法形态一律视同缺失（非变体）。
          info.upstreamId = m.upstreamModelId;
        }
        if (m.thinkingLevelMap && typeof m.thinkingLevelMap === "object") {
          info.supportedThinkingLevels = Object.keys(m.thinkingLevelMap);
        }
        out.push(info);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 模型降级数据 = models-store.json 目录缓存 + models.json 自定义（同 provider/id
 * 自定义覆盖目录项，与引擎合并语义一致：自定义是显式用户配置）。导出供单测。 */
export function readModelsFallback(agentDir: string): EngineModelInfo[] {
  const catalog = readModelsStore(agentDir);
  const customs = readCustomModels(agentDir);
  if (customs.length === 0) return catalog;
  const keyed = new Map(catalog.map((m) => [`${m.provider}/${m.id}`, m]));
  for (const m of customs) keyed.set(`${m.provider}/${m.id}`, m);
  return [...keyed.values()];
}

/** 协议面模型行按 provider/id 合并自定义 upstreamId（docs08 2026-10-22 批次任务 18）：
 * 协议面返回的目录行不携带变体上游映射，models.json 自定义是唯一权威源；仅补缺失
 * 字段不改写行本身（增量兼容，旧客户端多收一个字段不受影响）。导出供单测。 */
export function mergeUpstreamIds(rows: EngineModelInfo[], agentDir: string): EngineModelInfo[] {
  if (rows.length === 0) return rows;
  const upstream = new Map<string, string>();
  for (const m of readCustomModels(agentDir)) {
    if (m.upstreamId !== undefined) upstream.set(`${m.provider}/${m.id}`, m.upstreamId);
  }
  if (upstream.size === 0) return rows;
  return rows.map((r) => {
    const up = upstream.get(`${r.provider}/${r.id}`);
    return up !== undefined && r.upstreamId !== up ? { ...r, upstreamId: up } : r;
  });
}

/** settings.json favoriteModels 直读（CLI 收藏）。条目形如 "provider/model:thinkingLevel"
 * （":max" 是收藏时的思考档，webui 选择态独立管理不消费——剥除后归一为 "provider/model"），
 * 去重保序；文件缺失/格式异常返回空列表。导出供单测。 */
export function readFavoriteModels(agentDir: string): string[] {
  const file = join(agentDir, "settings.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { favoriteModels?: unknown };
    if (!Array.isArray(parsed.favoriteModels)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of parsed.favoriteModels) {
      if (typeof raw !== "string") continue;
      const slash = raw.indexOf("/");
      if (slash <= 0) continue;
      const colon = raw.lastIndexOf(":");
      const value = colon > slash ? raw.slice(0, colon) : raw;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  } catch {
    return [];
  }
}

/** settings.json 默认模型直读（引擎 native 配置，docs08-r5 任务 2）：
 * defaultProvider + defaultModel 组成 "provider/model" 选中值，defaultThinkingLevel 为
 * 可选思考档。文件缺失/JSON 异常/字段缺失或非字符串一律 null，绝不抛错。导出供单测。 */
export function readDefaultModel(agentDir: string): { provider: string; model: string; thinkingLevel: string | null } | null {
  const file = join(agentDir, "settings.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      defaultProvider?: unknown;
      defaultModel?: unknown;
      defaultThinkingLevel?: unknown;
    };
    if (typeof parsed.defaultProvider !== "string" || parsed.defaultProvider === "") return null;
    if (typeof parsed.defaultModel !== "string" || parsed.defaultModel === "") return null;
    return {
      provider: parsed.defaultProvider,
      model: parsed.defaultModel,
      thinkingLevel: typeof parsed.defaultThinkingLevel === "string" ? parsed.defaultThinkingLevel : null,
    };
  } catch {
    return null;
  }
}

/**
 * 把管理器已 spawn 的 RpcClient 包装成 adapter 的 client 面：
 * start/stop 为 no-op（生命周期归管理器），其余方法全部委托。
 * 整体 cast 原因：getEntries 的 SessionEntry 与 adapter 的 EngineEntry 是同一 wire
 * 形态（adapter 层已按此假设映射，见 senpi-adapter.ts 的默认工厂同样处理）。
 */
function wrapLifecycleClient(client: RpcClient): SenpiRpcClient {
  // adapter 的就绪探测直接取 client.send（senpi-adapter.ts start()），包装层必须暴露
  const rawSend = (client as unknown as { send: (m: unknown) => Promise<{ success: boolean }> }).send.bind(client);
  const wrapped = {
    start: async () => {},
    stop: async () => {},
    send: (message: unknown) => rawSend(message),
    setClientInfo: (width: number, capabilities?: string[]) => client.setClientInfo(width, capabilities),
    openSession: (options: Parameters<SenpiRpcClient["openSession"]>[0]) =>
      client.openSession(options as never),
    closeSession: (sessionId?: string) => client.closeSession(sessionId),
    listSessions: () => client.listSessions(),
    getEntries: (since?: string) => client.getEntries(since),
    fork: (entryId: string, options?: { position?: "before" | "at" }) => client.fork(entryId, options),
    prompt: (message: string, options?: { thinkingLevel?: string; images?: EnginePromptInput["images"]; streamingBehavior?: EnginePromptInput["streamingBehavior"] }) =>
      client.prompt(message, options as never),
    abort: () => client.abort(),
    // 队列协议面（docs08-r4 任务 11）：包装层显式清单必须随 SenpiRpcClient 接口同步扩充，
    // 否则运行时实例缺方法（QA 实测 getSteeringMessages is not a function 即漏此处）
    clearQueue: (options?: { abortWillFollow?: boolean }) => client.clearQueue(options),
    getSteeringMessages: () => client.getSteeringMessages(),
    getFollowUpMessages: () => client.getFollowUpMessages(),
    onEvent: (listener: (event: { type: string; [key: string]: unknown }) => void) =>
      client.onEvent(listener as never),
    sendExtensionUIResponse: (response: Record<string, unknown>) =>
      client.sendExtensionUIResponse(response as never),
    getAvailableModels: () => client.getAvailableModels(),
    getAvailableThinkingLevels: () => client.getAvailableThinkingLevels(),
    // 会话状态快照（get_state；pendingQuestions q1 对账与 docs08-r6 任务 11 runState
    // 三态推导供源）。此前清单漏此方法（同上 QA 教训：必须随 SenpiRpcClient 同步），
    // 注册表路径下 pendingQuestions 运行时缺 getState——补齐。
    getState: () => client.getState(),
    // 斜杠命令面（docs08-r3 任务 19）：宿主 RpcClient 已解包 data.commands
    getCommands: () => client.getCommands(),
    getSessionStats: () => client.getSessionStats(),
    // 手动压缩（docs08-r5 任务 8）：包装层清单随 SenpiRpcClient 同步扩充（同上 QA 教训）
    compact: (customInstructions?: string) => client.compact(customInstructions),
    getMedia: (toolCallId: string, contentIndex: number) => client.getMedia(toolCallId, contentIndex),
  };
  return wrapped as unknown as SenpiRpcClient;
}

/** 单项目运行时：adapter 挂管 + 会话态 + 操作互斥 */
class ProjectRuntime {
  private adapter: EngineAdapter | null = null;
  private wrappedClient: RpcClient | null = null;
  /** API 世界的活跃会话 id（durable id 或未落盘别名） */
  private activeId: string | null = null;
  /** 当前处于 webui 驱动回合中的会话 id（单驱动 409 依据） */
  private streamingId: string | null = null;
  /** wire sessionId（routing handle）→ durable id 映射（SSE 信封注入用）：
   * 只记录 store 验证过的 durable id（open_session 响应 handle + activeSessions 行），
   * 查不到的 handle 如实透传不猜。引擎重启 handle 全换，invalidate 时清空。 */
  private readonly handleToDurable = new Map<string, string>();
  /** 防抖：handle 查询 miss 时至多一个在途的 activeSessions 刷新 */
  private refreshInFlight = false;
  /** 已验证的 durable id 集合（合成事件 sessionId 直接是 durable id，
   * 信封 durableLookup 需要能识别它以注入 durableSessionId）。 */
  private readonly knownDurable = new Set<string>();
  /** 未落盘新会话的 holder UUID → sessionPath 别名（仅内存，禁止持久化） */
  private readonly aliases = new Map<string, string>();
  /** 引擎已认领 durable id 但会话文件从未落盘（docs08-2026-10-23-24-batch 任务 6，
   * t1 根因形态：RpcClient × 旧版引擎 open_session 认领 sessionFile 却不写盘）。
   * id → 认领的 sessionPath；resolveSession 对这类 id 报结构化 session_not_persisted
   * 而非笼统 404，落盘补齐（prompt 回执复核）后解除。 */
  private readonly unpersistedClaims = new Map<string, string>();
  /** 操作互斥链：串行化「切换活跃会话 + 作用于活跃会话」的关键区 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 回合进行中会话的 sessionPath（GET /api/sessions 的 active 字段依据，todo 15 修复） */
  private streamingPath: string | null = null;
  /** 回合序号：每次 prompt 接受自增；收尾监视的过期判定用 */
  private roundSeq = 0;
  /** 收尾监视定时器（仅回合进行中运行，严禁常态化轮询） */
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 已计过未读的 assistant 消息 id（幂等去重；封顶防泄漏） */
  private readonly countedMessages = new Set<string>();
  /** A5 速度环容量：每会话保留最近 N 条 assistant 消息 tok/s 样本（endedAt 序滑动） */
  private static readonly TURN_RING_CAPACITY = 20;
  /** 速度环在途起点封顶（end 缺席如引擎崩溃时不无限积累，同 countedMessages 处置） */
  private static readonly TURN_START_CAP = 200;
  /** A5 回合速度环：durable id → 最近 N 条 tok/s 样本（内存态，invalidate 清空，不落库） */
  private readonly turnSpeedByDurable = new Map<string, EngineTurnSample[]>();
  /** 在途 assistant 消息起点：wire sessionId（routing handle）→ { 起始时刻, durable 解析快照 }。
   * 真实 wire 的 message_start/end 无消息 id 字段（QA SSE 实证 2026-10-13：帧形态
   * {type,message,sessionId}；前端 fixtures 的 id 形态是落盘条目合成物）——配对依赖
   * 同会话 assistant 消息流式串行不重叠的计划假设（同一 handle 同时至多一条 assistant
   * 在途；间插的 user start/end 不触碰本表，随后被本会话下一条 assistant start 覆盖）。 */
  private readonly messageStartAt = new Map<string, { at: number; durable: string | undefined }>();

  constructor(
    private readonly manager: EngineProcessManager,
    readonly projectPath: string,
    private readonly opts: EngineRuntimeOptions,
  ) {}

  /** 引擎进程是否已就绪（不触发 spawn） */
  isReady(): boolean {
    return this.manager.getStatus(this.projectPath)?.state === "ready" && this.adapter !== null;
  }

  /**
   * 确保引擎进程就绪且 adapter 可用。管理器崩溃自动重启后会造新 client，
   * 检测到 client 更换即重建 adapter（旧 adapter 挂着死连接）并清空会话态。
   */
  async ensure(): Promise<void> {
    await this.manager.ensureRunning(this.projectPath);
    const client = this.manager.getClient(this.projectPath);
    if (!client) {
      throw new ApiError(503, "engine_not_ready", `项目引擎未就绪：${this.projectPath}`);
    }
    if (!this.adapter || this.wrappedClient !== client) {
      this.wrappedClient = client;
      this.activeId = null;
      this.streamingId = null;
      this.streamingPath = null;
      this.aliases.clear();
      this.unpersistedClaims.clear();
      this.handleToDurable.clear();
      this.knownDurable.clear();
      this.stopSettleWatch();
      const adapter: SenpiAdapter = new SenpiAdapter({
        projectDir: this.projectPath,
        agentDir: this.opts.agentDir ?? defaultAgentDir(),
        clientFactory: () => wrapLifecycleClient(client),
      });
      await adapter.start();
      this.adapter = adapter;
      // 回合结束信号：abort 与正常收尾都会发 agent_end / agent_settled
      // （docs/verification/01 abort 实证），清单驱动标记与收尾监视。
      adapter.events((event) => {
        const wire = event as {
          type?: string;
          sessionId?: unknown;
          id?: unknown;
          entry?: { type?: unknown; id?: unknown; message?: { role?: unknown } };
          message?: { role?: unknown; usage?: unknown };
        };
        const type = wire.type;
        if (type === "agent_end" || type === "agent_settled" || type === "agent_idle") {
          // 事件归属校验（决策 9a）：wire sessionId（routing handle）解析出的 durable
          // id 必须等于 streamingId 才算本回合收尾；不一致（同项目并发另一回合的
          // 收尾事件）只清位不触发。解析不出（holder 别名回合的 handle 无 durable
          // 映射）同样视为归属未证明只清位——别名回合由 settle watchdog 合成路径兜底。
          const settleInfo =
            typeof wire.sessionId === "string"
              ? this.captureSettleInfo(this.durableSessionIdFor(wire.sessionId))
              : null;
          this.settleRound();
          if (settleInfo) this.opts.onRoundSettled?.(this.projectPath, settleInfo, type);
          return;
        }
        // A5 回合速度环挂点：assistant 消息 message_start 记起点、message_end 取
        // message.usage.output 配对（05 P1-4：消息级 usage 落在 message_end 上）。
        // user 消息同样产生两事件但无 usage 实证（05 P1-4），一律忽略。
        if (type === "message_start" || type === "message_end") {
          this.recordTurnSpeedEvent(wire, type);
          return;
        }
        // 未读计数接线（todo 15 发现刷新归零）：assistant 消息条目落地即 unread+1。
        // 事件源取 entry_appended（entry.type==="message" 且 role=assistant）——
        // entry.id 是磁盘条目 id，天然满足「按 entryId 幂等」；message_end 的
        // message 体无 id 字段（实证），不作未读源。
        // 设计取舍：主动查看中的会话同样递增——前端在回合落定时对当前选中会话
        // 补发 POST /:id/read（清零+last_read），服务端不做「正在看」判定。
        if (type === "entry_appended" && wire.entry && wire.entry.type === "message") {
          const role = wire.entry.message?.role;
          const entryId = typeof wire.entry.id === "string" ? wire.entry.id : undefined;
          const handle = typeof wire.sessionId === "string" ? wire.sessionId : undefined;
          if (role === "assistant" && entryId && handle) {
            this.recordUnreadFor(handle, entryId);
          }
        }
      });
    }
  }

  /** assistant 消息条目落地 → unread+1；按 entry id 幂等（同一 entry 只计一次）。 */
  private recordUnreadFor(handle: string, entryId: string): void {
    if (this.countedMessages.has(entryId)) return;
    this.countedMessages.add(entryId);
    if (this.countedMessages.size > 2000) {
      // Set 保持插入序，裁掉最早的半量，防长驻进程缓慢泄漏
      for (const key of [...this.countedMessages].slice(0, 1000)) this.countedMessages.delete(key);
    }
    const durable = this.durableSessionIdFor(handle);
    if (durable) this.opts.recordUnread?.(this.projectPath, durable);
  }

  /** A5 挂点实现：assistant 消息 start/end 配对 → tok/s 样本入环。
   * 配对口径铁律：仅 assistant 消息；起点按 wire sessionId 存取（同 handle 同时至多
   * 一条 assistant 在途的串行假设，见字段注释）；无配对起点、output ≤ 0、elapsed ≤ 0
   * 或非有限值的样本一律丢弃。
   * durable 解析用回调作用域内现成的 durableSessionIdFor（prompt 回执已回填映射，
   * assistant 事件到达时正常命中）；miss 时起点快照存 undefined，end 再解析一次。 */
  private recordTurnSpeedEvent(
    wire: { sessionId?: unknown; message?: { role?: unknown; usage?: unknown } },
    phase: "message_start" | "message_end",
  ): void {
    if (wire.message?.role !== "assistant") return;
    const handle = typeof wire.sessionId === "string" ? wire.sessionId : undefined;
    if (handle === undefined) return;
    if (phase === "message_start") {
      if (this.messageStartAt.size >= ProjectRuntime.TURN_START_CAP) {
        // Map 保持插入序，裁掉最早半量残留（end 缺席样本不再积累）
        for (const key of [...this.messageStartAt.keys()].slice(0, ProjectRuntime.TURN_START_CAP / 2)) {
          this.messageStartAt.delete(key);
        }
      }
      this.messageStartAt.set(handle, {
        at: Date.now(),
        durable: this.durableSessionIdFor(handle),
      });
      return;
    }
    const start = this.messageStartAt.get(handle);
    this.messageStartAt.delete(handle);
    if (!start) return;
    const usage = (wire.message.usage ?? null) as Record<string, unknown> | null;
    const output = usage && typeof usage === "object" ? Number(usage.output) : NaN;
    const elapsedMs = Date.now() - start.at;
    if (!Number.isFinite(output) || output <= 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
    const durable = start.durable ?? this.durableSessionIdFor(handle);
    if (!durable) return;
    const ring = this.turnSpeedByDurable.get(durable) ?? [];
    ring.push({ tokPerSec: output / (elapsedMs / 1000), endedAt: new Date().toISOString() });
    if (ring.length > ProjectRuntime.TURN_RING_CAPACITY) ring.shift();
    this.turnSpeedByDurable.set(durable, ring);
  }

  /** A5 速度环只读快照（turns 为拷贝防外泄内部数组；空环 averageTokPerSec=0） */
  private turnSpeedSnapshot(durable: string): EngineTurnSpeed {
    const ring = this.turnSpeedByDurable.get(durable) ?? [];
    const turns = ring.map((t) => ({ ...t }));
    const averageTokPerSec =
      turns.length > 0 ? turns.reduce((sum, t) => sum + t.tokPerSec, 0) / turns.length : 0;
    return { turns, averageTokPerSec };
  }

  // ---- 收尾监视（todo 16 实证：个别回合收尾 wire 事件全部缺席）----
  // prompt 接受后以 settlePollMs 间隔 get_state 辅助监视：引擎确实空闲
  // （isStreaming=false）且宽限期内真实收尾事件未到 → 合成 agent_settled
  //（synthetic:true）进事件流，保证下游「回合结束」语义完整。仅在回合
  // 进行中运行，回合正常收尾即停；消息内容补全靠前端 GET messages 兜底。

  /** prompt 接受后启动收尾监视（幂等；同一时刻只有一个回合在驱动的项目级单例） */
  private startSettleWatch(): void {
    if (this.settleTimer) return;
    const pollMs = this.opts.settlePollMs ?? 2000;
    this.settleTimer = setInterval(() => {
      void this.checkSettle().catch(() => undefined);
    }, pollMs);
    this.settleTimer.unref?.();
  }

  private stopSettleWatch(): void {
    if (this.settleTimer) {
      clearInterval(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private async checkSettle(): Promise<void> {
    if (this.streamingId === null || !this.adapter) {
      this.stopSettleWatch();
      return;
    }
    const seq = this.roundSeq;
    const client = this.wrappedClient;
    if (!client) return;
    let isStreaming: unknown;
    try {
      const state = await (client as unknown as { getState: () => Promise<{ isStreaming?: unknown }> }).getState();
      isStreaming = state.isStreaming;
    } catch {
      return; // get_state 偶发失败不判收尾，下一轮再查
    }
    if (isStreaming !== false || this.streamingId === null || seq !== this.roundSeq) return;
    // 引擎已空闲但真实收尾事件未到：宽限一次（真实事件迟到则落定后跳过）
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.streamingId === null || seq !== this.roundSeq) return;
      this.synthesizeSettled(seq);
    }, this.opts.settleGraceMs ?? 5000);
    this.graceTimer.unref?.();
  }

  /** 清位前捕获回合收尾信息（streamingId/streamingPath 仍在时才有效）。
   * resolvedDurable 为 wire sessionId 的 durable 解析结果：非 undefined 时必须
   * 等于 streamingId（归属证明），不一致返回 null（并发错触防护，决策 9a）。 */
  private captureSettleInfo(
    resolvedDurable: string | undefined,
  ): { sessionId: string; sessionPath: string } | null {
    if (this.streamingId === null || this.streamingPath === null) return null;
    if (resolvedDurable !== undefined && resolvedDurable !== this.streamingId) return null;
    return { sessionId: this.streamingId, sessionPath: this.streamingPath };
  }

  /** 合成 agent_settled：带 synthetic 标记；sessionId 直接用 durable id
   *（流式中的会话必已 open，identity 已知），前端信封回退路径可直接路由。 */
  private synthesizeSettled(seq: number): void {
    if (this.streamingId === null || seq !== this.roundSeq) return;
    const sessionId = this.streamingId;
    // 合成路径 sessionId 即 streamingId（knownDurable 令信封 durableLookup 直认
    // durable 形态）；settleInfo 清位前捕获，onRoundSettled reason="settle_watchdog"
    const settleInfo =
      this.streamingPath !== null ? { sessionId, sessionPath: this.streamingPath } : null;
    this.settleRound();
    if (settleInfo) this.opts.onRoundSettled?.(this.projectPath, settleInfo, "settle_watchdog");
    this.opts.publishSyntheticEvent?.(this.projectPath, {
      type: "agent_settled",
      synthetic: true,
      sessionId,
      reason: "settle_watchdog",
    });
  }

  /** 回合落定：清流式标记（GET /api/sessions active 随之清位）+ 停监视 */
  private settleRound(): void {
    this.streamingId = null;
    this.streamingPath = null;
    this.stopSettleWatch();
  }

  /** 引擎进程崩溃/不可用：回合进行中则先合成收尾事件（reason:"engine_crash"）——
   * 前端 agent_settled 驱动 settleStreaming 立即解锁、可继续发新 prompt（消息内容
   * 缺口靠 GET messages 兜底）；随后 invalidate 清态（active 清位 + handle 映射清空，
   * adapter 由 ensure() 按 client 更换重建）。不合成则前端流式态挂死至手动刷新。 */
  crashSettle(): void {
    if (this.streamingId !== null) {
      const sessionId = this.streamingId;
      const seq = this.roundSeq;
      this.settleRound();
      if (seq === this.roundSeq) {
        this.opts.publishSyntheticEvent?.(this.projectPath, {
          type: "agent_settled",
          synthetic: true,
          sessionId,
          reason: "engine_crash",
        });
      }
    }
    this.invalidate();
  }

  /** 崩溃/重启时清空会话态（adapter 留给 ensure() 按 client 更换重建）。
   * handle→durable 映射一并清空：旧 handle 属于已死进程，保留只会误映射。 */
  invalidate(): void {
    this.activeId = null;
    this.streamingId = null;
    this.streamingPath = null;
    this.aliases.clear();
    this.unpersistedClaims.clear();
    this.handleToDurable.clear();
    this.knownDurable.clear();
    this.stopSettleWatch();
    // A5 速度环同属会话态：崩溃/重启后 handle 全换，内存环清空属预期（自然重建）
    this.turnSpeedByDurable.clear();
    this.messageStartAt.clear();
  }

  /** 引擎就绪时的**回合进行中**会话路径（active 字段语义 = 回合进行中，todo 15 修复） */
  async activeSessionPaths(): Promise<string[]> {
    if (!this.adapter) return [];
    // open 态行有副产物价值：顺带回填 handle→durable 映射（权威来源）
    try {
      const rows = await this.adapter.activeSessions();
      this.rememberHandleRows(rows);
    } catch {
      // 探询失败不阻塞 active 判定
    }
    return this.streamingPath ? [this.streamingPath] : [];
  }

  /** 运行态三态探询（docs08-r6 任务 11，EngineGateway.peekRunStates 供源）：只读现有
   *  状态三源推导——streamingId 占用（activeSessionPaths 同源同帧，单驱动至多一条）；
   *  引擎快照 pendingPermissions 非空（项目级记账，单驱动下 webui 回合至多一个，
   *  与流式会话归属一致；异端会话的权限无会话归属可用，作用域限流式会话行）；
   *  流式会话 pendingQuestions 非空（阻塞型提问挂起回合）。仅回合在途才发这一次
   *  get_state（经 questionsList：ensure 前置 isReady 已就绪不 spawn、switchTo 对
   *  流式会话幂等），列表刷新零常态 RPC；失败按无未决提问降级不炸列表。
   *  未就绪返回 null（不触发 spawn，active 同口径）。 */
  async peekRunStates(): Promise<Map<string, ServerSessionRunState> | null> {
    if (!this.isReady()) return null;
    const paths = await this.activeSessionPaths();
    const out = new Map<string, ServerSessionRunState>();
    if (paths.length === 0 || this.streamingId === null) return out;
    const permission = (this.manager.getStatus(this.projectPath)?.pendingPermissions.length ?? 0) > 0;
    let question = false;
    try {
      question = (await this.questionsList(this.streamingId)).length > 0;
    } catch {
      // get_state 失败按无未决提问降级：runState 落 running，不因探询失败炸整个列表
    }
    out.set(paths[0], deriveSessionRunState({ streaming: true, permission, question }));
    return out;
  }

  /** 活跃会话行的 handle→durableSessionId 回填（list_sessions 行两个字段都有，权威来源） */
  private rememberHandleRows(rows: Array<{ sessionId?: string; durableSessionId?: string }>): void {
    for (const row of rows) {
      if (row.sessionId && row.durableSessionId) {
        this.handleToDurable.set(row.sessionId, row.durableSessionId);
        this.knownDurable.add(row.durableSessionId);
      }
    }
  }

  /** wire sessionId → durable id：routing handle 查映射；合成事件的 sessionId
   * 本身就是 durable id（直认）。其余（未知 handle）返回 undefined（透传不猜）。
   * miss 时异步刷新一次活跃会话行（去重防事件风暴期间 RPC 刷屏）。 */
  durableSessionIdFor(handle: string): string | undefined {
    const hit = this.handleToDurable.get(handle);
    if (hit !== undefined) return hit;
    if (this.knownDurable.has(handle)) return handle;
    if (!this.refreshInFlight && this.adapter) {
      this.refreshInFlight = true;
      void this.adapter
        .activeSessions()
        .then((rows) => this.rememberHandleRows(rows))
        .catch(() => undefined)
        .finally(() => {
          this.refreshInFlight = false;
        });
    }
    return undefined;
  }

  /** SDK 直读会话库（不依赖引擎进程，sessionsList 不走 rpc） */
  async listStore(): Promise<EngineSessionSummary[]> {
    if (!this.adapter) {
      // 未 start 的 adapter 只有 options + sessionsList 可用（sessionsList 不调 rpc）
      this.adapter = new SenpiAdapter({
        projectDir: this.projectPath,
        agentDir: this.opts.agentDir ?? defaultAgentDir(),
      });
    }
    return this.adapter.sessionsList(this.projectPath);
  }

  /** 在本项目中按 id 查会话（活跃态 → store 行 → 未落盘别名）；查不到抛 404 */
  async resolveSession(sessionId: string): Promise<EngineSessionSummary> {
    // 引擎认领却从未落盘的会话（t1 根因形态）：先于三级查找报结构化错误——
    // 笼统 404「会话不存在」会让用户误以为删库，实际是引擎承诺的 sessionFile
    // 从未写盘（任务 6 消静默）。409 与 exportSessionHtml 的 session_not_persisted 同码。
    const claimedPath = this.unpersistedClaims.get(sessionId);
    if (claimedPath) {
      // 自愈：若引擎此后补写了文件（懒落盘），解除认领记录按正常会话解析
      if (existsSync(claimedPath)) {
        this.unpersistedClaims.delete(sessionId);
      } else {
        throw new ApiError(
          409,
          "session_not_persisted",
          `会话被引擎认领但从未落盘（${claimedPath}），数据可能未持久化：${sessionId}`,
        );
      }
    }
    // 活跃会话快捷路径：刚创建未落盘的会话不在 store 行内，活跃态即可定位
    if (this.activeId === sessionId) {
      const active = this.adapter?.getActiveSession();
      if (active) {
        return {
          path: active.sessionPath,
          id: sessionId,
          cwd: this.projectPath,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 0,
          firstMessage: "",
        };
      }
    }
    const rows = await this.listStore();
    const row = rows.find((r) => r.id === sessionId);
    if (row) return row;
    const aliasPath = this.aliases.get(sessionId);
    if (aliasPath) {
      return {
        path: aliasPath,
        id: sessionId,
        cwd: this.projectPath,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 0,
        firstMessage: "",
      };
    }
    throw new ApiError(404, "session_not_found", `会话不存在（项目 ${this.projectPath}）：${sessionId}`);
  }

  /** Fix0 性能埋点（docs08-2026-10-22-batch 任务 1；UL_OMO_WEBUI_DEBUG_PERF 默认关）：
   * 包一层 ④ensure 计时 + ②runExclusive 排队计时，body 内部自记 ③switchTo/①rpc 段；
   * 收尾（含失败）统一落一行 [perf] 日志。关闭路径与原实现等价：不建 span、不计时，
   * 仅 body 写入共享哑对象（无读者）。 */
  private runTraced<T>(op: string, sessionId: string, body: (span: PerfSpan) => Promise<T>): Promise<T> {
    if (!DEBUG_PERF) {
      // 关闭路径与原实现等价：ensure() 就绪后再进互斥队列（原方法体逐字语义）
      return this.ensure().then(() => this.runExclusive(() => body(INERT_PERF_SPAN)));
    }
    const span: PerfSpan = { op, proj: projHash8(this.projectPath), session: sessionId };
    const t0 = performance.now();
    return this.ensure()
      .catch((err) => {
        span.ensureMs = performance.now() - t0;
        span.err = perfErrCode(err);
        throw err;
      })
      .then(() => {
        span.ensureMs = performance.now() - t0;
        const tEnqueue = performance.now();
        return this.runExclusive(async () => {
          span.queueWaitMs = performance.now() - tEnqueue;
          return body(span);
        });
      })
      .catch((err) => {
        span.err ??= perfErrCode(err);
        throw err;
      })
      .finally(() => logPerfSpan(span));
  }

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** 确保目标会话是 adapter 活跃会话（open 切换；同会话幂等） */
  private async switchTo(sessionId: string): Promise<void> {
    const adapter = this.requireAdapter();
    if (this.activeId === sessionId && adapter.getActiveSession()) return;
    const row = await this.resolveSession(sessionId);
    const opened = await adapter.openSession({ sessionPath: row.path });
    this.activeId = sessionId;
    // wire 事件的 sessionId 就是这个 routing handle（open_session 响应顶层的
    // sessionId）；store 行解析出的 id（非别名）即可作为 durable 映射记录
    if (!this.aliases.has(sessionId)) this.rememberHandle(opened.routingId, sessionId);
  }

  private rememberHandle(handle: string | undefined, durableId: string | undefined): void {
    if (!handle || !durableId) return;
    this.handleToDurable.set(handle, durableId);
    this.knownDurable.add(durableId);
  }

  requireAdapter(): EngineAdapter {
    if (!this.adapter) throw new ApiError(409, "not_started", "项目运行时未初始化");
    return this.adapter;
  }

  async createSession(opts: {
    provider?: string;
    modelId?: string;
    thinkingLevel?: EngineThinkingLevel;
  }): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    await this.ensure();
    const adapter = this.requireAdapter();
    return this.runExclusive(async () => {
      const opened: EngineOpenSessionResult = await adapter.openSession({
        provider: opts.provider,
        modelId: opts.modelId,
        thinkingLevel: opts.thinkingLevel,
      });
      // durable id 解析：活跃会话行的 durableSessionId 是引擎侧磁盘 header id
      // （docs/verification/05 P1-1：list_sessions 行含 durableSessionId）。
      // 新会话未落盘时行可能缺失 durableSessionId，退化为 holder 别名（仅内存）。
      let id = opened.sessionId;
      let durable = false;
      let claimed = false;
      try {
        const rows = await adapter.activeSessions();
        this.rememberHandleRows(rows);
        const row = rows.find((r) => r.sessionPath === opened.sessionPath && r.durableSessionId);
        if (row?.durableSessionId) {
          id = row.durableSessionId;
          claimed = true;
          // durable 判定以磁盘为准（t1 根因：旧版引擎 list_sessions 行带 durableSessionId
          // 但会话 JSONL 从未写盘——口头认领不可信）。文件不存在时降级为别名并登记
          // 未落盘认领，resolveSession 据此报结构化 session_not_persisted 而非 404。
          durable = existsSync(opened.sessionPath);
        }
      } catch {
        // 活跃行查询失败不影响建会话，退化为别名
      }
      if (!durable) {
        this.aliases.set(id, opened.sessionPath);
        if (claimed) this.unpersistedClaims.set(id, opened.sessionPath);
      } else {
        // open_session 响应顶层 sessionId 即 routing handle（wire 事件同源）
        this.rememberHandle(opened.routingId, id);
      }
      this.activeId = id;
      return { id, sessionPath: opened.sessionPath, durable };
    });
  }

  async messages(sessionId: string, cursor?: string): Promise<EngineMessagesPage> {
    return this.runTraced("messages", sessionId, async (span) => {
      const tSwitch = performance.now();
      await this.switchTo(sessionId);
      span.switchToMs = performance.now() - tSwitch;
      const tRpc = performance.now();
      const page = await this.requireAdapter().messages(cursor);
      span.rpcMs = performance.now() - tRpc;
      span.entries = page.entries.length;
      return page;
    });
  }

  async prompt(
    sessionId: string,
    input: {
      text: string
      images?: EnginePromptInput["images"]
      model?: string
      thinkingLevel?: EngineThinkingLevel
      streamingBehavior?: EnginePromptInput["streamingBehavior"]
    },
  ): Promise<{ disposition: string; durableSessionId?: string; appliedModel?: string }> {
    return this.runTraced("prompt", sessionId, async (span) => {
      // 单驱动约束（P2-11）：目标会话已有 webui 驱动回合时明确 409，不排队不双驾驶。
      // docs08-r4 任务 11（spike 实证）：携带 streamingBehavior 时放行——prompt 入引擎队列
      // （回执 "queued"），streamingId 保持占用（排队回合同一 run，run 尾才 settle 一次）。
      // 跨窗口 409 落点见下方 catch 的 already processing 映射，语义不变。
      if (this.streamingId === sessionId && !input.streamingBehavior) {
        throw new ApiError(409, "already_processing", "该会话已有进行中的回合（单驱动约束，请先 abort 或等待回合结束）");
      }
      const tSwitch = performance.now();
      await this.switchTo(sessionId);
      span.switchToMs = performance.now() - tSwitch;
      const tRpc = performance.now();
      // docs08-r6 任务 8 ②：切换成功的模型行归一 "provider/model" 随回执带回（回执可观测）；
      // 排队请求（streamingBehavior）不走此分支——排队剥模型铁律在 api.ts 注入点，服务端此处不变
      let appliedModel: string | undefined;
      if (input.model) {
        const row = await this.switchModel(input.model);
        appliedModel = `${row.provider}/${row.id}`;
      }
      const adapter = this.requireAdapter();
      try {
        const receipt = await adapter.prompt({
          text: input.text,
          images: input.images,
          thinkingLevel: input.thinkingLevel,
          streamingBehavior: input.streamingBehavior,
        });
        span.rpcMs = performance.now() - tRpc;
        // disposition="handled"（如 /命令）表示没有开启回合，不等 agent_settled
        if (receipt.disposition !== "handled") {
          this.streamingId = sessionId;
          this.streamingPath = adapter.getActiveSession()?.sessionPath ?? null;
          this.roundSeq += 1;
          this.startSettleWatch();
        }
        // 首条消息落盘回执补全（缺陷修复：新会话首条用户消息不显示）：未落盘别名会话
        // 此刻已被引擎写盘，durable id 就绪。立即回填 handle→durable 映射——本轮后续
        // wire 事件（assistant 流式等）即时携带 durableSessionId，不再依赖 miss 时的
        // 防抖刷新；并把真实 id 随回执带回，前端即时换 key。
        if (this.aliases.has(sessionId)) {
          try {
            const rows = await adapter.activeSessions();
            this.rememberHandleRows(rows);
            const sessionPath = this.aliases.get(sessionId);
            const row = rows.find((r) => r.sessionPath === sessionPath && r.durableSessionId);
            if (row?.durableSessionId && sessionPath) {
              // 落盘复核（任务 6）：引擎此时认领了 durable id 但文件仍不存在，
              // 说明回合结果不会持久化——立即回传结构化错误，绝不静默放行
              // （否则下游 messages/resolve 全部 404「会话不存在」，t1 事发现场形态）。
              if (!existsSync(sessionPath)) {
                this.unpersistedClaims.set(row.durableSessionId, sessionPath);
                throw new ApiError(
                  409,
                  "session_not_persisted",
                  `引擎已认领会话 ${row.durableSessionId} 但会话文件未落盘（${sessionPath}），回合结果无法持久化`,
                );
              }
              this.unpersistedClaims.delete(row.durableSessionId);
              // 别名保留（resolveSession 仍需兜底在途的旧 id 请求）；活跃/流式位切到
              // 真实 id——单驱动 409 守卫按 id 比较，前端换 key 后以真实 id 再来也拦得住
              this.activeId = row.durableSessionId;
              if (this.streamingId === sessionId) this.streamingId = row.durableSessionId;
              return { disposition: receipt.disposition, durableSessionId: row.durableSessionId, appliedModel };
            }
          } catch (err) {
            // 落盘复核的结构化错误必须上抛（消静默）；仅活跃行查询失败才退回原回执
            if (err instanceof ApiError) throw err
          }
        }
        return appliedModel !== undefined ? { ...receipt, appliedModel } : receipt;
      } catch (err) {
        // 外部驱动或事件丢失兜底：引擎进程内守卫的报错映射为同一 409 语义
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("already processing")) {
          throw new ApiError(409, "already_processing", "引擎报告会话正在处理中（单驱动约束）");
        }
        throw err;
      }
    });
  }

  /** 排队对账快照（断线重连/初次渲染各拉一次；增量走 queue_update wire 事件透传） */
  async queueList(sessionId: string): Promise<EngineQueueSnapshot> {
    return this.runTraced("queueList", sessionId, async (span) => {
      const tSwitch = performance.now();
      await this.switchTo(sessionId);
      span.switchToMs = performance.now() - tSwitch;
      const tRpc = performance.now();
      const snapshot = await this.requireAdapter().queueList();
      span.rpcMs = performance.now() - tRpc;
      span.entries = snapshot.ordered.length;
      return snapshot;
    });
  }

  /** 整队清空（返回被撤项；单条撤销由前端清空后保留项重新入队实现） */
  async queueClear(sessionId: string): Promise<EngineQueueSnapshot> {
    await this.ensure();
    return this.runExclusive(async () => {
      await this.switchTo(sessionId);
      return this.requireAdapter().queueClear();
    });
  }

  /** 未决提问对账快照（q1 提问卡片；同 queue 口径——前端会话打开时拉一次，
   *  增量走 SSE 的 question 帧透传；get_state 快照无 sessionId，此处注入本会话 id） */
  async questionsList(sessionId: string): Promise<EngineQuestionFrame[]> {
    return this.runTraced("questionsList", sessionId, async (span) => {
      const tSwitch = performance.now();
      await this.switchTo(sessionId);
      span.switchToMs = performance.now() - tSwitch;
      const tRpc = performance.now();
      const frames = await this.requireAdapter().pendingQuestions();
      span.rpcMs = performance.now() - tRpc;
      span.entries = frames.length;
      // 快照帧不带会话归属（引擎侧 per-session 存储，出队即知归属）——注入当前
      // 请求的会话 id（REST 层的 :id 即 durable/别名，前端 store 键口径一致）
      return frames.map((f) => ({ ...f, sessionId }));
    });
  }

  /** adapter 无模型切换面（接口未含 setModel）；直接走协议命令，仅作用于当前活跃会话。
   * docs08-r6 任务 8 ①：显式取 client——引擎未挂时明确 503（forkSession 同款范式），
   * 绝不静默跳过（可选链会让模型切换无声失效，prompt 照发旧模型）；成功回模型行
   * （SDK setModel 契约 {provider,id}，connection-handler set_model success 行）供回执取 appliedModel */
  private async switchModel(model: string): Promise<{ provider: string; id: string }> {
    const slash = model.indexOf("/");
    if (slash <= 0) {
      throw new ApiError(400, "invalid_model", `model 需为 "provider/model" 形态：${model}`);
    }
    const provider = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    const client = this.wrappedClient;
    if (!client) throw new ApiError(503, "engine_not_ready", "项目引擎未就绪");
    return client.setModel(provider, modelId);
  }

  async abort(sessionId: string): Promise<void> {
    await this.ensure();
    return this.runExclusive(async () => {
      await this.switchTo(sessionId);
      // r11 todo 11（task-10 spike §2.2 定向）：权限等待态的中止在引擎面是静默 no-op
      // ——abort 200/11ms 后零帧、回合悬起 >5min、仅引擎重建可解除（实测取证：
      // .omo/evidence/r11/task-10-abort-spike.md §2.2）。修法：中止前把本回合挂起
      // 的权限请求经既有应答通道逐个取消（{cancelled:true}，与前端权限卡「忽略」
      // 同 wire 形态且对四型请求通用）：挂起工具以取消结果返回 → 回合自然收束 →
      // agent_end 可达（与提问等待 abort 的 question_resolved 收尾同机制，spike
      // §2.3 实证 +176ms）。仅当目标会话确为 webui 驱动回合（streamingId 占用）才
      // 执行，防跨会话误拒；快照在 runExclusive 锁内读取（单驱动下项目级记账至多
      // 对应本回合）。内联 adapter.permissionRespond + reportPermissionAnswered
      // （与公开 permissionRespond 同通道）而非复用公开方法——锁内重入 runExclusive
      // 会把 deny 排到本 abort 之后，破坏「先解权限门、后中止回合」的帧序。
      const adapter = this.requireAdapter();
      if (this.streamingId === sessionId) {
        const pending = this.manager.getStatus(this.projectPath)?.pendingPermissions ?? [];
        for (const requestId of pending) {
          await adapter.permissionRespond(requestId, { cancelled: true });
          this.manager.reportPermissionAnswered(this.projectPath, requestId);
        }
      }
      await adapter.abort();
    });
  }

  async permissionRespond(sessionId: string, requestId: string, reply: EnginePermissionReply): Promise<void> {
    await this.ensure();
    return this.runExclusive(async () => {
      await this.switchTo(sessionId);
      await this.requireAdapter().permissionRespond(requestId, reply);
      // 应答 wire 上无事件回声，必须显式上报解除忙判定（todo 8 空闲回收口径）
      this.manager.reportPermissionAnswered(this.projectPath, requestId);
    });
  }

  async usage(sessionId: string): Promise<EngineUsageStats> {
    return this.runTraced("usage", sessionId, async (span) => {
      const tSwitch = performance.now();
      await this.switchTo(sessionId);
      span.switchToMs = performance.now() - tSwitch;
      const tRpc = performance.now();
      const stats = await this.requireAdapter().usage();
      span.rpcMs = performance.now() - tRpc;
      // A5：附加内存速度环快照（durable 键）。别名 id（未落盘窗口）无映射则不下发
      // turnSpeed，前端按"暂无数据"降级；此时环内也尚无样本（样本归属真实 durable id）。
      const durable = this.durableSessionIdFor(sessionId);
      return durable ? { ...stats, turnSpeed: this.turnSpeedSnapshot(durable) } : stats;
    });
  }

  /** 手动压缩（docs08-r5 任务 8）：流式守卫 → 协议面 compact → 压缩后 usage 快照。
   *  引擎侧失败形态映射（spike 实证）："Already compacted"/"Nothing to compact"
   *  → 409 业务码（前端明示，不静默）；其余原样上抛（route 包装统一 500）。 */
  async compact(sessionId: string): Promise<{ result: EngineCompactResult; usage: EngineUsageStats }> {
    await this.ensure();
    return this.runExclusive(async () => {
      // 单驱动纪律：回合中拒绝——引擎 manual compact 会先 abort 活动回合
      // （agent-session.compact "Aborts the current agent operation first"），
      // webui 语义下隐式中断用户回合不可接受，明确 409 与 prompt 同码。
      if (this.streamingId === sessionId) {
        throw new ApiError(409, "already_processing", "该会话回合进行中，压缩前请先等待回合结束或中断");
      }
      await this.switchTo(sessionId);
      let result: EngineCompactResult;
      try {
        result = await this.requireAdapter().compactSession();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("Already compacted")) {
          throw new ApiError(409, "already_compacted", "上下文已压缩过，无新的可压缩内容");
        }
        if (message.includes("Nothing to compact")) {
          throw new ApiError(409, "nothing_to_compact", "会话上下文还很小，暂无需压缩");
        }
        throw err;
      }
      // 压缩后权威水位：同锁内取快照，前端 toast 与水位环直接对比 tokensBefore
      const stats = await this.requireAdapter().usage();
      return { result, usage: stats };
    });
  }

  async modelsList(): Promise<EngineModelInfo[]> {
    // 引擎未就绪时不为模型列表触发冷启动 spawn，直接走模型目录降级
    //（models-store.json 目录缓存 + models.json 自定义，同 id 自定义覆盖——
    // 自定义模型不依赖引擎拉起即可见，修复"下拉只显示套餐目录"缺陷）。
    // 三路径统一携带 upstreamId（任务 18）：两条降级路径经 readModelsFallback
    // 自定义覆盖自然携带；活跃会话路径由 mergeUpstreamIds 按 provider/id 补齐。
    if (!this.isReady()) return readModelsFallback(this.opts.agentDir ?? defaultAgentDir());
    const adapter = this.requireAdapter();
    if (adapter.getActiveSession()) {
      return mergeUpstreamIds(await adapter.modelsList(), this.opts.agentDir ?? defaultAgentDir());
    }
    // 无活跃会话时协议面报 missing_session_id（多会话模式命令需会话路由）。
    // 降级：直读引擎同一份模型目录 models-store.json（W0 实证格式
    // {provider:{models:[{id,reasoning,cost,contextWindow,thinkingLevelMap,...}]}}）
    // 并入 models.json 自定义（同 id 覆盖）。
    // 与协议面的差异：协议面按当前 provider 过滤，此处为全 provider 超集。
    return readModelsFallback(this.opts.agentDir ?? defaultAgentDir());
  }

  async commandsList(): Promise<EngineCommandInfo[] | null> {
    // 命令面无文件直读降级通道（枚举以 get_commands 为权威源，docs/verification/06）：
    // 引擎未就绪（不为此触发 spawn）或无活跃会话（missing_session_id 硬约束）一律
    // 返回 null 由端点降级，调用方（前端下拉）按空列表处理不渲染命令段。
    if (!this.isReady()) return null;
    const adapter = this.requireAdapter();
    if (!adapter.getActiveSession()) return null;
    return adapter.commands();
  }

  async deleteSession(sessionId: string): Promise<{ sessionPath: string; fileExisted: boolean }> {
    const row = await this.resolveSession(sessionId);
    if (this.adapter) {
      await this.runExclusive(async () => {
        if (this.streamingId === sessionId) {
          await this.requireAdapter().abort().catch(() => undefined);
        }
        if (this.activeId === sessionId && this.requireAdapter().getActiveSession()) {
          await this.requireAdapter().closeSession().catch(() => undefined);
          this.activeId = null;
        }
      });
    }
    // 引擎无会话删除协议面（rpc-client 全方法核对）——直接删磁盘会话文件。
    // 打开既有会话会追加扩展 bookkeeping 条目是正常语义，删除同理属文件级操作。
    let fileExisted = false;
    try {
      unlinkSync(row.path);
      fileExisted = true;
    } catch {
      // 文件尚未落盘（空会话）或已被删：仅清元数据
    }
    // 同清理 open_session 预建的 <sessionFile 去 .jsonl>-artifacts 目录
    //（todo 15 实证残留空目录）；存在才删，删失败不阻塞主删除。
    const artifactsDir = row.path.replace(/\.jsonl$/, "") + "-artifacts";
    try {
      if (existsSync(artifactsDir) && statSync(artifactsDir).isDirectory()) {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    } catch {
      // 残留不阻塞删除主流程
    }
    this.aliases.delete(sessionId);
    this.unpersistedClaims.delete(sessionId);
    this.countedMessages.clear();
    return { sessionPath: row.path, fileExisted };
  }

  async exportSessionHtml(sessionId: string): Promise<{ html: string; row: EngineSessionSummary }> {
    const row = await this.resolveSession(sessionId);
    if (!existsSync(row.path)) {
      throw new ApiError(409, "session_not_persisted", "会话尚未落盘（空会话），无法导出");
    }
    // --export 是 CLI 子命令（spawnSync），不依赖引擎进程活跃；adapter 未建时用裸
    // SenpiAdapter 携带正确的 agentDir/projectDir 即可（exportHtml 不走 rpc）。
    const adapter = this.adapter ?? new SenpiAdapter({
      projectDir: this.projectPath,
      agentDir: this.opts.agentDir ?? defaultAgentDir(),
    });
    const tmp = join(tmpdir(), `ul-omo-webui-export-${randomUUID()}.html`);
    try {
      await adapter.exportHtml(row.path, tmp);
      return { html: readFileSync(tmp, "utf8"), row };
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  async forkSession(
    sessionId: string,
    entryId: string,
    position: "before" | "at" = "before",
  ): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    await this.ensure();
    return this.runExclusive(async () => {
      // fork 会让引擎 teardown 当前活跃会话并切换到新会话——项目内存在 webui 驱动
      // 回合时一律拒绝（单驱动纪律，P2-11），避免把回合中的会话拆掉。
      if (this.streamingId !== null) {
        throw new ApiError(409, "already_processing", "该项目有进行中的回合，fork 前请等待回合结束或 abort");
      }
      await this.switchTo(sessionId);
      const client = this.wrappedClient;
      if (!client) throw new ApiError(503, "engine_not_ready", "项目引擎未就绪");
      let forked: { text: string; cancelled: boolean };
      try {
        forked = await client.fork(entryId, { position });
      } catch (err) {
        // 引擎侧条目校验：position="before" 仅接受 user 消息条目（agent-session-runtime fork）
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("Invalid entry ID")) {
          throw new ApiError(400, "invalid_entry", `entryId 不能作为 fork 点（${position} 语义不接受该条目）`);
        }
        if (message.includes("has not been saved yet")) {
          throw new ApiError(409, "session_not_persisted", "会话尚未落盘，无法 fork");
        }
        throw err;
      }
      if (forked.cancelled) {
        throw new ApiError(409, "fork_cancelled", "fork 被扩展取消");
      }
      // fork 后引擎活跃会话已切换为新会话（createBranchedSession 即物化落盘并写
      // parentSession 血缘）；durable id 解析同 createSession：活跃行 sessionPath
      // 匹配 durableSessionId 为准，退化用 getState().sessionId + 内存别名。
      const state = await (
        client as unknown as { getState: () => Promise<{ sessionId?: unknown; sessionFile?: unknown }> }
      ).getState();
      const sessionPath = typeof state.sessionFile === "string" ? state.sessionFile : "";
      if (!sessionPath) {
        throw new ApiError(500, "fork_failed", "fork 后未取得新会话文件路径");
      }
      let id = typeof state.sessionId === "string" ? state.sessionId : "";
      let durable = false;
      try {
        const rows = await this.requireAdapter().activeSessions();
        this.rememberHandleRows(rows);
        const row = rows.find((r) => r.sessionPath === sessionPath && r.durableSessionId);
        if (row?.durableSessionId) {
          id = row.durableSessionId;
          durable = true;
        }
      } catch {
        // 活跃行查询失败不影响 fork，退化为别名
      }
      if (!durable) {
        if (!id) throw new ApiError(500, "fork_failed", "fork 后未取得新会话 id");
        this.aliases.set(id, sessionPath);
      }
      // fork 已把引擎侧活跃切到新会话，但 adapter.active 仍指 fork 前的旧会话
      // （只有 openSession 会更新它）。resolveSession/switchTo 的活跃快捷路径信任
      // adapter.active——不对齐时按 fork id 的 messages/prompt/delete 会全部落到
      // 旧会话文件（走查实锤：删 fork 行实删了源会话）。显式按新 sessionPath 重开对齐。
      const realigned = await this.requireAdapter().openSession({ sessionPath });
      if (durable) this.rememberHandle(realigned.routingId, id);
      // 引擎活跃已是新会话，API 活跃跟随切换（后续 prompt 直达 fork 会话）
      this.activeId = id;
      return { id, sessionPath, durable, text: typeof forked.text === "string" ? forked.text : "" };
    });
  }
}

/** 引擎网关：路由层唯一入口。按项目懒加载运行时，会话 id 全局反查。 */
export class EngineRuntimeRegistry implements EngineGateway {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  /** sessionId → 运行时索引（createSession 填充 + 已知项目扫描回填） */
  private readonly index = new Map<string, ProjectRuntime>();

  constructor(
    private readonly manager: EngineProcessManager,
    private readonly opts: EngineRuntimeOptions,
  ) {
    // 引擎崩溃/不可用：回合进行中先合成收尾事件（前端解锁），再清会话态
    //（adapter 由 ensure() 按 client 更换重建）
    manager.onEvent((event) => {
      if (event.type === "process_crashed" || event.type === "engine_unavailable") {
        const projectPath = (event as { projectPath?: string }).projectPath;
        if (projectPath) this.runtimes.get(projectPath)?.crashSettle();
      }
    });
  }

  listProjectPaths(): string[] {
    return this.opts.listProjects();
  }

  private runtimeFor(project: string): ProjectRuntime {
    let rt = this.runtimes.get(project);
    if (!rt) {
      rt = new ProjectRuntime(this.manager, project, this.opts);
      this.runtimes.set(project, rt);
    }
    return rt;
  }

  /** 全局反查会话所属项目（索引 → 已知项目逐个扫 store；扫描不触发 spawn） */
  private async resolveRuntime(sessionId: string): Promise<ProjectRuntime> {
    const hit = this.index.get(sessionId);
    if (hit) return hit;
    for (const project of this.opts.listProjects()) {
      const rt = this.runtimeFor(project);
      try {
        await rt.resolveSession(sessionId);
      } catch {
        continue;
      }
      this.index.set(sessionId, rt);
      return rt;
    }
    throw new ApiError(404, "session_not_found", `会话不存在于任何已知项目：${sessionId}`);
  }

  async sessionsList(project: string): Promise<EngineSessionSummary[]> {
    return this.runtimeFor(project).listStore();
  }

  async createSession(
    project: string,
    opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    const rt = this.runtimeFor(project);
    const created = await rt.createSession(opts);
    this.index.set(created.id, rt);
    return created;
  }

  async messages(sessionId: string, cursor?: string): Promise<EngineMessagesPage> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.messages(sessionId, cursor);
  }

  /** 任务 16：会话 jsonl 路径反查（SDK 直读，不 spawn 引擎） */
  async sessionPath(sessionId: string): Promise<string> {
    const rt = await this.resolveRuntime(sessionId);
    const row = await rt.resolveSession(sessionId);
    return row.path;
  }

  async prompt(
    sessionId: string,
    input: {
      text: string
      images?: EnginePromptInput["images"]
      model?: string
      thinkingLevel?: EngineThinkingLevel
      streamingBehavior?: EnginePromptInput["streamingBehavior"]
    },
  ): Promise<{ disposition: string; durableSessionId?: string; appliedModel?: string }> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.prompt(sessionId, input);
  }

  async queueList(sessionId: string): Promise<EngineQueueSnapshot> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.queueList(sessionId);
  }

  async queueClear(sessionId: string): Promise<EngineQueueSnapshot> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.queueClear(sessionId);
  }

  async abort(sessionId: string): Promise<void> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.abort(sessionId);
  }

  async permissionRespond(sessionId: string, requestId: string, reply: EnginePermissionReply): Promise<void> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.permissionRespond(sessionId, requestId, reply);
  }

  async questionsList(sessionId: string): Promise<EngineQuestionFrame[]> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.questionsList(sessionId);
  }

  async usage(sessionId: string): Promise<EngineUsageStats> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.usage(sessionId);
  }

  async compact(sessionId: string): Promise<{ result: EngineCompactResult; usage: EngineUsageStats }> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.compact(sessionId);
  }

  async modelsList(project: string): Promise<EngineModelInfo[]> {
    return this.runtimeFor(project).modelsList();
  }

  favoriteModels(): string[] {
    return readFavoriteModels(this.opts.agentDir ?? defaultAgentDir());
  }

  defaultModel(): { provider: string; model: string; thinkingLevel: string | null } | null {
    return readDefaultModel(this.opts.agentDir ?? defaultAgentDir());
  }

  async commandsList(project: string): Promise<EngineCommandInfo[] | null> {
    return this.runtimeFor(project).commandsList();
  }

  async deleteSession(sessionId: string): Promise<{ sessionPath: string; fileExisted: boolean }> {
    const rt = await this.resolveRuntime(sessionId);
    const result = await rt.deleteSession(sessionId);
    this.index.delete(sessionId);
    return result;
  }

  async exportSessionHtml(sessionId: string): Promise<{ html: string; row: EngineSessionSummary }> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.exportSessionHtml(sessionId);
  }

  async forkSession(
    sessionId: string,
    entryId: string,
    position?: "before" | "at",
  ): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    const rt = await this.resolveRuntime(sessionId);
    const forked = await rt.forkSession(sessionId, entryId, position);
    this.index.set(forked.id, rt);
    return forked;
  }

  async peekActiveSessionPaths(project: string): Promise<string[] | null> {
    const rt = this.runtimes.get(project);
    if (!rt || !rt.isReady()) return null;
    return rt.activeSessionPaths();
  }

  async peekRunStates(project: string): Promise<Map<string, ServerSessionRunState> | null> {
    const rt = this.runtimes.get(project);
    if (!rt || !rt.isReady()) return null;
    return rt.peekRunStates();
  }

  /** wire sessionId（routing handle）→ durable id（SSE 信封注入用）。
   * 不触发引擎 spawn；项目运行时不存在或映射不明返回 undefined（透传不猜）。 */
  durableSessionIdFor(projectPath: string, handle: string): string | undefined {
    return this.runtimes.get(projectPath)?.durableSessionIdFor(handle);
  }

  /** sessionId → 会话 store 行（title-gen 取数：path 供 jsonl 直读、name 供触发
   * 条件判定）。不触发引擎 spawn（resolveSession 走活跃态/store 直查/别名三级）；
   * 查不到返回 null。 */
  async resolveSessionRow(sessionId: string): Promise<EngineSessionSummary | null> {
    for (const project of this.opts.listProjects()) {
      const rt = this.runtimeFor(project);
      try {
        return await rt.resolveSession(sessionId);
      } catch {
        continue;
      }
    }
    return null;
  }

  async restartProject(project: string): Promise<void> {
    // 重建 = 停旧进程 + 立即重新 spawn（新 spawn 参数生效）+ 会话态失效
    // W1 #4：用 crashSettle 而非裸 invalidate——停进程时回合若在流式中，
    // 先合成 agent_settled（reason:"engine_crash"）解锁前端流式态，再清态；
    // 裸 invalidate 不发合成收尾，前端流式标记挂死（与崩溃路径同一缺陷形态）。
    // 重放侧陈旧权限请求由 state_changed(to=stopped) 墓碑 + 本合成收尾双保险滤除。
    await this.manager.stop(project);
    this.runtimeFor(project).crashSettle();
    await this.manager.ensureRunning(project);
  }

  async stopAll(): Promise<void> {
    await this.manager.stopAll();
    // 引擎全停即会话态全失效：清流式标记并停收尾监视定时器
    for (const rt of this.runtimes.values()) rt.invalidate();
  }
}
