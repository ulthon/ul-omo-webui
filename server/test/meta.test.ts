// 元数据 sqlite 存储单测：五张表 CRUD 往返、input_history 去重与 200 条裁剪、
// 双连接并发写（WAL 下不死锁，冲突返回明确错误而非损坏）。
import { afterAll, describe, expect, test } from "bun:test";
import { Database, SQLiteError } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INPUT_HISTORY_LIMIT, openMetaDb } from "../src/db/meta";

const tmp = mkdtempSync(join(tmpdir(), "senpi-meta-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function dbFile(name: string): string {
  return join(tmp, `${name}.db`);
}

describe("meta_session CRUD", () => {
  test("upsert 创建与读取往返", () => {
    const db = openMetaDb({ path: dbFile("session-21") });
    expect(db.getSessionMeta("s1")).toBeNull();

    db.updateSessionMeta("s1", { pinned: true });
    const row = db.getSessionMeta("s1");
    expect(row).not.toBeNull();
    expect(row!.sessionId).toBe("s1");
    expect(row!.pinned).toBe(true);
    expect(row!.archivedAt).toBeNull();
    expect(row!.renamedTitle).toBeNull();
    expect(row!.unreadCount).toBe(0);
    expect(row!.lastRead).toBeNull();
    expect(row!.updatedAt).toBeTruthy();
    db.close();
  });

  test("partial patch 保留未提及字段", () => {
    const db = openMetaDb({ path: dbFile("session-38") });
    db.updateSessionMeta("s2", { renamedTitle: "标题", pinned: true });
    db.updateSessionMeta("s2", { unreadCount: 3 });
    const row = db.getSessionMeta("s2")!;
    expect(row.pinned).toBe(true);
    expect(row.renamedTitle).toBe("标题");
    expect(row.unreadCount).toBe(3);
    db.close();
  });

  test("置顶/重命名/归档与取消归档", () => {
    const db = openMetaDb({ path: dbFile("session-49") });
    db.setSessionPinned("s3", true);
    expect(db.getSessionMeta("s3")!.pinned).toBe(true);
    db.setSessionPinned("s3", false);
    expect(db.getSessionMeta("s3")!.pinned).toBe(false);

    db.setSessionRenamedTitle("s3", "新名字");
    expect(db.getSessionMeta("s3")!.renamedTitle).toBe("新名字");
    db.setSessionRenamedTitle("s3", null);
    expect(db.getSessionMeta("s3")!.renamedTitle).toBeNull();

    db.setSessionArchived("s3", "2026-10-06T00:00:00.000Z");
    expect(db.getSessionMeta("s3")!.archivedAt).toBe("2026-10-06T00:00:00.000Z");
    db.setSessionArchived("s3", null);
    expect(db.getSessionMeta("s3")!.archivedAt).toBeNull();
    db.close();
  });

  test("已读上报清零未读并更新 last_read", () => {
    const db = openMetaDb({ path: dbFile("session-68") });
    db.incrementUnread("s4");
    db.incrementUnread("s4");
    expect(db.getSessionMeta("s4")!.unreadCount).toBe(2);

    db.markSessionRead("s4", "2026-10-06T08:00:00.000Z");
    const row = db.getSessionMeta("s4")!;
    expect(row.unreadCount).toBe(0);
    expect(row.lastRead).toBe("2026-10-06T08:00:00.000Z");

    db.incrementUnread("s4");
    expect(db.getSessionMeta("s4")!.lastRead).toBe("2026-10-06T08:00:00.000Z");
    db.close();
  });

  test("listSessionMeta 与删除级联清 draft", () => {
    const db = openMetaDb({ path: dbFile("session-84") });
    db.updateSessionMeta("s5", { pinned: true });
    db.setDraft("s5", "草稿内容");
    expect(db.listSessionMeta().map((r) => r.sessionId)).toContain("s5");

    db.deleteSessionMeta("s5");
    expect(db.getSessionMeta("s5")).toBeNull();
    expect(db.getDraft("s5")).toBeNull();
    db.close();
  });

  test("deleteSessionMeta 原子性：draft 删除中途失败时整体回滚（不留孤儿 draft）", () => {
    const db = openMetaDb({ path: dbFile("session-delete-atomic") });
    db.updateSessionMeta("s-del", { pinned: true });
    db.setDraft("s-del", "草稿");

    // 第二连接建触发器令 meta_draft 的 DELETE 中途失败（事务包裹前第一条 DELETE 已生效，
    // 会留下孤儿 draft；包裹后应整体回滚）
    const raw = new Database(db.path);
    raw.exec(
      "CREATE TRIGGER block_draft_delete BEFORE DELETE ON meta_draft BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
    );
    expect(() => db.deleteSessionMeta("s-del")).toThrow(SQLiteError);
    expect(db.getSessionMeta("s-del")).not.toBeNull();
    expect(db.getDraft("s-del")).not.toBeNull();

    raw.exec("DROP TRIGGER block_draft_delete");
    raw.close();

    db.deleteSessionMeta("s-del");
    expect(db.getSessionMeta("s-del")).toBeNull();
    expect(db.getDraft("s-del")).toBeNull();
    db.close();
  });
});

describe("meta_draft CRUD", () => {
  test("set/get/覆盖/删除往返", () => {
    const db = openMetaDb({ path: dbFile("draft") });
    expect(db.getDraft("d1")).toBeNull();

    db.setDraft("d1", "第一版");
    const first = db.getDraft("d1")!;
    expect(first.content).toBe("第一版");
    expect(first.updatedAt).toBeTruthy();

    db.setDraft("d1", "第二版");
    const second = db.getDraft("d1")!;
    expect(second.content).toBe("第二版");
    expect(second.updatedAt >= first.updatedAt).toBe(true);

    db.deleteDraft("d1");
    expect(db.getDraft("d1")).toBeNull();
    db.close();
  });

  test("空字符串草稿也是合法值（区别于不存在）", () => {
    const db = openMetaDb({ path: dbFile("draft") });
    db.setDraft("d2", "");
    const row = db.getDraft("d2");
    expect(row).not.toBeNull();
    expect(row!.content).toBe("");
    db.close();
  });
});

describe("meta_input_history 去重与裁剪", () => {
  test("追加后按最新在前返回", () => {
    const db = openMetaDb({ path: dbFile("history-1") });
    db.appendInputHistory("/p/a", "第一条");
    db.appendInputHistory("/p/a", "第二条");
    const list = db.listInputHistory("/p/a");
    expect(list.map((i) => i.content)).toEqual(["第二条", "第一条"]);
    expect(list[0]!.projectPath).toBe("/p/a");
    expect(list[0]!.createdAt).toBeTruthy();
    db.close();
  });

  test("同 project_path 相同 content 去重（移到最新，不留重复）", () => {
    const db = openMetaDb({ path: dbFile("history-2") });
    db.appendInputHistory("/p/a", "x");
    db.appendInputHistory("/p/a", "y");
    db.appendInputHistory("/p/a", "x"); // 重复：删旧插新
    const list = db.listInputHistory("/p/a");
    expect(list.map((i) => i.content)).toEqual(["x", "y"]);

    db.appendInputHistory("/p/b", "x"); // 不同 project_path 互不影响
    expect(db.listInputHistory("/p/a").length).toBe(2);
    expect(db.listInputHistory("/p/b").map((i) => i.content)).toEqual(["x"]);
    db.close();
  });

  test(`上限 ${DEFAULT_INPUT_HISTORY_LIMIT} 条裁剪：最旧的被移除`, () => {
    const db = openMetaDb({ path: dbFile("history-3") });
    for (let i = 1; i <= DEFAULT_INPUT_HISTORY_LIMIT + 5; i++) {
      db.appendInputHistory("/p/a", `内容-${i}`);
    }
    const list = db.listInputHistory("/p/a");
    expect(list.length).toBe(DEFAULT_INPUT_HISTORY_LIMIT);
    expect(list[0]!.content).toBe(`内容-${DEFAULT_INPUT_HISTORY_LIMIT + 5}`);
    expect(list.at(-1)!.content).toBe(`内容-6`); // 1-5 被裁掉
    expect(db.listInputHistory("/p/a", 3).length).toBe(3);
    db.close();
  });

  test("clearInputHistory 清空指定项目", () => {
    const db = openMetaDb({ path: dbFile("history-4") });
    db.appendInputHistory("/p/c", "a");
    db.appendInputHistory("/p/d", "b");
    db.clearInputHistory("/p/c");
    expect(db.listInputHistory("/p/c")).toEqual([]);
    expect(db.listInputHistory("/p/d").length).toBe(1);
    db.close();
  });
});

describe("meta_project CRUD", () => {
  test("创建、部分更新、列表排序、删除", () => {
    const db = openMetaDb({ path: dbFile("project") });
    expect(db.getProjectMeta("/w/x")).toBeNull();

    db.updateProjectMeta("/w/x", { preferredModel: "glm-5.3-flash", lastOpenedAt: "2026-10-01T00:00:00.000Z" });
    db.updateProjectMeta("/w/y", { preferredModel: "glm-5.3-flash", lastOpenedAt: "2026-10-06T00:00:00.000Z" });
    expect(db.getProjectMeta("/w/x")).toEqual({
      projectPath: "/w/x",
      preferredModel: "glm-5.3-flash",
      lastOpenedAt: "2026-10-01T00:00:00.000Z",
    });

    db.updateProjectMeta("/w/x", { lastOpenedAt: "2026-10-07T00:00:00.000Z" }); // 只动一个字段
    const x = db.getProjectMeta("/w/x")!;
    expect(x.preferredModel).toBe("glm-5.3-flash");
    expect(x.lastOpenedAt).toBe("2026-10-07T00:00:00.000Z");

    const list = db.listProjectMeta();
    expect(list.map((p) => p.projectPath)).toEqual(["/w/x", "/w/y"]); // last_opened_at 新在前

    db.deleteProjectMeta("/w/x");
    expect(db.getProjectMeta("/w/x")).toBeNull();
    db.close();
  });
});

describe("meta_project.preferred_agent 删列迁移（W1 todo 6）", () => {
  test("老库带列 → openMetaDb 后列消失、其余列数据完好；二次启动幂等", () => {
    const path = dbFile("legacy-project-column");
    // 以旧版 DDL 造一个含 preferred_agent 列且带数据的库文件（模拟升级前的存量库）
    {
      const old = new Database(path, { create: true });
      old.exec(`
        CREATE TABLE meta_project (
          project_path     TEXT PRIMARY KEY,
          preferred_agent  TEXT,
          preferred_model  TEXT,
          last_opened_at   TEXT
        );
      `);
      old.run(
        "INSERT INTO meta_project (project_path, preferred_agent, preferred_model, last_opened_at) VALUES (?, ?, ?, ?)",
        ["/legacy/a", "terminal-agent", "glm-5.3-flash", "2026-01-01T00:00:00.000Z"],
      );
      old.close();
    }

    // 第一次打开（真实文件路径，走 openMetaDb → ensureSchema 的 PRAGMA 检测路径）：
    // 迁移删列，其余列数据原样保留
    const db = openMetaDb({ path });
    expect(db.getProjectMeta("/legacy/a")).toEqual({
      projectPath: "/legacy/a",
      preferredModel: "glm-5.3-flash",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
    });
    db.close();

    // 列确已消失（独立连接读 PRAGMA，避免依赖存储层 SELECT 形状）
    {
      const raw = new Database(path);
      const cols = raw.query("PRAGMA table_info(meta_project)").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "preferred_agent")).toBe(false);
      expect(cols.map((c) => c.name)).toEqual(["project_path", "preferred_model", "last_opened_at"]);
      raw.close();
    }

    // 第二次启动：列已不存在，PRAGMA 检测跳过 DROP，无错且数据不变（幂等）
    const again = openMetaDb({ path });
    expect(again.getProjectMeta("/legacy/a")?.preferredModel).toBe("glm-5.3-flash");
    again.close();
  });
});

