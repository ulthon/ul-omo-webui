// 笔记 REST 路由（todo 5）：CRUD + 回收站（软删）+ 版本历史。
// 存储行为全部在 db/meta.ts（todo 2），本层只做 HTTP 语义：输入校验
// （title/content/tags 形状、64KB 上限）、已注册项目校验（POST，同
// routes-snippets PUT 模式）、「content 与最新版本不同才追加版本」的
// 去重判断（库层注释明确该判断归 REST 层，latestNoteVersion 供此用）。
// NoteMeta.createdAt/updatedAt 类型 string|null（库层可空），序列化如实输出。
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import type { NoteMeta } from "../db/meta";
import { ApiError, parseJsonBody, requireParam, route } from "./http";
import type { ApiDeps } from "./deps";
import { validateProjectInput } from "./paths";

/** 单条 content 上限 64KB（UTF-8 字节数） */
const NOTE_MAX_BYTES = 64 * 1024;

/** 列表读的 project 键规范化：绝对路径 + 去尾斜杠；目录可不存在（库数据仍可读） */
function normalizeProjectKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || !raw.startsWith("/")) {
    throw new ApiError(400, "invalid_project", "project 必须是绝对路径");
  }
  return raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
}

/** tags 校验：缺省 undefined（创建时库层默认空数组）；提供时必须是字符串数组 */
function parseTags(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) {
    throw new ApiError(400, "invalid_tags", "tags 必须是字符串数组");
  }
  return raw as string[];
}

/** content 校验：字符串且 ≤64KB（UTF-8 字节数，同 snippets 4KB 模式） */
function parseContent(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "invalid_content", "content 必须是字符串");
  }
  if (Buffer.byteLength(raw, "utf8") > NOTE_MAX_BYTES) {
    throw new ApiError(400, "content_too_large", `content 超过 ${NOTE_MAX_BYTES} 字节上限`);
  }
  return raw;
}

