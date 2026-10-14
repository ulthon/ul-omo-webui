// 会话列表路由测试（todo 9 聚合扩展）：
// - 基线特征化（带 project 参数，锁定现有行为做回归锚）：响应形状、排序、q/archived、非法参数
// - 聚合模式（project 缺省）：全部注册项目并行合并、全局排序、单项目失败隔离（allSettled 语义）
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { EngineGateway } from "../src/api/engine-runtime";
import type {
  EngineMessagesPage,
  EngineModelInfo,
  EnginePermissionReply,
  EnginePromptInput,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineUsageStats,
} from "../src/adapter/engine-adapter";
import { ApiError } from "../src/api/http";
import { createSessionRoutes } from "../src/api/routes-session";
import { openMetaDb } from "../src/db/meta";

// ---------------------------------------------------------------- fake gateway

function summary(partial: Partial<EngineSessionSummary> & { id: string; path: string }): EngineSessionSummary {
  return {
    cwd: "/proj",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
    ...partial,
  };
}

/** 项目感知的 fake：每项目独立会话集 + 可注入失败（聚合失败隔离用例）。
 * listProjectPaths 对齐 EngineRuntimeRegistry 的结构能力（聚合模式的项目清单来源）。 */
class FakeProjectGateway implements EngineGateway {
  registeredProjects: string[] = [];
  sessionsByProject: Record<string, EngineSessionSummary[]> = {};
  failures: Record<string, unknown> = {};
  activePathsByProject: Record<string, string[]> | null = null;

  listProjectPaths(): string[] {
    return this.registeredProjects;
  }

  async sessionsList(project: string): Promise<EngineSessionSummary[]> {
    const failure = this.failures[project];
    if (failure !== undefined) {
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    return this.sessionsByProject[project] ?? [];
  }

  async peekActiveSessionPaths(project: string): Promise<string[] | null> {
    if (this.activePathsByProject === null) return null;
    return this.activePathsByProject[project] ?? [];
  }

  async createSession(
    _project: string,
    _opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new ApiError(500, "internal", "not canned in this test file");
  }
  async messages(_id: string, _cursor?: string): Promise<EngineMessagesPage> {
    return { entries: [], leafId: "leaf-1", cursor: "leaf-1" };
  }
  async prompt(_id: string, _input: { text: string; images?: EnginePromptInput["images"]; model?: string }) {
    return { disposition: "started" };
  }
  async abort(): Promise<void> {}
  async permissionRespond(_id: string, _requestId: string, _reply: EnginePermissionReply): Promise<void> {}
  async usage(): Promise<EngineUsageStats> {
    throw new ApiError(500, "internal", "not canned in this test file");
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    return [];
  }
  async deleteSession(id: string): Promise<{ sessionPath: string; fileExisted: boolean }> {
    return { sessionPath: `/proj/${id}.jsonl`, fileExisted: true };
  }
  async exportSessionHtml(sessionId: string): Promise<{ html: string; row: EngineSessionSummary }> {
    throw new ApiError(404, "session_not_found", `会话不存在：${sessionId}`);
  }
  async forkSession(
    sessionId: string,
    _entryId: string,
    _position?: "before" | "at",
  ): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    throw new ApiError(404, "session_not_found", `会话不存在：${sessionId}`);
  }
  async restartProject(_project: string): Promise<void> {}
  async stopAll(): Promise<void> {}
}

function buildApp(engines: EngineGateway) {
  const meta = openMetaDb({ path: join(mkdtempSync(join(tmpdir(), "agg-meta-")), "meta.db") });
  const app = new Hono();
  app.route("/", createSessionRoutes({ meta, engines }));
  return { app, meta };
}

const req = (app: Hono, path: string, init?: RequestInit) => app.request(path, init);

/** 捕获 console.error（失败隔离的跳过日志断言用），返回还原函数与记录数组 */
function captureConsoleError(): { records: unknown[][]; restore: () => void } {
  const records: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    records.push(args);
  };
  return { records, restore: () => (console.error = original) };
}

// ---------------------------------------------------------------- 基线特征化（带 project，行为不变锚）

