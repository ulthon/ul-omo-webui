// REST API 路由单测（todo 9）：
// - 路径逃逸（../ 、绝对路径注入、符号链接逃逸）
// - 错误统一形状 {error:{code,message}}
// - 会话列表合并/过滤（view=human、archived、q、置顶排序、元数据合并）
// - 单驱动约束：回合中再次 prompt 409（真实 EngineProcessManager + fake 引擎连接）
import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { createProjectRoutes } from "../src/api/routes-project";
import { createGitRoutes } from "../src/api/routes-git";
import { createFsRoutes } from "../src/api/routes-fs";
import { openMetaDb } from "../src/db/meta";
import { EngineProcessManager, type EngineClientLike, type RpcClientEvent, type RpcClientOptions } from "../src/engine/process-manager";
import type { ProcProbe } from "../src/engine/orphan-reaper";
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
import { agentDir as configAgentDir, engineRegistryPath, metaDbPath } from "../src/config";

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
  promptCalls: Array<{ id: string; input: { text: string; model?: string } }> = [];
  createdResults: Array<{ id: string; sessionPath: string; durable: boolean }> = [];
  deleted: string[] = [];
  activePaths: string[] | null = null;
  models: EngineModelInfo[] = [];

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
  async prompt(id: string, input: { text: string; images?: EnginePromptInput["images"]; model?: string }) {
    if (this.promptError) throw this.promptError;
    this.promptCalls.push({ id, input: { text: input.text, model: input.model } });
    return { disposition: "started" };
  }
  async abort(): Promise<void> {}
  async permissionRespond(_id: string, _requestId: string, _reply: EnginePermissionReply): Promise<void> {}
  async usage(): Promise<EngineUsageStats> {
    return fakeUsage();
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    return this.models;
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
  app.route("/", createSessionRoutes({ meta, engines }));
  app.route("/", createMetaRoutes({ meta, engines }));
  app.route("/", createProjectRoutes({ meta, engines }));
  app.route("/", createGitRoutes({ meta, engines }));
  app.route("/", createFsRoutes({ meta, engines }));
  return { app, meta };
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

  test("view=human 过滤 fork、q 标题搜索、archived 过滤、置顶排序、元数据合并", async () => {
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

    // 默认 view=human：s2（fork）被过滤；置顶 s1 排最前
    const res = await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`);
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s1", "s3"]);
    const s1 = body.sessions[0];
    expect(s1.title).toBe("重命名的标题");
    expect(s1.pinned).toBe(true);
    expect(body.sessions[1].unreadCount).toBe(5);
    expect(body.sessions[1].title).toBe("Fix the login bug");

    // view=all：fork 会话出现且带 parentSessionPath
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&view=all`)).json();
    expect(body.sessions).toHaveLength(3);
    const s2 = body.sessions.find((s: { id: string }) => s.id === "s2");
    expect(s2.parentSessionPath).toBe("/p/s1.jsonl");

    // q 搜索命中 renamed_title 与 firstMessage（标题级，消息内容搜索出范围）
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&q=` + encodeURIComponent("重命名"))).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s1"]);
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&q=login`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s3"]);

    // archived 过滤：默认不含归档；归档后 archived=true 可见
    meta.updateSessionMeta("s3", { archivedAt: "2026-02-01T00:00:00.000Z" });
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s1"]);
    body = await (await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&archived=true`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s3"]);

    // 非法参数
    expect((await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&view=bogus`)).status).toBe(400);
    expect((await req(app, `/api/sessions?project=${encodeURIComponent(proj)}&archived=bogus`)).status).toBe(400);
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
});

// ---------------------------------------------------------------- 项目/元数据杂项路由

