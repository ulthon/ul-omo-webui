// REST API 路由单测（todo 9）：
// - 路径逃逸（../ 、绝对路径注入、符号链接逃逸）
// - 错误统一形状 {error:{code,message}}
// - 会话列表合并/过滤（fork 会话、archived、q、置顶排序、元数据合并）
// - 单驱动约束：回合中再次 prompt 409（真实 EngineProcessManager + fake 引擎连接）
import { describe, expect, test, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DATA_DIR } from "../src/config";
import { Hono } from "hono";
import {
  EngineRuntimeRegistry,
  permissionPresetArgs,
  permissionPresetKey,
  type EngineGateway,
} from "../src/api/engine-runtime";
import { EventBus } from "../src/engine/events";
import { setEventBus, sseRoutes } from "../src/api/sse";
import { createSessionRoutes, exportFilename } from "../src/api/routes-session";
import { createMetaRoutes } from "../src/api/routes-meta";
import { createCommandsRoutes } from "../src/api/routes-commands";
import { createProjectRoutes } from "../src/api/routes-project";
import { createGitRoutes } from "../src/api/routes-git";
import { createFsRoutes } from "../src/api/routes-fs";
import { openConfigStore } from "../src/conf/config-store";
import { createProjectConfigStores, permissionPresetSpawnArgs } from "../src/api/config-migration";
import { openMetaDb } from "../src/db/meta";
import { EngineProcessManager, type EngineClientLike, type RpcClientEvent, type RpcClientOptions } from "../src/engine/process-manager";
import type { ProcProbe } from "../src/engine/orphan-reaper";
import type {
  EngineCommandInfo,
  EngineMessagesPage,
  EngineModelInfo,
  EnginePermissionReply,
  EngineQuestionFrame,
  EnginePromptInput,
  EngineQueueSnapshot,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineUsageStats,
} from "../src/adapter/engine-adapter";
import { ApiError } from "../src/api/http";
import { agentDir as configAgentDir, engineRegistryPath, metaDbPath } from "../src/config";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

function fakeUsage(): EngineUsageStats {
  return {
    sessionId: "s1",
    sessionFile: "/proj/s1.jsonl",
    userMessages: 2,
    assistantMessages: 2,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 4,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
    cost: 0.01,
  };
}

class FakeGateway implements EngineGateway {
  sessions: EngineSessionSummary[] = [];
  promptError: unknown = null;
  promptDurableId: string | null = null;
  /** docs08-r6 任务 8 ②：非空时 prompt 回执携带 appliedModel（模拟 setModel 成功回模型行） */
  promptAppliedModel: string | null = null;
  promptCalls: Array<{
    id: string;
    input: { text: string; model?: string; thinkingLevel?: EngineThinkingLevel; streamingBehavior?: "steer" | "followUp" };
  }> = [];
  createdResults: Array<{ id: string; sessionPath: string; durable: boolean }> = [];
  deleted: string[] = [];
  activePaths: string[] | null = null;
  models: EngineModelInfo[] = [];
  queueListResult: EngineQueueSnapshot = { steering: [], followUp: [], ordered: [] };
  queueClearResult: EngineQueueSnapshot = { steering: [], followUp: [], ordered: [] };
  queueCalls: Array<{ op: "list" | "clear"; id: string }> = [];

  async sessionsList(): Promise<EngineSessionSummary[]> {
    return this.sessions;
  }
  async createSession(
    _project: string,
    _opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    const next = this.createdResults.shift();
    if (!next) throw new ApiError(500, "internal", "no canned create result");
    return next;
  }
  async messages(_id: string, _cursor?: string): Promise<EngineMessagesPage> {
    return { entries: [], leafId: "leaf-1", cursor: "leaf-1" };
  }
  async prompt(
    id: string,
    input: {
      text: string;
      images?: EnginePromptInput["images"];
      model?: string;
      thinkingLevel?: EngineThinkingLevel;
      streamingBehavior?: "steer" | "followUp";
    },
  ) {
    if (this.promptError) throw this.promptError;
    this.promptCalls.push({
      id,
      input: {
        text: input.text,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        streamingBehavior: input.streamingBehavior,
      },
    });
    const base = this.promptDurableId
      ? { disposition: "started", durableSessionId: this.promptDurableId }
      : { disposition: "started" };
    return this.promptAppliedModel ? { ...base, appliedModel: this.promptAppliedModel } : base;
  }
  async queueList(id: string): Promise<EngineQueueSnapshot> {
    this.queueCalls.push({ op: "list", id });
    return this.queueListResult;
  }
  async queueClear(id: string): Promise<EngineQueueSnapshot> {
    this.queueCalls.push({ op: "clear", id });
    return this.queueClearResult;
  }
  async abort(): Promise<void> {}
  permissionReplies: Array<{ id: string; requestId: string; reply: EnginePermissionReply }> = [];
  async permissionRespond(id: string, requestId: string, reply: EnginePermissionReply): Promise<void> {
    this.permissionReplies.push({ id, requestId, reply });
  }
  questionsResult: EngineQuestionFrame[] = [];
  questionsCalls: string[] = [];
  async questionsList(id: string): Promise<EngineQuestionFrame[]> {
    this.questionsCalls.push(id);
    return this.questionsResult;
  }
  async usage(): Promise<EngineUsageStats> {
    return fakeUsage();
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    return this.models;
  }
  commandsResults: Array<EngineCommandInfo[] | null> = [];
  commandsCalls: string[] = [];
  async commandsList(project: string): Promise<EngineCommandInfo[] | null> {
    this.commandsCalls.push(project);
    const next = this.commandsResults.shift();
    if (next === undefined) throw new ApiError(409, "no_active_session", "无活跃会话：先 openSession()");
    return next;
  }
  async deleteSession(id: string): Promise<{ sessionPath: string; fileExisted: boolean }> {
    this.deleted.push(id);
    return { sessionPath: `/proj/${id}.jsonl`, fileExisted: true };
  }
  exportCalls: string[] = [];
  exportResults: Array<{ html: string; row: EngineSessionSummary } | Error> = [];
  async exportSessionHtml(sessionId: string): Promise<{ html: string; row: EngineSessionSummary }> {
    this.exportCalls.push(sessionId);
    const next = this.exportResults.shift();
    if (!next) throw new ApiError(404, "session_not_found", `会话不存在：${sessionId}`);
    if (next instanceof Error) throw next;
    return next;
  }
  forkCalls: Array<{ sessionId: string; entryId: string; position?: "before" | "at" }> = [];
  forkResults: Array<{ id: string; sessionPath: string; durable: boolean; text: string } | Error> = [];
  async forkSession(
    sessionId: string,
    entryId: string,
    position?: "before" | "at",
  ): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    this.forkCalls.push({ sessionId, entryId, position });
    const next = this.forkResults.shift();
    if (!next) throw new ApiError(404, "session_not_found", `会话不存在：${sessionId}`);
    if (next instanceof Error) throw next;
    return next;
  }
  async peekActiveSessionPaths(): Promise<string[] | null> {
    return this.activePaths;
  }
  restarts: string[] = [];
  async restartProject(project: string): Promise<void> {
    this.restarts.push(project);
  }
  async stopAll(): Promise<void> {}
}

function buildApp(engines: EngineGateway, meta = openMetaDb({ path: join(mkdtempSync(join(tmpdir(), "routes-meta-")), "meta.db") })) {
  const app = new Hono();
  // todo 6：项目偏好合并读取需项目文件层——每例独立临时全局目录 + 项目 store 解析器
  const configs = openConfigStore({ globalDir: join(mkdtempSync(join(tmpdir(), "routes-cfg-")), "global") });
  const projectConfigs = createProjectConfigStores(configs);
  app.route("/", createSessionRoutes({ meta, engines, configs, projectConfigs }));
  app.route("/", createMetaRoutes({ meta, engines }));
  app.route("/", createCommandsRoutes({ meta, engines }));
  app.route("/", createProjectRoutes({ meta, engines, projectConfigs }));
  app.route("/", createGitRoutes({ meta, engines }));
  app.route("/", createFsRoutes({ meta, engines }));
  return { app, meta, projectConfigs };
}

const req = (app: Hono, path: string, init?: RequestInit) => app.request(path, init);

// ---------------------------------------------------------------- 路径逃逸

