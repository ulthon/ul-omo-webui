// 元数据库建表 DDL。字段与计划 todo 11 / W1 todo 2 逐一对应，禁止随意加列。
// meta_session.last_read 是"任一设备查看即清零"未读语义的数据基础（已读上报时更新并清零 unread_count）。
// meta_kv 存外链地址、权限"总是允许"记忆等壳层配置。
// meta_note.tags 为 JSON 数组字符串（存标签名）；meta_note_version 随 note 硬删除在事务里级联清理。
// meta_session_tag 无外键：会话元数据生命周期独立管理（与 meta_draft 同理）。
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

CREATE TABLE IF NOT EXISTS meta_note (
  id            TEXT PRIMARY KEY,
  project_path  TEXT,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  sort          INT,
  deleted_at    TEXT NULL,
  created_at    TEXT,
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_meta_note_project
  ON meta_note (project_path, deleted_at, updated_at);

CREATE TABLE IF NOT EXISTS meta_note_version (
  id        TEXT PRIMARY KEY,
  note_id   TEXT,
  content   TEXT,
  saved_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_meta_note_version
  ON meta_note_version (note_id, saved_at);

CREATE TABLE IF NOT EXISTS meta_session_tag (
  session_id  TEXT,
  tag_scope   TEXT,
  tag_name    TEXT,
  created_at  TEXT,
  PRIMARY KEY (session_id, tag_scope, tag_name)
);

CREATE INDEX IF NOT EXISTS idx_meta_session_tag_tag
  ON meta_session_tag (tag_scope, tag_name);
`;

export function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  // 老库平滑升级：meta_session 补 generated_title 列。既有建表 DDL 保持逐字不变，
  // 新库与老库统一走 PRAGMA table_info 检测 + ALTER 补列路径（幂等，缺列才执行）。
  const cols = db.query("PRAGMA table_info(meta_session)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "generated_title")) {
    db.exec("ALTER TABLE meta_session ADD COLUMN generated_title TEXT");
  }
}
