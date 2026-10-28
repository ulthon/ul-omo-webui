// 类型化 REST client：覆盖 server 全部端点（shape 见 .omo/notepads/ul-omo-webui/learnings.md W2 todo 9）。
// 统一错误形状 {error:{code,message}} 解析；401（未登录/过期）统一跳登录页。
// prompt 的模型防呆/偏好注入读 ui store（ui.ts 对 api.ts 仅类型引用，无运行时环）。
import { useUiStore } from "@/stores/ui";
import { effectiveThinkingLevel } from "@/lib/thinking-level";
import { t } from "@/i18n/i18n";

// ---------- 领域类型 ----------

/** 会话 rebind 扫描行（r10 todo 18）：alreadyBound = 目标项目已存在同名文件（重复导入预警） */
export interface RebindScanRow {
  id: string;
  name: string | null;
  firstMessage: string;
  messageCount: number;
  created: string;
  modified: string;
  alreadyBound: boolean;
}

export interface ProjectMeta {
  projectPath: string;
  preferredModel: string | null;
  lastOpenedAt: string | null;
  /** 注册时间（C16 todo 9）：迁移前存量行 = 迁移时刻（同值），added 排序档对这批行
   * 退化为 lastOpenedAt 稳定序；可选以兼容旧服务端响应与单测构造 */
  createdAt?: string | null;
  /** 权限预设（kv permission-preset:<project>，spawn 级）；null = 默认行为。
   * 变更需项目引擎重启（restartProject）后生效。 */
  permissionPreset?: string | null;
  /** 思考档偏好（W2 todo 8，写项目 .ul-omo-webui.json；服务端仅接受 low/high/max/null） */
  preferredThinkingLevel?: string | null;
  /** 死项目守卫（W1 #2）：仅路径已不存在/不再是目录的条目携带 missing:true，
   * 可解析条目省略该字段；bootstrap 自动恢复据此静默跳过。 */
  missing?: boolean;
  /** 隐藏软标记（A2 docs08-r3 todo 10）：true = 侧栏聚合分组不显示，设置"已隐藏"筛选可见可恢复；
   * 可选以兼容旧服务端响应与单测构造 */
  hidden?: boolean;
}

export interface SessionListItem {
  id: string;
  path: string;
  project: string;
  title: string;
  name: string | null;
  renamedTitle: string | null;
  /** 仅 fork 场景写入；人工会话 = null */
  parentSessionPath: string | null;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  pinned: boolean;
  archivedAt: string | null;
  unreadCount: number;
  lastRead: string | null;
  /** true|false=引擎活跃探询结果；null=引擎未就绪未知 */
  active: boolean | null;
  /** 服务端三态真相源（docs08-r6 任务 11）：running|waiting|idle；null=引擎未就绪。
  *  可选以兼容旧服务端响应（缺席时 resync 不动，交无活动清扫兑底） */
  runState?: "running" | "waiting" | "idle" | "background_running" | null;
  /** 会话标签（server todo 3 落地前为 undefined，消费侧用 tags?.length 防御） */
  tags?: Array<{ scope: string; name: string }>;
  /** 挂载整替乐观锁（r9 F1-B1）：tags 内容 sha1 hex，setSessionTags 时回传 baseRevision */
  tagsRevision?: string;
  /** 切换 sheet 最后消息预览（r10 todo 8）：服务端尾读最后一条 user/assistant 文本截
   *  60 字；无消息/旧服务端响应时缺席。仅 sheet 行消费，桌面列表不渲染 */
  preview?: string;
}

/** 计划执行进度快照（r10 todo 12，GET /api/sessions/:id/plan-progress）：
 *  bound=false（无绑定 goal/无 boulder/会话不在任何 work）时其余字段缺席；
 *  bound=true 且 total=0（计划文件缺失或无 todo 行）展示层隐藏。 */
export interface PlanProgressSnapshot {
  bound: boolean;
  planName?: string;
  done?: number;
  total?: number;
  currentTitle?: string | null;
}

/** wire 原样条目（jsonl entry：{type:"message",id,parentId,timestamp,message} 等），渲染层自行甄别 */
export interface WireEntry {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface WireMessage {
  role: string;
  content?: WirePart[];
  [key: string]: unknown;
}

/** 消息级模型名窄化访问器（B11 切换点标记）：assistant message 载荷透传的 model 字段
 * （message_end 载荷实证 docs/verification/05-p1-findings.md:54；adapter 对 wire 条目
 * 原样透传）。老数据/异常（缺失、空串、非字符串）一律 null，消费侧不显示不报错。 */
export function messageModel(entry: WireEntry): string | null {
  const model = (entry.message as WireMessage | undefined)?.model;
  return typeof model === "string" && model !== "" ? model : null;
}

/** 模型短名（"provider/model" 取首个 "/" 后段；无斜杠原样）——气泡头部常驻短名与
 *  胶囊模型浮签共用（2026-10-15 模型可见性：逐条可知作答模型） */
export function shortModelName(value: string): string {
  const idx = value.indexOf("/");
  return idx >= 0 ? value.slice(idx + 1) : value;
}

export interface WirePart {
  type: string;
  [key: string]: unknown;
}

export interface MessagesPage {
  sessionId: string;
  entries: WireEntry[];
  leafId: string | null;
  /** 传回 GET messages?cursor= 取增量；与 leafId 同值 */
  cursor: string | null;
  /** 任务 16：文件头方向是否还有更多条目（尾窗直读路径携带；引擎路径缺省 false） */
  hasMore?: boolean;
  /** 任务 16：本窗最旧条目 id（向上翻页 ?before= 游标） */
  oldestId?: string | null;
}

export interface SessionCreated {
  id: string;
  sessionPath: string;
  durable: boolean;
  project: string;
  provider: string | null;
  modelId: string | null;
  [key: string]: unknown;
}

export interface PromptReceipt {
  sessionId: string;
  /** "handled" 表示无回合（/命令） */
  disposition: string;
  streaming: boolean;
  /** 未落盘别名会话（新会话）首条消息落盘后的真实会话 id（即时换 key）；已落盘会话无此字段 */
  durableSessionId?: string;
  degradations?: string[];
  /** setModel 成功的模型行归一 "provider/model"（docs08-r6 任务 8 ②）：携带 model 直发时
   *  由服务端回传；排队请求（排队剥模型铁律）与未携带 model 时缺省。 */
  appliedModel?: string;
}

/** 手动压缩回执（docs08-r5 任务 8：POST /api/sessions/:id/compact；协议面 compact）。
 *  tokensBefore/tokensAfter 为压缩前后水位（前端 toast 佐证真实生效）；usage 为
 *  压缩后权威快照（服务端同锁内取，水位环/状态条刷新数据源）。 */
export interface CompactReceipt {
  sessionId: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  /** 压缩后估算水位（引擎 estimatedTokensAfter；未下发时缺省） */
  tokensAfter?: number;
  usage: UsageInfo;
}

export interface DraftInfo {
  content: string;
  updatedAt: string;
}

/** 排队单项（queue_update.ordered / GET queue 快照同构；enqueueOrder 为引擎实例内单调序号，
 *  对账快照无该序号时为 null） */
export interface QueueItem {
  text: string;
  mode: "steer" | "followUp";
  enqueueOrder: number | null;
  /** 入队时刻（本端发送者本地时钟；对账/他端项为首次见到时刻） */
  enqueuedAt: number;
}

/** 排队快照（GET/DELETE /api/sessions/:id/queue；ordered 仅整队清空回执携带） */
export interface QueueSnapshot {
  sessionId: string;
  steering: string[];
  followUp: string[];
  ordered: Array<{ text: string; mode: string; enqueueOrder: number }>;
}

/** question 型 UI 请求帧（q1 提问卡片；wire 原样，GET questions 对账与 SSE 帧同构） */
export interface QuestionWireFrame {
  type: "extension_ui_request";
  method: "question";
  id: string;
  requestId: string;
  toolCallId: string;
  waitForAnswer: boolean;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect: boolean;
  }>;
  timeout: number;
  askedAtMs: number;
  deadlineAtMs: number;
  remainingMs: number;
}