describe("fs 路径逃逸校验", () => {
  let proj: string;
  const cleanup: string[] = [];

  function setup(): void {
    proj = mkdtempSync(join(tmpdir(), "fs-escape-proj-"));
    cleanup.push(proj);
    writeFileSync(join(proj, "readme.txt"), "inside");
    mkdirSync(join(proj, "subdir"));
    writeFileSync(join(proj, "subdir", "inner.txt"), "inner");
    const outside = mkdtempSync(join(tmpdir(), "fs-escape-out-"));
    cleanup.push(outside);
    writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync(outside, join(proj, "out-link"));
  }

  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("../ 逃逸被拒绝（403 path_escape）", async () => {
    setup();
    const { app } = buildApp(new FakeGateway());
    const res = await req(app, `/api/fs/file?project=${encodeURIComponent(proj)}&path=${encodeURIComponent("../secret.txt")}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("path_escape");
  });

  test("绝对路径注入被中和（读不到 /etc/passwd，项目内不存在 → 404）", async () => {
    setup();
    const { app } = buildApp(new FakeGateway());
    const res = await req(app, `/api/fs/file?project=${encodeURIComponent(proj)}&path=${encodeURIComponent("/etc/passwd")}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  test("符号链接逃逸被拒绝（403 path_escape）", async () => {
    setup();
    const { app } = buildApp(new FakeGateway());
    const res = await req(app, `/api/fs/file?project=${encodeURIComponent(proj)}&path=${encodeURIComponent("out-link/secret.txt")}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("path_escape");
  });

  test("项目内文件可读，tree 列目录正常", async () => {
    setup();
    const { app } = buildApp(new FakeGateway());
    const file = await req(app, `/api/fs/file?project=${encodeURIComponent(proj)}&path=subdir/inner.txt`);
    expect(file.status).toBe(200);
    expect((await file.json()).content).toBe("inner");
    const tree = await req(app, `/api/fs/tree?project=${encodeURIComponent(proj)}`);
    expect(tree.status).toBe(200);
    const body = await tree.json();
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("subdir");
    expect(names).toContain("readme.txt");
    expect(names).toContain("out-link");
  });

  test("tree 的 ../ 逃逸同样被拒绝", async () => {
    setup();
    const { app } = buildApp(new FakeGateway());
    const res = await req(app, `/api/fs/tree?project=${encodeURIComponent(proj)}&path=${encodeURIComponent("..")}`);
    expect(res.status).toBe(403);
  });

  test("非法 project（相对路径/不存在）→ 400", async () => {
    const { app } = buildApp(new FakeGateway());
    const rel = await req(app, "/api/fs/tree?project=relative/path");
    expect(rel.status).toBe(400);
    const missing = await req(app, "/api/fs/tree?project=/definitely/not/exist-w2-9");
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("project_not_found");
  });
});

// ---------------------------------------------------------------- 会话列表合并与过滤

describe("GET /api/sessions 合并与过滤", () => {
  let proj: string;

  test("列表含 fork、q 标题搜索、archived 过滤、置顶排序、元数据合并", async () => {
    proj = mkdtempSync(join(tmpdir(), "routes-list-"));
    const engines = new FakeGateway();
    engines.sessions = [
      summary({ id: "s1", path: "/p/s1.jsonl", name: "Alpha", modified: "2026-01-03T00:00:00.000Z" }),
      summary({
        id: "s2",
        path: "/p/s2.jsonl",
        parentSessionPath: "/p/s1.jsonl",
        modified: "2026-01-02T00:00:00.000Z",
      }),
      summary({ id: "s3", path: "/p/s3.jsonl", firstMessage: "Fix the login bug", modified: "2026-01-01T00:00:00.000Z" }),
    ];
    const { app, meta } = buildApp(engines);
    meta.updateSessionMeta("s1", { renamedTitle: "重命名的标题", pinned: true });
    meta.updateSessionMeta("s3", { unreadCount: 5 });

    // 默认口径（W3 todo 9 起）= 原 view=all：fork 会话 s2 在列；置顶 s1 排最前
    const res = await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`);
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s1", "s2", "s3"]);
    const s1 = body.sessions[0];
    expect(s1.title).toBe("重命名的标题");
    expect(s1.pinned).toBe(true);
    const s2 = body.sessions[1];
    expect(s2.parentSessionPath).toBe("/p/s1.jsonl");
    expect(body.sessions[2].unreadCount).toBe(5);
    expect(body.sessions[2].title).toBe("Fix the login bug");

    // 存量客户端带 view=human/view=all：accept-and-ignore，返回同一全量列表
    for (const stale of ["human", "all"]) {
      const legacy = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&view=${stale}`)).json();
      expect(legacy.sessions.map((s: { id: string }) => s.id)).toEqual(["s1", "s2", "s3"]);
    }

    // q 搜索命中 renamed_title 与 firstMessage（标题级，消息内容搜索出范围）
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&q=` + encodeURIComponent("重命名"))).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s1"]);
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&q=login`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s3"]);

    // archived 过滤：默认不含归档；归档后 archived=true 可见（语义与移除前逐字节一致）
    meta.updateSessionMeta("s3", { archivedAt: "2026-02-01T00:00:00.000Z" });
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s1", "s2"]);
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&archived=true`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s3"]);

    // 非法参数：archived 仍 400；view 已废弃被忽略（200）
    expect((await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&archived=bogus`)).status).toBe(400);
    expect((await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&view=bogus`)).status).toBe(200);
    rmSync(proj, { recursive: true, force: true });
  });

  test("活跃标记：引擎未就绪为 null，就绪时按 sessionPath 匹配", async () => {
    proj = mkdtempSync(join(tmpdir(), "routes-list-"));
    const engines = new FakeGateway();
    engines.sessions = [summary({ id: "s1", path: "/p/s1.jsonl" })];
    const { app } = buildApp(engines);
    let body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`)).json();
    expect(body.sessions[0].active).toBeNull();
    engines.activePaths = ["/p/s1.jsonl"];
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`)).json();
    expect(body.sessions[0].active).toBe(true);
    rmSync(proj, { recursive: true, force: true });
  });

  test("runState 字段（docs08-r6 任务 11）：可选面就绪时行下发三态；缺席退回 active-only；未就绪 null", async () => {
    proj = mkdtempSync(join(tmpdir(), "routes-list-"));
    // 可选面缺席（旧 fake）：退回 peekActiveSessionPaths——active 照发，runState 恒 null
    const plain = new FakeGateway();
    plain.sessions = [summary({ id: "s1", path: "/p/s1.jsonl" })];
    plain.activePaths = ["/p/s1.jsonl"];
    const plainApp = buildApp(plain).app;
    let body = await (await req(plainApp, `/api/sessions?project=${encodeURIComponent(proj)}`)).json();
    expect(body.sessions[0]).toMatchObject({ active: true, runState: null });

    // 可选面在位：未就绪 null/null；就绪时流式中会话 waiting、其余行 idle
    class RunStateGateway extends FakeGateway {
      runStateMap: Map<string, "running" | "waiting" | "idle"> | null = null;
      peekRunStates = async (): Promise<Map<string, "running" | "waiting" | "idle"> | null> =>
        this.runStateMap;
    }
    const rich = new RunStateGateway();
    rich.sessions = [summary({ id: "s1", path: "/p/s1.jsonl" }), summary({ id: "s2", path: "/p/s2.jsonl" })];
    const { app } = buildApp(rich);
    const list = async (): Promise<{ sessions: Array<{ id: string; active: boolean | null; runState: string | null }> }> =>
      (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`)).json();
    body = await list();
    expect(body.sessions[0]).toMatchObject({ active: null, runState: null });
    rich.runStateMap = new Map([["/p/s1.jsonl", "waiting"]]);
    body = await list();
    expect(body.sessions.find((s: { id: string }) => s.id === "s1")).toMatchObject({ active: true, runState: "waiting" });
    expect(body.sessions.find((s: { id: string }) => s.id === "s2")).toMatchObject({ active: false, runState: "idle" });
    rmSync(proj, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- 会话操作与错误形状

describe("会话操作路由", () => {
  let proj: string;
  const cleanup: string[] = [];

  function setup(): void {
    proj = mkdtempSync(join(tmpdir(), "routes-sessions-"));
    cleanup.push(proj);
  }

  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("POST /api/sessions 建会话（模型默认取项目偏好）与非法项目 400", async () => {
    setup();
    const engines = new FakeGateway();
    engines.createdResults.push({ id: "d-1", sessionPath: `${proj}/x.jsonl`, durable: true });
    const { app, meta } = buildApp(engines);
    meta.updateProjectMeta(proj, { preferredModel: "zai-coding-cn/glm-5.3-flash" });

    const res = await req(app, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: proj }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session.id).toBe("d-1");
    expect(body.session.provider).toBe("zai-coding-cn");

    const bad = await req(app, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "/not/exist-w2-9" }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("project_not_found");

    const badModel = await req(app, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: proj, model: "no-slash" }),
    });
    expect(badModel.status).toBe(400);
    expect((await badModel.json()).error.code).toBe("invalid_model");

    // todo 6：偏好已迁至项目文件（库值清空仅文件有值）——建会话模型缺省从文件来
    engines.createdResults.push({ id: "d-2", sessionPath: `${proj}/y.jsonl`, durable: true });
    const patch = await req(app, "/api/projects/meta", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: proj, preferredModel: "zai-coding-cn/glm-5.3" }),
    });
    expect(patch.status).toBe(200);
    meta.updateProjectMeta(proj, { preferredModel: null });
    const fromFile = await req(app, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: proj }),
    });
    const fromFileBody = await fromFile.json();
    expect(fromFileBody.session.id).toBe("d-2");
    expect(fromFileBody.session.provider).toBe("zai-coding-cn");
    expect(fromFileBody.session.modelId).toBe("glm-5.3");
  });

  test("prompt：409 单驱动冲突映射、agent 降级说明、非法 text 400", async () => {
    const engines = new FakeGateway();
    const { app } = buildApp(engines);

    const res = await req(app, "/api/sessions/s1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", agent: "planner", model: "zai-coding-cn/glm-5.3-flash" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.streaming).toBe(true);
    expect(body.degradations.length).toBe(1);
    expect(engines.promptCalls[0].input.model).toBe("zai-coding-cn/glm-5.3-flash");

    engines.promptError = new ApiError(409, "already_processing", "冲突");
    const conflict = await req(app, "/api/sessions/s1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "again" }),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("already_processing");

    const empty = await req(app, "/api/sessions/s1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.code).toBe("invalid_text");
  });

  test("prompt appliedModel 透传（docs08-r6 任务 8 ②）：setModel 成功回模型行、未携带 model 缺省", async () => {
    const engines = new FakeGateway();
    engines.promptAppliedModel = "zai-coding-cn/glm-4.7";
    const { app } = buildApp(engines);

    const res = await req(app, "/api/sessions/s1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", model: "zai-coding-cn/glm-4.7" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.appliedModel).toBe("zai-coding-cn/glm-4.7");

    // 网关未回 appliedModel（未携带 model / 排队请求）：字段缺省不出现，非 null 占位
    engines.promptAppliedModel = null;
    const plain = await req(app, "/api/sessions/s1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "again" }),
    });
    expect(plain.status).toBe(200);
    expect("appliedModel" in (await plain.json())).toBe(false);
  });

  test("prompt thinkingLevel 透传（W2 todo 7）：合法下传网关、缺省 undefined、非法 400", async () => {
    const engines = new FakeGateway();
    const { app } = buildApp(engines);

    const res = await req(app, "/api/sessions/s1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "深度思考", thinkingLevel: "max" }),
    });
    expect(res.status).toBe(200);
    expect(engines.promptCalls[0].input.thinkingLevel).toBe("max");

    // 缺省 → undefined（不猜档位，引擎用会话缺省）
    await req(app, "/api/sessions/s1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "普通" }),
    });
    expect(engines.promptCalls[1].input.thinkingLevel).toBeUndefined();

    // null/空串同缺省；档位外取值 400（与 POST /api/sessions 同一惯例）
    await req(app, "/api/sessions/s1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "清空", thinkingLevel: null }),
    });
    expect(engines.promptCalls[2].input.thinkingLevel).toBeUndefined();

    const bad = await req(app, "/api/sessions/s1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", thinkingLevel: "off" }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_thinking_level");
    expect(engines.promptCalls.length).toBe(3);
  });

  test("prompt streamingBehavior 透传（docs08-r4 任务 11 排队）：合法下传网关、缺省 undefined、非法 400", async () => {
    const engines = new FakeGateway();
    const { app } = buildApp(engines);

    // 合法两档逐个透传（followUp 默认档 / steer 插入档）
    for (const behavior of ["followUp", "steer"] as const) {
      const res = await req(app, "/api/sessions/s1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "排队消息", streamingBehavior: behavior }),
      });
      expect(res.status).toBe(200);
      expect(engines.promptCalls.at(-1)?.input.streamingBehavior).toBe(behavior);
    }

    // 缺省 → undefined（普通发送，回合中由网关 409 守卫拦截）
    await req(app, "/api/sessions/s1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "普通" }),
    });
    expect(engines.promptCalls[2].input.streamingBehavior).toBeUndefined();

    // 档位外取值 400（与 parseThinkingLevel 同一惯例）
    const bad = await req(app, "/api/sessions/s1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", streamingBehavior: "interrupt" }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_streaming_behavior");
    expect(engines.promptCalls.length).toBe(3);
  });

  test("queue 快照与整队清空路由（docs08-r4 任务 11）：GET 对账 / DELETE 撤队返回被撤项", async () => {
    const engines = new FakeGateway();
    const { app } = buildApp(engines);

    engines.queueListResult = {
      steering: ["插入项"],
      followUp: ["跟答一", "跟答二"],
      ordered: [],
    };
    const list = await req(app, "/api/sessions/s1/queue", { method: "GET" });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      sessionId: "s1",
      steering: ["插入项"],
      followUp: ["跟答一", "跟答二"],
      ordered: [],
    });

    engines.queueClearResult = {
      steering: [],
      followUp: ["跟答一", "跟答二"],
      ordered: [
        { text: "跟答一", mode: "followUp", enqueueOrder: 3 },
        { text: "跟答二", mode: "followUp", enqueueOrder: 4 },
      ],
    };
    const clear = await req(app, "/api/sessions/s1/queue", { method: "DELETE" });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({ sessionId: "s1", ...engines.queueClearResult });
    expect(engines.queueCalls).toEqual([
      { op: "list", id: "s1" },
      { op: "clear", id: "s1" },
    ]);
  });

  test("prompt：别名会话落盘回执透传 durableSessionId（缺陷修复：新会话首条消息不显示）", async () => {
    const engines = new FakeGateway();
    const { app } = buildApp(engines);

    engines.promptDurableId = "d-real-1";
    const res = await req(app, "/api/sessions/holder-1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第一条" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("holder-1");
    expect(body.streaming).toBe(true);
    expect(body.durableSessionId).toBe("d-real-1");

    // 已落盘会话（网关不回 durableSessionId）响应不含该字段
    engines.promptDurableId = null;
    const plain = await req(app, "/api/sessions/d-1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第二条" }),
    });
    expect(plain.status).toBe(200);
    const plainBody = await plain.json();
    expect("durableSessionId" in plainBody).toBe(false);
  });

  test("meta patch（归档/置顶/重命名）与已读清零、草稿、删除", async () => {
    const engines = new FakeGateway();
    const { app, meta } = buildApp(engines);
    meta.updateSessionMeta("s9", { unreadCount: 3 });

    let res = await req(app, "/api/sessions/s9/meta", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true, archived: true, renamedTitle: "新名字" }),
    });
    expect(res.status).toBe(200);
    let metaRow = (await res.json()).meta;
    expect(metaRow.pinned).toBe(true);
    expect(metaRow.archivedAt).not.toBeNull();
    expect(metaRow.renamedTitle).toBe("新名字");

    // renamedTitle=null 恢复自动名；archived=false 取消归档
    res = await req(app, "/api/sessions/s9/meta", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: false, renamedTitle: null }),
    });
    metaRow = (await res.json()).meta;
    expect(metaRow.archivedAt).toBeNull();
    expect(metaRow.renamedTitle).toBeNull();

    res = await req(app, "/api/sessions/s9/read", { method: "POST" });
    metaRow = (await res.json()).meta;
    expect(metaRow.unreadCount).toBe(0);
    expect(metaRow.lastRead).not.toBeNull();

    await req(app, "/api/sessions/s9/draft", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "写一半的 prompt" }),
    });
    const draft = await (await req(app, "/api/sessions/s9/draft")).json();
    expect(draft.draft.content).toBe("写一半的 prompt");

    res = await req(app, "/api/sessions/s9", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted.fileExisted).toBe(true);
    expect(engines.deleted).toEqual(["s9"]);
    expect(meta.getSessionMeta("s9")).toBeNull();
    expect(meta.getDraft("s9")).toBeNull();
  });

  test("usage / messages / permission 请求形状", async () => {
    const engines = new FakeGateway();
    const { app } = buildApp(engines);
    const usage = await (await req(app, "/api/usage?session=s1")).json();
    expect(usage.usage.totalMessages).toBe(4);
    expect((await req(app, "/api/usage")).status).toBe(400);

    const messages = await (await req(app, "/api/sessions/s1/messages?cursor=leaf-0")).json();
    expect(messages.cursor).toBe("leaf-1");
    expect(messages.entries).toEqual([]);

    const perm = await req(app, "/api/sessions/s1/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r1", confirmed: true }),
    });
    expect(perm.status).toBe(200);
    const badPerm = await req(app, "/api/sessions/s1/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r1" }),
    });
    expect(badPerm.status).toBe(400);
  });

  test("question 应答与快照端点（q1 提问卡片）", async () => {
    const engines = new FakeGateway();
    const { app } = buildApp(engines);

    // answers + comment 形态透传（select/confirm 语义之外的 question 型）
    const answer = await req(app, "/api/sessions/s1/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "q-req-1",
        answers: { q1: { selected: ["staging"], text: "若可选灰度" } },
        comment: "尽快部署",
      }),
    });
    expect(answer.status).toBe(200);
    expect(engines.permissionReplies).toEqual([
      {
        id: "s1",
        requestId: "q-req-1",
        reply: { answers: { q1: { selected: ["staging"], text: "若可选灰度" } }, comment: "尽快部署" },
      },
    ]);

    // 异形 answers（selected 非字符串数组）被拒且不算有效应答项 → 400
    const badAnswers = await req(app, "/api/sessions/s1/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "q-req-2", answers: { q1: { selected: "staging" } } }),
    });
    expect(badAnswers.status).toBe(400);

    // GET questions：快照原样透出（含注入的 sessionId）
    engines.questionsResult = [
      {
        type: "extension_ui_request",
        method: "question",
        id: "q-req-1",
        sessionId: "s1",
        requestId: "call_x",
        toolCallId: "call_x",
        waitForAnswer: true,
        questions: [
          { id: "q1", header: "Deploy", question: "环境?", options: [{ label: "staging" }], multiSelect: false },
        ],
        timeout: 1800000,
        askedAtMs: 1,
        deadlineAtMs: 2,
        remainingMs: 3,
      },
    ];
    const qs = await (await req(app, "/api/sessions/s1/questions")).json();
    expect(engines.questionsCalls).toEqual(["s1"]);
    expect(qs.sessionId).toBe("s1");
    expect(qs.questions).toHaveLength(1);
    expect(qs.questions[0].id).toBe("q-req-1");
    expect(qs.questions[0].questions[0].multiSelect).toBe(false);
  });
});

// ---------------------------------------------------------------- 项目/元数据杂项路由

describe("项目与元数据杂项路由", () => {
  test("GET /api/projects 死项目守卫：目录被删/被文件顶替标 missing:true，其余条目不受影响", async () => {
    const alive = mkdtempSync(join(tmpdir(), "routes-missing-alive-"));
    const dead = mkdtempSync(join(tmpdir(), "routes-missing-dead-"));
    const { app, meta } = buildApp(new FakeGateway());
    try {
      // 直接写库模拟「注册过但目录随后消失」：绕过注册路径校验
      meta.updateProjectMeta(alive, { lastOpenedAt: "2026-01-02T00:00:00.000Z" });
      meta.updateProjectMeta(dead, { lastOpenedAt: "2026-01-01T00:00:00.000Z" });

      // shape 约定（only-on-missing）：目录可解析的条目不含 missing 字段
      const find = (rows: Array<Record<string, unknown>>, p: string): Record<string, unknown> => {
        const row = rows.find((r) => r.projectPath === p);
        if (!row) throw new Error(`project row not found: ${p}`);
        return row;
      };
      let list = await (await req(app, "/api/projects")).json();
      expect("missing" in find(list.projects, alive)).toBe(false);
      expect("missing" in find(list.projects, dead)).toBe(false);

      // 删除 dead 目录：该项 missing:true，其余字段原样（meta 仍在列表中，不静默剔除）
      rmSync(dead, { recursive: true, force: true });
      list = await (await req(app, "/api/projects")).json();
      const deadRow = find(list.projects, dead);
      expect(deadRow.missing).toBe(true);
      expect(deadRow.lastOpenedAt).toBe("2026-01-01T00:00:00.000Z");
      const aliveRow = find(list.projects, alive);
      expect("missing" in aliveRow).toBe(false);

      // 注册路径被同名文件顶替（realpath 可解析但 lstat 非目录）同样 missing
      writeFileSync(dead, "not a directory");
      list = await (await req(app, "/api/projects")).json();
      expect(find(list.projects, dead).missing).toBe(true);
    } finally {
      rmSync(alive, { recursive: true, force: true });
      rmSync(dead, { recursive: true, force: true });
    }
  });

  test("projects 注册/列表/偏好；非法路径 400", async () => {
    const proj = mkdtempSync(join(tmpdir(), "routes-proj-"));
    const { app } = buildApp(new FakeGateway());
    try {
      const res = await req(app, "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj }),
      });
      expect(res.status).toBe(200);
      const row = (await res.json()).project;
      expect(row.projectPath).toBe(proj);
      expect(row.lastOpenedAt).not.toBeNull();

      const list = await (await req(app, "/api/projects")).json();
      expect(list.projects).toHaveLength(1);

      const patch = await req(app, "/api/projects/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, preferredModel: "zai-coding-cn/glm-5.3-flash" }),
      });
      expect((await patch.json()).project.preferredModel).toBe("zai-coding-cn/glm-5.3-flash");

      const missing = await req(app, "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/definitely/missing-w2-9" }),
      });
      expect(missing.status).toBe(400);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("POST /api/projects create:true：mkdir -p 后注册；父级不可写 403；中段是文件 400；已存在幂等", async () => {
    const base = mkdtempSync(join(tmpdir(), "routes-create-"));
    const { app, meta } = buildApp(new FakeGateway());
    try {
      // 不存在的多级路径 → 递归建目录并注册，返回 realpath 形态
      const target = join(base, "a", "b", "new-proj");
      const res = await req(app, "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target, create: true }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).project.projectPath).toBe(target);
      expect(existsSync(target)).toBe(true);
      expect(meta.getProjectMeta(target)).not.toBeNull();

      // 尾部斜杠与 .. 规范化后等价（幂等注册同一路径）
      const again = await req(app, "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: `${target}/../new-proj/`, create: true }),
      });
      expect(again.status).toBe(200);
      expect((await again.json()).project.projectPath).toBe(target);

      // 已存在的空目录 + create:true → 直接注册（不 mkdir）
      const existing = join(base, "existing");
      mkdirSync(existing);
      const reg = await req(app, "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: existing, create: true }),
      });
      expect(reg.status).toBe(200);

      // 中段是文件 → 父级不是目录 400
      writeFileSync(join(base, "afile"), "x");
      const throughFile = await req(app, "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: join(base, "afile", "sub"), create: true }),
      });
      expect(throughFile.status).toBe(400);
      expect((await throughFile.json()).error.code).toBe("mkdir_failed");

      // 只读父级 → 403 mkdir_forbidden（root 绕过权限位，仅非 root 环境可断言；
      // root 下该目录 mkdir 会成功，此时跳过 403 断言只验证不炸）
      const readonly = join(base, "readonly");
      mkdirSync(readonly, { mode: 0o555 });
      const denied = await req(app, "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: join(readonly, "child"), create: true }),
      });
      if (typeof process.getuid === "function" && process.getuid() !== 0) {
        expect(denied.status).toBe(403);
        expect((await denied.json()).error.code).toBe("mkdir_forbidden");
      } else {
        expect([200, 403]).toContain(denied.status);
      }

      // 形状校验：非绝对路径/NUL → 400（create 分支同原口径）
      const rel = await req(app, "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "relative/path", create: true }),
      });
      expect(rel.status).toBe(400);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("DELETE /api/projects 注销：删注册行保留 meta_session，未注册 404，重复注销 404", async () => {
    const proj = mkdtempSync(join(tmpdir(), "routes-remove-"));
    const dead = mkdtempSync(join(tmpdir(), "routes-remove-dead-"));
    const { app, meta } = buildApp(new FakeGateway());
    try {
      meta.updateProjectMeta(proj, { lastOpenedAt: "2026-01-01T00:00:00.000Z" });
      meta.updateProjectMeta(dead, { lastOpenedAt: "2026-01-02T00:00:00.000Z" });
      meta.updateSessionMeta("s-keep", { pinned: true, renamedTitle: "保留名" });

      // 未注册路径 → 404 not_registered
      const unregistered = await req(app, "/api/projects", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/definitely/not-registered" }),
      });
      expect(unregistered.status).toBe(404);
      expect((await unregistered.json()).error.code).toBe("not_registered");

      // 形状校验：非绝对路径 → 400
      const bad = await req(app, "/api/projects", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "not-absolute" }),
      });
      expect(bad.status).toBe(400);

      // 死项目（目录已删，missing 主场景）：无存在性校验，照常可注销
      rmSync(dead, { recursive: true, force: true });
      const deadRes = await req(app, "/api/projects", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dead }),
      });
      expect(deadRes.status).toBe(200);
      expect(await deadRes.json()).toEqual({ path: dead, removed: true });

      // 活项目注销：注册行删除，meta_session 原样保留（置顶/改名不丢）
      const res = await req(app, "/api/projects", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ path: proj, removed: true });
      expect(meta.getProjectMeta(proj)).toBeNull();
      const kept = meta.getSessionMeta("s-keep");
      expect(kept?.pinned).toBe(true);
      expect(kept?.renamedTitle).toBe("保留名");
      const list = await (await req(app, "/api/projects")).json();
      expect(list.projects.find((p: { projectPath: string }) => p.projectPath === proj)).toBeUndefined();

      // 幂等语义（文档化决策）：重复注销按未注册处理，不做静默 200
      const again = await req(app, "/api/projects", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj }),
      });
      expect(again.status).toBe(404);
      expect((await again.json()).error.code).toBe("not_registered");
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(dead, { recursive: true, force: true });
    }
  });

  test("PUT /api/projects/hidden 软标记：往返/幂等/校验/GET 回显，meta_session 原样保留", async () => {
    const proj = mkdtempSync(join(tmpdir(), "routes-hidden-"));
    const dead = mkdtempSync(join(tmpdir(), "routes-hidden-dead-"));
    const { app, meta } = buildApp(new FakeGateway());
    try {
      meta.updateProjectMeta(proj, { lastOpenedAt: "2026-01-01T00:00:00.000Z" });
      meta.updateProjectMeta(dead, { lastOpenedAt: "2026-01-02T00:00:00.000Z" });
      meta.updateSessionMeta("s-keep", { pinned: true, renamedTitle: "保留名" });

      // 形状校验（malformed input）：非绝对路径 / 非布尔 hidden → 400
      const badPath = await req(app, "/api/projects/hidden", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "not-absolute", hidden: true }),
      });
      expect(badPath.status).toBe(400);
      expect((await badPath.json()).error.code).toBe("invalid_project");
      const badHidden = await req(app, "/api/projects/hidden", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, hidden: "yes" }),
      });
      expect(badHidden.status).toBe(400);
      expect((await badHidden.json()).error.code).toBe("invalid_hidden");
      const missingField = await req(app, "/api/projects/hidden", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj }),
      });
      expect(missingField.status).toBe(400);

      // 未注册路径 → 404 not_registered
      const unregistered = await req(app, "/api/projects/hidden", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/definitely/not-registered", hidden: true }),
      });
      expect(unregistered.status).toBe(404);
      expect((await unregistered.json()).error.code).toBe("not_registered");

      // 隐藏往返：GET 回显 hidden:true；meta_session 原样（软标记不碰置顶/改名）
      const hide = await req(app, "/api/projects/hidden", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, hidden: true }),
      });
      expect(hide.status).toBe(200);
      expect((await hide.json()).project).toMatchObject({ projectPath: proj, hidden: true });
      expect(meta.getSessionMeta("s-keep")?.renamedTitle).toBe("保留名");

      // 二次隐藏幂等：重复 PUT 同值不崩、确定性同结果
      const twice = await req(app, "/api/projects/hidden", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, hidden: true }),
      });
      expect(twice.status).toBe(200);
      expect((await twice.json()).project).toMatchObject({ hidden: true });

      // 死项目（missing）同样可标记（hidden+missing 组合场景入口）
      const deadRes = await req(app, "/api/projects/hidden", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dead, hidden: true }),
      });
      expect(deadRes.status).toBe(200);

      // GET /api/projects 全量列表回显 hidden 字段
      let list = await (await req(app, "/api/projects")).json();
      expect(list.projects.find((p: { projectPath: string }) => p.projectPath === proj).hidden).toBe(true);
      expect(list.projects.find((p: { projectPath: string }) => p.projectPath === proj).missing).toBeUndefined();

      // 恢复：PUT false → hidden:false
      const restore = await req(app, "/api/projects/hidden", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, hidden: false }),
      });
      expect(restore.status).toBe(200);
      expect((await restore.json()).project).toMatchObject({ hidden: false });
      list = await (await req(app, "/api/projects")).json();
      expect(list.projects.find((p: { projectPath: string }) => p.projectPath === proj).hidden).toBe(false);
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(dead, { recursive: true, force: true });
    }
  });

  test("POST /api/projects/restart 调用网关重建并校验路径", async () => {
    const proj = mkdtempSync(join(tmpdir(), "routes-restart-"));
    const engines = new FakeGateway();
    const { app } = buildApp(engines);
    try {
      const res = await req(app, "/api/projects/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: proj }),
      });
      expect(res.status).toBe(200);
      expect(engines.restarts).toEqual([proj]);
      const bad = await req(app, "/api/projects/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: "/definitely/missing-w2-preset" }),
      });
      expect(bad.status).toBe(400);
      expect(engines.restarts).toEqual([proj]);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("permissionPreset 预设：PATCH 校验合法档位、null 清除、列表与 meta 回显（todo 6 起写项目文件）", async () => {
    const proj = mkdtempSync(join(tmpdir(), "routes-preset-"));
    const { app, meta } = buildApp(new FakeGateway());
    const configFile = join(proj, ".ul-omo-webui.json");
    try {
      meta.updateProjectMeta(proj, { lastOpenedAt: new Date().toISOString() });

      // 合法档位写入项目文件并在 meta 与列表回显（kv 不再是写入目标）
      const set = await req(app, "/api/projects/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, permissionPreset: "read-only" }),
      });
      expect(set.status).toBe(200);
      expect((await set.json()).project.permissionPreset).toBe("read-only");
      expect(JSON.parse(readFileSync(configFile, "utf8")).permissionPreset).toBe("read-only");
      expect(meta.getKv(permissionPresetKey(proj))).toBeNull();
      const list = await (await req(app, "/api/projects")).json();
      expect(list.projects[0].permissionPreset).toBe("read-only");

      // null 清除 = 默认行为（文件字段显式 null，spawn 不加 --permission-preset）
      const clear = await req(app, "/api/projects/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, permissionPreset: null }),
      });
      expect((await clear.json()).project.permissionPreset).toBeNull();
      expect(JSON.parse(readFileSync(configFile, "utf8")).permissionPreset).toBeNull();

      // 非法档位 400 且不改文件（保持显式 null）
      const bad = await req(app, "/api/projects/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, permissionPreset: "yolo" }),
      });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.code).toBe("invalid_permission_preset");
      expect(JSON.parse(readFileSync(configFile, "utf8")).permissionPreset).toBeNull();
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("PATCH 拆分语义（todo 6）：偏好字段写文件、lastOpenedAt 写库，一次 PATCH 都生效", async () => {
    const proj = mkdtempSync(join(tmpdir(), "routes-patch-split-"));
    const { app, meta } = buildApp(new FakeGateway());
    try {
      meta.updateProjectMeta(proj, { lastOpenedAt: "2026-01-01T00:00:00.000Z" });
      const res = await req(app, "/api/projects/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: proj,
          preferredModel: "zai-coding-cn/glm-5.3",
          permissionPreset: "read-only",
          lastOpenedAt: "2026-02-02T00:00:00.000Z",
        }),
      });
      expect(res.status).toBe(200);
      const project = (await res.json()).project;
      expect(project.preferredModel).toBe("zai-coding-cn/glm-5.3");
      expect(project.permissionPreset).toBe("read-only");
      expect(project.lastOpenedAt).toBe("2026-02-02T00:00:00.000Z");
      // 文件源与库源各自落位
      const doc = JSON.parse(readFileSync(join(proj, ".ul-omo-webui.json"), "utf8"));
      expect(doc.preferredModel).toBe("zai-coding-cn/glm-5.3");
      expect(doc.permissionPreset).toBe("read-only");
      expect(meta.getProjectMeta(proj)?.preferredModel).toBeNull();
      expect(meta.getProjectMeta(proj)?.lastOpenedAt).toBe("2026-02-02T00:00:00.000Z");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("preferredThinkingLevel 写读回环（W2 todo 7）：PATCH 落文件、GET/PATCH 响应合并读、null 清除", async () => {
    const proj = mkdtempSync(join(tmpdir(), "routes-thinking-"));
    const { app, meta } = buildApp(new FakeGateway());
    try {
      // 先注册项目（合并读响应需 meta 行）
      meta.updateProjectMeta(proj, { lastOpenedAt: "2026-01-01T00:00:00.000Z" });
      // 写档位 → 文件落位 + 响应合并读
      const patch = await req(app, "/api/projects/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, preferredThinkingLevel: "high" }),
      });
      expect(patch.status).toBe(200);
      const project = (await patch.json()).project;
      expect(project.preferredThinkingLevel).toBe("high");
      const doc = JSON.parse(readFileSync(join(proj, ".ul-omo-webui.json"), "utf8"));
      expect(doc.preferredThinkingLevel).toBe("high");

      // GET 列表合并读同值
      const list = await (await req(app, "/api/projects")).json();
      expect(list.projects[0].preferredThinkingLevel).toBe("high");

      // null 清除 → 文件显式 null（合法），响应 null
      const clear = await req(app, "/api/projects/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, preferredThinkingLevel: null }),
      });
      expect(clear.status).toBe(200);
      expect((await clear.json()).project.preferredThinkingLevel).toBeNull();
      expect(JSON.parse(readFileSync(join(proj, ".ul-omo-webui.json"), "utf8")).preferredThinkingLevel).toBeNull();

      // 档位外取值 400；与 preferredModel 同时 PATCH 各自落位
      const bad = await req(app, "/api/projects/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, preferredThinkingLevel: "off" }),
      });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.code).toBe("invalid_preferred_thinking_level");

      const both = await req(app, "/api/projects/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, preferredModel: "zai-coding-cn/glm-5.3-flash", preferredThinkingLevel: "low" }),
      });
      expect(both.status).toBe(200);
      const bothBody = (await both.json()).project;
      expect(bothBody.preferredModel).toBe("zai-coding-cn/glm-5.3-flash");
      expect(bothBody.preferredThinkingLevel).toBe("low");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("过渡态回退（todo 6）：文件缺字段 + 库值未迁清 → GET/建会话以库值为准", async () => {
    const proj = mkdtempSync(join(tmpdir(), "routes-transition-"));
    const engines = new FakeGateway();
    engines.createdResults.push({ id: "d-t", sessionPath: `${proj}/x.jsonl`, durable: true });
    const { app, meta } = buildApp(engines);
    try {
      meta.updateProjectMeta(proj, { preferredModel: "zai-coding-cn/glm-5.3" });
      meta.setKv(permissionPresetKey(proj), "read-only");
      // 文件存在但无偏好字段（如已被 tags/snippets 写过的旧文件）
      writeFileSync(join(proj, ".ul-omo-webui.json"), JSON.stringify({ version: 1, tags: [] }));

      const list = await (await req(app, "/api/projects")).json();
      expect(list.projects[0].preferredModel).toBe("zai-coding-cn/glm-5.3");
      expect(list.projects[0].permissionPreset).toBe("read-only");
      expect(list.projects[0].configError).toBeUndefined();

      // 建会话模型缺省同样走过渡态库值
      const res = await req(app, "/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: proj }),
      });
      expect((await res.json()).session.provider).toBe("zai-coding-cn");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("文件损坏降级（todo 6 决策 10b）：单项目损坏 GET 仍 200（字段 null + configError），仅 lastOpenedAt 的 PATCH 不误报", async () => {
    const proj = mkdtempSync(join(tmpdir(), "routes-corrupt-"));
    const engines = new FakeGateway();
    engines.createdResults.push({ id: "d-c", sessionPath: `${proj}/x.jsonl`, durable: true });
    const { app, meta } = buildApp(engines);
    try {
      meta.updateProjectMeta(proj, { preferredModel: "zai-coding-cn/glm-5.3" });
      writeFileSync(join(proj, ".ul-omo-webui.json"), "{broken");

      // 单项目损坏：列表整体 200，该项目字段降级 null + configError 标志
      const list = await req(app, "/api/projects");
      expect(list.status).toBe(200);
      const row = (await list.json()).projects[0];
      expect(row.preferredModel).toBeNull();
      expect(row.permissionPreset).toBeNull();
      expect(row.configError).toBe(true);

      // 仅 lastOpenedAt：库写成功即 200，响应带 configError（不误报失败）
      const patch = await req(app, "/api/projects/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, lastOpenedAt: "2026-03-03T00:00:00.000Z" }),
      });
      expect(patch.status).toBe(200);
      const patched = (await patch.json()).project;
      expect(patched.lastOpenedAt).toBe("2026-03-03T00:00:00.000Z");
      expect(patched.configError).toBe(true);
      expect(meta.getProjectMeta(proj)?.lastOpenedAt).toBe("2026-03-03T00:00:00.000Z");

      // 显式写偏好字段：损坏 500 带文件路径（决策 10a），库值不动
      const strict = await req(app, "/api/projects/meta", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: proj, preferredModel: "zai-coding-cn/glm-5.3-flash" }),
      });
      expect(strict.status).toBe(500);
      expect((await strict.json()).error.message).toContain(".ul-omo-webui.json");
      expect(meta.getProjectMeta(proj)?.preferredModel).toBe("zai-coding-cn/glm-5.3");

      // 建会话模型缺省损坏降级 null = 引擎默认（不 500）
      const created = await req(app, "/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: proj }),
      });
      expect(created.status).toBe(201);
      expect((await created.json()).session.provider).toBeNull();
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("models 需已知项目；input-history 去重上限；settings 校验", async () => {
    const engines = new FakeGateway();
    engines.models = [{ provider: "zai-coding-cn", id: "glm-5.3-flash", reasoning: true }];
    const proj = mkdtempSync(join(tmpdir(), "routes-misc-"));
    const { app, meta } = buildApp(engines);
    try {
      const noProject = await req(app, "/api/models");
      expect(noProject.status).toBe(400);
      expect((await noProject.json()).error.code).toBe("no_project");

      meta.updateProjectMeta(proj, { lastOpenedAt: new Date().toISOString() });
      const models = await (await req(app, "/api/models")).json();
      expect(models.models).toHaveLength(1);
      expect(models.models[0].id).toBe("glm-5.3-flash");

      for (const text of ["a", "b", "a"]) {
        await req(app, "/api/input-history", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: proj, content: text }),
        });
      }
      let history = await (await req(app, `/api/input-history?project=${encodeURIComponent(proj)}`)).json();
      expect(history.items.map((i: { content: string }) => i.content)).toEqual(["a", "b"]);

      const badLimit = await req(app, `/api/input-history?project=${encodeURIComponent(proj)}&limit=999`);
      expect(badLimit.status).toBe(400);

      const badSettings = await req(app, "/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: 42 }),
      });
      expect(badSettings.status).toBe(400);
      const settings = await (
        await req(app, "/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ external_git_url: "https://git.example.com" }),
        })
      ).json();
      expect(settings.settings.external_git_url).toBe("https://git.example.com");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("models favorites：fake 未实现可选面降级空数组；实现则透传", async () => {
    const proj = mkdtempSync(join(tmpdir(), "routes-fav-"));
    try {
      // FakeGateway 未实现 favoriteModels（接口可选面）→ 路由层降级空数组
      const { app: appPlain, meta: metaPlain } = buildApp(new FakeGateway());
      metaPlain.updateProjectMeta(proj, { lastOpenedAt: new Date().toISOString() });
      const degraded = await (await req(appPlain, "/api/models")).json();
      expect(degraded.favorites).toEqual([]);

      class FavGateway extends FakeGateway {
        favoriteModels(): string[] {
          return ["zai-coding-cn/glm-5.3", "zai-coding-cn/glm-5.3-4k"];
        }
      }
      const { app: appFav, meta: metaFav } = buildApp(new FavGateway());
      metaFav.updateProjectMeta(proj, { lastOpenedAt: new Date().toISOString() });
      const passed = await (await req(appFav, "/api/models")).json();
      expect(passed.favorites).toEqual(["zai-coding-cn/glm-5.3", "zai-coding-cn/glm-5.3-4k"]);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("models defaults：fake 未实现可选面降级 null；实现则透传（docs08-r5 任务 2）", async () => {
    const proj = mkdtempSync(join(tmpdir(), "routes-default-"));
    try {
      // FakeGateway 未实现 defaultModel（接口可选面）→ 路由层降级 null
      const { app: appPlain, meta: metaPlain } = buildApp(new FakeGateway());
      metaPlain.updateProjectMeta(proj, { lastOpenedAt: new Date().toISOString() });
      const degraded = await (await req(appPlain, "/api/models")).json();
      expect(degraded.defaults).toBeNull();

      class DefaultGateway extends FakeGateway {
        defaultModel() {
          return { provider: "zai-coding-cn", model: "glm-5.3-4k", thinkingLevel: "max" };
        }
      }
      const { app: appDefault, meta: metaDefault } = buildApp(new DefaultGateway());
      metaDefault.updateProjectMeta(proj, { lastOpenedAt: new Date().toISOString() });
      const passed = await (await req(appDefault, "/api/models")).json();
      expect(passed.defaults).toEqual({ provider: "zai-coding-cn", model: "glm-5.3-4k", thinkingLevel: "max" });
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("git status/diff：非仓库 409、仓库解析 porcelain 条目", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "routes-git-"));
    const repo = mkdtempSync(join(tmpdir(), "routes-git-"));
    const { app } = buildApp(new FakeGateway());
    try {
      const notRepo = await req(app, `/api/git/status?project=${encodeURIComponent(nonRepo)}`);
      expect(notRepo.status).toBe(409);
      expect((await notRepo.json()).error.code).toBe("not_a_git_repo");

      const run = (args: string[]) => spawnSync(args[0], args.slice(1), { cwd: repo });
      run(["git", "init", "-q"]);
      run(["git", "config", "user.email", "t@t"]);
      run(["git", "config", "user.name", "t"]);
      writeFileSync(join(repo, "tracked.txt"), "x\n");
      run(["git", "add", "tracked.txt"]);
      run(["git", "commit", "-qm", "init"]);
      writeFileSync(join(repo, "tracked.txt"), "changed\n");
      writeFileSync(join(repo, "untracked.txt"), "new\n");

      const status = await (await req(app, `/api/git/status?project=${encodeURIComponent(repo)}`)).json();
      const paths = status.entries.map((e: { path: string }) => e.path).sort();
      expect(paths).toEqual(["tracked.txt", "untracked.txt"]);

      const diff = await (await req(app, `/api/git/diff?project=${encodeURIComponent(repo)}`)).json();
      expect(diff.diff).toContain("+changed");
      expect(diff.truncated).toBe(false);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- 导出与 fork（todo 25）

describe("导出与 fork 路由", () => {
  test("exportFilename：非法字符清洗、中文回退 ascii、空标题回退 id", () => {
    // 路径分隔符与非法字符清洗
    expect(exportFilename('a/b\\c:d*e?f"g<h>i|j', "sid")).toEqual({
      ascii: "a b c d e f g h i j.html",
      utf8: "a b c d e f g h i j.html",
    });
    // 首尾点/空格剥离、控制字符、长度截断
    const dotted = exportFilename("  ..hidden name..  ", "sid");
    expect(dotted.utf8).toBe("hidden name.html");
    // 中文标题：utf8 保留，ascii 回退 id 前缀
    const zh = exportFilename("季度总结报告", "12345678-9abc");
    expect(zh.utf8).toBe("季度总结报告.html");
    expect(zh.ascii).toBe("12345678.html");
    // 空标题回退 id
    expect(exportFilename("", "abc").utf8).toBe("abc.html");
  });

  test("导出：200 HTML + Content-Disposition 附件（utf8 文件名）", async () => {
    const engines = new FakeGateway();
    engines.exportResults.push({
      html: "<html><body>会话内容</body></html>",
      row: summary({ id: "s1", path: "/proj/s1.jsonl", name: "冒烟会话" }),
    });
    const { app } = buildApp(engines);
    const res = await req(app, "/api/sessions/s1/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("冒烟会话.html")}`);
    expect(await res.text()).toBe("<html><body>会话内容</body></html>");
    expect(engines.exportCalls).toEqual(["s1"]);
  });

  test("导出：会话不存在 404、未落盘 409（错误形状统一）", async () => {
    const { app } = buildApp(new FakeGateway());
    const missing = await req(app, "/api/sessions/nope/export");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("session_not_found");

    const engines = new FakeGateway();
    engines.exportResults.push(new ApiError(409, "session_not_persisted", "会话尚未落盘（空会话），无法导出"));
    const { app: app2 } = buildApp(engines);
    const empty = await req(app2, "/api/sessions/s-empty/export");
    expect(empty.status).toBe(409);
    expect((await empty.json()).error.code).toBe("session_not_persisted");
  });

  test("fork：200 返回新会话身份与原文，position 透传", async () => {
    const engines = new FakeGateway();
    engines.forkResults.push({
      id: "fork-1",
      sessionPath: "/proj/fork-1.jsonl",
      durable: true,
      text: "原始提问",
    });
    const { app } = buildApp(engines);
    const res = await req(
      app,
      "/api/sessions/s1/fork",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryId: "entry-u1", position: "before" }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      session: { id: "fork-1", sessionPath: "/proj/fork-1.jsonl", durable: true },
      text: "原始提问",
    });
    expect(engines.forkCalls).toEqual([{ sessionId: "s1", entryId: "entry-u1", position: "before" }]);

    // 缺省 position 透传 undefined（gateway 层默认 before）
    engines.forkResults.push({ id: "fork-2", sessionPath: "/proj/fork-2.jsonl", durable: false, text: "" });
    await req(app, "/api/sessions/s1/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "entry-u2" }),
    });
    expect(engines.forkCalls[1]).toEqual({ sessionId: "s1", entryId: "entry-u2", position: undefined });
  });

  test("fork：缺 entryId 400、非法 position 400、gateway 409 透传", async () => {
    const { app } = buildApp(new FakeGateway());
    const noEntry = await req(app, "/api/sessions/s1/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noEntry.status).toBe(400);
    expect((await noEntry.json()).error.code).toBe("invalid_entry");

    const badPos = await req(app, "/api/sessions/s1/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "e1", position: "middle" }),
    });
    expect(badPos.status).toBe(400);
    expect((await badPos.json()).error.code).toBe("invalid_position");

    const engines = new FakeGateway();
    engines.forkResults.push(new ApiError(409, "already_processing", "该项目有进行中的回合"));
    const { app: app2 } = buildApp(engines);
    const busy = await req(app2, "/api/sessions/s1/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "e1" }),
    });
    expect(busy.status).toBe(409);
    expect((await busy.json()).error.code).toBe("already_processing");
  });
});

