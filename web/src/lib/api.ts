// 类型化 REST client：覆盖 server 全部端点（shape 见 .omo/notepads/senpi-webui/learnings.md W2 todo 9）。
// 统一错误形状 {error:{code,message}} 解析；401（未登录/过期）统一跳登录页。
// prompt 的模型防呆/偏好注入读 ui store（ui.ts 对 api.ts 仅类型引用，无运行时环）。
import { useUiStore } from "@/stores/ui";
import { effectiveThinkingLevel } from "@/lib/thinking-level";

// ---------- 领域类型 ----------

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
  /** 思考档偏好（W2 todo 8，写项目 .senpi-webui.json；服务端仅接受 low/high/max/null） */
  preferredThinkingLevel?: string | null;
  /** 死项目守卫（W1 #2）：仅路径已不存在/不再是目录的条目携带 missing:true，
   * 可解析条目省略该字段；bootstrap 自动恢复据此静默跳过。 */
  missing?: boolean;
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
  /** 会话标签（server todo 3 落地前为 undefined，消费侧用 tags?.length 防御） */
  tags?: Array<{ scope: string; name: string }>;
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
}

export interface DraftInfo {
  content: string;
  updatedAt: string;
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
}

export interface ModelsResponse {
  project: string | null;
  models: ModelInfo[];
}

export interface InputHistoryItem {
  id: number;
  projectPath: string;
  content: string;
  createdAt: string;
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
  truncated: boolean;
  binary: boolean;
  content: string | null;
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
    throw new ApiError(401, "unauthorized", "未登录或会话已过期");
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
  async listMessages(sessionId: string, cursor?: string): Promise<MessagesPage> {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/messages${qs}`);
  },
  async prompt(
    sessionId: string,
    body: { text: string; images?: Array<{ data: string; mimeType: string }>; model?: string; thinkingLevel?: string; agent?: string },
  ): Promise<PromptReceipt> {
    // 防呆（todo 22）：模型列表已确认为空时引擎无可用模型，发送必然失败——客户端直接拦截，
    // 不发请求；输入区捕获 ApiError 后行内展示。
    const ui = useUiStore.getState();
    if (ui.modelsLoaded && ui.models.length === 0) {
      throw new ApiError(400, "no_models_available", "无可用模型，无法发送（请检查引擎模型配置）");
    }
    // 命令门（todo 24）：/ 前缀命中不支持命令时抛 ApiError（chat-view 注册的 commandGate）
    promptGate?.(body.text);
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
  async respondPermission(
    sessionId: string,
    body: { requestId: string; value?: unknown; confirmed?: boolean; cancelled?: boolean },
  ): Promise<{ ok: boolean; sessionId: string; requestId: string }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/permission`, jsonInit("POST", body));
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
      throw new ApiError(401, "unauthorized", "未登录或会话已过期");
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

  // ---- models ----
  async listModels(project?: string): Promise<ModelsResponse> {
    const qs = project ? `?project=${encodeURIComponent(project)}` : "";
    return request(`/api/models${qs}`);
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

  // ---- 标签（todo 11）----
  /** 两源标签定义：global 恒返回；project 仅传项目路径时返回（读不要求已注册） */
  async listTags(project?: string): Promise<{ global: TagDefinition[]; project: TagDefinition[] }> {
    const qs = project ? `?project=${encodeURIComponent(project)}` : "";
    return request(`/api/tags${qs}`);
  },
  /** 按 scope 整替定义列表（新增/重命名/删除/排序共用；重名 400 invalid_tags） */
  async putTags(body: { scope: "global" | "project"; project?: string; tags: TagDefinition[] }): Promise<{ tags: TagDefinition[] }> {
    return request("/api/tags", jsonInit("PUT", body));
  },
  /** 会话标签挂载整替（挂载与定义解耦：不校验定义存在；重复项服务端按 (scope,name) 去重） */
  async setSessionTags(sessionId: string, tags: TagRef[]): Promise<{ tags: TagRef[] }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/tags`, jsonInit("PUT", { tags }));
  },

  // ---- 常用语（todo 14）----
  /** 两源常用语：global 恒返回；project 仅传项目路径时返回（读不要求已注册） */
  async listSnippets(project?: string): Promise<{ global: SnippetEntry[]; project: SnippetEntry[] }> {
    const qs = project ? `?project=${encodeURIComponent(project)}` : "";
    return request(`/api/snippets${qs}`);
  },
  /** 按 scope 整替条目列表（增删改/排序/导入共用；返回整替后该 scope 列表，免二次 GET） */
  async putSnippets(body: {
    scope: "global" | "project";
    project?: string;
    snippets: SnippetEntry[];
  }): Promise<{ snippets: SnippetEntry[] }> {
    return request("/api/snippets", jsonInit("PUT", body));
  },
};

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

/** 标签定义条目（GET /api/tags；name 必填，sort 升序同 sort 按 name 码元序） */
export interface TagDefinition {
  name: string;
  sort: number;
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