describe("GET /api/sessions 带 project（基线特征化）", () => {
  test("响应形状：{project:<路径>,archived,sessions}，行含合并字段与 active", async () => {
    const proj = mkdtempSync(join(tmpdir(), "agg-base-"));
    const engines = new FakeProjectGateway();
    engines.sessionsByProject[proj] = [
      summary({ id: "s1", path: `${proj}/s1.jsonl`, cwd: proj, modified: "2026-01-02T00:00:00.000Z" }),
    ];
    const { app } = buildApp(engines);
    const res = await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project).toBe(proj);
    expect(body.view).toBeUndefined(); // W3 todo 9：view 字段随参数一并移除
    expect(body.archived).toBe("false");
    expect(body.sessions).toHaveLength(1);
    const row = body.sessions[0];
    expect(row.id).toBe("s1");
    expect(row.path).toBe(`${proj}/s1.jsonl`);
    expect(row.project).toBe(proj);
    expect(row.pinned).toBe(false);
    expect(row.archivedAt).toBeNull();
    expect(row.unreadCount).toBe(0);
    expect(row.active).toBeNull(); // 引擎未就绪
    rmSync(proj, { recursive: true, force: true });
  });

  test("排序：置顶优先，其余 modified 降序（单项目内）", async () => {
    const proj = mkdtempSync(join(tmpdir(), "agg-base-"));
    const engines = new FakeProjectGateway();
    engines.sessionsByProject[proj] = [
      summary({ id: "old", path: `${proj}/old.jsonl`, cwd: proj, modified: "2026-01-01T00:00:00.000Z" }),
      summary({ id: "new", path: `${proj}/new.jsonl`, cwd: proj, modified: "2026-01-05T00:00:00.000Z" }),
      summary({ id: "mid", path: `${proj}/mid.jsonl`, cwd: proj, modified: "2026-01-03T00:00:00.000Z" }),
    ];
    const { app, meta } = buildApp(engines);
    meta.updateSessionMeta("old", { pinned: true });
    const body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["old", "new", "mid"]);
    rmSync(proj, { recursive: true, force: true });
  });

  test("列表含 fork、q 标题搜索、archived 三态", async () => {
    const proj = mkdtempSync(join(tmpdir(), "agg-base-"));
    const engines = new FakeProjectGateway();
    engines.sessionsByProject[proj] = [
      summary({ id: "top", path: `${proj}/top.jsonl`, cwd: proj, firstMessage: "Fix the login bug" }),
      summary({ id: "fork", path: `${proj}/fork.jsonl`, cwd: proj, parentSessionPath: `${proj}/top.jsonl` }),
    ];
    const { app, meta } = buildApp(engines);
    // 默认口径 = 原 view=all：fork 行在列（modified 同值保持插入序）
    let body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["top", "fork"]);

    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&q=login`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["top"]);

    meta.updateSessionMeta("top", { archivedAt: "2026-02-01T00:00:00.000Z" });
    // 默认 archived=false：归档的 top 隐藏，未归档的 fork 仍在列
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["fork"]);
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&archived=true`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["top"]);
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&archived=all`)).json();
    expect(body.sessions).toHaveLength(2);
    rmSync(proj, { recursive: true, force: true });
  });

  test("active：就绪时按 sessionPath 匹配（true/false）", async () => {
    const proj = mkdtempSync(join(tmpdir(), "agg-base-"));
    const engines = new FakeProjectGateway();
    engines.sessionsByProject[proj] = [
      summary({ id: "s1", path: `${proj}/s1.jsonl`, cwd: proj }),
      summary({ id: "s2", path: `${proj}/s2.jsonl`, cwd: proj }),
    ];
    engines.activePathsByProject = { [proj]: [`${proj}/s2.jsonl`] };
    const { app } = buildApp(engines);
    const body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`)).json();
    expect(body.sessions.find((s: { id: string }) => s.id === "s1").active).toBe(false);
    expect(body.sessions.find((s: { id: string }) => s.id === "s2").active).toBe(true);
    rmSync(proj, { recursive: true, force: true });
  });

  test("非法参数：project 不存在 → 400 project_not_found；archived 非法 → 400；view 已废弃被忽略（200）", async () => {
    const proj = mkdtempSync(join(tmpdir(), "agg-base-"));
    const engines = new FakeProjectGateway();
    const { app } = buildApp(engines);
    const missing = await req(app, `/api/sessions?project=${encodeURIComponent("/not/exist-agg")}`);
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("project_not_found");
    // accept-and-ignore：view=human/all/bogus 一律 200（存量客户端容忍）
    expect((await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&view=human`)).status).toBe(200);
    expect((await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&view=bogus`)).status).toBe(200);
    expect((await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&archived=bogus`)).status).toBe(400);
    rmSync(proj, { recursive: true, force: true });
  });

  test("tag 过滤：单标签命中已挂载会话，未挂载会话滤掉（todo 3 落地语义）", async () => {
    const proj = mkdtempSync(join(tmpdir(), "agg-base-"));
    const engines = new FakeProjectGateway();
    engines.sessionsByProject[proj] = [
      summary({ id: "s1", path: `${proj}/s1.jsonl`, cwd: proj }),
      summary({ id: "s2", path: `${proj}/s2.jsonl`, cwd: proj }),
    ];
    const { app, meta } = buildApp(engines);
    meta.setSessionTags("s1", [{ scope: "global", name: "work" }]);
    let body = await (
      await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&tag=work`)
    ).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s1"]);
    body = await (
      await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&tag=other`)
    ).json();
    expect(body.sessions).toEqual([]);
    rmSync(proj, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- 聚合模式（project 缺省）

describe("GET /api/sessions 聚合模式（project 缺省）", () => {
  function setupTwoProjects(): { p1: string; p2: string; engines: FakeProjectGateway } {
    const p1 = mkdtempSync(join(tmpdir(), "agg-p1-"));
    const p2 = mkdtempSync(join(tmpdir(), "agg-p2-"));
    const engines = new FakeProjectGateway();
    engines.registeredProjects = [p1, p2];
    engines.sessionsByProject[p1] = [
      summary({ id: "a1", path: `${p1}/a1.jsonl`, cwd: p1, modified: "2026-01-04T00:00:00.000Z" }),
      summary({ id: "a2", path: `${p1}/a2.jsonl`, cwd: p1, modified: "2026-01-01T00:00:00.000Z" }),
    ];
    engines.sessionsByProject[p2] = [
      summary({ id: "b1", path: `${p2}/b1.jsonl`, cwd: p2, modified: "2026-01-02T00:00:00.000Z" }),
    ];
    return { p1, p2, engines };
  }

  test("合并两项目 + project:null + 全局排序（pinned 跨项目优先，再 modified 降序）", async () => {
    const { p1, p2, engines } = setupTwoProjects();
    const { app, meta } = buildApp(engines);
    // a2 modified 最老但置顶 → 全局第一（排序在聚合层做，非组内）
    meta.updateSessionMeta("a2", { pinned: true });
    const res = await req(app, "/api/sessions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project).toBeNull();
    expect(body.archived).toBe("false");
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["a2", "a1", "b1"]);
    expect(body.sessions.every((s: { project: string }) => s.project === p1 || s.project === p2)).toBe(true);
    rmSync(p1, { recursive: true, force: true });
    rmSync(p2, { recursive: true, force: true });
  });

  test("q/archived 跨项目生效（列表含 p2 的 fork）", async () => {
    const { p1, p2, engines } = setupTwoProjects();
    engines.sessionsByProject[p2] = [
      summary({ id: "b1", path: `${p2}/b1.jsonl`, cwd: p2, modified: "2026-01-02T00:00:00.000Z" }),
      summary({ id: "bfork", path: `${p2}/bfork.jsonl`, cwd: p2, parentSessionPath: `${p2}/b1.jsonl`, modified: "2026-01-03T00:00:00.000Z" }),
    ];
    const { app } = buildApp(engines);
    // 默认口径 = 原 view=all：bfork 全局排序入列
    let body = await (await req(app, "/api/sessions")).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["a1", "bfork", "b1", "a2"]);

    // 存量客户端带 view=human：accept-and-ignore，聚合口径不变
    body = await (await req(app, "/api/sessions?view=human")).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["a1", "bfork", "b1", "a2"]);

    body = await (await req(app, `/api/sessions?q=${encodeURIComponent("hello")}`)).json();
    expect(body.sessions).toHaveLength(4); // 全部（含 bfork）firstMessage=hello

    body = await (await req(app, `/api/sessions?q=${encodeURIComponent("world")}`)).json();
    expect(body.sessions).toHaveLength(0);
    rmSync(p1, { recursive: true, force: true });
    rmSync(p2, { recursive: true, force: true });
  });

  test("单项目失败隔离：一项目 sessionsList 抛错 → 200，其余项目照常，跳过有日志", async () => {
    const { p1, p2, engines } = setupTwoProjects();
    engines.failures[p2] = new Error("store corrupted");
    const { app } = buildApp(engines);
    const { records, restore } = captureConsoleError();
    try {
      const res = await req(app, "/api/sessions");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.project).toBeNull();
      expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["a1", "a2"]);
      // misleading success 防护：失败项目有跳过日志且响应不含其会话，而非静默空
      expect(records.some((args) => args.join(" ").includes(p2))).toBe(true);
    } finally {
      restore();
    }
    rmSync(p1, { recursive: true, force: true });
    rmSync(p2, { recursive: true, force: true });
  });

  test("空注册表（无项目）→ 200 空聚合", async () => {
    const engines = new FakeProjectGateway();
    const { app } = buildApp(engines);
    const res = await req(app, "/api/sessions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project).toBeNull();
    expect(body.sessions).toEqual([]);
  });

  test("聚合模式 tag/archived/q 之外同样支持 active 探询（就绪项目标 true）", async () => {
    const { p1, p2, engines } = setupTwoProjects();
    engines.activePathsByProject = { [p2]: [`${p2}/b1.jsonl`] };
    const { app } = buildApp(engines);
    const body = await (await req(app, "/api/sessions")).json();
    expect(body.sessions.find((s: { id: string }) => s.id === "b1").active).toBe(true);
    expect(body.sessions.find((s: { id: string }) => s.id === "a1").active).toBe(false);
    rmSync(p1, { recursive: true, force: true });
    rmSync(p2, { recursive: true, force: true });
  });

  test("tag 过滤同样生效于聚合模式（跨项目命中挂载会话）", async () => {
    const { p1, p2, engines } = setupTwoProjects();
    const { app, meta } = buildApp(engines);
    meta.setSessionTags("b1", [{ scope: "project", name: "work" }]);
    const body = await (await req(app, "/api/sessions?tag=work")).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["b1"]);
    rmSync(p1, { recursive: true, force: true });
    rmSync(p2, { recursive: true, force: true });
  });

  test("hidden 项目过滤（A2 docs08-r3 todo 10）：聚合模式分组消失，单项目显式访问不过滤", async () => {
    const { p1, p2, engines } = setupTwoProjects();
    const { app, meta } = buildApp(engines);
    // 隐藏 p1：聚合只回 p2 会话；恢复后 p1 会话回归（软标记往返，数据零丢失）
    meta.updateProjectMeta(p1, { hidden: true });
    let body = await (await req(app, "/api/sessions")).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["b1"]);
    expect(body.sessions.every((s: { project: string }) => s.project === p2)).toBe(true);

    meta.updateProjectMeta(p1, { hidden: false });
    body = await (await req(app, "/api/sessions")).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["a1", "b1", "a2"]);

    // 单项目显式访问不过滤：隐藏项目的会话仍可按 project 参数直达
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(p1)}`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["a1", "a2"]);

    // 无 meta 行的项目（引擎清单有、库无注册行）视为未隐藏，照常聚合
    const p3 = mkdtempSync(join(tmpdir(), "agg-p3-"));
    engines.registeredProjects = [p1, p2, p3];
    engines.sessionsByProject[p3] = [
      summary({ id: "c1", path: `${p3}/c1.jsonl`, cwd: p3, modified: "2026-01-03T00:00:00.000Z" }),
    ];
    body = await (await req(app, "/api/sessions")).json();
    expect(body.sessions.some((s: { id: string }) => s.id === "c1")).toBe(true);
    rmSync(p1, { recursive: true, force: true });
    rmSync(p2, { recursive: true, force: true });
    rmSync(p3, { recursive: true, force: true });
  });
});
