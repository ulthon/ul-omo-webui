// 会话 REST 路由（todo 9）：建/列表/消息/prompt/abort/权限/草稿/已读/元数据/删除/usage。
// 错误统一 {error:{code,message}}（http.ts route 包装）；鉴权由入口 /api/* 中间件覆盖。
import { Hono, type Context } from "hono";
import type {
  EngineSessionSummary,
  EngineThinkingLevel,
} from "../adapter/engine-adapter";
import type { SessionMeta } from "../db/meta";
import type { ApiDeps } from "./deps";
import { ApiError, parseJsonBody, requireParam, route } from "./http";
import { validateProjectInput } from "./paths";

const THINKING_LEVELS: ReadonlySet<string> = new Set(["low", "high", "max"]);

/** "provider/model" → [provider, model]（首个 "/" 切分；模型 id 可含多段） */
export function splitModelId(model: string): [string, string] {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new ApiError(400, "invalid_model", `model 需为 "provider/model" 形态：${model}`);
  }
  return [model.slice(0, slash), model.slice(slash + 1)];
}

function parseThinkingLevel(raw: unknown): EngineThinkingLevel | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string" && THINKING_LEVELS.has(raw)) return raw as EngineThinkingLevel;
  // 引擎实测 glm 系档位为 low/high/max，无 off（docs/verification/01）
  throw new ApiError(400, "invalid_thinking_level", "thinkingLevel 仅支持 low/high/max");
}

function parseImages(raw: unknown): Array<{ type: "image"; data: string; mimeType: string }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, "invalid_images", "images 必须是数组");
  if (raw.length > 8) throw new ApiError(400, "invalid_images", "images 最多 8 张");
  return raw.map((item) => {
    const img = item as { data?: unknown; mimeType?: unknown };
    if (typeof img.data !== "string" || img.data.length === 0 || typeof img.mimeType !== "string" || !img.mimeType) {
      throw new ApiError(400, "invalid_images", "每张图片需含 data（base64）与 mimeType");
    }
    return { type: "image" as const, data: img.data, mimeType: img.mimeType };
  });
}

/** 引擎行 + 元数据行合并为 API 会话对象（title 优先级：renamedTitle > name > firstMessage） */
export function mergeSessionRow(row: EngineSessionSummary, meta: SessionMeta | null) {
  const firstMessage = row.firstMessage ?? "";
  return {
    id: row.id,
    path: row.path,
    project: row.cwd,
    title: meta?.renamedTitle ?? row.name ?? (firstMessage ? firstMessage.slice(0, 80) : "(空会话)"),
    name: row.name ?? null,
    renamedTitle: meta?.renamedTitle ?? null,
    // 仅 fork 场景写入（docs/verification/05 P1-1）；人工会话 = 无此字段
    parentSessionPath: row.parentSessionPath ?? null,
    created: row.created,
    modified: row.modified,
    messageCount: row.messageCount,
    firstMessage,
    pinned: meta?.pinned ?? false,
    archivedAt: meta?.archivedAt ?? null,
    unreadCount: meta?.unreadCount ?? 0,
    lastRead: meta?.lastRead ?? null,
  };
}

