// 记忆浏览端点单测（docs08-r4 任务 12）：聚焦 HTTP 语义层——绑定条目定位库、
// 重算兜底金样（/root→root-94a6b447、/→agent-8a5edab2，spike 实测恒真）、
// facts 解析（front-matter 跳过/bullet 拆条/续行并入/原文不截断）、空库/库不存在
// 诚实空态、未注册项目 403、符号链接逃逸 403、非法身份串降级重算。
// 全部用 mkdtemp 隔离目录 + 注入 memoryHome，不触引擎、不碰真实 ~/.omo/memory。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type {
  EngineMessagesPage,
  EngineModelInfo,
  EnginePermissionReply,
  EnginePromptInput,
  EngineQueueSnapshot,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineUsageStats,
} from "../src/adapter/engine-adapter";
import type { EngineGateway } from "../src/api/engine-runtime";
import { openMetaDb } from "../src/db/meta";
import { createMemoryRoutes } from "../src/api/routes-memory";

/** 记忆路由只读 sessionsList；其余方法误用即在测试里以异常暴露。 */
class FakeEngines implements EngineGateway {
  rows: EngineSessionSummary[] = [];
  async sessionsList(): Promise<EngineSessionSummary[]> {
    return this.rows;
  }
  async createSession(
    _project: string,
    _opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new Error("memory routes must not create sessions");
  }
  async messages(_id: string, _cursor?: string): Promise<EngineMessagesPage> {
    throw new Error("memory routes must not read messages");
  }
  async prompt(_id: string, _input: EnginePromptInput): Promise<{ disposition: string }> {
    throw new Error("memory routes must not prompt");
  }
  async abort(): Promise<void> {}
  async queueList(): Promise<EngineQueueSnapshot> {
    throw new Error("memory routes must not touch queue");
  }
  async queueClear(): Promise<EngineQueueSnapshot> {
    throw new Error("memory routes must not touch queue");
  }
  async permissionRespond(_id: string, _requestId: string, _reply: EnginePermissionReply): Promise<void> {}
  async usage(): Promise<EngineUsageStats> {
    throw new Error("memory routes must not read usage");
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    throw new Error("memory routes must not list models");
  }
  async deleteSession(): Promise<{ sessionPath: string; fileExisted: boolean }> {
    throw new Error("memory routes must not delete sessions");
  }
  async exportSessionHtml(): Promise<{ html: string; row: EngineSessionSummary }> {
    throw new Error("memory routes must not export");
  }
  async forkSession(): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    throw new Error("memory routes must not fork");
  }
  async peekActiveSessionPaths(): Promise<string[] | null> {
    return null;
  }
  async restartProject(): Promise<void> {}
  async stopAll(): Promise<void> {}
}