export interface SessionMetaInfo {
  sessionId: string;
  pinned: boolean;
  archivedAt: string | null;
  renamedTitle: string | null;
  unreadCount: number;
  lastRead: string | null;
  updatedAt: string;
}

/** 回合速度样本（A5：assistant 消息 message_start→end 配对，tokPerSec = output tokens / 秒） */
export interface TurnSpeedSample {
  tokPerSec: number;
  endedAt: string;
}

/** 最近 N 回合速度（服务端内存速度环快照，无回合时 turns 为空数组） */
export interface TurnSpeed {
  turns: TurnSpeedSample[];
  averageTokPerSec: number;
}

export interface UsageInfo {
  tokens?: Record<string, number>;
  cost?: Record<string, unknown>;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  turnSpeed?: TurnSpeed;
  [key: string]: unknown;
}

export interface ModelInfo {
  provider: string;
  id: string;
  contextWindow: number | null;
  reasoning: boolean;
  /** 引擎 models-store 部分条目缺 thinkingLevelMap，服务端可能不下发 */
  supportedThinkingLevels?: string[];
  /** 变体上游模型 id（docs08 2026-10-22 批次任务 18）：models.json 自定义条目的
   *  upstreamModelId（如 glm-5.3-4k → glm-5.3）；服务端按 provider/id 合并，缺席 =
   *  非变体。旧服务端不下发（可选，增量兼容）。 */
  upstreamId?: string;
}

/** 引擎 native 默认模型（服务端直读 settings.json defaultProvider/defaultModel/
 * defaultThinkingLevel；docs08-r5 任务 2） */
export interface EngineDefaultModel {
  provider: string;
  model: string;
  thinkingLevel: string | null;
}

export interface DiscoverProvider {
  id: string;
  baseUrl: string;
  api: string | null;
  modelCount: number;
}

/** 发现报告：discovered=远端去重清单；added=本地缺失可导入；unchanged=保留既有；
 * imported/written 仅确认导入后非空/为真（预览恒 null/false） */
export interface DiscoverReport {
  provider: string;
  url: string;
  discovered: string[];
  added: string[];
  unchanged: string[];
  imported: string[] | null;
  written: boolean;
}

/** 宽带流量监控（docs08-2026-10-22 批次任务 28）：服务端请求级日账 + vnstat 系统账 */
export interface TrafficEndpointStat {
  endpoint: string;
  requests: number;
  reqBytes: number;
  resBytes: number;
  sseConnections: number;
  sseEvents: number;
  sseBytes: number;
  sseDurationMs: number;
}
export interface VnstatSystem {
  available: true;
  interface: string;
  day: { date: string; rx: number; tx: number };
  month: { rx: number; tx: number };
}
export interface VnstatUnavailable {
  available: false;
  reason: string;
}
export interface TrafficSnapshot {
  day: string;
  generatedAt: string;
  endpoints: TrafficEndpointStat[];
  system: VnstatSystem | VnstatUnavailable;
}

export interface ModelsResponse {
  project: string | null;
  models: ModelInfo[];
  /** CLI 收藏（服务端读 settings.json favoriteModels 归一 "provider/model"）；
   * 旧服务端未下发时缺省（undefined → 空） */
  favorites?: string[];
  /** 引擎 native 默认模型（新会话回退链中位：项目偏好 > defaults > 列表首项）；
   * 旧服务端未下发或引擎未配置时缺省（undefined/null → 跳过该档） */
  defaults?: EngineDefaultModel | null;
}

export interface InputHistoryItem {
  id: number;
  projectPath: string;
  content: string;
  createdAt: string;
}

/** 用法提示条目（docs08-2026-10-22 批次任务 25）：GET /api/tips 返回项，契约同引擎
 *  omo --list-tips（requiresCommand 为关联命令名/布尔，原样透传不过滤，对拍口径 GET=CLI）。 */
export interface TipItem {
  id: string;
  text: string;
  requiresCommand?: string | boolean;
}

/** 斜杠命令行（GET /api/commands；docs08-r3 任务 19，通道实证 docs/verification/06） */
export interface SlashCommandInfo {
  name: string;
  source: string;
  description?: string;
}

export interface CommandsResponse {
  project: string;
  /** false = 引擎未就绪或无活跃会话（降级）：三段为空，前端下拉不渲染命令面 */
  available: boolean;
  /** extension=引擎命令 / skill=技能（name 固定 "skill:" 前缀）/ prompt=用户提示 */
  commands: { extension: SlashCommandInfo[]; skill: SlashCommandInfo[]; prompt: SlashCommandInfo[] };
}

