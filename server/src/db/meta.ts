// 元数据 sqlite 存储层（bun:sqlite，WAL 模式）。
// 单进程多连接安全：WAL + busy_timeout，写冲突时抛 SqliteError（明确错误而非损坏/死锁）。
// REST 层（todo 9）按这里的签名调用；本文件不 import 引擎与 adapter，纯本地。
import { Database, SQLiteError, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureSchema } from "./schema";

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
  preferredAgent: string | null;
  preferredModel: string | null;
  lastOpenedAt: string | null;
}

export interface ProjectMetaPatch {
  preferredAgent?: string | null;
  preferredModel?: string | null;
  lastOpenedAt?: string | null;
}

export interface OpenMetaDbOptions {
  /** 库文件路径；缺省依次取 SENPI_WEBUI_META_DB 环境变量、server/data/meta.db */
  path?: string;
  /** 写锁等待毫秒数，超时抛 SQLITE_BUSY；默认 5000 */
  busyTimeoutMs?: number;
}

export const DEFAULT_INPUT_HISTORY_LIMIT = 200;

export function defaultMetaDbPath(): string {
  return process.env.SENPI_WEBUI_META_DB ?? join(import.meta.dir, "..", "..", "data", "meta.db");
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
      return get<ProjectMeta>(
        `SELECT project_path AS projectPath, preferred_agent AS preferredAgent,
                preferred_model AS preferredModel, last_opened_at AS lastOpenedAt
         FROM meta_project WHERE project_path = ?`,
        projectPath,
      );
    },

    listProjectMeta() {
      return all<ProjectMeta>(
        `SELECT project_path AS projectPath, preferred_agent AS preferredAgent,
                preferred_model AS preferredModel, last_opened_at AS lastOpenedAt
         FROM meta_project ORDER BY last_opened_at DESC`,
      );
    },

    updateProjectMeta(projectPath, patch) {
      immediate(() => {
        const existing = meta.getProjectMeta(projectPath);
        if (existing) {
          run(
            `UPDATE meta_project SET preferred_agent = ?, preferred_model = ?, last_opened_at = ?
             WHERE project_path = ?`,
            patch.preferredAgent === undefined ? existing.preferredAgent : patch.preferredAgent,
            patch.preferredModel === undefined ? existing.preferredModel : patch.preferredModel,
            patch.lastOpenedAt === undefined ? existing.lastOpenedAt : patch.lastOpenedAt,
            projectPath,
          );
        } else {
          run(
            `INSERT INTO meta_project (project_path, preferred_agent, preferred_model, last_opened_at)
             VALUES (?, ?, ?, ?)`,
            projectPath,
            patch.preferredAgent ?? null,
            patch.preferredModel ?? null,
            patch.lastOpenedAt ?? null,
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