// ---------------------------------------------------------------- 运行时单驱动（真实管理器 + fake 引擎连接）

/** fake 引擎连接：EngineClientLike（管理器面）+ RpcClient 会话命令面（adapter 包装目标）。 */
class FakeEngineClient implements EngineClientLike {
  static nextPid = 9000;
  readonly spawnOpts: RpcClientOptions;
  process: { pid: number };
  readonly listeners: Array<(e: RpcClientEvent) => void> = [];
  durableSessionId: string | undefined = "durable-1";
  readonly prompts: string[] = [];
  readonly modelSwitches: Array<{ provider: string; modelId: string }> = [];
  closed = 0;
  /** get_state 的 isStreaming 返回值（收尾监视测试用） */
  fakeStreaming = false;
  /** get_state 的 pendingQuestions 返回值（runState 三态推导测试用） */
  fakePendingQuestions: Array<Record<string, unknown>> = [];
  /** getState 调用计数（runState 推导 over-fetch 断言用：无回合时零 get_state） */
  stateCalls = 0;
  /** stop() 时的旁路钩子（测试模拟进程随 stop 退出：从探针摘除 pid）。 */
  onStop?: () => void;

  constructor(opts: RpcClientOptions) {
    this.spawnOpts = opts;
    this.process = { pid: ++FakeEngineClient.nextPid };
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.onStop?.();
  }
  onEvent(listener: (e: RpcClientEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  getStderr(): string {
    return "";
  }
  async send(
    // oxlint-disable-next-line no-unused-vars -- fake 实现按 EngineClientLike 签名收参：fake 不消费 payload
    message: unknown,
  ): Promise<{ success: boolean; data: unknown }> {
    return { success: true, data: { engineVersion: "fake" } };
  }
  emit(event: Record<string, unknown>): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- 迭代期快照：监听器在回调内增删不得影响本次遍历
    for (const l of [...this.listeners]) l(event as RpcClientEvent);
  }
  async setClientInfo(): Promise<void> {}
  async openSession(options: { sessionPath?: string }): Promise<{
    sessionId: string;
    state: { sessionId: string; sessionFile?: string };
  }> {
    return {
      sessionId: "routing-1",
      state: { sessionId: "holder-1", sessionFile: options.sessionPath ?? `${this.spawnOpts.cwd}/sessions/2026_new.jsonl` },
    };
  }
  async closeSession(): Promise<void> {
    this.closed++;
  }
  async listSessions(): Promise<Array<Record<string, unknown>>> {
    const sessionPath = `${this.spawnOpts.cwd}/sessions/2026_new.jsonl`;
    const row: Record<string, unknown> = {
      sessionId: "routing-1",
      sessionPath,
      cwd: this.spawnOpts.cwd,
      status: "open",
    };
    if (this.durableSessionId !== undefined) row.durableSessionId = this.durableSessionId;
    return [row];
  }
  async getEntries(_since?: string): Promise<{ entries: never[]; leafId: string | null }> {
    return { entries: [], leafId: "leaf-1" };
  }
  async prompt(message: string): Promise<string> {
    this.prompts.push(message);
    return "started";
  }
  async abort(): Promise<void> {}
  async sendExtensionUIResponse(): Promise<void> {}
  async getAvailableModels(): Promise<never[]> {
    return [];
  }
  async getAvailableThinkingLevels(): Promise<string[]> {
    return ["low"];
  }
  async getState(): Promise<Record<string, unknown>> {
    this.stateCalls += 1;
    return { isStreaming: this.fakeStreaming, messageCount: 2, pendingQuestions: this.fakePendingQuestions };
  }
  async getSessionStats(): Promise<Record<string, unknown>> {
    return {
      sessionId: "holder-1",
      sessionFile: "x.jsonl",
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      cost: 0,
    };
  }
  async getMedia(): Promise<{ type: "image"; data: string; mimeType: string }> {
    throw new Error("not implemented");
  }
  async setModel(provider: string, modelId: string): Promise<unknown> {
    this.modelSwitches.push({ provider, modelId });
    return { provider, id: modelId };
  }
}

/** 内存进程探针：PID 存在于 map 即存活 */
class StaticProbe implements ProcProbe {
  readonly pids = new Set<number>();
  readonly signals: Array<{ pid: number; sig: string }> = [];
  alive(pid: number): boolean {
    return this.pids.has(pid);
  }
  cwd(): string | undefined {
    return undefined;
  }
  argv(): string[] | undefined {
    return undefined;
  }
  listPids(): number[] {
    return [...this.pids];
  }
  signal(pid: number): void {
    this.signals.push({ pid, sig: "SIGKILL" });
    this.pids.delete(pid);
  }
  async sleep(ms: number): Promise<void> {
    await sleep(Math.min(ms, 5));
  }
}

describe("EngineRuntimeRegistry 单驱动与 durable id", () => {
  let proj: string;
  let client: FakeEngineClient;
  let probe: StaticProbe;
  let manager: EngineProcessManager;
  let registry: EngineRuntimeRegistry;
  let syntheticEvents: Array<{ projectPath: string; event: Record<string, unknown> }>;
  let unreadCalls: Array<{ projectPath: string; durableSessionId: string }>;

  function setup(durableSessionId: string | undefined): void {
    proj = mkdtempSync(join(tmpdir(), "runtime-proj-"));
    mkdirSync(join(proj, "sessions"), { recursive: true });
    client = new FakeEngineClient({ cwd: proj } as RpcClientOptions);
    client.durableSessionId = durableSessionId;
    // 默认流式中：收尾监视见到 isStreaming=true 不合成（需要空闲的测试显式置 false）
    client.fakeStreaming = true;
    probe = new StaticProbe();
    probe.pids.add(client.process.pid);
    syntheticEvents = [];
    unreadCalls = [];
    manager = new EngineProcessManager({
      // 每次启动把 pid 放回探针（重启场景模拟进程重新出现）
      clientFactory: () => {
        probe.pids.add(client.process.pid);
        return client;
      },
      probe,
      registryPath: join(proj, "registry.json"),
      readyProbeIntervalMs: 1,
      readyProbeMaxAttempts: 10,
      crashPollMs: 60_000,
    });
    registry = new EngineRuntimeRegistry(manager, {
      listProjects: () => [proj],
      agentDir: proj,
      settlePollMs: 30,
      settleGraceMs: 80,
      publishSyntheticEvent: (projectPath, event) => syntheticEvents.push({ projectPath, event }),
      recordUnread: (projectPath, durableSessionId) => unreadCalls.push({ projectPath, durableSessionId }),
    });
  }

  afterEach(async () => {
    probe.pids.clear(); // 让 stopAll 的 waitForExit 立即见到进程退出，不空等宽限
    await registry.stopAll();
    rmSync(proj, { recursive: true, force: true });
  });

  test("createSession 解析 durable id；回合中重复 prompt 409；agent_end 解除", async () => {
    setup("durable-1");
    const created = await registry.createSession(proj, {});
    // createSession 走 open_session 新会话路径，sessionFile 为 fake 的缺省新路径
    expect(created.sessionPath).toContain("2026_new.jsonl");
    expect(created.durable).toBe(true);
    // handle→durable 映射：wire 事件 sessionId（routing-1）可解析为磁盘 header id
    expect(registry.durableSessionIdFor(proj, "routing-1")).toBe("durable-1");
    expect(registry.durableSessionIdFor(proj, "unknown-handle")).toBeUndefined();

    const r1 = await registry.prompt(created.id, { text: "第一问" });
    expect(r1.disposition).toBe("started");
    expect(client.prompts).toEqual(["第一问"]);

    let conflict: unknown = null;
    try {
      await registry.prompt(created.id, { text: "第二问" });
    } catch (err) {
      conflict = err;
    }
    expect(conflict).toBeInstanceOf(ApiError);
    expect((conflict as ApiError).status).toBe(409);
    expect((conflict as ApiError).code).toBe("already_processing");
    expect(client.prompts).toEqual(["第一问"]);

    // 回合结束信号解除单驱动
    client.emit({ type: "agent_end", sessionId: "routing-1" });
    const r3 = await registry.prompt(created.id, { text: "第三问" });
    expect(r3.disposition).toBe("started");
    expect(client.prompts).toEqual(["第一问", "第三问"]);
    // r3 又开启回合，结束后再验证带模型切换的 prompt
    client.emit({ type: "agent_settled", sessionId: "routing-1" });
    await registry.prompt(created.id, { text: "换模型", model: "zai-coding-cn/glm-5.3-flash" });
    expect(client.modelSwitches).toEqual([{ provider: "zai-coding-cn", modelId: "glm-5.3-flash" }]);
  });

  test("messages/usage 作用于目标会话；deleteSession 删文件并解除活跃", async () => {
    setup("durable-1");
    const created = await registry.createSession(proj, {});
    const page = await registry.messages(created.id);
    expect(page.leafId).toBe("leaf-1");
    const usage = await registry.usage(created.id);
    expect(usage.totalMessages).toBe(2);

    const sessionFile = created.sessionPath;
    writeFileSync(sessionFile, "{}\n");
    // (d) 回归：open_session 预建的 artifacts 目录随会话一并清理
    const artifactsDir = sessionFile.replace(/\.jsonl$/, "") + "-artifacts";
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "blob.bin"), "x");
    const removed = await registry.deleteSession(created.id);
    expect(removed.fileExisted).toBe(true);
    expect(removed.sessionPath).toBe(sessionFile);
    expect(existsSync(sessionFile)).toBe(false);
    expect(existsSync(artifactsDir)).toBe(false);
    expect(client.closed).toBeGreaterThanOrEqual(1);
  });