export interface GitStatusResponse {
  project: string;
  entries: Array<Record<string, unknown>>;
  raw: string;
}

export interface GitDiffResponse {
  project: string;
  diff: string;
  truncated: boolean;
}

export interface FsTreeEntry {
  name: string;
  type: "directory" | "file" | "symlink" | "other";
}

export interface FsTreeResponse {
  project: string;
  path: string;
  entries: FsTreeEntry[];
}

export interface FsFileResponse {
  project: string;
  path: string;
  size: number;
  /** 服务端 bigint mtimeNs 的十进制字符串（任务 9）：保存前置校验期望值源
   * （Number 会丢 1.7e18 量级纳秒值低 11 位，字符串为唯一无损通道） */
  mtimeNs: string;
  truncated: boolean;
  binary: boolean;
  content: string | null;
}

/** fs 写操作回执（routes-fs-write：201 载荷；mtimeNs 为 bigint 纳秒字符串化） */
export interface FsWriteReceipt {
  path: string;
  size?: number;
  bytes?: number;
  mtimeNs?: string;
}

/** fs/upload 409 target_exists 携带的既有条目信息（前端确认弹窗数据源） */
export interface FsUploadExisting {
  path: string;
  kind: string;
  size: number;
  mtimeNs: string;
}

/** fs/upload 非 2xx 响应体（统一 {error} + 兄弟字段 existing） */
interface FsUploadErrorBody {
  error?: { code?: string; message?: string };
  existing?: FsUploadExisting;
}

// ---------- 错误与请求基底 ----------

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function redirectToLogin(): void {
  window.location.assign("/login");
}

/** fsUpload 409 冲突：携带既有条目信息（overwrite 重试由调用方确认后发起） */
export class FsUploadConflictError extends ApiError {
  readonly existing: FsUploadExisting | null;

  constructor(message: string, existing: FsUploadExisting | null) {
    super(409, "target_exists", message);
    this.name = "FsUploadConflictError";
    this.existing = existing;
  }
}

/** fs 保存 409 file_changed（任务 9）：文件已被修改（引擎或其他来源）；current 为
 * 服务端当前 {mtimeNs, size}（冲突弹窗重载依据；重载走重取，不直接覆盖） */
export class FileConflictError extends ApiError {
  readonly current: { mtimeNs: string | null; size: number | null };

  constructor(message: string, current: { mtimeNs: string | null; size: number | null }) {
    super(409, "file_changed", message);
    this.name = "FileConflictError";
    this.current = current;
  }
}

interface RequestOptions {
  /** false 时 401 不跳登录（登录接口自身、登录页探测用） */
  authRedirect?: boolean;
}

async function request<T>(path: string, init?: RequestInit & RequestOptions): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(0, "network", err instanceof Error ? err.message : String(err));
  }
  if (res.status === 401) {
    if (init?.authRedirect !== false) redirectToLogin();
    throw new ApiError(401, "unauthorized", t("common.lib.unauthorized"));
  }
  if (!res.ok) {
    let code = "unknown";
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } | string };
      if (typeof body.error === "string") {
        code = body.error;
        message = body.error;
      } else if (body.error && typeof body.error === "object") {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      }
    } catch {
      // 非 JSON 错误体，保留 HTTP 状态默认文案
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

function jsonInit(method: string, body: unknown, opts?: RequestOptions): RequestInit & RequestOptions {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...opts,
  };
}

// ---------- prompt 命令门（todo 24：chat-view 注册，拦截不支持命令直通模型） ----------

/** 命令门：同步校验 prompt 文本，不支持时抛 ApiError（composer 行内展示） */
type PromptGate = (text: string) => void;

let promptGate: PromptGate | null = null;

export function setPromptGate(gate: PromptGate | null): void {
  promptGate = gate;
}

// ---------- API ----------

export interface ListSessionsParams {
  /** 缺省 = 聚合模式：server 并行拉取全部注册项目合并单响应（project 字段为 null） */
  project?: string;
  /** "true"|"false"|"all"，默认 "false" */
  archived?: "true" | "false" | "all";
  q?: string;
  /** 会话标签过滤参数（本 todo 只透传；server todo 3 落地后自然生效） */
  tag?: string;
  /** 多标签过滤（todo 11）：多个 tag 参数 OR 语义（任一命中），server 逐个 append */
  tags?: string[];
}

