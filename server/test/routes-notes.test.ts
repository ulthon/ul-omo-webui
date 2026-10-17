// 笔记端点单测（todo 5）：聚焦 HTTP 语义层（列表形状不含 content、64KB 上限、
// 版本追加去重、purge 前置条件、软删/恢复、tag 过滤、排序、项目注册校验）——
// meta 层 note 读写行为已由 meta.test.ts 锁定，此处不重复。
// 全部用 mkdtemp 隔离目录，不触引擎。
import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type {
  EngineMessagesPage,
  EngineModelInfo,
  EnginePermissionReply,
  EngineQuestionFrame,
  EnginePromptInput,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineUsageStats,
  EngineQueueSnapshot,
} from "../src/adapter/engine-adapter";
import type { EngineGateway } from "../src/api/engine-runtime";
import { openMetaDb } from "../src/db/meta";
import { createNotesRoutes } from "../src/api/routes-notes";

/** notes 路由不触引擎；类型占位实现（任何误用都会在测试里以异常暴露）。 */
class NoEngines implements EngineGateway {
  async sessionsList(): Promise<EngineSessionSummary[]> {
    return [];
  }
  async createSession(
    _project: string,
    _opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new Error("notes routes must not create sessions");
  }
  async messages(_id: string, _cursor?: string): Promise<EngineMessagesPage> {
    throw new Error("notes routes must not read messages");
  }
  async prompt(_id: string, _input: EnginePromptInput): Promise<{ disposition: string }> {
    throw new Error("notes routes must not prompt");
  }
  async abort(): Promise<void> {}
  async queueList(): Promise<EngineQueueSnapshot> {
    throw new Error("queue routes must not be touched here");
  }
  async queueClear(): Promise<EngineQueueSnapshot> {
    throw new Error("queue routes must not be touched here");
  }
  async permissionRespond(_id: string, _requestId: string, _reply: EnginePermissionReply): Promise<void> {}
  async questionsList(_id: string): Promise<EngineQuestionFrame[]> {
    return [];
  }
  async usage(): Promise<EngineUsageStats> {
    throw new Error("notes routes must not read usage");
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    throw new Error("notes routes must not list models");
  }
  async deleteSession(): Promise<{ sessionPath: string; fileExisted: boolean }> {
    throw new Error("notes routes must not delete sessions");
  }
  async exportSessionHtml(): Promise<{ html: string; row: EngineSessionSummary }> {
    throw new Error("notes routes must not export");
  }
  async forkSession(): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    throw new Error("notes routes must not fork");
  }
  async peekActiveSessionPaths(): Promise<string[] | null> {
    return null;
  }
  async restartProject(): Promise<void> {}
  async stopAll(): Promise<void> {}
}

