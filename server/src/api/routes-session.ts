// 会话 REST 路由（todo 9）：建/列表/消息/prompt/abort/权限/草稿/已读/元数据/删除/usage。
// 错误统一 {error:{code,message}}（http.ts route 包装）；鉴权由入口 /api/* 中间件覆盖。
import { Hono, type Context } from "hono";
import type {
  EngineSessionSummary,
  EngineThinkingLevel,
} from "../adapter/engine-adapter";
import type { SessionMeta, SessionTagRef } from "../db/meta";
import type { TitleGenService } from "../title-gen";
import { readProjectPreferences } from "./config-migration";
import type { ApiDeps } from "./deps";
import type { EngineGateway } from "./engine-runtime";
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

/** 标题回退链（决策 9f，列表与 export 文件名两处共用）：
 * `renamedTitle > name > generatedTitle > firstMessage 截断 80 字 > emptyFallback`。
 * name 非恒空（终端 `omo -p --name` 建的会话带 name）；emptyFallback 列表用
 * "(空会话)"、export 用 ""（后续 `title || id` 回退会话 id）。 */
export function resolveSessionTitle(
  parts: {
    renamedTitle: string | null;
    name: string | null;
    generatedTitle: string | null;
    firstMessage: string;
  },
  emptyFallback = "(空会话)",
): string {
  return (
    parts.renamedTitle ??
    parts.name ??
    parts.generatedTitle ??
    (parts.firstMessage ? parts.firstMessage.slice(0, 80) : emptyFallback)
  );
}

/** 引擎行 + 元数据行合并为 API 会话对象（title 走 resolveSessionTitle 链）。
 * tags 为该会话的挂载关系 [{scope,name}]（createdAt 出参裁掉；孤儿挂载如实透传）。
 * generatedTitle 为 meta_session.generated_title（标题生成写入，与 renamed_title 独立）。 */
export function mergeSessionRow(
  row: EngineSessionSummary,
  meta: SessionMeta | null,
  tags: SessionTagRef[] = [],
  generatedTitle: string | null = null,
) {
  const firstMessage = row.firstMessage ?? "";
  const title = resolveSessionTitle({
    renamedTitle: meta?.renamedTitle ?? null,
    name: row.name ?? null,
    generatedTitle,
    firstMessage,
  });
  return {
    id: row.id,
    path: row.path,
    project: row.cwd,
    title,
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
    tags,
  };
}

/**
 * 导出文件名清洗（会话名可能含路径非法字符/控制字符/首尾点空格）。
 * 返回 {ascii, utf8}：ascii 作 filename 兜底（非 ASCII 会话名退化为 id 前缀），
 * utf8 作 filename*（RFC 5987，中文会话名的权威来源）。
 */
export function exportFilename(title: string, sessionId: string): { ascii: string; utf8: string } {
  const cleaned = title
    // oxlint-disable-next-line no-control-regex -- 有意匹配控制字符：清洗文件名非法字符
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 60)
    .trim();
  const utf8 = `${cleaned || sessionId || "session"}.html`;
  const asciiSafe = cleaned.replace(/[^\x20-\x7e]/g, "").trim() || sessionId.slice(0, 8) || "session";
  return { ascii: `${asciiSafe}.html`, utf8 };
}

/** 聚合模式（project 缺省）需要网关的项目清单能力。EngineGateway 接口未含
 * listProjectPaths（engine-runtime.ts 属并行任务领地禁改），按结构能力探测：
 * 真实 EngineRuntimeRegistry 具备该方法；缺失时聚合退化为空列表。 */
type ProjectListerGateway = EngineGateway & { listProjectPaths?: () => string[] };

/** 会话列表行（合并元数据 + active 探询后的形态） */
type SessionListRow = ReturnType<typeof mergeSessionRow> & { active: boolean | null };

/** 置顶优先，其余按最后活动时间倒序（todo 15 排序语义；聚合模式跨项目全局比较） */
function byPinnedThenModified(a: { pinned: boolean; modified: string }, b: { pinned: boolean; modified: string }): number {
  return Number(b.pinned) - Number(a.pinned) || b.modified.localeCompare(a.modified);
}

/** 单项目会话列表：store 直查 + 元数据合并 + 视图/归档/搜索/标签过滤 + active 探询。
 * 不定序（单项目与聚合两种调用方各自定序）。tagNames 为 OR 语义的标签名集合
 *（空数组 = 不过滤）；命中判定按 name 无关 scope（挂载与定义解耦，跨 scope
 * 同名命中属合理语义，routes-tags.test.ts 锁定该决策）。 */
async function listProjectSessions(
  deps: ApiDeps,
  project: string,
  view: "human" | "all",
  archived: "true" | "false" | "all",
  q: string,
  tagNames: string[],
): Promise<SessionListRow[]> {
  let sessions = (await deps.engines.sessionsList(project)).map((row) => {
    const tags = deps.meta.listSessionTags(row.id).map(({ scope, name }) => ({ scope, name }));
    return mergeSessionRow(
      row,
      deps.meta.getSessionMeta(row.id),
      tags,
      deps.meta.getSessionGeneratedTitle(row.id),
    );
  });
  if (tagNames.length > 0) {
    const wanted = new Set(tagNames);
    sessions = sessions.filter((s) => s.tags.some((t) => wanted.has(t.name)));
  }
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
  // active 语义 = 回合进行中（webui 驱动的流式回合）：true/false，引擎未就绪为
  // null（不触发 spawn）。注意不是引擎 open 态——open 在回合结束后仍保留，
  // 按 open 判定会导致 active 永远 true（todo 15 实证，已修复）。
  // 状态点（运行中/等待权限/空闲/出错）仍以 SSE 状态事件为准（todo 15）。
  const activePaths = await deps.engines.peekActiveSessionPaths(project);
  return sessions.map((s) => ({
    ...s,
    active: activePaths ? activePaths.includes(s.path) : null,
  }));
}

