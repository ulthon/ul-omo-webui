// 元数据库建表 DDL。字段与计划 todo 11 逐一对应，禁止随意加列。
// meta_session.last_read 是"任一设备查看即清零"未读语义的数据基础（已读上报时更新并清零 unread_count）。
// meta_kv 存外链地址、权限"总是允许"记忆等壳层配置。
import type { Database } from "bun:sqlite";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta_session (
  session_id     TEXT PRIMARY KEY,
  pinned         INTEGER NOT NULL DEFAULT 0,
  archived_at    TEXT,
  renamed_title  TEXT,
  unread_count   INTEGER NOT NULL DEFAULT 0,
  last_read      TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta_draft (
  session_id  TEXT PRIMARY KEY,
  content     TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta_input_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path  TEXT NOT NULL,
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meta_input_history_project
  ON meta_input_history (project_path, id);

CREATE TABLE IF NOT EXISTS meta_project (
  project_path     TEXT PRIMARY KEY,
  preferred_agent  TEXT,
  preferred_model  TEXT,
  last_opened_at   TEXT
);

CREATE TABLE IF NOT EXISTS meta_kv (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
`;

export function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
}