const tmp = mkdtempSync(join(tmpdir(), "senpi-notes-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 每个用例独立子目录（bun test 同文件共享模块态，防串数据）。
let seq = 0;
function setup() {
  seq += 1;
  const caseDir = mkdtempSync(join(tmp, `case-${seq}-`));
  const projectDir = join(caseDir, "proj");
  mkdirSync(projectDir, { recursive: true });
  const meta = openMetaDb({ path: join(caseDir, "meta.db") });
  const app = new Hono();
  app.route("/", createNotesRoutes({ meta, engines: new NoEngines() }));
  const register = () => meta.updateProjectMeta(projectDir, { lastOpenedAt: new Date().toISOString() });
  const createNote = (body: Record<string, unknown>) =>
    app.request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: projectDir, ...body }),
    });
  return { app, meta, projectDir, register, createNote };
}

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("全回路（建/改/版本/软删/恢复/硬删）", () => {
  test("建 → 改 → 版本列表 → 版本恢复 → 同内容幂等 → 软删 → 回收站 → 恢复 → purge 前置 409 → 硬删", async () => {
    const { app, projectDir, register, createNote } = setup();
    register();

    // 创建（带 tags）：首个版本快照入 meta_note_version
    const created = await createNote({ title: "笔记一", content: "第一版内容", tags: ["work", "idea"] });
    expect(created.status).toBe(201);
    const note = (await created.json()).note;
    expect(note.id).toBeTruthy();
    expect(note.title).toBe("笔记一");
    expect(note.content).toBe("第一版内容");
    expect(note.tags).toEqual(["work", "idea"]);
    expect(note.deletedAt).toBeNull();

    // PUT 改内容：追加新版本
    const putV2 = await app.request(`/api/notes/${note.id}`, json({ content: "第二版内容" }, "PUT"));
    expect(putV2.status).toBe(200);
    expect((await putV2.json()).note.content).toBe("第二版内容");

    // 版本列表：新在前，2 条，preview 取前 100 字
    const versions1 = await app.request(`/api/notes/${note.id}/versions`);
    expect(versions1.status).toBe(200);
    const list1 = (await versions1.json()).versions;
    expect(list1).toHaveLength(2);
    expect(list1[0].preview.startsWith("第二版内容")).toBe(true);
    expect(list1[0].id).toBeTruthy();
    expect(typeof list1[0].savedAt).toBe("string");
    expect(list1[1].preview.startsWith("第一版内容")).toBe(true);

    // 版本恢复到第一版：正文变回 v1，恢复结果作为新版本追加（历史不可变，共 3 条）
    const restoreV1 = await app.request(`/api/notes/${note.id}/versions/${list1[1].id}/restore`, { method: "POST" });
    expect(restoreV1.status).toBe(200);
    expect((await restoreV1.json()).note.content).toBe("第一版内容");
    const versions2 = await app.request(`/api/notes/${note.id}/versions`);
    const list2 = (await versions2.json()).versions;
    expect(list2).toHaveLength(3);
    expect(list2[0].preview.startsWith("第一版内容")).toBe(true);

    // 同内容重复保存：版本不增（幂等）
    await app.request(`/api/notes/${note.id}`, json({ content: "第一版内容" }, "PUT"));
    const versions3 = await app.request(`/api/notes/${note.id}/versions`);
    expect((await versions3.json()).versions).toHaveLength(3);

    // 列表：不含 content 字段、唯一一条
    const list = await app.request(`/api/notes?project=${encodeURIComponent(projectDir)}`);
    expect(list.status).toBe(200);
    const listed = (await list.json()).notes;
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]).sort()).toEqual(["deletedAt", "id", "tags", "title", "updatedAt"]);
    expect(listed[0].id).toBe(note.id);

    // 软删：deleted=0 不可见、deleted=1 可见且带 deletedAt
    const del = await app.request(`/api/notes/${note.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const liveAfterDelete = await app.request(`/api/notes?project=${encodeURIComponent(projectDir)}`);
    expect((await liveAfterDelete.json()).notes).toHaveLength(0);
    const trashed = await app.request(`/api/notes?project=${encodeURIComponent(projectDir)}&deleted=1`);
    const trashedNotes = (await trashed.json()).notes;
    expect(trashedNotes).toHaveLength(1);
    expect(trashedNotes[0].deletedAt).not.toBeNull();

    // 恢复：deleted_at 置 null，回到活动列表
    const restored = await app.request(`/api/notes/${note.id}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect((await restored.json()).note.deletedAt).toBeNull();

    // purge 前置条件：未软删状态 purge=1 → 409（不是静默成功）
    const purgeEarly = await app.request(`/api/notes/${note.id}?purge=1`, { method: "DELETE" });
    expect(purgeEarly.status).toBe(409);
    expect((await purgeEarly.json()).error.code).toBe("purge_requires_deleted");
    // 未软删时 purge 409 不得误删
    expect((await app.request(`/api/notes/${note.id}`)).status).toBe(200);

    // 再软删 → purge=1 硬删：笔记与版本随之消失
    await app.request(`/api/notes/${note.id}`, { method: "DELETE" });
    const purge = await app.request(`/api/notes/${note.id}?purge=1`, { method: "DELETE" });
    expect(purge.status).toBe(200);
    expect((await app.request(`/api/notes/${note.id}`)).status).toBe(404);
    expect((await app.request(`/api/notes/${note.id}/versions`)).status).toBe(404);
  });
});

