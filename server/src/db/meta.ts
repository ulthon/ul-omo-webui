// 元数据 sqlite 存储层（node:sqlite 经 ./sqlite 适配层，WAL 模式）。
// 单进程多连接安全：WAL + busy_timeout，写冲突时抛 SQLiteError（明确错误而非损坏/死锁）。
// REST 层（todo 9）按这里的签名调用；本文件不 import 引擎与 adapter，纯本地。
import { Database, SQLiteError, type SQLQueryBindings } from "./sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSchema } from "./schema";
import { selfDir } from "../runtime-paths";

export { SQLiteError };

// ---------- 领域类型（camelCase，供 REST 层直接序列化） ----------

export interface SessionMeta {
  sessionId: string;
  pinned: boolean;
  archivedAt: string | null;
  renamedTitle: string | null;
  unreadCount: number;
  lastRead: string | null;
  updatedAt: string;
}

export interface SessionMetaPatch {
  pinned?: boolean;
  archivedAt?: string | null;
  renamedTitle?: string | null;
  unreadCount?: number;
  lastRead?: string | null;
}

export interface Draft {
  content: string;
  updatedAt: string;
}

export interface InputHistoryItem {
  id: number;
  projectPath: string;
  content: string;
  createdAt: string;
}

export interface ProjectMeta {
  projectPath: string;
  preferredModel: string | null;
  lastOpenedAt: string | null;
  /** 注册时间（C16 todo 9）：迁移前存量行 = 迁移时刻（同值），新注册行 = 注册时刻 */
  createdAt: string | null;
  /** 隐藏软标记（A2 docs08-r3 todo 10）：true = 侧栏聚合列表不出现该分组（注册行与会话元数据保留） */
  hidden: boolean;
}

export interface ProjectMetaPatch {
  preferredModel?: string | null;
  lastOpenedAt?: string | null;
  hidden?: boolean;
}