  test("未落盘新会话：durableSessionId 缺失时用 holder 别名（不持久化），仍可 prompt", async () => {
    setup(undefined);
    const created = await registry.createSession(proj, {});
    expect(created.durable).toBe(false);
    expect(created.id).toBe("holder-1");
    // 别名不是 durable 身份：handle 映射不记录（SSE 如实透传不猜）
    expect(registry.durableSessionIdFor(proj, "routing-1")).toBeUndefined();
    const r = await registry.prompt(created.id, { text: "别名追问" });
    expect(r.disposition).toBe("started");
    expect(client.prompts).toEqual(["别名追问"]);
  });

  test("(c) active 语义 = 回合进行中：settled 事件清位", async () => {
    setup("durable-1");
    const created = await registry.createSession(proj, {});
    await registry.prompt(created.id, { text: "第一问" });
    // 回合进行中：active 命中该会话路径
    expect(await registry.peekActiveSessionPaths(proj)).toEqual([created.sessionPath]);
    // 真实收尾事件：清位且不触发合成
    client.emit({ type: "agent_end", sessionId: "routing-1" });
    expect(await registry.peekActiveSessionPaths(proj)).toEqual([]);
    await sleep(200); // 越过轮询+宽限窗口
    expect(syntheticEvents).toEqual([]);
  });