describe("GET /api/notes 列表", () => {
  test("列表项形状逐字：{id,title,tags,updatedAt,deletedAt}，不含 content", async () => {
    const { app, projectDir, register, createNote } = setup();
    register();
    await createNote({ title: "T", content: "正文不应出现在列表", tags: ["a"] });
    const res = await app.request(`/api/notes?project=${encodeURIComponent(projectDir)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notes).toHaveLength(1);
    const item = body.notes[0];
    expect(Object.keys(item).sort()).toEqual(["deletedAt", "id", "tags", "title", "updatedAt"]);
    expect(item.title).toBe("T");
    expect(item.tags).toEqual(["a"]);
    expect(item.deletedAt).toBeNull();
    expect(typeof item.updatedAt).toBe("string");
  });

  test("deleted=1 只看回收站，deleted 非法值 400", async () => {
    const { app, projectDir, register, createNote } = setup();
    register();
    const created = await createNote({ title: "回收我", content: "x" });
    const id = (await created.json()).note.id;
    await app.request(`/api/notes/${id}`, { method: "DELETE" });

    const live = await app.request(`/api/notes?project=${encodeURIComponent(projectDir)}&deleted=0`);
    expect((await live.json()).notes).toHaveLength(0);
    const trashed = await app.request(`/api/notes?project=${encodeURIComponent(projectDir)}&deleted=1`);
    const trashedNotes = (await trashed.json()).notes;
    expect(trashedNotes).toHaveLength(1);
    expect(trashedNotes[0].id).toBe(id);
    expect(trashedNotes[0].deletedAt).not.toBeNull();

    const bad = await app.request(`/api/notes?project=${encodeURIComponent(projectDir)}&deleted=2`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_deleted");
  });

  test("tag 过滤：JSON tags 包含即命中", async () => {
    const { app, projectDir, register, createNote } = setup();
    register();
    await createNote({ title: "n1", content: "1", tags: ["work"] });
    await createNote({ title: "n2", content: "2", tags: ["life"] });
    await createNote({ title: "n3", content: "3", tags: ["work", "life"] });

    const work = await app.request(`/api/notes?project=${encodeURIComponent(projectDir)}&tag=work`);
    expect((await work.json()).notes.map((n: { title: string }) => n.title).sort()).toEqual(["n1", "n3"]);
    const life = await app.request(`/api/notes?project=${encodeURIComponent(projectDir)}&tag=life`);
    expect((await life.json()).notes.map((n: { title: string }) => n.title).sort()).toEqual(["n2", "n3"]);
    const none = await app.request(`/api/notes?project=${encodeURIComponent(projectDir)}&tag=missing`);
    expect((await none.json()).notes).toHaveLength(0);
  });

  test("排序：sort 升序（null 最后）+ updated_at 降序", async () => {
    const { app, meta, projectDir, register, createNote } = setup();
    register();
    // REST 形状不暴露 sort（计划 POST/PUT body 逐字无此字段）；
    // sort 是库层预留字段，经 meta 直设，测试锁列表排序语义。
    // 创建顺序 updated_at 递增：sort=2 → sort=1 → sort=null
    const n2 = await createNote({ title: "sort2", content: "a", tags: [] });
    const n1 = await createNote({ title: "sort1", content: "b", tags: [] });
    const n0 = await createNote({ title: "sortnull", content: "c", tags: [] });
    meta.updateNote((await n2.json()).note.id, { sort: 2 });
    meta.updateNote((await n1.json()).note.id, { sort: 1 });
    void n0;
    const res = await app.request(`/api/notes?project=${encodeURIComponent(projectDir)}`);
    expect((await res.json()).notes.map((n: { title: string }) => n.title)).toEqual([
      "sort1",
      "sort2",
      "sortnull",
    ]);
  });
});

describe("GET /api/notes/:id 详情", () => {
  test("完整形状：{id,project,title,content,tags,deletedAt,createdAt,updatedAt}", async () => {
    const { app, projectDir, register, createNote } = setup();
    register();
    const created = await createNote({ title: "详情", content: "正文", tags: ["t"] });
    const id = (await created.json()).note.id;
    const res = await app.request(`/api/notes/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.note).sort()).toEqual([
      "content",
      "createdAt",
      "deletedAt",
      "id",
      "project",
      "tags",
      "title",
      "updatedAt",
    ]);
    expect(body.note.project).toBe(projectDir);
    expect(body.note.content).toBe("正文");
  });
});