/** 详情载荷（计划逐字形状）：projectPath 以 project 键输出 */
function toNotePayload(note: NoteMeta) {
  return {
    id: note.id,
    project: note.projectPath,
    title: note.title,
    content: note.content,
    tags: note.tags,
    deletedAt: note.deletedAt,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

/** 列表排序：sort 升序（null 最后）+ updated_at 降序（计划 129 行语义，测试锁定） */
function bySortThenUpdated(a: NoteMeta, b: NoteMeta): number {
  const sa = a.sort ?? Number.POSITIVE_INFINITY;
  const sb = b.sort ?? Number.POSITIVE_INFINITY;
  return sa - sb || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

export function createNotesRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  function requireNote(id: string): NoteMeta {
    const note = deps.meta.getNote(id);
    if (!note) throw new ApiError(404, "note_not_found", `笔记不存在：${id}`);
    return note;
  }

  // 列表：project 必填（读不要求已注册）；deleted=0 活动 |1 回收站（其他值 400）；
  // tag 可选包含过滤；列表项不含 content（避免 64KB×N 负载，正文走详情）。
  app.get("/api/notes", route(async (c: Context) => {
    const project = normalizeProjectKey(c.req.query("project"));
    const deleted = c.req.query("deleted") ?? "0";
    if (deleted !== "0" && deleted !== "1") {
      throw new ApiError(400, "invalid_deleted", "deleted 仅支持 0|1");
    }
    const tag = c.req.query("tag");
    const notes = (deleted === "1" ? deps.meta.listTrashedNotes(project) : deps.meta.listNotes(project))
      .filter((n) => (tag ? n.tags.includes(tag) : true))
      .sort(bySortThenUpdated);
    return c.json({
      notes: notes.map((n) => ({
        id: n.id,
        title: n.title,
        tags: n.tags,
        updatedAt: n.updatedAt,
        deletedAt: n.deletedAt,
      })),
    });
  }));

  // 创建：project 必须已注册（validateProjectInput 要求目录存在 + meta 注册）；
  // 首个版本快照入 meta_note_version（与正文同内容）。
  app.post("/api/notes", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.project);
    if (!deps.meta.getProjectMeta(project)) {
      throw new ApiError(400, "project_not_found", `项目未注册：${project}`);
    }
    if (typeof body.title !== "string") {
      throw new ApiError(400, "invalid_title", "title 必填且必须是字符串");
    }
    const content = parseContent(body.content);
    const tags = parseTags(body.tags);
    const note = deps.meta.createNote({
      id: randomUUID(),
      projectPath: project,
      title: body.title,
      content,
      ...(tags !== undefined ? { tags } : {}),
    });
    deps.meta.appendNoteVersion(note.id, content);
    return c.json({ note: toNotePayload(note) }, 201);
  }));

  app.get("/api/notes/:id", route(async (c: Context) => {
    return c.json({ note: toNotePayload(requireNote(requireParam(c, "id"))) });
  }));

  // 更新：部分更新；content 与最新版本不同才追加新版本快照（同内容重复保存不产生冗余版本）。
  app.put("/api/notes/:id", route(async (c: Context) => {
    const id = requireParam(c, "id");
    requireNote(id);
    const body = await parseJsonBody(c);
    const patch: { title?: string; content?: string; tags?: string[] } = {};
    if (body.title !== undefined) {
      if (typeof body.title !== "string") throw new ApiError(400, "invalid_title", "title 必须是字符串");
      patch.title = body.title;
    }
    if (body.content !== undefined) patch.content = parseContent(body.content);
    const tags = parseTags(body.tags);
    if (tags !== undefined) patch.tags = tags;
    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, "invalid_request", "需要 title/content/tags 至少一项");
    }
    const note = deps.meta.updateNote(id, patch);
    if (patch.content !== undefined) {
      const latest = deps.meta.latestNoteVersion(id);
      if (!latest || latest.content !== patch.content) {
        deps.meta.appendNoteVersion(id, patch.content);
      }
    }
    return c.json({ note: toNotePayload(note) });
  }));

  // 删除：缺省软删（deleted_at=now）；purge=1 硬删（连版本），仅软删状态允许，
  // 未软删先 409（防误删——静默成功会掩盖用户对回收站语义的误解）。
  app.delete("/api/notes/:id", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const note = requireNote(id);
    const purge = c.req.query("purge") ?? "0";
    if (purge !== "0" && purge !== "1") {
      throw new ApiError(400, "invalid_purge", "purge 仅支持 0|1");
    }
    if (purge === "1") {
      if (note.deletedAt === null) {
        throw new ApiError(409, "purge_requires_deleted", "仅软删除状态的笔记可永久删除，请先软删");
      }
      deps.meta.hardDeleteNote(id);
      return c.json({ ok: true, purged: id });
    }
    deps.meta.softDeleteNote(id);
    return c.json({ ok: true, deleted: id });
  }));

  // 软删恢复：deleted_at 置 null
  app.post("/api/notes/:id/restore", route(async (c: Context) => {
    const id = requireParam(c, "id");
    requireNote(id);
    deps.meta.restoreNote(id);
    return c.json({ note: toNotePayload(requireNote(id)) });
  }));

  // 版本列表：新在前（库层 saved_at DESC），preview 取前 100 字符，不带全文
  app.get("/api/notes/:id/versions", route(async (c: Context) => {
    const id = requireParam(c, "id");
    requireNote(id);
    return c.json({
      versions: deps.meta.listNoteVersions(id).map((v) => ({
        id: v.id,
        savedAt: v.savedAt,
        preview: v.content.slice(0, 100),
      })),
    });
  }));

  // 恢复到指定版本：正文写回该版本内容，恢复结果作为新版本追加（历史不可变）。
  // 版本必须存在且属于该笔记（跨笔记版本 id 一律 404）。
  app.post("/api/notes/:id/versions/:vid/restore", route(async (c: Context) => {
    const id = requireParam(c, "id");
    requireNote(id);
    const vid = requireParam(c, "vid");
    const version = deps.meta.getNoteVersion(vid);
    if (!version || version.noteId !== id) {
      throw new ApiError(404, "version_not_found", `版本不存在：${vid}`);
    }
    deps.meta.updateNote(id, { content: version.content });
    deps.meta.appendNoteVersion(id, version.content);
    return c.json({ note: toNotePayload(requireNote(id)) });
  }));

  return app;
}