export const api = {
  // ---- 鉴权 ----
  async login(password: string): Promise<void> {
    await request<{ ok: boolean }>("/api/auth/login", jsonInit("POST", { password }, { authRedirect: false }));
  },
  async logout(): Promise<void> {
    await request<{ ok: boolean }>("/api/auth/logout", { method: "POST", authRedirect: false });
  },
  async health(opts?: RequestOptions): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>("/api/health", opts);
  },

  // ---- 会话 ----
  async createSession(body: { project: string; model?: string; thinkingLevel?: string }): Promise<{ session: SessionCreated }> {
    return request("/api/sessions", jsonInit("POST", body));
  },
  async listSessions(params: ListSessionsParams): Promise<{ project: string | null; archived: string; sessions: SessionListItem[] }> {
    const q = new URLSearchParams();
    if (params.project) q.set("project", params.project);
    if (params.archived) q.set("archived", params.archived);
    if (params.q) q.set("q", params.q);
    if (params.tag) q.set("tag", params.tag);
    if (params.tags) for (const t of params.tags) q.append("tag", t);
    return request(`/api/sessions?${q.toString()}`);
  },
  async listMessages(
    sessionId: string,
    opts?: { cursor?: string; before?: string; full?: boolean },
  ): Promise<MessagesPage> {
    const q = new URLSearchParams();
    if (opts?.cursor) q.set("cursor", opts.cursor);
    if (opts?.before) q.set("before", opts.before);
    if (opts?.full) q.set("full", "1");
    const qs = q.toString();
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ""}`);
  },
  async prompt(
    sessionId: string,
    body: {
      text: string;
      images?: Array<{ data: string; mimeType: string }>;
      model?: string;
      thinkingLevel?: string;
      agent?: string;
      /** 回合中排队语义（docs08-r4 任务 11）：携带时本请求转为入队而非 409 */
      streamingBehavior?: "steer" | "followUp";
    },
  ): Promise<PromptReceipt> {
    // 防呆（todo 22）：模型列表已确认为空时引擎无可用模型，发送必然失败——客户端直接拦截，
    // 不发请求；输入区捕获 ApiError 后行内展示。
    const ui = useUiStore.getState();
    if (ui.modelsLoaded && ui.models.length === 0) {
      throw new ApiError(400, "no_models_available", t("common.lib.noModelsSend"));
    }
    // 命令门（todo 24）：/ 前缀命中不支持命令时抛 ApiError（chat-view 注册的 commandGate）
    promptGate?.(body.text);
    // 排队请求铁律（spike 实证）：只带 streamingBehavior——不注入模型/思考档偏好
    //（排队 prompt 带 thinkingLevel 引擎直接拒绝；模型切换属会话级操作，排队窗口不做）
    if (body.streamingBehavior) {
      return request(
        `/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
        jsonInit("POST", { text: body.text, streamingBehavior: body.streamingBehavior }),
      );
    }
    // 顶栏选中的当前偏好随下一条 prompt 生效：服务端对活跃会话执行 setModel（会话 jsonl
    // 追加 model_change 条目，verification/01 有该条目形态）；调用方显式传 model 时以其为准。
    const model = body.model ?? ui.selectedModel ?? undefined;
    // 思考档随下一条 prompt 注入（W2 todo 8，todo 7 已实证引擎按 per-prompt 档位执行）：
    // 所选模型未下发 supportedThinkingLevels 时视为未选（与 chip 隐藏规则同一判定，
    // lib/thinking-level 共用）；调用方显式传值以其为准。
    const selectedModelInfo = model ? ui.models.find((m) => `${m.provider}/${m.id}` === model) : undefined;
    const thinkingLevel = body.thinkingLevel ?? effectiveThinkingLevel(selectedModelInfo, ui.selectedThinkingLevel);
    return request(
      `/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
      jsonInit("POST", { ...body, model, thinkingLevel }),
    );
  },
  async abort(sessionId: string): Promise<{ ok: boolean; sessionId: string }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, jsonInit("POST", {}));
  },
  /** 手动压缩上下文（docs08-r5 任务 8）：协议面 compact 直调，绝不走 prompt 通道
   *  （/compact 进 prompt 会被模型当普通消息并伪执行已压缩）。失败 409/5xx 由调用方
   *  明示（ApiError.message），不静默。 */
  async compactSession(sessionId: string): Promise<CompactReceipt> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/compact`, jsonInit("POST", {}));
  },
  /** 排队快照对账（docs08-r4 任务 11）：断线重连/初次渲染各拉一次；增量走 queue_update 事件 */
  async getQueue(sessionId: string): Promise<QueueSnapshot> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/queue`);
  },
  /** 整队清空（引擎无单条撤单协议面），返回被撤项（ordered 含 enqueueOrder） */
  async clearQueue(sessionId: string): Promise<QueueSnapshot> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, { method: "DELETE" });
  },
  async respondPermission(
    sessionId: string,
    body: {
      requestId: string;
      value?: unknown;
      confirmed?: boolean;
      cancelled?: boolean;
      /** question 型应答（q1 提问卡片）：键为 question.id，selected 为选项 label 数组 */
      answers?: Record<string, { selected: string[]; text?: string }>;
      /** question 型自由文本补充（非空即落定 comment-submitted） */
      comment?: string;
    },
  ): Promise<{ ok: boolean; sessionId: string; requestId: string }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/permission`, jsonInit("POST", body));
  },
  /** 未决提问对账快照（q1 提问卡片；打开会话拉一次，增量走 SSE question 帧） */
  async getQuestions(sessionId: string): Promise<{ sessionId: string; questions: QuestionWireFrame[] }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/questions`);
  },
  async getDraft(sessionId: string): Promise<{ sessionId: string; draft: DraftInfo | null }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/draft`);
  },
  async putDraft(sessionId: string, content: string): Promise<{ ok: boolean; sessionId: string; draft: DraftInfo | null }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/draft`, jsonInit("PUT", { content }));
  },
  async markRead(sessionId: string): Promise<{ ok: boolean; sessionId: string; meta: SessionMetaInfo | null }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/read`, jsonInit("POST", {}));
  },
  async patchSessionMeta(
    sessionId: string,
    patch: { pinned?: boolean; archived?: boolean; renamedTitle?: string | null },
  ): Promise<{ ok: boolean; sessionId: string; meta: SessionMetaInfo | null }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/meta`, jsonInit("PATCH", patch));
  },
  async deleteSession(sessionId: string): Promise<{ ok: boolean; deleted: { id: string; sessionPath: string; fileExisted: boolean } }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  },
  /** 从指定条目 fork 新会话（重试语义；position 默认 before，仅接受 user 消息条目） */
  async forkSession(
    sessionId: string,
    body: { entryId: string; position?: "before" | "at" },
  ): Promise<{ session: { id: string; sessionPath: string; durable: boolean }; text: string }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, jsonInit("POST", body));
  },
  /** 导出会话 HTML 下载（GET /:id/export 返回 attachment；文件名取服务端 Content-Disposition） */
  async exportSession(sessionId: string, fallbackTitle: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/export`);
    } catch (err) {
      throw new ApiError(0, "network", err instanceof Error ? err.message : String(err));
    }
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError(401, "unauthorized", t("common.lib.unauthorized"));
    }
    if (!res.ok) {
      let code = "unknown";
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body.error?.code) code = body.error.code;
        if (body.error?.message) message = body.error.message;
      } catch {
        // 非 JSON 错误体，保留默认文案
      }
      throw new ApiError(res.status, code, message);
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    let filename = `${fallbackTitle || sessionId}.html`;
    const utf8Match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    if (utf8Match) {
      try {
        filename = decodeURIComponent(utf8Match[1]);
      } catch {
        // 编码异常保留回退名
      }
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  /** 手动生成标题（W3 todo 12）：同步生成，成功 {title}；失败 502 带原因（ApiError.message） */
  async generateTitle(sessionId: string): Promise<{ title: string }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/generate-title`, jsonInit("POST", {}));
  },
  async getUsage(session: string): Promise<{ sessionId: string; usage: UsageInfo }> {
    return request(`/api/usage?session=${encodeURIComponent(session)}`);
  },
  /** 计划执行进度（r10 todo 12）：会话绑定的 goal 计划 todo 勾选态速览（只读） */
  async getPlanProgress(sessionId: string): Promise<PlanProgressSnapshot> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/plan-progress`);
  },

  // ---- 附件（docs08-r3 任务 17：大文本粘贴转附件） ----
  /** 大段文本存服务端附件临时区（DATA_DIR/attachments/<projectHash>/，≤1MB），
   * 返回绝对路径供 prompt 拼接路径行由引擎按需读取。 */
  async postAttachment(sessionId: string, body: { content: string; name?: string }): Promise<{ path: string; name: string; bytes: number }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, jsonInit("POST", body));
  },
  /** 删除附件临时文件。仅挂用户显式移除 chip——发送成功后文件刻意留存
   * （引擎按需读取），48h 按龄清理兜底，发送清空绝不调用本方法。 */
  async removeAttachment(sessionId: string, path: string): Promise<{ ok: boolean }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/attachments?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  },
  /** 通用二进制附件上传（docs08 2026-10-23/24 批次 t17 双通道之二进制面，任务 18 消费）：
   * 原始 body + application/octet-stream，文件名经 ?name= 查询参数（纯文件名白名单
   * 服务端校验）；≤10MB 超限 413 attachment_too_large。返回 { path 绝对路径, name, bytes }。 */
  async postBinaryAttachment(sessionId: string, file: Blob, name?: string): Promise<{ path: string; name: string; bytes: number }> {
    const qs = name ? `?name=${encodeURIComponent(name)}` : "";
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/attachments${qs}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
  },
  /** 按需取引用图片字节（docs08 2026-10-23/24 批次任务 19 历史引用化）：GET 附件服务
   *  → Blob（objectURL 渲染）。410（清理/缺失）抛 ApiError("attachment_expired"）。 */
  async fetchAttachmentBlob(sessionId: string, path: string): Promise<Blob> {
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/attachments?path=${encodeURIComponent(path)}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new ApiError(0, "network", err instanceof Error ? err.message : String(err));
    }
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError(401, "unauthorized", t("common.lib.unauthorized"));
    }
    if (!res.ok) {
      let code = "unknown";
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code ?? code;
        throw new ApiError(res.status, code, body.error?.message ?? `HTTP ${res.status}`);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(res.status, code, `HTTP ${res.status}`);
      }
    }
    return res.blob();
  },

  // ---- models ----
  async listModels(project?: string): Promise<ModelsResponse> {
    const qs = project ? `?project=${encodeURIComponent(project)}` : "";
    return request(`/api/models${qs}`);
  },

  // ---- 模型发现（docs08-2026-10-22 批次任务 23：OpenAI 兼容 provider）----
  /** models.json 中可发现的 provider 清单（文件缺失返回空清单） */
  async listDiscoverProviders(): Promise<{ providers: DiscoverProvider[] }> {
    return request("/api/models/discover");
  },

  /** 发现预览：拉远端 /models 并 diff，不落盘（import 缺省 = 仅预览） */
  async discoverModels(provider: string): Promise<DiscoverReport> {
    return request("/api/models/discover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });
  },

  /** 确认导入：全选（"all"）或所选新增 id 子集，合并写回 models.json */
  async importDiscoveredModels(provider: string, ids: string[] | "all"): Promise<DiscoverReport> {
    return request("/api/models/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, import: ids }),
    });
  },

  // ---- 宽带流量监控（docs08-2026-10-22 批次任务 28）----
  /** webui 请求级日账 + vnstat 系统账快照（服务端内存日账，零点自动重置） */
  async getTraffic(): Promise<TrafficSnapshot> {
    return request("/api/stats/traffic");
  },

  // ---- 斜杠命令枚举（docs08-r3 任务 19：SlashHints 三段下拉数据源） ----
  /** 三段一次取数（引擎命令/技能/用户提示，服务端 60s 按项目缓存）；引擎未就绪
   * 或无活跃会话时 available=false 空三段（降级不渲染，绝不 5xx）。 */
  async getCommands(project: string): Promise<CommandsResponse> {
    return request(`/api/commands?project=${encodeURIComponent(project)}`);
  },

  // ---- 项目 ----
  async listProjects(): Promise<{ projects: ProjectMeta[] }> {
    return request("/api/projects");
  },
  /** 注册项目；create=true（docs08-r3 任务 20"新建并添加"）：路径不存在时服务端
   * 按安全口径 mkdir -p 后注册（父级不可写 403 / 中段非目录 400，错误走 ApiError.message）。 */
  async addProject(path: string, create = false): Promise<{ ok: boolean; project: ProjectMeta | null }> {
    return request("/api/projects", jsonInit("POST", { path, ...(create ? { create: true } : {}) }));
  },
  /** 项目注销（W1 #1）：删 meta_project 注册行，项目内会话数据与会话 meta（置顶/改名/
   * 标签）原样保留，重新添加即恢复；未注册（含重复注销）404 not_registered。不涉及
   * 引擎进程生命周期。 */
  async removeProject(path: string): Promise<{ path: string; removed: boolean }> {
    return request("/api/projects", jsonInit("DELETE", { path }));
  },
  /** 项目隐藏软标记（A2 docs08-r3 任务 10）：hidden 只写 meta_project.hidden 列——
   * 注册行与会话 meta 原样保留，侧栏聚合分组消失（GET /api/sessions 聚合过滤 +
   * 侧栏客户端防御过滤双保险），设置"已隐藏"筛选可恢复；未注册 404 not_registered。 */
  async putProjectHidden(path: string, hidden: boolean): Promise<{ ok: boolean; project: ProjectMeta | null }> {
    return request("/api/projects/hidden", jsonInit("PUT", { path, hidden }));
  },
  async patchProjectMeta(patch: {
    path: string;
    preferredModel?: string | null;
    preferredThinkingLevel?: string | null;
    lastOpenedAt?: string | null;
    permissionPreset?: string | null;
  }): Promise<{ ok: boolean; project: ProjectMeta | null }> {
    return request("/api/projects/meta", jsonInit("PATCH", patch));
  },
  /** 重建项目引擎进程：spawn 参数级配置（权限预设等）变更后的生效口。
   * 进行中的回合中断、会话态失效（下次访问懒加载重建）；SSE 为服务端事件流不受影响。 */
  async restartProject(project: string): Promise<{ ok: boolean; project: string }> {
    return request("/api/projects/restart", jsonInit("POST", { project }));
  },

  // ---- 会话 rebind（r10 todo 18：旧目录会话导入重绑）----

  /** 扫描旧目录会话库预览：返回可导入会话行（alreadyBound = 目标项目已存在同名文件）。
   * 旧目录不存在/空 → 空清单（不报错）；totalFiles 与 sessions 差值 = 损坏/非会话文件数。 */
  async scanRebindSessions(
    project: string,
    oldPath: string,
  ): Promise<{ project: string; oldPath: string; totalFiles: number; sessions: RebindScanRow[] }> {
    return request("/api/sessions/rebind/scan", jsonInit("POST", { project, oldPath }));
  },

  /** 导入重绑：逐会话移动（header cwd 重写 + sidecars 迁移，引擎 --rebind 同语义）。
   * 逐会话容错：冲突/找不到/损坏 → skipped 结构化报告，部分失败不是 HTTP 错误。 */
  async rebindSessions(
    project: string,
    oldPath: string,
    sessionIds: string[],
  ): Promise<{
    project: string;
    oldPath: string;
    imported: Array<{ id: string; path: string; disposition: "moved" | "already_bound" }>;
    skipped: Array<{ id: string; reason: "not_found" | "corrupt_header" | "rebind_conflict"; message: string }>;
  }> {
    return request("/api/sessions/rebind", jsonInit("POST", { project, oldPath, sessionIds }));
  },

  // ---- 输入历史 / 设置 ----
  async listInputHistory(project: string, limit?: number): Promise<{ project: string; items: InputHistoryItem[] }> {
    const qs = new URLSearchParams({ project });
    if (limit) qs.set("limit", String(limit));
    return request(`/api/input-history?${qs.toString()}`);
  },
  async appendInputHistory(project: string, content: string): Promise<{ ok: boolean; items: InputHistoryItem[] }> {
    return request("/api/input-history", jsonInit("POST", { project, content }));
  },
  async getSettings(): Promise<{ settings: Record<string, string> }> {
    return request("/api/settings");
  },
  async putSettings(kv: Record<string, string>): Promise<{ ok: boolean; settings: Record<string, string> }> {
    return request("/api/settings", jsonInit("PUT", kv));
  },

  // ---- 用法提示（docs08-2026-10-22 批次任务 25）----
  /** 空态提示卡数据源：服务端缓存 omo --list-tips（失败降级空表，前端无 tip 区） */
  async listTips(): Promise<{ tips: TipItem[] }> {
    return request("/api/tips");
  },

  // ---- git / fs（只读）----
  async gitStatus(project: string): Promise<GitStatusResponse> {
    return request(`/api/git/status?project=${encodeURIComponent(project)}`);
  },
  async gitDiff(project: string): Promise<GitDiffResponse> {
    return request(`/api/git/diff?project=${encodeURIComponent(project)}`);
  },
  async fsTree(project: string, path?: string): Promise<FsTreeResponse> {
    const qs = new URLSearchParams({ project });
    if (path) qs.set("path", path);
    return request(`/api/fs/tree?${qs.toString()}`);
  },
  async fsFile(project: string, path: string): Promise<FsFileResponse> {
    return request(`/api/fs/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`);
  },

  /** 受限目录浏览（/api/fs/browse）：仅列子目录、base=realpath(home)；path 缺省 = home。
   * 越界 403 由调用方静默处理（路径补全不建议）；EACCES → 200 + entries:[] + error 字段。 */
  async fsBrowse(path?: string): Promise<FsBrowseResponse> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : "";
    return request(`/api/fs/browse${qs}`);
  },

  // ---- fs 写操作（builtin-file-management 任务 6；端点契约 server/src/api/routes-fs-write.ts）----
  /** 新建文件：POST /api/fs/file；目标已存在 409 exists，父目录缺失 404。 */
  async fsCreateFile(project: string, path: string, content?: string): Promise<FsWriteReceipt> {
    return request(`/api/fs/file?project=${encodeURIComponent(project)}`, jsonInit("POST", { path, ...(content ? { content } : {}) }));
  },
  /** 建目录：POST /api/fs/dir；最终层已存在 409 exists；parents:true 逐层补建。 */
  async fsMkdir(project: string, path: string, parents?: boolean): Promise<FsWriteReceipt> {
    return request(`/api/fs/dir?project=${encodeURIComponent(project)}`, jsonInit("POST", { path, ...(parents ? { parents: true } : {}) }));
  },
  /** 重命名/移动：PATCH /api/fs/entry；目标存在默认 409 target_exists（overwrite 覆盖 /
   * conflict:"rename" 保留两者由调用方确认后重试）；引擎回合占用 from 路径 409 engine_busy。 */
  async fsMove(
    project: string,
    from: string,
    to: string,
    opts?: { overwrite?: boolean; conflict?: "rename" },
  ): Promise<{ ok: boolean; path: string }> {
    return request(`/api/fs/entry?project=${encodeURIComponent(project)}`, jsonInit("PATCH", { from, to, ...opts }));
  },
  /** 删除：DELETE /api/fs/entry；纯硬删；引擎回合进行中 409 engine_busy。 */
  async fsDelete(project: string, path: string): Promise<{ ok: boolean }> {
    return request(`/api/fs/entry?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`, { method: "DELETE" });
  },
  /** 流式上传：POST /api/fs/upload raw body（fetch 无上传进度，XHR 包装）。onProgress
   * 为 upload 事件进度（loaded/total 字节）；目标已存在 409 target_exists → 抛
   * FsUploadConflictError（携带 existing 既有条目信息），调用方确认后 overwrite:true 重试；
   * 超限 413 upload_too_large 等服务端错误按统一形状抛 ApiError。 */
  async fsUpload(
    project: string,
    dirPath: string,
    file: Blob,
    opts?: { overwrite?: boolean; onProgress?: (loaded: number, total: number) => void },
  ): Promise<FsWriteReceipt> {
    if (!(file instanceof File)) throw new ApiError(400, "invalid_request", "file must be a File (plain filename required)");
    const qs = new URLSearchParams({ project, path: dirPath, name: file.name });
    if (opts?.overwrite) qs.set("overwrite", "true");
    return new Promise<FsWriteReceipt>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/fs/upload?${qs.toString()}`);
      if (opts?.onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
        };
      }
      xhr.onload = () => {
        let body: FsUploadErrorBody | null = null;
        try {
          body = JSON.parse(xhr.responseText) as FsUploadErrorBody;
        } catch {
          // 非 JSON 响应体，走状态码默认文案
        }
        if (xhr.status === 401) {
          redirectToLogin();
          reject(new ApiError(401, "unauthorized", t("common.lib.unauthorized")));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          const code = body?.error?.code ?? "unknown";
          const message = body?.error?.message ?? `HTTP ${xhr.status}`;
          reject(
            xhr.status === 409 && code === "target_exists"
              ? new FsUploadConflictError(message, body?.existing ?? null)
              : new ApiError(xhr.status, code, message),
          );
          return;
        }
        resolve((body ?? {}) as FsWriteReceipt);
      };
      xhr.onerror = () => reject(new ApiError(0, "network", "upload network error"));
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.send(file);
    });
  },
  /** 下载 URL 纯拼接（GET /api/fs/download；调用方自行 anchor/location 触发浏览器下载） */
  fsDownloadUrl(project: string, path: string): string {
    return `/api/fs/download?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`;
  },
  /** 保存文本文件（任务 9）：PUT /api/fs/file。expectations 为打开时 GET 回传的
   * 期望值（乐观锁前置，编辑器持有并随保存回执滚动）；前置失配 409 → 抛
   * FileConflictError（携带服务端当前 {mtimeNs,size}，调用方弹「重载/取消」）；
   * 成功回 {mtimeNs,size} 作下轮期望值。其余错误统一 ApiError 形状。 */
  async fsSaveFile(
    project: string,
    path: string,
    content: string,
    expectations: { expectedMtimeNs: string; expectedSize: number },
  ): Promise<{ mtimeNs: string; size: number }> {
    let res: Response;
    try {
      res = await fetch(
        `/api/fs/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,
        jsonInit("PUT", { content, ...expectations }),
      );
    } catch (err) {
      throw new ApiError(0, "network", err instanceof Error ? err.message : String(err));
    }
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError(401, "unauthorized", t("common.lib.unauthorized"));
    }
    // 错误体 {error} + 兄弟字段 mtimeNs/size（同 upload 409 existing 模式）
    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string }; mtimeNs?: string; size?: number }
      | null;
    if (!res.ok) {
      const code = body?.error?.code ?? "unknown";
      const message = body?.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 409 && code === "file_changed") {
        throw new FileConflictError(message, {
          mtimeNs: typeof body?.mtimeNs === "string" ? body.mtimeNs : null,
          size: typeof body?.size === "number" ? body.size : null,
        });
      }
      throw new ApiError(res.status, code, message);
    }
    return { mtimeNs: body?.mtimeNs ?? "", size: body?.size ?? 0 };
  },

  // ---- 标签（todo 11）----
  /** 两源标签定义：global 恒返回；project 仅传项目路径时返回（读不要求已注册）。
   * revision：两源定义内容拼接的 sha1 hex（r9 乐观锁，整替提交时回传 baseRevision） */
  async listTags(project?: string): Promise<{ global: TagDefinition[]; project: TagDefinition[]; revision: string }> {
    const qs = project ? `?project=${encodeURIComponent(project)}` : "";
    return request(`/api/tags${qs}`);
  },
  /** 按 scope 整替定义列表（新增/重命名/删除/排序共用；重名 400 invalid_tags）。
   * baseRevision（r9 乐观锁）：传最近一次 GET 的 revision，服务端不一致返回 409 tag_conflict */
  async putTags(body: {
    scope: "global" | "project";
    project?: string;
    tags: TagDefinition[];
    baseRevision?: string;
  }): Promise<{ tags: TagDefinition[] }> {
    return request("/api/tags", jsonInit("PUT", body));
  },
  /** 会话标签挂载整替（挂载与定义解耦：不校验定义存在；重复项服务端按 (scope,name) 去重）。
   * source：触发本次整替的 UI 动作标识（服务端对被移除挂载写审计行用，缺省 "api"）。
   * baseRevision（r9 F1-B1 乐观锁）：传最近一次读取的挂载 revision，不一致服务端 409 tag_mount_conflict */
  async setSessionTags(
    sessionId: string,
    tags: TagRef[],
    source?: string,
    baseRevision?: string,
  ): Promise<{ tags: TagRef[]; revision: string }> {
    const payload: Record<string, unknown> = { tags };
    if (source) payload.source = source;
    if (baseRevision) payload.baseRevision = baseRevision;
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/tags`, jsonInit("PUT", payload));
  },

  /** 单会话挂载读取（r9 F1-B1 乐观锁读取面）：tags + revision，操作前重拉与冲突后恢复快照用 */
  async getSessionTags(sessionId: string): Promise<{ tags: TagRef[]; revision: string }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/tags`);
  },

  // ---- 常用语（todo 14）----
  /** 两源常用语：global 恒返回；project 仅传项目路径时返回（读不要求已注册）。
   * revision：两源聚合 sha1（兼容保留，不作锁基线）；globalRevision/projectRevision
   * （r9 BLOCKER-1 修复）：各组条目内容独立 sha1——整替提交回传对应组的 revision 作
   * baseRevision（读写面同口径，活跃项目下 global 组不再恒 409） */
  async listSnippets(
    project?: string,
  ): Promise<{
    global: SnippetEntry[];
    project: SnippetEntry[];
    revision: string;
    globalRevision: string;
    projectRevision: string;
  }> {
    const qs = project ? `?project=${encodeURIComponent(project)}` : "";
    return request(`/api/snippets${qs}`);
  },
  /** 按 scope 整替条目列表（增删改/排序/导入共用；返回整替后该 scope 列表，免二次 GET）。
   * baseRevision（r9 F1-B1 乐观锁）：传最近一次 GET 的 revision，服务端不一致返回 409 snippet_conflict */
  async putSnippets(body: {
    scope: "global" | "project";
    project?: string;
    snippets: SnippetEntry[];
    baseRevision?: string;
  }): Promise<{ snippets: SnippetEntry[] }> {
    return request("/api/snippets", jsonInit("PUT", body));
  },

  // ---- 记忆浏览（docs08-r4 任务 12，只读）----
  /** 项目记忆库 facts：服务端只读 repo/notes/facts/*.md（bullet 拆条）与 repo/system/*.md
   * （正文整体）；库缺失/空返回空列表 + libraryPath 说明，不报错（诚实空态）。 */
  async getMemoryFacts(project: string): Promise<MemoryFactsResponse> {
    return request(`/api/memory/facts?project=${encodeURIComponent(project)}`);
  },

  // ---- 定时任务（docs08-2026-10-22 批次任务 21 后端 / 任务 22 前端）----
  /** 全量列表（三状态目录直读）：jobs 按到期升序；invalid 如实回显；runner 存活态供状态列 */
  async listSchedule(): Promise<ScheduleListResponse> {
    return request("/api/schedule");
  },
  /** 创建：due 支持 epoch 毫秒或 ISO 字符串（过去时刻合法——runner 下次扫描即触发）；
   * everyMs 最小 60000（runner 轮询语义）。错误码 invalid_session/invalid_prompt/invalid_due/
   * invalid_every/schedule_limit（400）、session_not_found（404）、schedule_runner_unavailable（503） */
  async createSchedule(body: { sessionId: string; prompt: string; due: number | string; everyMs?: number | null }): Promise<{ job: ScheduleJobItem }> {
    return request("/api/schedule", jsonInit("POST", body));
  },
  /** 取消：pending → cancelled 墓碑移动；不存在 404（已在触发中/已取消同形） */
  async cancelSchedule(id: string): Promise<{ ok: boolean; id: string }> {
    return request(`/api/schedule/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  // ---- 扩展资源面与凭证检查（docs08-2026-10-22 批次任务 24）----
  /** 资源清单：extensions/skills/prompts 三目录 + settings packages；cliAvailable=false 降级 */
  async listExtensions(): Promise<ExtensionsResponse> {
    return request("/api/extensions");
  },
  /** 启停写入（服务端串行锁）；错误码 invalid_name/invalid_enabled/invalid_kind/extension_not_found */
  async setExtensionEnabled(name: string, kind: string, enabled: boolean): Promise<{ name: string; kind: string; enabled: boolean }> {
    return request(`/api/extensions/${encodeURIComponent(name)}`, jsonInit("PUT", { enabled, kind }));
  },
  /** 凭证检查三态（绝不回显凭证材料） */
  async getAuthStatus(): Promise<AuthStatusResponse> {
    return request("/api/auth/status");
  },
  /** 非交互 install/remove/update（async spawn 有界超时；失败 502 ok=false） */
  async runExtensionAction(action: "install" | "remove" | "update", source?: string): Promise<{ ok: boolean; message: string }> {
    return request(`/api/extensions/${action}`, jsonInit("POST", source ? { source } : {}));
  },
};

/** 定时任务行（server ScheduleJob + 目录派生 state；时间字段均为 epoch 毫秒） */
export interface ScheduleJobItem {
  version: number;
  id: string;
  sessionId: string;
  sessionFile: string | null;
  cwd: string;
  prompt: string;
  createdAt: number;
  dueAt: number;
  everyMs: number | null;
  fireCount: number;
  lastFiredAt: number | null;
  lastError: string | null;
  state: "pending" | "firing" | "failed";
  /** firing/failed 记录的 occurrence 序号（引擎命名契约 @n 段）；pending 无 */
  occurrence?: number;
}

export interface ScheduleListResponse {
  jobs: ScheduleJobItem[];
  /** 不可解析/命名异常的记录（如实报告，不静默丢） */
  invalid: { file: string; error: string }[];
  runner: { alive: boolean };
}

export interface FsBrowseEntry {
  name: string;
  /** 绝对路径（服务端按 realpath 拼接），补全回填与树逐级下钻直接回传 */
  path: string;
  hidden: boolean;
}

export interface FsBrowseResponse {
  entries: FsBrowseEntry[];
  /** "eacces" = 目录不可读（200 而非 500 的降级标注） */
  error?: string;
}

/** 标签定义条目（GET /api/tags；name 必填，sort 升序同 sort 按 name 码元序）。
 * color/display 为 todo 20 v2 可选字段（缺省 = hash 自动取色 / 跟随全局展示模式） */
export interface TagDefinition {
  name: string;
  sort: number;
  color?: string;
  display?: "text" | "grid";
}

/** 标签挂载引用（scope 取 "global"|"project"；挂载与定义解耦，孤儿如实返回） */
export interface TagRef {
  scope: string;
  name: string;
}

/** 常用语条目（GET/PUT /api/snippets；content 非空且 ≤4KB UTF-8 字节，sort 升序回显） */
export interface SnippetEntry {
  content: string;
  sort: number;
}

/** 记忆月文件组（GET /api/memory/facts；front-matter 已剥离，bullet 拆条，条目原文不截断） */
export interface MemoryFactsGroup {
  file: string;
  description: string | null;
  entries: string[];
}

/** system 记忆正文组（markdown 正文整体返回，不拆条） */
export interface MemorySystemDoc {
  file: string;
  description: string | null;
  body: string;
}

/** 记忆库遥测（docs08-r5 任务 14，只读硬数据；字段口径由 mini-spike 钉死） */
export interface MemoryTelemetry {
  /** 当日 committed 记忆运行个数（服务器本地时区日界线） */
  todayCount: number;
  /** facts bullet 条目总数 */
  totalEntries: number;
  /** facts + system 的 *.md 文件数 */
  fileCount: number;
  /** 最新 facts 文件 mtime（ISO 串；无 facts 文件为 null） */
  lastEntryAt: string | null;
  /** repo/system/*.md 磁盘字节和（展示文案“system 文件体积”，非注入体积） */
  systemBytes: number;
}

/** 记忆库浏览响应：exists=false = 库目录不存在（诚实空态；libraryPath 仍给出预期落点，
 * telemetry=null——无库即无遥测数字可报） */
export interface MemoryFactsResponse {
  project: string;
  libraryId: string;
  libraryPath: string;
  exists: boolean;
  facts: MemoryFactsGroup[];
  system: MemorySystemDoc[];
  telemetry: MemoryTelemetry | null;
}

/** 扩展资源条目（GET /api/extensions；docs08-2026-10-22 批次任务 24） */
export interface ExtensionItem {
  name: string;
  kind: "extension" | "skill" | "prompt" | "package";
  enabled: boolean;
  /** package 项的安装源（remove 动作入参） */
  source?: string;
}

export interface ExtensionsResponse {
  items: ExtensionItem[];
  /** false = omo CLI 缺失，install/remove/update 与凭证检查降级 */
  cliAvailable: boolean;
}

/** 凭证检查三态（0/1/2 → ready/not_configured/error；绝不回显凭证材料） */
export interface AuthStatusResponse {
  status: "ready" | "not_configured" | "error";
  provider: string | null;
  checkedAt: number;
  detail: string | null;
}