describe("输入校验", () => {
  test("64KB 边界：65536 字节通过，65537 字节 400（POST 与 PUT 同限）", async () => {
    const { app, register, createNote } = setup();
    register();
    const atLimit = await createNote({ title: "边界", content: "x".repeat(65536) });
    expect(atLimit.status).toBe(201);
    const id = (await atLimit.json()).note.id;

    const overPost = await createNote({ title: "超限", content: "x".repeat(65537) });
    expect(overPost.status).toBe(400);
    expect((await overPost.json()).error.code).toBe("content_too_large");

    const overPut = await app.request(`/api/notes/${id}`, json({ content: "y".repeat(65537) }, "PUT"));
    expect(overPut.status).toBe(400);
    expect((await overPut.json()).error.code).toBe("content_too_large");
  });

  test("title 缺失或非字符串 400，content 缺失或非字符串 400，tags 非数组 400", async () => {
    const { register, createNote } = setup();
    register();
    expect((await createNote({ content: "无标题" })).status).toBe(400);
    expect((await createNote({ title: 3, content: "x" })).status).toBe(400);
    expect((await createNote({ title: "无正文" })).status).toBe(400);
    expect((await createNote({ title: "t", content: 42 })).status).toBe(400);
    const badTags = await createNote({ title: "t", content: "x", tags: "work" });
    expect(badTags.status).toBe(400);
    expect((await badTags.json()).error.code).toBe("invalid_tags");
    const badTagItem = await createNote({ title: "t", content: "x", tags: ["ok", 1] });
    expect(badTagItem.status).toBe(400);
  });

  test("PUT 空 patch 400，PUT 不存在 id 404", async () => {
    const { app, register, createNote } = setup();
    register();
    const created = await createNote({ title: "t", content: "c" });
    const id = (await created.json()).note.id;
    const empty = await app.request(`/api/notes/${id}`, json({}, "PUT"));
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.code).toBe("invalid_request");
    const missing = await app.request(`/api/notes/does-not-exist`, json({ title: "x" }, "PUT"));
    expect(missing.status).toBe(404);
  });
});

describe("项目注册校验（POST）", () => {
  test("目录存在但未注册 400 project_not_found；目录不存在 400；非绝对路径 400", async () => {
    const { app, projectDir } = setup();
    // projectDir 存在但未注册
    const unregistered = await app.request("/api/notes", json({ project: projectDir, title: "t", content: "c" }));
    expect(unregistered.status).toBe(400);
    expect((await unregistered.json()).error.code).toBe("project_not_found");
    // 目录不存在
    expect((await app.request("/api/notes", json({ project: "/tmp/definitely-not-here-xyz", title: "t", content: "c" }))).status).toBe(400);
    // 非绝对路径
    expect((await app.request("/api/notes", json({ project: "relative/path", title: "t", content: "c" }))).status).toBe(400);
  });
});

describe("404 矩阵与 purge/恢复参数", () => {
  test("GET/DELETE/restore/versions 对不存在 id 一律 404", async () => {
    const { app } = setup();
    expect((await app.request("/api/notes/nope")).status).toBe(404);
    expect((await app.request("/api/notes/nope", { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/api/notes/nope/restore", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/notes/nope/versions")).status).toBe(404);
    expect((await app.request("/api/notes/nope/versions/also-nope/restore", { method: "POST" })).status).toBe(404);
  });

  test("恢复不存在的版本 id 404；purge 非法值 400", async () => {
    const { app, register, createNote } = setup();
    register();
    const created = await createNote({ title: "t", content: "c" });
    const id = (await created.json()).note.id;
    const missingVersion = await app.request(`/api/notes/${id}/versions/no-such-vid/restore`, { method: "POST" });
    expect(missingVersion.status).toBe(404);
    expect((await missingVersion.json()).error.code).toBe("version_not_found");
    const badPurge = await app.request(`/api/notes/${id}?purge=yes`, { method: "DELETE" });
    expect(badPurge.status).toBe(400);
    expect((await badPurge.json()).error.code).toBe("invalid_purge");
  });
});
