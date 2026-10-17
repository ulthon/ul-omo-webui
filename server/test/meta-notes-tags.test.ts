// 元数据扩展单测（W1 todo 2）：meta_note CRUD 与软删/回收站、meta_note_version 版本链
// 与级联硬删除、meta_session_tag 整替幂等、meta_session.generated_title 读写、
// 老库（无新列旧 schema）经 ensureSchema 平滑升级。
// 排序断言一律用显式时间戳/集合断言，不依赖同毫秒时钟。
import { afterAll, describe, expect, test } from "vitest";
import { Database } from "../src/db/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMetaDb } from "../src/db/meta";

const tmp = mkdtempSync(join(tmpdir(), "senpi-meta-notes-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function dbFile(name: string): string {
  return join(tmp, `${name}.db`);
}

function tableNames(path: string): string[] {
  const raw = new Database(path);
  const rows = raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  raw.close();
  return rows.map((r) => r.name);
}

describe("meta_note CRUD", () => {
  test("创建与读取往返（tags/sort/时间戳）", () => {
    const db = openMetaDb({ path: dbFile("note-crud") });
    expect(db.getNote("n1")).toBeNull();

    const created = db.createNote({
      id: "n1",
      projectPath: "/p/a",
      title: "第一篇",
      content: "正文",
      tags: ["架构", "待办"],
      sort: 2,
    });
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();
    expect(created.deletedAt).toBeNull();

    const row = db.getNote("n1")!;
    expect(row.projectPath).toBe("/p/a");
    expect(row.title).toBe("第一篇");
    expect(row.content).toBe("正文");
    expect(row.tags).toEqual(["架构", "待办"]);
    expect(row.sort).toBe(2);
    db.close();
  });

  test("缺省 tags 为空数组、sort 为 null", () => {
    const db = openMetaDb({ path: dbFile("note-defaults") });
    db.createNote({ id: "n1", projectPath: "/p/a", title: "t", content: "c" });
    const row = db.getNote("n1")!;
    expect(row.tags).toEqual([]);
    expect(row.sort).toBeNull();
    db.close();
  });

  test("updateNote 部分更新保留未提及字段；笔记不存在时抛错", () => {
    const db = openMetaDb({ path: dbFile("note-update") });
    db.createNote({ id: "n1", projectPath: "/p/a", title: "旧标题", content: "旧内容", tags: ["a"] });
    const updated = db.updateNote("n1", { title: "新标题", tags: ["b", "c"] });
    expect(updated.title).toBe("新标题");
    expect(updated.content).toBe("旧内容");
    expect(updated.tags).toEqual(["b", "c"]);
    expect(() => db.updateNote("missing", { title: "x" })).toThrow();
    db.close();
  });

  test("listNotes 按项目隔离，updated_at 新在前（显式时间戳）", () => {
    const path = dbFile("note-list");
    const db = openMetaDb({ path });
    db.createNote({ id: "n1", projectPath: "/p/a", title: "一", content: "c" });
    db.createNote({ id: "n2", projectPath: "/p/a", title: "二", content: "c" });
    db.createNote({ id: "n3", projectPath: "/p/b", title: "三", content: "c" });

    // 显式 updated_at 排序值，勿依赖同毫秒时钟
    const raw = new Database(path);
    raw.run("UPDATE meta_note SET updated_at = '2026-01-02T00:00:00.000Z' WHERE id = 'n1'");
    raw.run("UPDATE meta_note SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 'n2'");
    raw.close();

    expect(db.listNotes("/p/a").map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(db.listNotes("/p/b").map((n) => n.id)).toEqual(["n3"]);
    db.close();
  });
});

describe("meta_note 软删除与回收站", () => {
  test("软删后 listNotes 排除、listTrashedNotes 列出、恢复后回到列表", () => {
    const db = openMetaDb({ path: dbFile("note-soft") });
    db.createNote({ id: "n1", projectPath: "/p/a", title: "一", content: "c" });
    db.createNote({ id: "n2", projectPath: "/p/a", title: "二", content: "c" });

    db.softDeleteNote("n1");
    expect(db.listNotes("/p/a").map((n) => n.id)).toEqual(["n2"]);
    const trashed = db.listTrashedNotes("/p/a");
    expect(trashed.map((n) => n.id)).toEqual(["n1"]);
    expect(trashed[0]!.deletedAt).toBeTruthy();

    db.restoreNote("n1");
    expect(new Set(db.listNotes("/p/a").map((n) => n.id))).toEqual(new Set(["n1", "n2"]));
    expect(db.listTrashedNotes("/p/a")).toEqual([]);
    db.close();
  });
});

describe("meta_note tags 列容错", () => {
  test("tags 存了非法 JSON：读取返回空数组，不崩", () => {
    const path = dbFile("note-bad-tags");
    const db = openMetaDb({ path });
    db.createNote({ id: "n1", projectPath: "/p/a", title: "t", content: "c" });
    db.close();

    const raw = new Database(path);
    raw.run("UPDATE meta_note SET tags = 'not-json{{' WHERE id = 'n1'");
    raw.close();

    const reopened = openMetaDb({ path });
    expect(reopened.getNote("n1")!.tags).toEqual([]);
    expect(reopened.listNotes("/p/a")[0]!.tags).toEqual([]);

    // 合法 JSON 但不是字符串数组：同样容错
    const raw2 = new Database(path);
    raw2.run("UPDATE meta_note SET tags = '{\"x\":1}' WHERE id = 'n1'");
    raw2.close();
    expect(reopened.getNote("n1")!.tags).toEqual([]);
    reopened.close();
  });
});

describe("meta_note_version 版本链", () => {
  test("追加与列表：saved_at 新在前（显式排序值）、latest/get 往返", () => {
    const db = openMetaDb({ path: dbFile("ver-list") });
    db.createNote({ id: "n1", projectPath: "/p/a", title: "t", content: "c" });
    const v1 = db.appendNoteVersion("n1", "第一版", "2026-10-01T00:00:00.000Z");
    const v2 = db.appendNoteVersion("n1", "第二版", "2026-10-02T00:00:00.000Z");
    const v3 = db.appendNoteVersion("n1", "第三版", "2026-10-03T00:00:00.000Z");

    expect(db.listNoteVersions("n1").map((v) => v.id)).toEqual([v3.id, v2.id, v1.id]);
    expect(db.latestNoteVersion("n1")!.content).toBe("第三版");
    expect(db.getNoteVersion(v1.id)!.content).toBe("第一版");
    expect(db.getNoteVersion(v1.id)!.noteId).toBe("n1");
    expect(db.listNoteVersions("missing")).toEqual([]);
    expect(db.latestNoteVersion("missing")).toBeNull();
    db.close();
  });

  test("恢复历史版本 = 追加新版本，历史原样不改写", () => {
    const db = openMetaDb({ path: dbFile("ver-restore") });
    db.createNote({ id: "n1", projectPath: "/p/a", title: "t", content: "c" });
    const v1 = db.appendNoteVersion("n1", "v1 内容", "2026-10-01T00:00:00.000Z");
    const v2 = db.appendNoteVersion("n1", "v2 内容", "2026-10-02T00:00:00.000Z");

    // 库层原语：REST 层恢复 v1 即以 v1 内容追加新版本（去重判断在 REST）
    const v3 = db.appendNoteVersion("n1", "v1 内容", "2026-10-03T00:00:00.000Z");
    const versions = db.listNoteVersions("n1");
    expect(versions.map((v) => v.id)).toEqual([v3.id, v2.id, v1.id]);
    expect(versions.map((v) => v.content)).toEqual(["v1 内容", "v2 内容", "v1 内容"]);
    expect(db.getNoteVersion(v1.id)!.content).toBe("v1 内容");
    expect(db.latestNoteVersion("n1")!.id).toBe(v3.id);
    db.close();
  });

  test("appendNoteVersion 缺省 savedAt 取当前时间", () => {
    const db = openMetaDb({ path: dbFile("ver-now") });
    db.createNote({ id: "n1", projectPath: "/p/a", title: "t", content: "c" });
    const v = db.appendNoteVersion("n1", "内容");
    expect(v.savedAt).toBeTruthy();
    db.close();
  });
});

describe("meta_session_tag 挂载", () => {
  test("setSessionTags 整替、listSessionTags 回读、同输入重复调用幂等", () => {
    const db = openMetaDb({ path: dbFile("tag-replace") });
    db.setSessionTags("s1", [
      { scope: "global", name: "重要" },
      { scope: "project", name: "架构" },
    ]);
    expect(db.listSessionTags("s1")).toEqual([
      { scope: "global", name: "重要", createdAt: expect.any(String) },
      { scope: "project", name: "架构", createdAt: expect.any(String) },
    ]);

    // 整替：换为完全不同的集合
    db.setSessionTags("s1", [{ scope: "project", name: "新标签" }]);
    expect(db.listSessionTags("s1").map((t) => t.name)).toEqual(["新标签"]);

    // 幂等：同一输入再调一次，结果集合不变
    db.setSessionTags("s1", [{ scope: "project", name: "新标签" }]);
    expect(db.listSessionTags("s1").map((t) => t.name)).toEqual(["新标签"]);

    // 空数组整替 = 清空挂载；未挂载会话返回空列表
    db.setSessionTags("s1", []);
    expect(db.listSessionTags("s1")).toEqual([]);
    expect(db.listSessionTags("s2")).toEqual([]);
    db.close();
  });

  test("listSessionsByTag / countSessionsByTag 按 scope+tag 精确匹配", () => {
    const db = openMetaDb({ path: dbFile("tag-query") });
    db.setSessionTags("s1", [{ scope: "global", name: "重要" }]);
    db.setSessionTags("s2", [{ scope: "global", name: "重要" }, { scope: "project", name: "架构" }]);
    db.setSessionTags("s3", [{ scope: "project", name: "架构" }]);

    expect(db.listSessionsByTag("global", "重要")).toEqual(["s1", "s2"]);
    expect(db.listSessionsByTag("project", "架构")).toEqual(["s2", "s3"]);
    expect(db.listSessionsByTag("global", "架构")).toEqual([]);
    expect(db.countSessionsByTag("global", "重要")).toBe(2);
    expect(db.countSessionsByTag("project", "不存在")).toBe(0);
    db.close();
  });
});

describe("级联硬删除", () => {
  test("hardDeleteNote 删笔记且版本表行数归零；其他笔记版本不受影响", () => {
    const path = dbFile("cascade");
    const db = openMetaDb({ path });
    db.createNote({ id: "n1", projectPath: "/p/a", title: "t1", content: "c1" });
    db.appendNoteVersion("n1", "v1", "2026-10-01T00:00:00.000Z");
    db.appendNoteVersion("n1", "v2", "2026-10-02T00:00:00.000Z");
    db.createNote({ id: "n2", projectPath: "/p/a", title: "t2", content: "c2" });
    db.appendNoteVersion("n2", "n2 的版本", "2026-10-02T00:00:00.000Z");

    db.hardDeleteNote("n1");

    expect(db.getNote("n1")).toBeNull();
    expect(db.listNoteVersions("n1")).toEqual([]);
    // 数据面实证：不只看接口不抛错，版本表里 n1 的行必须归零
    const raw = new Database(path);
    const count = raw.query(
      "SELECT COUNT(*) AS n FROM meta_note_version WHERE note_id = 'n1'",
    ).get() as { n: number };
    raw.close();
    expect(count.n).toBe(0);

    // 其他笔记与其版本不受影响
    expect(db.getNote("n2")).not.toBeNull();
    expect(db.latestNoteVersion("n2")!.content).toBe("n2 的版本");
    db.close();
  });
});

describe("meta_session.generated_title", () => {
  test("set/get 往返、置 null 清除、未写过的会话返回 null", () => {
    const db = openMetaDb({ path: dbFile("gt-basic") });
    expect(db.getSessionGeneratedTitle("s1")).toBeNull();

    db.setSessionGeneratedTitle("s1", "自动标题");
    expect(db.getSessionGeneratedTitle("s1")).toBe("自动标题");

    db.setSessionGeneratedTitle("s1", null);
    expect(db.getSessionGeneratedTitle("s1")).toBeNull();
    db.close();
  });

  test("与既有 meta 字段互不干扰（双向）", () => {
    const db = openMetaDb({ path: dbFile("gt-isolation") });
    db.setSessionGeneratedTitle("s3", "标题三");
    db.updateSessionMeta("s3", { pinned: true });
    expect(db.getSessionGeneratedTitle("s3")).toBe("标题三");

    db.updateSessionMeta("s3", { renamedTitle: "手改名" });
    const meta = db.getSessionMeta("s3")!;
    expect(meta.pinned).toBe(true);
    expect(meta.renamedTitle).toBe("手改名");
    expect(db.getSessionGeneratedTitle("s3")).toBe("标题三");
    db.close();
  });
});

describe("老库平滑升级", () => {
  test("旧 schema 库经 ensureSchema 补 generated_title 列并新建三表，既有数据保留", () => {
    const path = dbFile("upgrade");
    // 手工建旧版 meta_session（无 generated_title、无任何新表），塞一行数据
    const old = new Database(path);
    old.exec(`
      CREATE TABLE meta_session (
        session_id     TEXT PRIMARY KEY,
        pinned         INTEGER NOT NULL DEFAULT 0,
        archived_at    TEXT,
        renamed_title  TEXT,
        unread_count   INTEGER NOT NULL DEFAULT 0,
        last_read      TEXT,
        updated_at     TEXT NOT NULL
      );
    `);
    old.run(
      "INSERT INTO meta_session (session_id, pinned, renamed_title, updated_at) VALUES ('old-1', 1, '旧名', '2026-01-01T00:00:00.000Z')",
    );
    old.close();
    expect(tableNames(path)).not.toContain("meta_note");

    // 经 openMetaDb（内部 ensureSchema）打开：列补齐、三新表建成、数据还在、新列可写
    const db = openMetaDb({ path });
    const raw = new Database(path);
    const cols = (
      raw.query("PRAGMA table_info(meta_session)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    raw.close();
    expect(cols).toContain("generated_title");
    expect(tableNames(path)).toEqual(expect.arrayContaining(["meta_note", "meta_note_version", "meta_session_tag"]));

    const row = db.getSessionMeta("old-1")!;
    expect(row.pinned).toBe(true);
    expect(row.renamedTitle).toBe("旧名");

    db.setSessionGeneratedTitle("old-1", "升级后可写");
    expect(db.getSessionGeneratedTitle("old-1")).toBe("升级后可写");
    db.close();
  });

  test("新库与重开库不重复补列（幂等）", () => {
    const path = dbFile("upgrade-idempotent");
    openMetaDb({ path }).close();
    const reopened = openMetaDb({ path });
    expect(reopened.getSessionMeta("anything")).toBeNull();
    reopened.setSessionGeneratedTitle("s1", "ok");
    expect(reopened.getSessionGeneratedTitle("s1")).toBe("ok");
    reopened.close();
  });
});