export function createSessionRoutes(deps: ApiDeps & { titleGen?: TitleGenService }): Hono {
  const app = new Hono();
  // 新建会话：模型优先级 body.model > 项目偏好（todo 6：项目文件合并读取，过渡态
  // 库值回退 + 损坏降级 null = 引擎默认）> 引擎默认
  app.post("/api/sessions", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.project);
    const preferred =
      readProjectPreferences(deps.projectConfigs ?? null, deps.meta, project).preferredModel ?? undefined;
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

  // 会话列表：project 必填时单项目（现状行为）；缺省时聚合全部注册项目——
  // 逐项目 catch（allSettled 语义）失败跳过不炸整体（注册项目目录已删/库损坏时
  // 侧栏仍可用），合并后全局排序（置顶优先 + modified 降序，跨项目比较）。
  // view/q/archived/tag 语义不变、跨项目生效；tag 可多个（OR：任一命中，
  // 服务端按 meta_session_tag 过滤，listProjectSessions 内实现故两模式一致）。
  // q = 标题/会话名子串匹配（消息内容搜索明确出范围，docs/02 只承诺标题级搜索）
  app.get("/api/sessions", route(async (c: Context) => {
    const view = c.req.query("view") ?? "human";
    if (view !== "human" && view !== "all") {
      throw new ApiError(400, "invalid_view", "view 仅支持 human|all");
    }
    const archived = c.req.query("archived") ?? "false";
    if (archived !== "true" && archived !== "false" && archived !== "all") {
      throw new ApiError(400, "invalid_archived", "archived 仅支持 true|false|all");
    }
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    // Hono queries() 在 key 缺席时返回 undefined（类型标注不符），兜底空数组
    const tagNames = c.req.queries("tag") ?? [];
    const rawProject = c.req.query("project");

    if (rawProject === undefined || rawProject === "") {
      const lister = deps.engines as ProjectListerGateway;
      const projects = lister.listProjectPaths?.() ?? [];
      const settled = await Promise.allSettled(
        projects.map((project) => listProjectSessions(deps, project, view, archived, q, tagNames)),
      );
      const sessions: SessionListRow[] = [];
      settled.forEach((result, i) => {
        if (result.status === "fulfilled") {
          sessions.push(...result.value);
        } else {
          console.error(`[sessions] 聚合跳过失败项目 ${projects[i]}:`, result.reason);
        }
      });
      sessions.sort(byPinnedThenModified);
      return c.json({ project: null, view, archived, sessions });
    }

    const project = validateProjectInput(rawProject);
    const sessions = await listProjectSessions(deps, project, view, archived, q, tagNames);
    sessions.sort(byPinnedThenModified);
    return c.json({ project, view, archived, sessions });
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
      // 未落盘别名会话首条消息落盘后的真实 id（前端即时换 key；已落盘会话无此字段）
      ...(typeof receipt.durableSessionId === "string" && receipt.durableSessionId !== id
        ? { durableSessionId: receipt.durableSessionId }
        : {}),
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

  // 手动生成标题（W2 todo 8）：同步生成（超时 ≤10s，Bun.serve 空闲 ~12s 掐断内），
  // 成功写 renamedTitle（任何链形态下立即生效，不被引擎 name 压住），失败 502 带原因。
  app.post("/api/sessions/:id/generate-title", route(async (c: Context) => {
    const id = requireParam(c, "id");
    if (!deps.titleGen) throw new ApiError(502, "title_gen_unavailable", "标题生成服务未接线");
    try {
      const title = await deps.titleGen.generateForSession(id);
      return c.json({ title });
    } catch (err) {
      throw new ApiError(502, "title_gen_failed", err instanceof Error ? err.message : String(err));
    }
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

  // 单会话导出 HTML（verification/05 P1-7：omo --export 实证可用）。
  // 空会话未落盘 → gateway 409 session_not_persisted，前端无感（按钮点了才报）。
  // 文件名标题链与列表共用 resolveSessionTitle（决策 9f，含 generatedTitle 层）。
  app.get("/api/sessions/:id/export", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const { html, row } = await deps.engines.exportSessionHtml(id);
    const title = resolveSessionTitle(
      {
        renamedTitle: deps.meta.getSessionMeta(id)?.renamedTitle ?? null,
        name: row.name ?? null,
        generatedTitle: deps.meta.getSessionGeneratedTitle(id),
        firstMessage: row.firstMessage ?? "",
      },
      "",
    );
    const name = exportFilename(title || id, id);
    return c.body(html, 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name.ascii.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name.utf8)}`,
    });
  }));

  // 从指定条目 fork 新会话（重试语义）：position 默认 "before"（仅接受 user 消息条目，
  // 新会话 = 该消息之前的上下文，text 返回原消息文本供前端重发）。
  // "编辑后重发"降级不在此路由实现——capabilities.editResend=false（verification/05 P1-6：
  // 官配引擎无 continue_from_leaf），入口不渲染，fork 重试为替代路径。
  app.post("/api/sessions/:id/fork", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const body = await parseJsonBody(c);
    if (typeof body.entryId !== "string" || !body.entryId) {
      throw new ApiError(400, "invalid_entry", "entryId 必填");
    }
    const position = body.position === undefined ? undefined : body.position;
    if (position !== undefined && position !== "before" && position !== "at") {
      throw new ApiError(400, "invalid_position", "position 仅支持 before|at");
    }
    const forked = await deps.engines.forkSession(id, body.entryId, position);
    return c.json({
      session: { id: forked.id, sessionPath: forked.sessionPath, durable: forked.durable },
      text: forked.text,
    });
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
