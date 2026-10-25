// 元数据库建表 DDL。字段与计划 todo 11 / W1 todo 2 逐一对应，禁止随意加列。
// meta_session.last_read 是"任一设备查看即清零"未读语义的数据基础（已读上报时更新并清零 unread_count）。
// meta_kv 存外链地址、权限"总是允许"记忆等壳层配置。
// meta_note.tags 为 JSON 数组字符串（存标签名）；meta_note_version 随 note 硬删除在事务里级联清理。
// meta_session_tag 无外键：会话元数据生命周期独立管理（与 meta_draft 同理）。
import type { Database } from "./sqlite";

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

CREATE TABLE IF NOT EXISTS meta_tag_mount_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  tag_scope   TEXT NOT NULL,
  tag_name    TEXT NOT NULL,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
`;

export function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  // 老库平滑升级：meta_session 补 generated_title 列。既有建表 DDL 保持逐字不变，
  // 新库与老库统一走 PRAGMA table_info 检测 + ALTER 补列路径（幂等，缺列才执行）。
  const cols = db.query("PRAGMA table_info(meta_session)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "generated_title")) {
    db.exec("ALTER TABLE meta_session ADD COLUMN generated_title TEXT");
  }
  // 老库平滑降级（W1 todo 6）：agent 枚举特性退役，meta_project.preferred_agent 为
  // write-once-read-never 死列，启动时删除（SQLite ≥ 3.35 支持 DROP COLUMN，幂等：
  // 列已不存在时跳过；写操作永不读它，删列无数据语义损失）。
  const projectCols = db.query("PRAGMA table_info(meta_project)").all() as Array<{ name: string }>;
  if (projectCols.some((c) => c.name === "preferred_agent")) {
    db.exec("ALTER TABLE meta_project DROP COLUMN preferred_agent");
  }
  // C16（docs08-r3 todo 9）：meta_project 补 created_at 注册时间列（侧栏"添加"排序档的
  // 数据基础）。SQLite ALTER TABLE ADD COLUMN 不接受非常量 DEFAULT（CURRENT_TIMESTAMP），
  // 两步走：先加可空列，再回填存量行为迁移时刻——存量行 createdAt 同值，前端"添加"档
  // 对这批行退化为 last_opened_at 稳定排序。幂等：列已存在时跳过加列与回填（重复启动
  // 不重复改写存量值，新注册行的注册时刻不受影响）。
  if (!projectCols.some((c) => c.name === "created_at")) {
    db.exec("ALTER TABLE meta_project ADD COLUMN created_at TEXT");
    db.run("UPDATE meta_project SET created_at = ?", [new Date().toISOString()]);
  }
  // A2（docs08-r3 todo 10）：meta_project 补 hidden 软标记列（项目隐藏）。DEFAULT 0 为
  // 常量（ALTER 合法），单步加列即可；幂等：列已存在时跳过（重复启动零改写）。
  if (!projectCols.some((c) => c.name === "hidden")) {
    db.exec("ALTER TABLE meta_project ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  }
}
