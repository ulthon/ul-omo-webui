// 会话 REST 路由（todo 9）：建/列表/消息/prompt/abort/权限/草稿/已读/元数据/删除/usage/附件。
// 错误统一 {error:{code,message}}（http.ts route 包装）；鉴权由入口 /api/* 中间件覆盖。
import { Hono, type Context } from "hono";
import { lstatSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EnginePromptInput,
  EngineSessionSummary,
  EngineThinkingLevel,
} from "../adapter/engine-adapter";
import {
  ATTACHMENT_MAX_BYTES,
  attachmentsRoot,
  generatedAttachmentName,
  projectAttachmentsDir,
  validateAttachmentName,
} from "./attachments";
import type { SessionMeta, SessionTagRef } from "../db/meta";
import { resolveTitleLanguage, type TitleGenService } from "../title-gen";
import { readProjectPreferences } from "./config-migration";
import type { ApiDeps } from "./deps";
import type { EngineGateway, ServerSessionRunState } from "./engine-runtime";
import { ApiError, parseJsonBody, requireParam, route, toErrorResponse } from "./http";
import { validateProjectInput } from "./paths";
import { CursorInvalidError, readEntriesBefore, readTailEntries } from "../adapter/session-file";
import { DEBUG_PERF, logPerfHttp } from "./perf";

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

const STREAMING_BEHAVIORS: ReadonlySet<string> = new Set(["steer", "followUp"]);

/** 压缩 HTTP 同步等待期限（docs08-r6 任务 18 ④）：Bun.serve 空闲 ~12s 掐断连接
 *  （title-gen 手动路径同例），期限内未完成即 504 compact_timeout 明示「仍在后台
 *  进行」——引擎侧压缩不随 HTTP 放弃等待而取消（RPC 连接独立于 HTTP 连接），
 *  compaction_end SSE 事件驱动前端重拉 usage 补偿（事件链见 web compact-run/event-dispatch）。 */
export const COMPACT_HTTP_TIMEOUT_MS = 10_000;