const tmp = mkdtempSync(join(tmpdir(), "senpi-memory-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function setup() {
  seq += 1;
  const caseDir = mkdtempSync(join(tmp, `case-${seq}-`));
  const projectDir = join(caseDir, "proj");
  mkdirSync(projectDir, { recursive: true });
  const memHome = join(caseDir, "mem-home");
  const agentsRoot = join(memHome, "agents");
  const meta = openMetaDb({ path: join(caseDir, "meta.db") });
  const engines = new FakeEngines();
  const app = new Hono();
  app.route("/", createMemoryRoutes({ meta, engines, memoryHome: memHome }));
  const register = (path = projectDir) =>
    meta.updateProjectMeta(path, { lastOpenedAt: new Date().toISOString() });
  const writeSession = (identity: string) => {
    const file = join(caseDir, `session-${engines.rows.length}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({
        type: "custom",
        customType: "senpi-memory.session-binding",
        data: { identity, repoPathHash: "ab".repeat(32), boundAt: 1 },
        id: "e1",
        parentId: "e0",
        timestamp: "2026-10-14T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    engines.rows.push({
      path: file,
      id: `sid-${engines.rows.length}`,
      cwd: projectDir,
      created: "2026-10-14T00:00:00.000Z",
      modified: "2026-10-14T00:00:00.000Z",
      messageCount: 1,
      firstMessage: "",
    });
  };
  const makeLibrary = (identity: string, files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      const path = join(agentsRoot, identity, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content, "utf8");
    }
  };
  const get = (project: string) =>
    app.request(`/api/memory/facts?project=${encodeURIComponent(project)}`);
  const getNoParam = () => app.request("/api/memory/facts");
  return { caseDir, projectDir, memHome, agentsRoot, register, writeSession, makeLibrary, get, getNoParam };
}

describe("GET /api/memory/facts", () => {
  test("绑定条目定位库 + facts 解析（front-matter 跳过、bullet 拆条、续行并入、原文完整）", async () => {
    const { projectDir, agentsRoot, register, writeSession, makeLibrary, get } = setup();
    register();
    writeSession("custom-lib-12345678");
    makeLibrary("custom-lib-12345678", {
      "repo/notes/facts/2026-10.md": `---
description: Explicit facts for 2026-10
---
- [2026-10-07] 第一条事实
- [2026-10-08] 第二条事实
  续行内容保持原文
`,
      "repo/system/persona.md": `---
description: Persona
kind: persona
---
正文第一行。

正文第二行。
`,
    });
    const res = await get(projectDir);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.libraryId).toBe("custom-lib-12345678");
    expect(body.libraryPath).toBe(join(agentsRoot, "custom-lib-12345678"));
    expect(body.facts).toHaveLength(1);
    expect(body.facts[0].file).toBe("2026-10.md");
    expect(body.facts[0].description).toBe("Explicit facts for 2026-10");
    expect(body.facts[0].entries).toEqual([
      "[2026-10-07] 第一条事实",
      "[2026-10-08] 第二条事实\n  续行内容保持原文",
    ]);
    expect(body.system).toHaveLength(1);
    expect(body.system[0].file).toBe("persona.md");
    expect(body.system[0].description).toBe("Persona");
    expect(body.system[0].body).toBe("正文第一行。\n\n正文第二行。");
  });

  test("重算兜底金样：/root → root-94a6b447（spike 实测恒真）", async () => {
    const { agentsRoot, register, makeLibrary, get } = setup();
    register("/root");
    makeLibrary("root-94a6b447", { "repo/notes/facts/2026-10.md": "- [2026-10-07] 金样事实\n" });
    const res = await get("/root");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.libraryId).toBe("root-94a6b447");
    expect(body.exists).toBe(true);
    expect(body.facts[0].entries).toEqual(["[2026-10-07] 金样事实"]);
  });

  test("重算兜底金样：/ 空 basename 回退 agent → agent-8a5edab2", async () => {
    const { register, makeLibrary, get } = setup();
    register("/");
    makeLibrary("agent-8a5edab2", { "repo/system/human.md": "IDENTITY: human\n" });
    const res = await get("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.libraryId).toBe("agent-8a5edab2");
    expect(body.exists).toBe(true);
    expect(body.system[0].file).toBe("human.md");
  });

  test("库存在但 repo/ 零文件 → exists=true + 空列表（诚实空态）", async () => {
    const { agentsRoot, projectDir, register, writeSession, get } = setup();
    register();
    writeSession("empty-lib-12345678");
    mkdirSync(join(agentsRoot, "empty-lib-12345678", "runtime"), { recursive: true });
    const res = await get(projectDir);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.facts).toEqual([]);
    expect(body.system).toEqual([]);
  });

  test("库不存在 → exists=false + 空列表 + libraryPath 说明字段", async () => {
    const { agentsRoot, projectDir, register, writeSession, get } = setup();
    register();
    writeSession("ghost-lib-12345678");
    const res = await get(projectDir);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(false);
    expect(body.facts).toEqual([]);
    expect(body.system).toEqual([]);
    expect(body.libraryPath).toBe(join(agentsRoot, "ghost-lib-12345678"));
  });

  test("越界：未注册目录 403；相对路径/缺参/不存在路径 400", async () => {
    const { projectDir, register, get, getNoParam } = setup();
    // 未注册的现存目录
    const stranger = mkdtempSync(join(tmpdir(), "senpi-memory-stranger-"));
    const resStranger = await get(stranger);
    expect(resStranger.status).toBe(403);
    expect((await resStranger.json()).error.code).toBe("project_not_registered");
    // 形状/存在性 400（validateProjectInput 先例）
    expect((await get("relative/path")).status).toBe(400);
    expect((await getNoParam()).status).toBe(400);
    expect((await get(join(projectDir, "missing-dir"))).status).toBe(400);
    register();
    expect((await get(projectDir)).status).toBe(200);
  });

  test("绑定身份符号链接逃逸 agents/ → 403 memory_escape", async () => {
    const { caseDir, projectDir, agentsRoot, register, writeSession, get } = setup();
    register();
    writeSession("sub");
    const outside = join(caseDir, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(agentsRoot, { recursive: true });
    symlinkSync(outside, join(agentsRoot, "sub"));
    const res = await get(projectDir);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("memory_escape");
  });

  test("绑定身份形状非法（路径穿越不可表达）→ 降级重算不炸", async () => {
    const { projectDir, register, writeSession, get } = setup();
    register();
    writeSession("../../evil");
    const res = await get(projectDir);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(false);
    expect(body.facts).toEqual([]);
  });
});