  test("(r6-11) peekRunStates 三态推导：running / 权限 waiting / 提问 waiting / 落定空表 / 未就绪 null", async () => {
    setup("durable-1");
    // 未就绪（无运行时）：null——peek 语义不触发 spawn
    expect(await registry.peekRunStates(proj)).toBeNull();
    const created = await registry.createSession(proj, {});
    // 就绪且无回合：空表（未入表 = idle，行级 idle 由路由层补）；且零 get_state——
    // 列表刷新不加常态 RPC（over-fetch 纪律）
    expect(await registry.peekRunStates(proj)).toEqual(new Map());
    expect(client.stateCalls).toBe(0);
    await registry.prompt(created.id, { text: "第一问" });
    // streaming 占用、无权限无提问 → running
    expect(await registry.peekRunStates(proj)).toEqual(new Map([[created.sessionPath, "running"]]));
    // 权限挂起（项目级 pendingPermissions 记账，wire 事件驱动）→ waiting
    client.emit({ type: "extension_ui_request", method: "confirm", id: "perm-1", sessionId: "routing-1" });
    expect(await registry.peekRunStates(proj)).toEqual(new Map([[created.sessionPath, "waiting"]]));
    // 应答落定（reportPermissionAnswered 清账）→ 回 running
    await registry.permissionRespond(created.id, "perm-1", { confirmed: true });
    expect(await registry.peekRunStates(proj)).toEqual(new Map([[created.sessionPath, "running"]]));
    // 阻塞型提问挂起（get_state pendingQuestions 非空）→ waiting
    client.fakePendingQuestions = [{ type: "extension_ui_request", method: "question", id: "q-1" }];
    expect(await registry.peekRunStates(proj)).toEqual(new Map([[created.sessionPath, "waiting"]]));
    // 回合落定 → 空表
    client.emit({ type: "agent_end", sessionId: "routing-1" });
    expect(await registry.peekRunStates(proj)).toEqual(new Map());
  });

