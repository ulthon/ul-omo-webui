// 常用语端点单测（todo 4）：聚焦 HTTP 语义层（两源聚合、整替幂等、输入校验、
// 项目注册校验、损坏文件 500 带路径）——config-store 读写行为已由
// config-store.test.ts 锁定，此处不重复。
// 全部用 mkdtemp 隔离目录，绝不触碰真实 ~/.config 与仓库 .ul-omo-webui.json。
import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type {
  EngineMessagesPage,
  EngineModelInfo,
  EnginePermissionReply,
  EnginePromptInput,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineUsageStats,
  EngineQueueSnapshot,
} from "../src/adapter/engine-adapter";
import type { EngineGateway } from "../src/api/engine-runtime";
import { openConfigStore } from "../src/conf/config-store";
import { openMetaDb } from "../src/db/meta";
import { createSnippetsRoutes } from "../src/api/routes-snippets";

/** snippets 路由不触引擎；类型占位实现（任何误用都会在测试里以异常暴露）。 */
class NoEngines implements EngineGateway {
  async sessionsList(): Promise<EngineSessionSummary[]> {
    return [];
  }
  async createSession(
    _project: string,
    _opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new Error("snippets routes must not create sessions");
  }
  async messages(_id: string, _cursor?: string): Promise<EngineMessagesPage> {
    throw new Error("snippets routes must not read messages");
  }
  async prompt(_id: string, _input: EnginePromptInput): Promise<{ disposition: string }> {
    throw new Error("snippets routes must not prompt");
  }
  async abort(): Promise<void> {}
  async queueList(): Promise<EngineQueueSnapshot> {
    throw new Error("queue routes must not be touched here");
  }
  async queueClear(): Promise<EngineQueueSnapshot> {
    throw new Error("queue routes must not be touched here");
  }
  async permissionRespond(_id: string, _requestId: string, _reply: EnginePermissionReply): Promise<void> {}
  async usage(): Promise<EngineUsageStats> {
    throw new Error("snippets routes must not read usage");
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    throw new Error("snippets routes must not list models");
  }
  async deleteSession(): Promise<{ sessionPath: string; fileExisted: boolean }> {
    throw new Error("snippets routes must not delete sessions");
  }
  async exportSessionHtml(): Promise<{ html: string; row: EngineSessionSummary }> {
    throw new Error("snippets routes must not export");
  }
  async forkSession(): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    throw new Error("snippets routes must not fork");
  }
  async peekActiveSessionPaths(): Promise<string[] | null> {
    return null;
  }
  async restartProject(): Promise<void> {}
  async stopAll(): Promise<void> {}
}

