// 类型化 REST client：覆盖 server 全部端点（shape 见 .omo/notepads/senpi-webui/learnings.md W2 todo 9）。
// 统一错误形状 {error:{code,message}} 解析；401（未登录/过期）统一跳登录页。

// ---------- 领域类型 ----------

export interface ProjectMeta {
  projectPath: string;
  preferredAgent: string | null;
  preferredModel: string | null;
  lastOpenedAt: string | null;
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
  durable: string;
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

export interface UsageInfo {
  tokens?: Record<string, number>;
  cost?: Record<string, unknown>;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  [key: string]: unknown;
}

export interface AgentsResponse {
  capabilities: { agentsList: boolean };
  agents: string[];
  degraded: boolean;
  reason: string;
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

// ---------- API ----------

export interface ListSessionsParams {
  project: string;
  view?: "human" | "all";
  /** "true"|"false"|"all"，默认 "false" */
  archived?: "true" | "false" | "all";
  q?: string;
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
  async listSessions(params: ListSessionsParams): Promise<{ project: string; view: string; archived: string; sessions: SessionListItem[] }> {
    const q = new URLSearchParams({ project: params.project });
    if (params.view) q.set("view", params.view);
    if (params.archived) q.set("archived", params.archived);
    if (params.q) q.set("q", params.q);
    return request(`/api/sessions?${q.toString()}`);
  },
  async listMessages(sessionId: string, cursor?: string): Promise<MessagesPage> {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/messages${qs}`);
  },
  async prompt(
    sessionId: string,
    body: { text: string; images?: Array<{ data: string; mimeType: string }>; model?: string; agent?: string },
  ): Promise<PromptReceipt> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, jsonInit("POST", body));
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
  async getUsage(session: string): Promise<{ sessionId: string; usage: UsageInfo }> {
    return request(`/api/usage?session=${encodeURIComponent(session)}`);
  },

  // ---- agents / models ----
  async listAgents(): Promise<AgentsResponse> {
    return request("/api/agents");
  },
  async listModels(project?: string): Promise<ModelsResponse> {
    const qs = project ? `?project=${encodeURIComponent(project)}` : "";
    return request(`/api/models${qs}`);
  },

  // ---- 项目 ----
  async listProjects(): Promise<{ projects: ProjectMeta[] }> {
    return request("/api/projects");
  },
  async addProject(path: string): Promise<{ ok: boolean; project: ProjectMeta | null }> {
    return request("/api/projects", jsonInit("POST", { path }));
  },
  async patchProjectMeta(patch: {
    path: string;
    preferredAgent?: string | null;
    preferredModel?: string | null;
    lastOpenedAt?: string | null;
  }): Promise<{ ok: boolean; project: ProjectMeta | null }> {
    return request("/api/projects/meta", jsonInit("PATCH", patch));
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
};