  test("(a) 收尾事件缺席 + get_state 空闲 → 宽限后合成 agent_settled（synthetic:true）", async () => {
    setup("durable-1");
    const created = await registry.createSession(proj, {});
    await registry.prompt(created.id, { text: "只回复：好" });
    // 引擎实际已空闲（get_state isStreaming=false）但收尾事件永不到来
    client.fakeStreaming = false;
    // 轮询 30ms + 宽限 80ms，留裕量
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && syntheticEvents.length === 0) {
      await sleep(20);
    }
    expect(syntheticEvents).toHaveLength(1);
    const { projectPath, event } = syntheticEvents[0];
    expect(projectPath).toBe(proj);
    expect(event.type).toBe("agent_settled");
    expect(event.synthetic).toBe(true);
    // 合成事件 sessionId = durable id（前端信封回退路径直接可路由）
    expect(event.sessionId).toBe(created.id);
    // 合成后 active 清位（僵尸流式态消除）
    expect(await registry.peekActiveSessionPaths(proj)).toEqual([]);
    // 引擎仍在流式（get_state isStreaming=true）时不合成
    setup("durable-1");
    const c2 = await registry.createSession(proj, {});
    await registry.prompt(c2.id, { text: "第二问" });
    client.fakeStreaming = true;
    await sleep(250);
    expect(syntheticEvents).toHaveLength(0);
  });

  test("(a-2) 流式中引擎崩溃 → 合成 agent_settled（engine_crash）+ 清位 + 可继续 prompt", async () => {
    // 独立 manager：crashPoll 1ms 快速检出（setup 默认 60s 抑制崩溃检测）
    proj = mkdtempSync(join(tmpdir(), "runtime-proj-"));
    mkdirSync(join(proj, "sessions"), { recursive: true });
    client = new FakeEngineClient({ cwd: proj } as RpcClientOptions);
    client.durableSessionId = "durable-1";
    client.fakeStreaming = true;
    probe = new StaticProbe();
    probe.pids.add(client.process.pid);
    syntheticEvents = [];
    unreadCalls = [];
    const crashManager = new EngineProcessManager({
      clientFactory: () => {
        probe.pids.add(client.process.pid);
        return client;
      },
      probe,
      registryPath: join(proj, "registry.json"),
      readyProbeIntervalMs: 1,
      readyProbeMaxAttempts: 10,
      crashPollMs: 1,
      backoffBaseMs: 5,
    });
    registry = new EngineRuntimeRegistry(crashManager, {
      listProjects: () => [proj],
      agentDir: proj,
      publishSyntheticEvent: (projectPath, event) => syntheticEvents.push({ projectPath, event }),
      recordUnread: (projectPath, durableSessionId) => unreadCalls.push({ projectPath, durableSessionId }),
    });

    const created = await registry.createSession(proj, {});
    await registry.prompt(created.id, { text: "长任务" });
    expect(await registry.peekActiveSessionPaths(proj)).toEqual([created.sessionPath]);
    // 模拟 kill -9：进程从探针消失 → crashPoll 检出 process_crashed → crashSettle
    probe.pids.delete(client.process.pid);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && syntheticEvents.length === 0) {
      await sleep(10);
    }
    expect(syntheticEvents).toHaveLength(1);
    const { projectPath, event } = syntheticEvents[0];
    expect(projectPath).toBe(proj);
    expect(event.type).toBe("agent_settled");
    expect(event.synthetic).toBe(true);
    expect(event.reason).toBe("engine_crash");
    expect(event.sessionId).toBe(created.id);
    // active 清位（重启窗口期 peek 引擎未就绪返回 null 也属预期语义）
    expect(await registry.peekActiveSessionPaths(proj)).toEqual([]);
    // 真实场景会话已落盘：写最小 jsonl（header id=durable-1）供 store 扫描重解析
    //（invalidate 清空了内存索引，durable id 靠磁盘 jsonl 找回）
    const encode = (cwd: string) => `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`;
    const storeDir = join(proj, "sessions", encode(proj));
    mkdirSync(storeDir, { recursive: true });
    const persistedPath = join(storeDir, "2026-10-07T01-00-00-000Z_durable-1.jsonl");
    writeFileSync(
      persistedPath,
      `${JSON.stringify({ type: "session", version: 3, id: created.id, cwd: proj, timestamp: "2026-10-07T01:00:00.000Z" })}\n` +
        `${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-07T01:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "长任务" }] } })}\n`,
    );
    // 引擎重启（fake 同实例重新出现）后可继续发新 prompt（不再 409）
    const r = await registry.prompt(created.id, { text: "继续" });
    expect(r.disposition).toBe("started");
    expect(client.prompts).toEqual(["长任务", "继续"]);
    // 崩溃会话态已清（invalidate）：stopAll 走 registry
    probe.pids.clear();
    await registry.stopAll();
    rmSync(proj, { recursive: true, force: true });
  });

  test("(b) assistant 消息条目落地 → unread 递增（按 entryId 幂等）", async () => {
    setup("durable-1");
    await registry.createSession(proj, {});
    const appended = (id: string, role: string, entryType = "message") =>
      client.emit({
        type: "entry_appended",
        sessionId: "routing-1",
        entry: { type: entryType, id, message: { role } },
      });
    // assistant 消息条目落地：递增一次
    appended("e-1", "assistant");
    expect(unreadCalls).toEqual([{ projectPath: proj, durableSessionId: "durable-1" }]);
    // 同一条目重复投递：不重复计
    appended("e-1", "assistant");
    expect(unreadCalls).toHaveLength(1);
    // 另一条 assistant：再计
    appended("e-2", "assistant");
    expect(unreadCalls).toHaveLength(2);
    // 用户消息 / 自定义条目 / message_end（无 entry id，不作未读源）：不计
    appended("e-3", "user");
    appended("e-4", "assistant", "custom");
    client.emit({ type: "message_end", sessionId: "routing-1", message: { role: "assistant" } });
    client.emit({ type: "agent_start", sessionId: "routing-1" });
    expect(unreadCalls).toHaveLength(2);
  });

  test("(restart) 重建项目引擎：会话态失效、引擎重回 ready、可继续建会话", async () => {
    setup("durable-1");
    // oxlint-disable-next-line no-unused-vars -- 存量：仅需触发建会话副作用，会话身份经 durableSessionIdFor 断言
    const created = await registry.createSession(proj, {});
    expect(registry.durableSessionIdFor(proj, "routing-1")).toBe("durable-1");
    await registry.restartProject(proj);
    // 会话态失效（handle→durable 映射清空；旧 handle 属于已死进程）
    expect(registry.durableSessionIdFor(proj, "routing-1")).toBeUndefined();
    // 引擎重回 ready 且空闲
    expect(await registry.peekActiveSessionPaths(proj)).toEqual([]);
    // 后续建会话正常
    const again = await registry.createSession(proj, {});
    expect(again.id).toBe("durable-1");
  });

  test("(preset) 项目文件权限预设 → spawn 参数：有值含 --permission-preset，无值/损坏不含（todo 6）", async () => {
    const projWith = mkdtempSync(join(tmpdir(), "preset-with-"));
    const projWithout = mkdtempSync(join(tmpdir(), "preset-without-"));
    // 工厂内构造 fake（拿到管理器 buildSpawnOptions 的真实产物）
    const mk = (project: string, extra?: (p: string) => string[]) => {
      const pr = new StaticProbe();
      let c!: FakeEngineClient;
      const m = new EngineProcessManager({
        clientFactory: (o) => {
          c = new FakeEngineClient(o);
          pr.pids.add(c.process.pid);
          return c;
        },
        probe: pr,
        registryPath: join(project, "registry.json"),
        readyProbeIntervalMs: 1,
        readyProbeMaxAttempts: 10,
        crashPollMs: 60_000,
        extraSpawnArgs: extra,
      });
      return { get client() { return c; }, pr, m };
    };
    // 与组合根同构：extraSpawnArgs = 合并读取项目文件的权限预设（损坏降级空数组）
    const spawnMeta = openMetaDb({ path: join(mkdtempSync(join(tmpdir(), "preset-meta-")), "meta.db") });
    const cfg = openConfigStore({ globalDir: join(mkdtempSync(join(tmpdir(), "preset-cfg-")), "global") });
    const stores = createProjectConfigStores(cfg);
    const extra = (p: string) => permissionPresetSpawnArgs(stores, spawnMeta, p);
    const withPreset = mk(projWith, extra);
    const withoutPreset = mk(projWithout, extra);
    try {
      writeFileSync(join(projWith, ".ul-omo-webui.json"), JSON.stringify({ version: 1, permissionPreset: "read-only" }));
      await withPreset.m.ensureRunning(projWith);
      await withoutPreset.m.ensureRunning(projWithout);
      expect(withPreset.client.spawnOpts.args).toContain("--permission-preset");
      expect(withPreset.client.spawnOpts.args).toContain("read-only");
      expect(withoutPreset.client.spawnOpts.args).not.toContain("--permission-preset");

      // 文件损坏 → spawn 参数降级为空（不炸 spawn）；修复后恢复
      writeFileSync(join(projWith, ".ul-omo-webui.json"), "{broken");
      expect(extra(projWith)).toEqual([]);
      writeFileSync(join(projWith, ".ul-omo-webui.json"), JSON.stringify({ version: 1, permissionPreset: "  read-only  " }));
      expect(extra(projWith)).toEqual(["--permission-preset", "read-only"]);
      // helper 直测：值去空白、无值空数组
      expect(permissionPresetArgs("  read-only  ")).toEqual(["--permission-preset", "read-only"]);
      expect(permissionPresetArgs(null)).toEqual([]);
    } finally {
      withPreset.pr.pids.clear();
      withoutPreset.pr.pids.clear();
      await withPreset.m.stopAll();
      await withoutPreset.m.stopAll();
      rmSync(projWith, { recursive: true, force: true });
      rmSync(projWithout, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- 装配隔离：meta 库路径与 agentDir

describe("config 路径装配", () => {
  const saved = {
    metaDb: process.env.UL_OMO_WEBUI_META_DB,
    agentDirEnv: process.env.UL_OMO_WEBUI_AGENT_DIR,
  };
  afterEach(() => {
    if (saved.metaDb !== undefined) process.env.UL_OMO_WEBUI_META_DB = saved.metaDb;
    else delete process.env.UL_OMO_WEBUI_META_DB;
    if (saved.agentDirEnv !== undefined) process.env.UL_OMO_WEBUI_AGENT_DIR = saved.agentDirEnv;
    else delete process.env.UL_OMO_WEBUI_AGENT_DIR;
  });

  test("(b) meta 库默认随 DATA_DIR，显式 META_DB 仍最高优先", () => {
    delete process.env.UL_OMO_WEBUI_META_DB;
    expect(metaDbPath()).toBe(resolve(DATA_DIR, "meta.db"));
    process.env.UL_OMO_WEBUI_META_DB = "/tmp/explicit-meta.db";
    expect(metaDbPath()).toBe("/tmp/explicit-meta.db");
    // PID 登记表同属运行数据目录
    expect(engineRegistryPath()).toBe(resolve(DATA_DIR, "engine-processes.json"));
  });

  test("(a) agentDir 缺省 ~/.omo/agent（2026-10-15 改锚与命令行版同库），env 覆盖生效", () => {
    delete process.env.UL_OMO_WEBUI_AGENT_DIR;
    expect(configAgentDir()).toBe(join(homedir(), ".omo", "agent"));
    process.env.UL_OMO_WEBUI_AGENT_DIR = "/tmp/fake-agent";
    expect(configAgentDir()).toBe("/tmp/fake-agent");
  });
});

describe("EngineRuntimeRegistry agentDir 传递（models 降级读同源目录）", () => {
  test("registry 的 agentDir 决定 modelsList 降级直读的 models-store.json", async () => {
    const fakeAgent = mkdtempSync(join(tmpdir(), "fake-agent-"));
    const proj = mkdtempSync(join(tmpdir(), "agentdir-proj-"));
    writeFileSync(
      join(fakeAgent, "models-store.json"),
      JSON.stringify({ "fake-provider": { models: [{ id: "fake-model-a", reasoning: false, contextWindow: 1000 }] } }),
    );
    const manager = new EngineProcessManager({
      registryPath: join(proj, "registry.json"),
      readyProbeIntervalMs: 1,
      readyProbeMaxAttempts: 10,
      crashPollMs: 60_000,
    });
    const registry = new EngineRuntimeRegistry(manager, {
      listProjects: () => [proj],
      agentDir: fakeAgent,
    });
    try {
      // 冷路径（引擎未 spawn）：modelsList 降级直读 agentDir 下的 models-store.json
      const models = await registry.modelsList(proj);
      expect(models).toHaveLength(1);
      expect(models[0].provider).toBe("fake-provider");
      expect(models[0].id).toBe("fake-model-a");
    } finally {
      await manager.stopAll();
      rmSync(fakeAgent, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- SSE 信封 durableSessionId 注入

describe("SSE data 帧 durableSessionId 注入", () => {
  test("映射可得时注入，映射不明缺席；?session= 过滤兼容 durable id", async () => {
    const bus = new EventBus({ capacity: 10 });
    setEventBus(bus, {
      heartbeatMs: 50,
      durableLookup: (projectPath, handle) =>
        projectPath === "/proj" && handle === "routing-1" ? "durable-1" : undefined,
    });
    const res = await sseRoutes.request("/events");
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // 已映射 / 未映射各一条
    bus.publish("/proj", { type: "message_update", sessionId: "routing-1" } as never);
    bus.publish("/other", { type: "message_update", sessionId: "routing-9" } as never);
    let text = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !(text.includes("routing-1") && text.includes("routing-9"))) {
      const chunk = await Promise.race([reader.read(), sleep(50).then(() => null)]);
      if (!chunk) continue;
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    const frames = text.split("\n").filter((l) => l.startsWith("data:"));
    const mapped = frames.find((l) => l.includes("routing-1"));
    const unmapped = frames.find((l) => l.includes("routing-9"));
    expect(mapped).toBeDefined();
    expect(unmapped).toBeDefined();
    // 映射命中：注入 durableSessionId，wire 原样字段不受影响
    const mappedPayload = JSON.parse(mapped!.slice(5));
    expect(mappedPayload.durableSessionId).toBe("durable-1");
    expect((mappedPayload.event as { sessionId: string }).sessionId).toBe("routing-1");
    // 映射不明：如实透传（无该字段）
    const unmappedPayload = JSON.parse(unmapped!.slice(5));
    expect(unmappedPayload.durableSessionId).toBeUndefined();
  });

  test("?session= 传 durable id 也能过滤命中", async () => {
    const bus = new EventBus({ capacity: 10 });
    setEventBus(bus, {
      heartbeatMs: 50,
      durableLookup: (_projectPath, handle) => (handle === "routing-1" ? "durable-1" : undefined),
    });
    const res = await sseRoutes.request("/events?session=durable-1");
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    bus.publish("/proj", { type: "agent_start", sessionId: "routing-1" } as never);
    bus.publish("/proj", { type: "agent_start", sessionId: "routing-2" } as never);
    let text = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !text.includes("routing-2")) {
      const chunk = await Promise.race([reader.read(), sleep(50).then(() => null)]);
      if (!chunk) continue;
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    // durable-1 命中 routing-1 帧放行；routing-2 映射不到被过滤
    expect(text).toContain("routing-1");
    expect(text).not.toContain("routing-2");
  });
});

// ---------------------------------------------------------------- 斜杠命令枚举（docs08-r3 任务 19）

describe("GET /api/commands 三段枚举", () => {
  const row = (name: string, source: string, description?: string): EngineCommandInfo => ({
    name,
    source,
    ...(description ? { description } : {}),
  });

  test("三段按 source 分组排序；未知 source 归引擎命令段", async () => {
    const engines = new FakeGateway();
    engines.commandsResults = [
      [
        row("todo", "extension", "Manage todos"),
        row("skill:ast-grep", "skill", "AST 搜索"),
        row("doctor", "prompt"),
        row("weird", "mystery"),
        row("init", "extension"),
      ],
    ];
    const proj = mkdtempSync(join(tmpdir(), "routes-cmds-"));
    const { app } = buildApp(engines);
    try {
      const res = await req(app, `/api/commands?project=${encodeURIComponent(proj)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        project: string;
        available: boolean;
        commands: Record<"extension" | "skill" | "prompt", EngineCommandInfo[]>;
      };
      expect(body.available).toBe(true);
      expect(body.project).toBe(proj);
      expect(body.commands.extension.map((r) => r.name)).toEqual(["init", "todo", "weird"]);
      expect(body.commands.skill.map((r) => r.name)).toEqual(["skill:ast-grep"]);
      expect(body.commands.prompt.map((r) => r.name)).toEqual(["doctor"]);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("60s 按项目缓存：同项目两次请求取数一次，异项目各自取数", async () => {
    const engines = new FakeGateway();
    engines.commandsResults = [[row("init", "extension")], [row("skill:git-master", "skill")]];
    const projA = mkdtempSync(join(tmpdir(), "routes-cmds-a-"));
    const projB = mkdtempSync(join(tmpdir(), "routes-cmds-b-"));
    const { app } = buildApp(engines);
    try {
      const first = await (await req(app, `/api/commands?project=${encodeURIComponent(projA)}`)).json();
      const second = await (await req(app, `/api/commands?project=${encodeURIComponent(projA)}`)).json();
      expect(first.commands.extension).toHaveLength(1);
      expect(second.commands.extension).toHaveLength(1);
      expect(engines.commandsCalls).toEqual([projA]);
      const third = await (await req(app, `/api/commands?project=${encodeURIComponent(projB)}`)).json();
      expect(third.commands.skill).toHaveLength(1);
      expect(engines.commandsCalls).toEqual([projA, projB]);
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  test("降级不崩：gateway 报 null（引擎未就绪/无活跃会话）→ 200 available=false 空三段且不入缓存", async () => {
    const engines = new FakeGateway();
    engines.commandsResults = [null, [row("reload", "extension")]];
    const proj = mkdtempSync(join(tmpdir(), "routes-cmds-d-"));
    const { app } = buildApp(engines);
    try {
      const down = await (await req(app, `/api/commands?project=${encodeURIComponent(proj)}`)).json();
      expect(down.available).toBe(false);
      expect(down.commands).toEqual({ extension: [], skill: [], prompt: [] });
      // 降级未入缓存：引擎就绪后同项目下一请求即取到真数据
      const up = await (await req(app, `/api/commands?project=${encodeURIComponent(proj)}`)).json();
      expect(up.available).toBe(true);
      expect(up.commands.extension.map((r: EngineCommandInfo) => r.name)).toEqual(["reload"]);
      expect(engines.commandsCalls).toEqual([proj, proj]);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("gateway 抛错同降级口径；无已知项目 400 no_project", async () => {
    const engines = new FakeGateway();
    const { app, meta } = buildApp(engines);
    const noProject = await req(app, "/api/commands");
    expect(noProject.status).toBe(400);
    expect(((await noProject.json()) as { error: { code: string } }).error.code).toBe("no_project");

    const proj = mkdtempSync(join(tmpdir(), "routes-cmds-e-"));
    meta.updateProjectMeta(proj, { lastOpenedAt: new Date().toISOString() });
    try {
      // commandsResults 已耗尽（空数组 shift 得 undefined → fake 抛 ApiError 409）
      const res = await req(app, "/api/commands");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean };
      expect(body.available).toBe(false);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("project 参数规范化：非绝对路径 400 invalid_project", async () => {
    const { app } = buildApp(new FakeGateway());
    const res = await req(app, "/api/commands?project=relative/path");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_project");
  });
});