const tmp = mkdtempSync(join(tmpdir(), "senpi-snippets-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 每个用例独立子目录（bun test 同文件共享模块态，防串数据）。
// hostRoot 模拟组合根注入实例的 projectRoot（生产中是仓库根，端点从不触它）。
let seq = 0;
function setup() {
  seq += 1;
  const caseDir = mkdtempSync(join(tmp, "case-"));
  const globalDir = join(caseDir, "global");
  const projectDir = mkdtempSync(join(caseDir, "proj-"));
  const hostRoot = join(caseDir, "host");
  const configs = openConfigStore({ globalDir, projectRoot: hostRoot });
  const meta = openMetaDb({ path: join(caseDir, "meta.db") });
  const app = new Hono();
  app.route("/", createSnippetsRoutes({ meta, engines: new NoEngines(), configs }));
  const snippetsPath = join(globalDir, "snippets.json");
  const register = (dir: string) => meta.updateProjectMeta(dir, { lastOpenedAt: new Date().toISOString() });
  return { app, meta, globalDir, projectDir, snippetsPath, register };
}

describe("GET /api/snippets", () => {
  test("无数据返回两源空数组", async () => {
    const { app } = setup();
    const res = await app.request("/api/snippets");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ global: [], project: [] });
  });

  test("两源聚合：global 与 project 各自返回互不污染", async () => {
    const { app, projectDir, register } = setup();
    register(projectDir);
    await app.request("/api/snippets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", snippets: [{ content: "全局常用语", sort: 1 }] }),
    });
    await app.request("/api/snippets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "project", project: projectDir, snippets: [{ content: "项目常用语", sort: 1 }] }),
    });
    const res = await app.request(`/api/snippets?project=${encodeURIComponent(projectDir)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.global).toEqual([{ content: "全局常用语", sort: 1 }]);
    expect(body.project).toEqual([{ content: "项目常用语", sort: 1 }]);
    // 不带 project 参数时 project 源为空数组，global 不受影响
    const resNoProject = await app.request("/api/snippets");
    expect((await resNoProject.json()).project).toEqual([]);
  });
});

describe("PUT /api/snippets global scope", () => {
  test("整替并按 sort 升序回显，GET 回读一致", async () => {
    const { app } = setup();
    const res = await app.request("/api/snippets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        snippets: [
          { content: "后插入", sort: 2 },
          { content: "先插入", sort: 1 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()).snippets;
    expect(echoed).toEqual([
      { content: "先插入", sort: 1 },
      { content: "后插入", sort: 2 },
    ]);
    const readBack = await app.request("/api/snippets");
    expect((await readBack.json()).global).toEqual(echoed);
  });

  test("整替幂等：再次 PUT 覆盖不追加", async () => {
    const { app } = setup();
    const put = (snippets: unknown) =>
      app.request("/api/snippets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "global", snippets }),
      });
    await put([
      { content: "旧一", sort: 1 },
      { content: "旧二", sort: 2 },
    ]);
    const res = await put([{ content: "新一", sort: 1 }]);
    expect(res.status).toBe(200);
    expect((await res.json()).snippets).toEqual([{ content: "新一", sort: 1 }]);
  });

  test("空串 content 条目 400 invalid_snippets", async () => {
    const { app } = setup();
    const res = await app.request("/api/snippets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", snippets: [{ content: "", sort: 1 }] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_snippets");
  });

  test("单条 content 超 4KB 400，4096 字节边界通过", async () => {
    const { app } = setup();
    const atLimit = await app.request("/api/snippets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", snippets: [{ content: "x".repeat(4096), sort: 1 }] }),
    });
    expect(atLimit.status).toBe(200);
    const overLimit = await app.request("/api/snippets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", snippets: [{ content: "x".repeat(4097), sort: 1 }] }),
    });
    expect(overLimit.status).toBe(400);
    expect((await overLimit.json()).error.code).toBe("invalid_snippets");
  });

  test("snippets 非数组或条目形状非法 400", async () => {
    const { app } = setup();
    const put = (snippets: unknown) =>
      app.request("/api/snippets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "global", snippets }),
      });
    expect((await put("not-an-array")).status).toBe(400);
    expect((await (await put(undefined)).json()).error.code).toBe("invalid_snippets");
    expect((await put([{ sort: 1 }])).status).toBe(400); // 缺 content
    expect((await put(["裸字符串"])).status).toBe(400); // 条目非对象
    expect((await put([{ content: "ok", sort: "NaN" }])).status).toBe(400); // sort 非数字
  });
});

describe("PUT /api/snippets project scope", () => {
  test("非法 scope 400", async () => {
    const { app } = setup();
    const res = await app.request("/api/snippets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "workspace", snippets: [] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_scope");
  });

  test("project scope 缺 project 400", async () => {
    const { app } = setup();
    const res = await app.request("/api/snippets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "project", snippets: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("目录存在但未注册 400 project_not_found", async () => {
    const { app, projectDir } = setup();
    const res = await app.request("/api/snippets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "project", project: projectDir, snippets: [{ content: "x", sort: 1 }] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("project_not_found");
  });

  test("已注册项目整替成功写入 .ul-omo-webui.json，GET 回读", async () => {
    const { app, projectDir, register } = setup();
    register(projectDir);
    const res = await app.request("/api/snippets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "project", project: projectDir, snippets: [{ content: "项目级", sort: 3 }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).snippets).toEqual([{ content: "项目级", sort: 3 }]);
    const readBack = await app.request(`/api/snippets?project=${encodeURIComponent(projectDir)}`);
    expect((await readBack.json()).project).toEqual([{ content: "项目级", sort: 3 }]);
  });
});

describe("配置文件损坏", () => {
  test("GET 全局损坏 500 且错误信息带文件路径", async () => {
    const { app, globalDir, snippetsPath } = setup();
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(snippetsPath, "{broken json");
    const res = await app.request("/api/snippets");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal");
    expect(body.error.message).toContain(snippetsPath);
  });

  test("PUT 损坏 scope 500 带路径（不静默成功）", async () => {
    const { app, globalDir, snippetsPath } = setup();
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(snippetsPath, "{broken json");
    const res = await app.request("/api/snippets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", snippets: [{ content: "x", sort: 1 }] }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toContain(snippetsPath);
  });
});