/** 排队语义枚举校验（docs08-r4 任务 11，与 parseThinkingLevel 同一解析惯例） */
function parseStreamingBehavior(raw: unknown): EnginePromptInput["streamingBehavior"] {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string" && STREAMING_BEHAVIORS.has(raw)) return raw as EnginePromptInput["streamingBehavior"];
  // 引擎回合中入队仅认 steer/followUp 两档（spike 实测，其余值报 already processing）
  throw new ApiError(400, "invalid_streaming_behavior", "streamingBehavior 仅支持 steer/followUp");
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

/** question 型应答甄别（q1 提问卡片）：Record<questionId, {selected: label[]; text?}>。
 *  空对象 {} 合法：引擎 ConnectionQuestionBridge.respond 要求载荷含 answers 键才进入
 *  settledQuestionStatus 甄别（comment-only 落定 comment-submitted 必须带 answers:{}），
 *  剥掉空 answers 会让引擎拒收 question_incomplete 且静默（r6 实录卡死根因）。
 *  空对象仅在同时有非空 comment 时放行（路由内守卫），纯空对象仍由总校验报 400。 */
function isQuestionAnswers(raw: unknown): raw is Record<string, { selected: string[]; text?: string }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const entries = Object.values(raw as Record<string, unknown>);
  if (entries.length === 0) return true;
  return entries.every(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      Array.isArray((v as { selected?: unknown }).selected) &&
      (v as { selected: unknown[] }).selected.every((s) => typeof s === "string"),
  );
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

/** 附件端点需要"会话 → 所属项目路径"反查。EngineGateway 接口未含 resolveSessionRow，
 * 同 ProjectListerGateway 结构能力探测先例：真实 EngineRuntimeRegistry 具备该方法
 * （纯读不触发 spawn），fake 测试按需提供。 */
type SessionRowGateway = EngineGateway & {
  resolveSessionRow?: (sessionId: string) => Promise<EngineSessionSummary | null>;
};

/** 附件端点共用：会话 id 反查所属项目路径（附件临时区按项目隔离的键） */
async function requireSessionProject(deps: ApiDeps, sessionId: string): Promise<string> {
  const row = await (deps.engines as SessionRowGateway).resolveSessionRow?.(sessionId);
  if (!row) throw new ApiError(404, "session_not_found", `会话不存在：${sessionId}`);
  return row.cwd;
}

/** 会话列表行（合并元数据 + active/runState 探询后的形态） */
type SessionListRow = ReturnType<typeof mergeSessionRow> & {
  active: boolean | null;
  /** 服务端三态真相源（docs08-r6 任务 11）：running|waiting|idle；引擎未就绪为 null */
  runState: ServerSessionRunState | null;
};

/** 置顶优先，其余按最后活动时间倒序（todo 15 排序语义；聚合模式跨项目全局比较） */
function byPinnedThenModified(a: { pinned: boolean; modified: string }, b: { pinned: boolean; modified: string }): number {
  return Number(b.pinned) - Number(a.pinned) || b.modified.localeCompare(a.modified);
}

/** 单项目会话列表：store 直查 + 元数据合并 + 归档/搜索/标签过滤 + active 探询。
 * 不定序（单项目与聚合两种调用方各自定序）。tagNames 为 OR 语义的标签名集合
 *（空数组 = 不过滤）；命中判定按 name 无关 scope（挂载与定义解耦，跨 scope
 * 同名命中属合理语义，routes-tags.test.ts 锁定该决策）。
 * 旧 view 参数已移除（W3 todo 9）：列表固定含 fork 会话（原 view=all 口径）；
 * 存量客户端携带 view=human/all 时被忽略（accept-and-ignore，不做 400 拒绝）。 */
async function listProjectSessions(
  deps: ApiDeps,
  project: string,
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
  // runState（docs08-r6 任务 11）= 服务端三态真相源（waiting 压制 running 的映射
  // 见 deriveSessionRunState）：水合探询与前端 resync 据此对账。可选面缺席
  // （旧 fake）退回 peekActiveSessionPaths——active 照发，runState 恒 null。
  const runStates = await deps.engines.peekRunStates?.(project);
  const activePaths = runStates ? [...runStates.keys()] : await deps.engines.peekActiveSessionPaths(project);
  return sessions.map((s) => ({
    ...s,
    active: activePaths ? activePaths.includes(s.path) : null,
    runState: runStates ? (runStates.get(s.path) ?? "idle") : null,
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
  // q/archived/tag 语义不变、跨项目生效；tag 可多个（OR：任一命中，
  // 服务端按 meta_session_tag 过滤，listProjectSessions 内实现故两模式一致）。
  // q = 标题/会话名子串匹配（消息内容搜索明确出范围，docs/02 只承诺标题级搜索）。
  // 旧 view 参数不再解析（W3 todo 9）：固定返回含 fork 的全量列表，存量客户端
  // 带 view=human/all 时不报错（accept-and-ignore），响应也不再回显 view 字段。
  app.get("/api/sessions", route(async (c: Context) => {
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
      // A2（docs08-r3 todo 10）：聚合模式过滤 hidden 项目的分组（软标记在 meta_project，
      // 无 meta 行的项目视为未隐藏——与侧栏可见性口径一致）；单项目显式访问不过滤。
      const projects = (lister.listProjectPaths?.() ?? []).filter(
        (project) => deps.meta.getProjectMeta(project)?.hidden !== true,
      );
      const settled = await Promise.allSettled(
        projects.map((project) => listProjectSessions(deps, project, archived, q, tagNames)),
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
      return c.json({ project: null, archived, sessions });
    }

    const project = validateProjectInput(rawProject);
    const sessions = await listProjectSessions(deps, project, archived, q, tagNames);
    sessions.sort(byPinnedThenModified);
    return c.json({ project, archived, sessions });
  }));

  // 会话消息分页：cursor = 上页 leafId，传回取增量（verification/01 游标语义）。
  // 任务 16（GAP-6 修复）：无 cursor 首载改服务端尾窗直读（resolveSession 取
  // sessionPath，SDK 直读不 spawn 引擎不进 runExclusive 不 switchTo；读不到会话
  // 文件的新会话/别名回退引擎全量）；?before= 上一窗（无效 409 cursor_invalid）；
  // ?cursor= 前向增量与 ?full=1 全量（SSE gap 重连对账依赖）走引擎不变。
  // Fix0 HTTP 计时（docs08 任务 1；UL_OMO_WEBUI_DEBUG_PERF 默认关零输出）。
  app.get("/api/sessions/:id/messages", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const cursor = c.req.query("cursor") || undefined;
    const before = c.req.query("before") || undefined;
    const full = c.req.query("full") === "1";
    const t0 = DEBUG_PERF ? performance.now() : 0;
    try {
      let page: Awaited<ReturnType<typeof deps.engines.messages>>;
      let hasMore = false;
      let oldestId: string | null = null;
      if (cursor || full || !deps.engines.sessionPath) {
        // 前向增量 / 全量 / fake 网关（无直读面）：引擎路径原样
        page = await deps.engines.messages(id, cursor);
        oldestId = page.entries[0]?.id ?? null;
      } else {
        // 尾窗直读：磁盘文件在则直读；不在（新会话未落盘/别名）回退引擎
        const sessionPath = await deps.engines.sessionPath(id);
        let stat: { size: number } | null = null;
        try {
          stat = statSync(sessionPath);
        } catch {
          stat = null;
        }
        if (stat && stat.size > 0) {
          try {
            const tail = before
              ? await readEntriesBefore(sessionPath, before)
              : await readTailEntries(sessionPath);
            page = { entries: tail.entries, leafId: tail.leafId, cursor: tail.leafId };
            hasMore = tail.hasMore;
            oldestId = tail.oldestId;
          } catch (err) {
            if (err instanceof CursorInvalidError) {
              throw new ApiError(409, "cursor_invalid", "before 游标在会话文件中不存在");
            }
            throw err;
          }
        } else {
          page = await deps.engines.messages(id);
          oldestId = page.entries[0]?.id ?? null;
        }
      }
      if (DEBUG_PERF) logPerfHttp(200, performance.now() - t0, page.entries.length);
      return c.json({
        sessionId: id,
        entries: page.entries,
        leafId: page.leafId,
        cursor: page.cursor,
        hasMore,
        oldestId,
      });
    } catch (err) {
      if (DEBUG_PERF) logPerfHttp(toErrorResponse(c, err).status, performance.now() - t0, undefined);
      throw err;
    }
  }));

  // 发送 prompt（body: text 必填、images 可选、model 可选 "provider/model"、
  // thinkingLevel 可选 low/high/max（W2 todo 7，与 POST /api/sessions 同一解析惯例）、
  // streamingBehavior 可选 steer/followUp（docs08-r4 任务 11：回合中入队而非 409）、agent 接受但降级）
  app.post("/api/sessions/:id/prompt", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const body = await parseJsonBody(c);
    if (typeof body.text !== "string" || body.text.trim() === "") {
      throw new ApiError(400, "invalid_text", "text 必填且不能为空");
    }
    const images = parseImages(body.images);
    const thinkingLevel = parseThinkingLevel(body.thinkingLevel);
    const streamingBehavior = parseStreamingBehavior(body.streamingBehavior);
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
    const receipt = await deps.engines.prompt(id, { text: body.text, images, model, thinkingLevel, streamingBehavior });
    return c.json({
      sessionId: id,
      disposition: receipt.disposition,
      streaming: receipt.disposition !== "handled",
      // setModel 成功的模型行归一 "provider/model"（docs08-r6 任务 8 ②：切换结果回执可观测）；
      // 排队/未携带 model 时缺省（排队剥模型铁律——模型不随排队请求生效）
      ...(typeof receipt.appliedModel === "string" && receipt.appliedModel ? { appliedModel: receipt.appliedModel } : {}),
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

  // 手动压缩上下文（docs08-r5 任务 8）：协议面 compact，端点无参数（webui 只暴露
  // 裸 /compact）；回执带压缩前后水位（tokensBefore/estimatedTokensAfter + 压缩后
  // usage 快照）供前端佐证真实生效。回合中 409 already_processing、无更多可压缩
  // 内容 409 already_compacted/nothing_to_compact（运行时层映射，前端明示不静默）。
  // 超时映射（任务 18 ④，常量说明见模块级 COMPACT_HTTP_TIMEOUT_MS）。
  app.post("/api/sessions/:id/compact", route(async (c: Context) => {
    const id = requireParam(c, "id");
    // 可选面守卫（favoriteModels 同例）：测试装配 fake 可省略 compact
    if (!deps.engines.compact) {
      throw new ApiError(501, "compact_unsupported", "当前网关未实现压缩通道");
    }
    // 同步 RPC 入口保留（fire-and-forget 红线：仍是 await 整链回执）；仅加超时映射——
    // 期限内网关拒绝（409 already_processing 等）原样先到上抛，语义零改动；
    // 超时后放弃等待，迟到成败静默吞掉（防 unhandled rejection，结果由事件流补偿）
    const compactPromise = deps.engines.compact(id);
    void compactPromise.catch(() => {});
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { result, usage } = await Promise.race([
        compactPromise,
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(
            () => reject(new ApiError(504, "compact_timeout", "压缩仍在后台进行，完成后水位自动刷新")),
            COMPACT_HTTP_TIMEOUT_MS,
          );
        }),
      ]);
      return c.json({
        sessionId: id,
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        ...(result.estimatedTokensAfter !== undefined ? { tokensAfter: result.estimatedTokensAfter } : {}),
        usage,
      });
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }
  }));

  // 排队快照对账（docs08-r4 任务 11，spike 指引 2）：断线重连/初次渲染拉一次；
  // 增量走 queue_update wire 事件（SSE 原样透传，前端 store 消化）
  app.get("/api/sessions/:id/queue", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const snapshot = await deps.engines.queueList(id);
    return c.json({ sessionId: id, ...snapshot });
  }));

  // 整队清空（引擎无单条撤单协议面；单条撤销=前端自持列表清空后保留项重排），返回被撤项
  app.delete("/api/sessions/:id/queue", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const snapshot = await deps.engines.queueClear(id);
    return c.json({ sessionId: id, ...snapshot });
  }));

  // 权限/表单/提问应答（verification/02 四型 + q1 question）：value|confirmed|cancelled|answers 至少一项
  app.post("/api/sessions/:id/permission", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const body = await parseJsonBody(c);
    if (typeof body.requestId !== "string" || !body.requestId) {
      throw new ApiError(400, "invalid_request", "requestId 必填");
    }
    const reply: { value?: string; confirmed?: boolean; cancelled?: boolean; answers?: Record<string, { selected: string[]; text?: string }>; comment?: string } = {};
    if (typeof body.value === "string") reply.value = body.value;
    if (typeof body.confirmed === "boolean") reply.confirmed = body.confirmed;
    if (body.cancelled === true) reply.cancelled = true;
    if (isQuestionAnswers(body.answers)) {
      const hasComment = typeof body.comment === "string" && body.comment.length > 0;
      // 空 answers 仅随非空 comment 透传（comment-only 落定路径）；纯空对象不进 reply，
      // 落入下方总校验 400（引擎对空 answers+无 comment 恒拒收 question_incomplete）
      if (Object.keys(body.answers).length > 0 || hasComment) reply.answers = body.answers;
    }
    if (typeof body.comment === "string" && body.comment) reply.comment = body.comment;
    if (Object.keys(reply).length === 0) {
      throw new ApiError(400, "invalid_request", "需要 value/confirmed/cancelled/answers 之一");
    }
    await deps.engines.permissionRespond(id, body.requestId, reply);
    return c.json({ ok: true, sessionId: id, requestId: body.requestId });
  }));

  // 未决提问对账快照（q1 提问卡片；同 queue 口径——前端打开会话时拉一次，增量走 SSE）
  app.get("/api/sessions/:id/questions", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const questions = await deps.engines.questionsList(id);
    return c.json({ sessionId: id, questions });
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
      // 计划任务 9：手动入口读服务端语言设置（env UL_OMO_WEBUI_TITLE_LANG 覆盖 >
      // meta_kv titlegen.language > 缺省 zh），不收客户端语言参数（不随 UI 语言切换）
      const title = await deps.titleGen.generateForSession(id, resolveTitleLanguage(deps.meta));
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
    // schedule 钩子（任务 21c）：该会话 pending 定时任务标 invalid（abandoned）。
    // best-effort：标记失败不回滚删除，仅告警（引擎删除已不可逆，阻塞无意义）。
    try {
      await deps.schedule?.onSessionDeleted(id);
    } catch (err) {
      console.warn(`[schedule] 会话删除标记定时任务失败：${err instanceof Error ? err.message : String(err)}`);
    }
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

  // 会话 usage 统计（会话级累计，verification/05 P1-4：get_session_stats）；
  // A5：usage 内含可选 turnSpeed（运行时层内存速度环附加，engine-runtime usage() 取数口）
  app.get("/api/usage", route(async (c: Context) => {
    const id = c.req.query("session");
    if (!id) throw new ApiError(400, "invalid_request", "session 查询参数必填");
    const usage = await deps.engines.usage(id);
    return c.json({ sessionId: id, usage });
  }));

  // ---------- 附件临时区（docs08-r3 任务 17：大文本粘贴转附件） ----------
  // 文件落 DATA_DIR/attachments/<projectHash>/；prompt 只带绝对路径行由引擎按需
  // 读取，故 DELETE 仅挂用户显式移除 chip（发送成功后文件刻意留存，48h 清理兜底）。

  // 上传大文本：content（≤1MB UTF-8 字节）+ 可选 name（纯文件名，含分隔符或 .. 即 400，
  // 缺省服务端自生成）→ { path 绝对路径, name, bytes }
  app.post("/api/sessions/:id/attachments", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const project = await requireSessionProject(deps, id);
    const body = await parseJsonBody(c);
    if (typeof body.content !== "string" || body.content.length === 0) {
      throw new ApiError(400, "invalid_content", "content 必填且不能为空");
    }
    const bytes = Buffer.byteLength(body.content, "utf8");
    if (bytes > ATTACHMENT_MAX_BYTES) {
      throw new ApiError(400, "content_too_large", `content 超过 1MB 上限（${bytes} 字节）`);
    }
    const name = validateAttachmentName(body.name);
    const root = deps.attachmentsRoot ?? attachmentsRoot();
    const dir = projectAttachmentsDir(root, project);
    mkdirSync(dir, { recursive: true });
    // mkdir 后目录必存在；realpath 规范化防 DATA_DIR 自身经符号链接挂载
    const dirReal = realpathSync(dir);
    const filename = name ?? generatedAttachmentName();
    // filename 已保证纯文件名（白名单/自生成），join 后落点必然在 dirReal 内
    const target = join(dirReal, filename);
    // 目录内预置同名符号链接会劫持 writeFileSync 跟随写出（外部文件被污染）——
    // lstat 不跟随，先查先拒绝，做到零写出；写入后 realpath 复核兜底 lstat→write
    // 窗口的 TOCTOU 残余
    try {
      if (lstatSync(target).isSymbolicLink()) {
        unlinkSync(target);
        throw new ApiError(403, "attachment_escape", "附件落点越界被拒绝");
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // ENOENT = 无预置文件，正常继续
    }
    writeFileSync(target, body.content, "utf8");
    const real = realpathSync(target);
    if (real !== target || !real.startsWith(dirReal + "/")) {
      try {
        unlinkSync(target);
      } catch {
        // 尽力清理
      }
      throw new ApiError(403, "attachment_escape", "附件落点越界被拒绝");
    }
    return c.json({ path: target, name: filename, bytes }, 201);
  }));

  // 删除附件：?path= 必填；realpath 必须严格位于本会话所属项目的
  // attachments/<projectHash>/ 内（等于目录本身、其他项目临时文件、临时区外
  // 任意路径、符号链接逃逸一律 403）；目标不存在 404。
  app.delete("/api/sessions/:id/attachments", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const project = await requireSessionProject(deps, id);
    const raw = c.req.query("path");
    if (typeof raw !== "string" || raw === "") {
      throw new ApiError(400, "invalid_request", "path 查询参数必填");
    }
    const root = deps.attachmentsRoot ?? attachmentsRoot();
    const dir = projectAttachmentsDir(root, project);
    let dirReal: string;
    try {
      dirReal = realpathSync(dir);
    } catch {
      // 本项目附件目录不存在 = 不可能有属于本项目的附件
      throw new ApiError(404, "attachment_not_found", "附件不存在");
    }
    let real: string;
    try {
      real = realpathSync(raw);
    } catch {
      throw new ApiError(404, "attachment_not_found", "附件不存在");
    }
    if (real === dirReal || !real.startsWith(dirReal + "/")) {
      throw new ApiError(403, "attachment_escape", "路径越界被拒绝");
    }
    if (!statSync(real).isFile()) {
      throw new ApiError(400, "invalid_path", "目标不是文件");
    }
    unlinkSync(real);
    return c.json({ ok: true });
  }));

  return app;
}