export function createSessionRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // 新建会话：模型优先级 body.model > 项目偏好 preferred_model > 引擎默认
  app.post("/api/sessions", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.project);
    const preferred = deps.meta.getProjectMeta(project)?.preferredModel ?? undefined;
    const modelStr = typeof body.model === "string" && body.model ? body.model : preferred;
    let provider: string | undefined;
    let modelId: string | undefined;
    if (modelStr) [provider, modelId] = splitModelId(modelStr);
    const created = await deps.engines.createSession(project, {
      provider,
      modelId,
      thinkingLevel: parseThinkingLevel(body.thinkingLevel),
    });
    return c.json({ session: { ...created, project, provider: provider ?? null, modelId: modelId ?? null } }, 201);
  }));

  // 会话列表：引擎 store 直查 + 元数据合并；view=human 过滤出人工会话（无 fork 血缘）；
  // q = 标题/会话名子串匹配（消息内容搜索明确出范围，docs/02 只承诺标题级搜索）
  app.get("/api/sessions", route(async (c: Context) => {
    const project = validateProjectInput(c.req.query("project"));
    const view = c.req.query("view") ?? "human";
    if (view !== "human" && view !== "all") {
      throw new ApiError(400, "invalid_view", "view 仅支持 human|all");
    }
    const archived = c.req.query("archived") ?? "false";
    if (archived !== "true" && archived !== "false" && archived !== "all") {
      throw new ApiError(400, "invalid_archived", "archived 仅支持 true|false|all");
    }
    const q = (c.req.query("q") ?? "").trim().toLowerCase();

    let sessions = (await deps.engines.sessionsList(project)).map((row) =>
      mergeSessionRow(row, deps.meta.getSessionMeta(row.id)),
    );
    if (view === "human") {
      sessions = sessions.filter((s) => s.parentSessionPath === null);
    }
    if (archived !== "all") {
      const wantArchived = archived === "true";
      sessions = sessions.filter((s) => (s.archivedAt !== null) === wantArchived);
    }
    if (q) {
      sessions = sessions.filter(
        (s) => s.title.toLowerCase().includes(q) || (s.name ?? "").toLowerCase().includes(q),
      );
    }
    // 活跃标记：仅在引擎已就绪时探询（列表请求不触发冷启动 spawn），null 表示未知
    const activePaths = await deps.engines.peekActiveSessionPaths(project);
    const withActive = sessions.map((s) => ({
      ...s,
      active: activePaths ? activePaths.includes(s.path) : null,
    }));
    // 置顶优先，其余按最后活动时间倒序（todo 15 列表排序语义）
    withActive.sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.modified.localeCompare(a.modified),
    );
    return c.json({ project, view, archived, sessions: withActive });
  }));

  // 会话消息分页：cursor = 上页 leafId，传回取增量（verification/01 游标语义）
  app.get("/api/sessions/:id/messages", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const cursor = c.req.query("cursor") || undefined;
    const page = await deps.engines.messages(id, cursor);
    return c.json({ sessionId: id, entries: page.entries, leafId: page.leafId, cursor: page.cursor });
  }));

  // 发送 prompt（body: text 必填、images 可选、model 可选 "provider/model"、agent 接受但降级）
  app.post("/api/sessions/:id/prompt", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const body = await parseJsonBody(c);
    if (typeof body.text !== "string" || body.text.trim() === "") {
      throw new ApiError(400, "invalid_text", "text 必填且不能为空");
    }
    const images = parseImages(body.images);
    let model: string | undefined;
    if (typeof body.model === "string" && body.model) {
      splitModelId(body.model);
      model = body.model;
    }
    const degradations: string[] = [];
    if (typeof body.agent === "string" && body.agent) {
      // 引擎无 agent 选择协议面（docs/verification/05 P1-5）；显式降级不静默丢弃
      degradations.push("agent: 引擎无 agent 选择协议面，参数未生效（capabilities.agentsList=false）");
    }
    const receipt = await deps.engines.prompt(id, { text: body.text, images, model });
    return c.json({
      sessionId: id,
      disposition: receipt.disposition,
      streaming: receipt.disposition !== "handled",
      ...(degradations.length > 0 ? { degradations } : {}),
    });
  }));

  app.post("/api/sessions/:id/abort", route(async (c: Context) => {
    const id = requireParam(c, "id");
    await deps.engines.abort(id);
    return c.json({ ok: true, sessionId: id });
  }));

  // 权限/表单应答（verification/02 四型）：value|confirmed|cancelled 至少一项
  app.post("/api/sessions/:id/permission", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const body = await parseJsonBody(c);
    if (typeof body.requestId !== "string" || !body.requestId) {
      throw new ApiError(400, "invalid_request", "requestId 必填");
    }
    const reply: { value?: string; confirmed?: boolean; cancelled?: boolean } = {};
    if (typeof body.value === "string") reply.value = body.value;
    if (typeof body.confirmed === "boolean") reply.confirmed = body.confirmed;
    if (body.cancelled === true) reply.cancelled = true;
    if (Object.keys(reply).length === 0) {
      throw new ApiError(400, "invalid_request", "需要 value/confirmed/cancelled 之一");
    }
    await deps.engines.permissionRespond(id, body.requestId, reply);
    return c.json({ ok: true, sessionId: id, requestId: body.requestId });
  }));

  // 服务端草稿（纯元数据，不触引擎）
  app.get("/api/sessions/:id/draft", route(async (c: Context) => {
    const id = requireParam(c, "id");
    return c.json({ sessionId: id, draft: deps.meta.getDraft(id) });
  }));

  app.put("/api/sessions/:id/draft", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const body = await parseJsonBody(c);
    if (typeof body.content !== "string") {
      throw new ApiError(400, "invalid_content", "content 必须是字符串");
    }
    deps.meta.setDraft(id, body.content);
    return c.json({ ok: true, sessionId: id, draft: deps.meta.getDraft(id) });
  }));

  // 已读上报：last_read 置值 + 未读清零（"任一设备查看即清零"语义）
  app.post("/api/sessions/:id/read", route(async (c: Context) => {
    const id = requireParam(c, "id");
    deps.meta.markSessionRead(id);
    return c.json({ ok: true, sessionId: id, meta: deps.meta.getSessionMeta(id) });
  }));

  // 会话元数据：置顶/归档/重命名（部分更新；renamedTitle=null 恢复自动名）
  app.patch("/api/sessions/:id/meta", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const body = await parseJsonBody(c);
    const patch: {
      pinned?: boolean;
      archivedAt?: string | null;
      renamedTitle?: string | null;
    } = {};
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== "boolean") throw new ApiError(400, "invalid_pinned", "pinned 必须是布尔值");
      patch.pinned = body.pinned;
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== "boolean") throw new ApiError(400, "invalid_archived", "archived 必须是布尔值");
      patch.archivedAt = body.archived ? new Date().toISOString() : null;
    }
    if (body.renamedTitle !== undefined) {
      if (body.renamedTitle !== null && typeof body.renamedTitle !== "string") {
        throw new ApiError(400, "invalid_renamed_title", "renamedTitle 必须是字符串或 null");
      }
      patch.renamedTitle = body.renamedTitle === null ? null : body.renamedTitle;
    }
    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, "invalid_request", "需要 pinned/archived/renamedTitle 至少一项");
    }
    const meta = deps.meta.updateSessionMeta(id, patch);
    return c.json({ ok: true, sessionId: id, meta });
  }));

  // 删除会话：引擎侧删会话文件（无删除协议面，见 gateway 注释）+ 元数据行级联清理
  app.delete("/api/sessions/:id", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const removed = await deps.engines.deleteSession(id);
    deps.meta.deleteSessionMeta(id);
    return c.json({ ok: true, deleted: { id, ...removed } });
  }));

  // 会话 usage 统计（会话级累计，verification/05 P1-4：get_session_stats）
  app.get("/api/usage", route(async (c: Context) => {
    const id = c.req.query("session");
    if (!id) throw new ApiError(400, "invalid_request", "session 查询参数必填");
    const usage = await deps.engines.usage(id);
    return c.json({ sessionId: id, usage });
  }));

  return app;
}