describe("meta_kv 任意 key/value", () => {
  test("set/get/覆盖/list/delete 往返", () => {
    const db = openMetaDb({ path: dbFile("kv") });
    expect(db.getKv("外链.git")).toBeNull();

    db.setKv("外链.git", "https://git.example.com");
    db.setKv("perm.allow:eval", "*");
    expect(db.getKv("外链.git")).toBe("https://git.example.com");
    expect(db.getKv("perm.allow:eval")).toBe("*");

    db.setKv("外链.git", "https://git2.example.com");
    expect(db.getKv("外链.git")).toBe("https://git2.example.com");

    expect(db.listKv()).toEqual({
      "外链.git": "https://git2.example.com",
      "perm.allow:eval": "*",
    });

    db.deleteKv("外链.git");
    expect(db.getKv("外链.git")).toBeNull();
    expect("外链.git" in db.listKv()).toBe(false);
    db.close();
  });
});

describe("WAL 与并发写", () => {
  test("journal_mode 为 wal", () => {
    const path = dbFile("wal");
    openMetaDb({ path }).close();
    const raw = new Database(path);
    const row = raw.query("PRAGMA journal_mode").get() as { journal_mode: string };
    raw.close();
    expect(row.journal_mode).toBe("wal");
  });

  test("两个连接交替写同一会话 draft 不死锁", () => {
    const path = dbFile("concurrent");
    const a = openMetaDb({ path });
    const b = openMetaDb({ path });
    for (let i = 0; i < 50; i++) {
      a.setDraft("c1", `a-${i}`);
      b.setDraft("c1", `b-${i}`);
    }
    expect(b.getDraft("c1")!.content).toBe("b-49");
    expect(a.getDraft("c1")!.content).toBe("b-49");
    expect(b.integrityCheck()).toBe("ok");
    a.close();
    b.close();
  });

  test("写锁被长事务持有时：等待后抛明确 SqliteError，锁释放后可恢复且库不损坏", async () => {
    const path = dbFile("busy");
    openMetaDb({ path }).close(); // 先初始化 schema，锁持有方才能写 meta_draft
    const holder = new Database(path); // 锁持有方（原生连接，模拟另一进程/连接）
    holder.exec("PRAGMA journal_mode = WAL");
    holder.exec("BEGIN IMMEDIATE");
    holder.run("INSERT INTO meta_draft (session_id, content, updated_at) VALUES ('locked', 'holding', 'x')");

    const waiter = openMetaDb({ path, busyTimeoutMs: 200 });
    let caught: unknown = null;
    try {
      waiter.setDraft("locked", "should-fail");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SQLiteError);
    expect((caught as Error).message).toMatch(/locked|busy/i);

    // 锁释放后：waiter 正常写入，两连接读到一致数据，库完整
    holder.exec("COMMIT");
    waiter.setDraft("locked", "recovered");
    expect(waiter.getDraft("locked")!.content).toBe("recovered");
    expect(waiter.integrityCheck()).toBe("ok");
    holder.close();
    waiter.close();
  });
});

describe("库路径解析", () => {
  test("SENPI_WEBUI_META_DB 环境变量覆盖默认路径", () => {
    const envPath = dbFile("env-override");
    const prev = process.env.SENPI_WEBUI_META_DB;
    process.env.SENPI_WEBUI_META_DB = envPath;
    try {
      const db = openMetaDb();
      expect(db.path).toBe(envPath);
      db.setKv("k", "v");
      db.close();
    } finally {
      if (prev === undefined) delete process.env.SENPI_WEBUI_META_DB;
      else process.env.SENPI_WEBUI_META_DB = prev;
    }
  });
});