export interface NoteMeta {
  id: string;
  projectPath: string;
  title: string;
  content: string;
  /** 标签名数组；tags 列损坏（非法 JSON / 非字符串数组）时容错为空数组 */
  tags: string[];
  sort: number | null;
  /** 软删除时间戳；null = 未删除 */
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface NoteInput {
  id: string;
  projectPath: string;
  title: string;
  content: string;
  tags?: string[];
  sort?: number | null;
}

export interface NotePatch {
  title?: string;
  content?: string;
  tags?: string[];
  sort?: number | null;
}

export interface NoteVersion {
  id: string;
  noteId: string;
  content: string;
  savedAt: string;
}

export type TagScope = "global" | "project";

export interface SessionTag {
  scope: TagScope;
  name: string;
  createdAt: string;
}

export interface SessionTagRef {
  scope: TagScope;
  name: string;
}

export interface OpenMetaDbOptions {
  /** 库文件路径；缺省依次取 UL_OMO_WEBUI_META_DB 环境变量、server/data/meta.db */
  path?: string;
  /** 写锁等待毫秒数，超时抛 SQLITE_BUSY；默认 5000 */
  busyTimeoutMs?: number;
}

export const DEFAULT_INPUT_HISTORY_LIMIT = 200;

export function defaultMetaDbPath(): string {
  return process.env.UL_OMO_WEBUI_META_DB ?? join(selfDir(), "..", "..", "data", "meta.db");
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------- 存储行类型（snake_case，仅内部转换用） ----------

interface SessionMetaRow {
  session_id: string;
  pinned: number;
  archived_at: string | null;
  renamed_title: string | null;
  unread_count: number;
  last_read: string | null;
  updated_at: string;
}

function toSessionMeta(row: SessionMetaRow): SessionMeta {
  return {
    sessionId: row.session_id,
    pinned: row.pinned === 1,
    archivedAt: row.archived_at,
    renamedTitle: row.renamed_title,
    unreadCount: row.unread_count,
    lastRead: row.last_read,
    updatedAt: row.updated_at,
  };
}

interface NoteRow {
  id: string;
  project_path: string;
  title: string;
  content: string;
  tags: string;
  sort: number | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** tags 列容错解析：非法 JSON 或非字符串数组一律返回空数组，不崩（手工塞坏数据可恢复） */
function parseNoteTags(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}

function toNoteMeta(row: NoteRow): NoteMeta {
  return {
    id: row.id,
    projectPath: row.project_path,
    title: row.title,
    content: row.content,
    tags: parseNoteTags(row.tags),
    sort: row.sort,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** hidden 为 INTEGER 列（0/1），SELECT 别名 camelCase 后经此转 boolean */
interface ProjectMetaRow {
  projectPath: string;
  preferredModel: string | null;
  lastOpenedAt: string | null;
  createdAt: string | null;
  hidden: number;
}

function toProjectMeta(row: ProjectMetaRow): ProjectMeta {
  return {
    projectPath: row.projectPath,
    preferredModel: row.preferredModel,
    lastOpenedAt: row.lastOpenedAt,
    createdAt: row.createdAt,
    hidden: row.hidden === 1,
  };
}

const PROJECT_META_SELECT = `SELECT project_path AS projectPath, preferred_model AS preferredModel,
        last_opened_at AS lastOpenedAt, created_at AS createdAt, hidden
 FROM meta_project`;

export interface MetaDb {
  readonly path: string;

  // meta_session
  getSessionMeta(sessionId: string): SessionMeta | null;
  listSessionMeta(): SessionMeta[];
  /** 部分更新（不存在则创建行），返回更新后的完整记录 */
  updateSessionMeta(sessionId: string, patch: SessionMetaPatch): SessionMeta;
  setSessionPinned(sessionId: string, pinned: boolean): void;
  setSessionArchived(sessionId: string, archivedAt: string | null): void;
  setSessionRenamedTitle(sessionId: string, title: string | null): void;
  /** 已读上报：last_read 置为 readAt（缺省 now），unread_count 清零 */
  markSessionRead(sessionId: string, readAt?: string): void;
  /** 新消息到达时未读 +1（行不存在则创建） */
  incrementUnread(sessionId: string): void;
  /** 删除会话时级联清理元数据 */
  deleteSessionMeta(sessionId: string): void;

  // meta_draft
  getDraft(sessionId: string): Draft | null;
  setDraft(sessionId: string, content: string): void;
  deleteDraft(sessionId: string): void;

  // meta_input_history
  listInputHistory(projectPath: string, limit?: number): InputHistoryItem[];
  /**
   * 去重追加：同 project_path 下已存在相同 content 时删旧插新（保证唯一且最新），
   * 插入后按 limit 裁剪掉最旧的（默认 200 条）。
   */
  appendInputHistory(projectPath: string, content: string, limit?: number): void;
  clearInputHistory(projectPath: string): void;

  // meta_project
  getProjectMeta(projectPath: string): ProjectMeta | null;
  listProjectMeta(): ProjectMeta[];
  /** 部分更新（不存在则创建行） */
  updateProjectMeta(projectPath: string, patch: ProjectMetaPatch): void;
  deleteProjectMeta(projectPath: string): void;

  // meta_kv
  getKv(key: string): string | null;
  setKv(key: string, value: string): void;
  listKv(): Record<string, string>;
  deleteKv(key: string): void;

  // meta_note
  createNote(input: NoteInput): NoteMeta;
  getNote(id: string): NoteMeta | null;
  /** 未删除笔记（updated_at 新在前） */
  listNotes(projectPath: string): NoteMeta[];
  /** 软删除笔记即回收站（deleted_at 新在前） */
  listTrashedNotes(projectPath: string): NoteMeta[];
  /** 部分更新；笔记不存在时抛错 */
  updateNote(id: string, patch: NotePatch): NoteMeta;
  softDeleteNote(id: string): void;
  restoreNote(id: string): void;
  /** 硬删除：同事务级联删除全部版本 */
  hardDeleteNote(id: string): void;

  // meta_note_version
  /** 追加版本（savedAt 缺省取当前时间）；"content 与最新版本不同才追加"的判断在 REST 层 */
  appendNoteVersion(noteId: string, content: string, savedAt?: string): NoteVersion;
  /** 版本列表（saved_at 新在前） */
  listNoteVersions(noteId: string): NoteVersion[];
  getNoteVersion(versionId: string): NoteVersion | null;
  /** 最新版本（无版本时 null），供 REST 层做追加去重判断 */
  latestNoteVersion(noteId: string): NoteVersion | null;

  // meta_session_tag
  listSessionTags(sessionId: string): SessionTag[];
  /** 整替挂载：单事务先清后插 */
  setSessionTags(sessionId: string, tags: SessionTagRef[]): void;
  listSessionsByTag(scope: TagScope, name: string): string[];
  countSessionsByTag(scope: TagScope, name: string): number;

  // meta_tag_mount_audit（挂载删除审计：每次整替中被移除的挂载逐条落行）
  appendTagMountAudit(rows: TagMountAuditInput[]): void;
  listTagMountAudit(sessionId?: string): TagMountAudit[];

  // meta_session.generated_title（标题生成写入，独立于 renamed_title）
  setSessionGeneratedTitle(sessionId: string, title: string | null): void;
  getSessionGeneratedTitle(sessionId: string): string | null;

  /** 完整性自检（测试与运维用），返回 "ok" 或错误描述 */
  integrityCheck(): string;
  close(): void;
}

export function openMetaDb(options: OpenMetaDbOptions = {}): MetaDb {
  const path = options.path ?? defaultMetaDbPath();
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;

  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec("PRAGMA synchronous = NORMAL");
  ensureSchema(db);

  function run(sql: string, ...params: SQLQueryBindings[]): void {
    db.run(sql, params);
  }

  function get<T>(sql: string, ...params: SQLQueryBindings[]): T | null {
    return (db.query(sql).get(...params) ?? null) as T | null;
  }

  function all<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
    return db.query(sql).all(...params) as T[];
  }

  /** 多语句写路径统一 BEGIN IMMEDIATE：拿不到写锁时按 busy_timeout 等待后抛 SQLiteError */
  function immediate<T>(fn: () => T): T {
    return db.transaction(fn).immediate();
  }

  function upsertSessionMeta(sessionId: string, patch: SessionMetaPatch): SessionMeta {
    immediate(() => {
      const existing = get<SessionMetaRow>(
        "SELECT * FROM meta_session WHERE session_id = ?",
        sessionId,
      );
      if (existing) {
        run(
          `UPDATE meta_session SET
             pinned = ?, archived_at = ?, renamed_title = ?,
             unread_count = ?, last_read = ?, updated_at = ?
           WHERE session_id = ?`,
          patch.pinned === undefined ? existing.pinned : (patch.pinned ? 1 : 0),
          patch.archivedAt === undefined ? existing.archived_at : patch.archivedAt,
          patch.renamedTitle === undefined ? existing.renamed_title : patch.renamedTitle,
          patch.unreadCount === undefined ? existing.unread_count : patch.unreadCount,
          patch.lastRead === undefined ? existing.last_read : patch.lastRead,
          nowIso(),
          sessionId,
        );
      } else {
        run(
          `INSERT INTO meta_session
             (session_id, pinned, archived_at, renamed_title, unread_count, last_read, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          sessionId,
          patch.pinned === undefined ? 0 : (patch.pinned ? 1 : 0),
          patch.archivedAt ?? null,
          patch.renamedTitle ?? null,
          patch.unreadCount ?? 0,
          patch.lastRead ?? null,
          nowIso(),
        );
      }
    });
    const row = get<SessionMetaRow>(
      "SELECT * FROM meta_session WHERE session_id = ?",
      sessionId,
    );
    if (!row) throw new Error(`meta_session upsert failed for ${sessionId}`);
    return toSessionMeta(row);
  }

  const meta: MetaDb = {
    path,

    getSessionMeta(sessionId) {
      const row = get<SessionMetaRow>(
        "SELECT * FROM meta_session WHERE session_id = ?",
        sessionId,
      );
      return row ? toSessionMeta(row) : null;
    },

    listSessionMeta() {
      return all<SessionMetaRow>(
        "SELECT * FROM meta_session ORDER BY updated_at DESC",
      ).map(toSessionMeta);
    },

    updateSessionMeta: upsertSessionMeta,

    setSessionPinned(sessionId, pinned) {
      upsertSessionMeta(sessionId, { pinned });
    },

    setSessionArchived(sessionId, archivedAt) {
      upsertSessionMeta(sessionId, { archivedAt });
    },

    setSessionRenamedTitle(sessionId, title) {
      upsertSessionMeta(sessionId, { renamedTitle: title });
    },

    markSessionRead(sessionId, readAt) {
      upsertSessionMeta(sessionId, { lastRead: readAt ?? nowIso(), unreadCount: 0 });
    },

    incrementUnread(sessionId) {
      immediate(() => {
        run(
          `INSERT INTO meta_session (session_id, unread_count, updated_at)
           VALUES (?, 1, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             unread_count = unread_count + 1,
             updated_at = excluded.updated_at`,
          sessionId,
          nowIso(),
        );
      });
    },

    deleteSessionMeta(sessionId) {
      // 单事务保证原子：中途失败整体回滚，不留孤儿 draft 行
      immediate(() => {
        run("DELETE FROM meta_session WHERE session_id = ?", sessionId);
        run("DELETE FROM meta_draft WHERE session_id = ?", sessionId);
      });
    },

    getDraft(sessionId) {
      return get<Draft>(
        "SELECT content, updated_at AS updatedAt FROM meta_draft WHERE session_id = ?",
        sessionId,
      );
    },

    setDraft(sessionId, content) {
      immediate(() => {
        run(
          `INSERT INTO meta_draft (session_id, content, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             content = excluded.content,
             updated_at = excluded.updated_at`,
          sessionId,
          content,
          nowIso(),
        );
      });
    },

    deleteDraft(sessionId) {
      run("DELETE FROM meta_draft WHERE session_id = ?", sessionId);
    },

    listInputHistory(projectPath, limit = DEFAULT_INPUT_HISTORY_LIMIT) {
      return all<InputHistoryItem & { project_path: string }>(
        `SELECT id, project_path, content, created_at AS createdAt
         FROM meta_input_history
         WHERE project_path = ?
         ORDER BY id DESC
         LIMIT ?`,
        projectPath,
        limit,
      ).map((row) => ({
        id: row.id,
        projectPath: row.project_path,
        content: row.content,
        createdAt: row.createdAt,
      }));
    },

    appendInputHistory(projectPath, content, limit = DEFAULT_INPUT_HISTORY_LIMIT) {
      immediate(() => {
        run(
          "DELETE FROM meta_input_history WHERE project_path = ? AND content = ?",
          projectPath,
          content,
        );
        run(
          "INSERT INTO meta_input_history (project_path, content, created_at) VALUES (?, ?, ?)",
          projectPath,
          content,
          nowIso(),
        );
        run(
          `DELETE FROM meta_input_history WHERE project_path = ? AND id NOT IN (
             SELECT id FROM meta_input_history WHERE project_path = ? ORDER BY id DESC LIMIT ?
           )`,
          projectPath,
          projectPath,
          limit,
        );
      });
    },

    clearInputHistory(projectPath) {
      run("DELETE FROM meta_input_history WHERE project_path = ?", projectPath);
    },

    getProjectMeta(projectPath) {
      const row = get<ProjectMetaRow>(
        `${PROJECT_META_SELECT} WHERE project_path = ?`,
        projectPath,
      );
      return row ? toProjectMeta(row) : null;
    },

    listProjectMeta() {
      return all<ProjectMetaRow>(
        `${PROJECT_META_SELECT} ORDER BY last_opened_at DESC`,
      ).map(toProjectMeta);
    },

    updateProjectMeta(projectPath, patch) {
      immediate(() => {
        const existing = meta.getProjectMeta(projectPath);
        if (existing) {
          run(
            `UPDATE meta_project SET preferred_model = ?, last_opened_at = ?, hidden = ?
             WHERE project_path = ?`,
            patch.preferredModel === undefined ? existing.preferredModel : patch.preferredModel,
            patch.lastOpenedAt === undefined ? existing.lastOpenedAt : patch.lastOpenedAt,
            patch.hidden === undefined ? (existing.hidden ? 1 : 0) : (patch.hidden ? 1 : 0),
            projectPath,
          );
        } else {
          run(
            `INSERT INTO meta_project (project_path, preferred_model, last_opened_at, created_at, hidden)
             VALUES (?, ?, ?, ?, ?)`,
            projectPath,
            patch.preferredModel ?? null,
            patch.lastOpenedAt ?? null,
            nowIso(),
            patch.hidden === true ? 1 : 0,
          );
        }
      });
    },

    deleteProjectMeta(projectPath) {
      run("DELETE FROM meta_project WHERE project_path = ?", projectPath);
    },

    getKv(key) {
      const row = get<{ value: string }>("SELECT value FROM meta_kv WHERE key = ?", key);
      return row ? row.value : null;
    },

    setKv(key, value) {
      immediate(() => {
        run(
          `INSERT INTO meta_kv (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          key,
          value,
          nowIso(),
        );
      });
    },

    listKv() {
      const rows = all<{ key: string; value: string }>(
        "SELECT key, value FROM meta_kv",
      );
      const out: Record<string, string> = {};
      for (const row of rows) out[row.key] = row.value;
      return out;
    },

    deleteKv(key) {
      run("DELETE FROM meta_kv WHERE key = ?", key);
    },

    createNote(input) {
      const now = nowIso();
      immediate(() => {
        run(
          `INSERT INTO meta_note (id, project_path, title, content, tags, sort, deleted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          input.id,
          input.projectPath,
          input.title,
          input.content,
          JSON.stringify(input.tags ?? []),
          input.sort ?? null,
          now,
          now,
        );
      });
      const row = get<NoteRow>("SELECT * FROM meta_note WHERE id = ?", input.id);
      if (!row) throw new Error(`meta_note insert failed for ${input.id}`);
      return toNoteMeta(row);
    },

    getNote(id) {
      const row = get<NoteRow>("SELECT * FROM meta_note WHERE id = ?", id);
      return row ? toNoteMeta(row) : null;
    },

    listNotes(projectPath) {
      return all<NoteRow>(
        `SELECT * FROM meta_note
         WHERE project_path = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC, rowid DESC`,
        projectPath,
      ).map(toNoteMeta);
    },

    listTrashedNotes(projectPath) {
      return all<NoteRow>(
        `SELECT * FROM meta_note
         WHERE project_path = ? AND deleted_at IS NOT NULL
         ORDER BY deleted_at DESC, rowid DESC`,
        projectPath,
      ).map(toNoteMeta);
    },

    updateNote(id, patch) {
      return immediate(() => {
        const existing = get<NoteRow>("SELECT * FROM meta_note WHERE id = ?", id);
        if (!existing) throw new Error(`meta_note not found: ${id}`);
        run(
          `UPDATE meta_note SET title = ?, content = ?, tags = ?, sort = ?, updated_at = ?
           WHERE id = ?`,
          patch.title === undefined ? existing.title : patch.title,
          patch.content === undefined ? existing.content : patch.content,
          patch.tags === undefined ? existing.tags : JSON.stringify(patch.tags),
          patch.sort === undefined ? existing.sort : (patch.sort ?? null),
          nowIso(),
          id,
        );
        const row = get<NoteRow>("SELECT * FROM meta_note WHERE id = ?", id);
        if (!row) throw new Error(`meta_note update failed for ${id}`);
        return toNoteMeta(row);
      });
    },

    softDeleteNote(id) {
      immediate(() => {
        run(
          "UPDATE meta_note SET deleted_at = ?, updated_at = ? WHERE id = ?",
          nowIso(),
          nowIso(),
          id,
        );
      });
    },

    restoreNote(id) {
      immediate(() => {
        run(
          "UPDATE meta_note SET deleted_at = NULL, updated_at = ? WHERE id = ?",
          nowIso(),
          id,
        );
      });
    },

    hardDeleteNote(id) {
      // 单事务保证原子：版本随笔记一起消失，不留孤儿版本行
      immediate(() => {
        run("DELETE FROM meta_note_version WHERE note_id = ?", id);
        run("DELETE FROM meta_note WHERE id = ?", id);
      });
    },

    appendNoteVersion(noteId, content, savedAt) {
      const version: NoteVersion = {
        id: crypto.randomUUID(),
        noteId,
        content,
        savedAt: savedAt ?? nowIso(),
      };
      immediate(() => {
        run(
          "INSERT INTO meta_note_version (id, note_id, content, saved_at) VALUES (?, ?, ?, ?)",
          version.id,
          version.noteId,
          version.content,
          version.savedAt,
        );
      });
      return version;
    },

    listNoteVersions(noteId) {
      return all<NoteVersion>(
        `SELECT id, note_id AS noteId, content, saved_at AS savedAt
         FROM meta_note_version
         WHERE note_id = ?
         ORDER BY saved_at DESC, rowid DESC`,
        noteId,
      );
    },

    getNoteVersion(versionId) {
      return get<NoteVersion>(
        `SELECT id, note_id AS noteId, content, saved_at AS savedAt
         FROM meta_note_version WHERE id = ?`,
        versionId,
      );
    },

    latestNoteVersion(noteId) {
      return get<NoteVersion>(
        `SELECT id, note_id AS noteId, content, saved_at AS savedAt
         FROM meta_note_version
         WHERE note_id = ?
         ORDER BY saved_at DESC, rowid DESC
         LIMIT 1`,
        noteId,
      );
    },

    listSessionTags(sessionId) {
      return all<SessionTag>(
        `SELECT tag_scope AS scope, tag_name AS name, created_at AS createdAt
         FROM meta_session_tag
         WHERE session_id = ?
         ORDER BY tag_scope, tag_name`,
        sessionId,
      );
    },

    setSessionTags(sessionId, tags) {
      immediate(() => {
        run("DELETE FROM meta_session_tag WHERE session_id = ?", sessionId);
        for (const tag of tags) {
          run(
            "INSERT INTO meta_session_tag (session_id, tag_scope, tag_name, created_at) VALUES (?, ?, ?, ?)",
            sessionId,
            tag.scope,
            tag.name,
            nowIso(),
          );
        }
      });
    },

    listSessionsByTag(scope, name) {
      return all<{ session_id: string }>(
        `SELECT session_id FROM meta_session_tag
         WHERE tag_scope = ? AND tag_name = ?
         ORDER BY session_id`,
        scope,
        name,
      ).map((row) => row.session_id);
    },

    countSessionsByTag(scope, name) {
      const row = get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM meta_session_tag WHERE tag_scope = ? AND tag_name = ?",
        scope,
        name,
      );
      return row ? row.n : 0;
    },

    appendTagMountAudit(rows) {
      if (rows.length === 0) return;
      const now = nowIso();
      immediate(() => {
        for (const row of rows) {
          run(
            "INSERT INTO meta_tag_mount_audit (session_id, tag_scope, tag_name, source, created_at) VALUES (?, ?, ?, ?, ?)",
            row.sessionId,
            row.scope,
            row.name,
            row.source,
            now,
          );
        }
      });
    },

    listTagMountAudit(sessionId) {
      const rows = sessionId
        ? all<{ id: number; session_id: string; tag_scope: string; tag_name: string; source: string; created_at: string }>(
            "SELECT * FROM meta_tag_mount_audit WHERE session_id = ? ORDER BY id",
            sessionId,
          )
        : all<{ id: number; session_id: string; tag_scope: string; tag_name: string; source: string; created_at: string }>(
            "SELECT * FROM meta_tag_mount_audit ORDER BY id",
          );
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        scope: row.tag_scope as TagScope,
        name: row.tag_name,
        source: row.source,
        createdAt: row.created_at,
      }));
    },

    setSessionGeneratedTitle(sessionId, title) {
      immediate(() => {
        run(
          `INSERT INTO meta_session (session_id, generated_title, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             generated_title = excluded.generated_title,
             updated_at = excluded.updated_at`,
          sessionId,
          title,
          nowIso(),
        );
      });
    },

    getSessionGeneratedTitle(sessionId) {
      const row = get<{ generated_title: string | null }>(
        "SELECT generated_title FROM meta_session WHERE session_id = ?",
        sessionId,
      );
      return row ? row.generated_title : null;
    },

    integrityCheck() {
      const row = get<{ integrity_check: string }>("PRAGMA integrity_check");
      return row ? row.integrity_check : "unknown";
    },

    close() {
      db.close();
    },
  };

  return meta;
}