describe("项目与元数据杂项路由", () => {
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

  test("agents 降级响应；models 需已知项目；input-history 去重上限；settings 校验", async () => {
    const engines = new FakeGateway();
    engines.models = [{ provider: "zai-coding-cn", id: "glm-5.3-flash", reasoning: true }];
    const proj = mkdtempSync(join(tmpdir(), "routes-misc-"));
    const { app, meta } = buildApp(engines);
    try {
      const agents = await (await req(app, "/api/agents")).json();
      expect(agents.capabilities.agentsList).toBe(false);
      expect(agents.degraded).toBe(true);

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

  test("git status/diff：非仓库 409、仓库解析 porcelain 条目", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "routes-git-"));
    const repo = mkdtempSync(join(tmpdir(), "routes-git-"));
    const { app } = buildApp(new FakeGateway());
    try {
      const notRepo = await req(app, `/api/git/status?project=${encodeURIComponent(nonRepo)}`);
      expect(notRepo.status).toBe(409);
      expect((await notRepo.json()).error.code).toBe("not_a_git_repo");

      const run = (args: string[]) => Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe" });
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
  async send(message: unknown): Promise<{ success: boolean; data: unknown }> {
    return { success: true, data: { engineVersion: "fake" } };
  }
  emit(event: Record<string, unknown>): void {
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
    return { isStreaming: this.fakeStreaming, messageCount: 2 };
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
    await Bun.sleep(Math.min(ms, 5));
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
    const exists = await Bun.file(sessionFile).exists();
    expect(exists).toBe(false);
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
    await Bun.sleep(200); // 越过轮询+宽限窗口
    expect(syntheticEvents).toEqual([]);
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
      await Bun.sleep(20);
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
    await Bun.sleep(250);
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
      await Bun.sleep(10);
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

  test("(preset) meta_kv 权限预设 → spawn 参数：有值含 --permission-preset，无值不含", async () => {
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
    const withPreset = mk(projWith, (p) => permissionPresetArgs((k) => (k === permissionPresetKey(p) ? "read-only" : null), p));
    const withoutPreset = mk(projWithout);
    try {
      await withPreset.m.ensureRunning(projWith);
      await withoutPreset.m.ensureRunning(projWithout);
      expect(withPreset.client.spawnOpts.args).toContain("--permission-preset");
      expect(withPreset.client.spawnOpts.args).toContain("read-only");
      expect(withoutPreset.client.spawnOpts.args).not.toContain("--permission-preset");
      // helper 直测：值去重空白、无值空数组
      expect(
        permissionPresetArgs((k) => (k === permissionPresetKey(projWith) ? "  read-only  " : null), projWith),
      ).toEqual(["--permission-preset", "read-only"]);
      expect(permissionPresetArgs(() => null, projWith)).toEqual([]);
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
    metaDb: process.env.SENPI_WEBUI_META_DB,
    agentDirEnv: process.env.SENPI_WEBUI_AGENT_DIR,
  };
  afterEach(() => {
    if (saved.metaDb !== undefined) process.env.SENPI_WEBUI_META_DB = saved.metaDb;
    else delete process.env.SENPI_WEBUI_META_DB;
    if (saved.agentDirEnv !== undefined) process.env.SENPI_WEBUI_AGENT_DIR = saved.agentDirEnv;
    else delete process.env.SENPI_WEBUI_AGENT_DIR;
  });

  test("(b) meta 库默认随 DATA_DIR，显式 META_DB 仍最高优先", () => {
    delete process.env.SENPI_WEBUI_META_DB;
    expect(metaDbPath()).toBe(resolve(DATA_DIR, "meta.db"));
    process.env.SENPI_WEBUI_META_DB = "/tmp/explicit-meta.db";
    expect(metaDbPath()).toBe("/tmp/explicit-meta.db");
    // PID 登记表同属运行数据目录
    expect(engineRegistryPath()).toBe(resolve(DATA_DIR, "engine-processes.json"));
  });

  test("(a) agentDir 缺省 ~/.pi/agent，env 覆盖生效", () => {
    delete process.env.SENPI_WEBUI_AGENT_DIR;
    expect(configAgentDir()).toBe(join(homedir(), ".pi", "agent"));
    process.env.SENPI_WEBUI_AGENT_DIR = "/tmp/fake-agent";
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
      const chunk = await Promise.race([reader.read(), Bun.sleep(50).then(() => null)]);
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
      const chunk = await Promise.race([reader.read(), Bun.sleep(50).then(() => null)]);
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
