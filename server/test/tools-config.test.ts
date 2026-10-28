// r10 todo 17：项目级工具启停（spawn 透传 --tools/--exclude-tools/--no-tools + 重启生效）。
// - toolsSpawnArgs 纯函数：白名单子集/全默认/黑名单子集/双单并存/显式空集降级（--no-tools）
// - 配置持久化：写 .ul-omo-webui.json → 新实例重读（read-after-write + 损坏降级）
// - PATCH /api/projects/meta：tools/excludedTools 写入与回读、形状校验 400、
//   显式空集响应 degradedNoTools 标志、GET /api/projects/tools 目录
// - restart 集成：extraSpawnArgs 组合根同构装配（权限预设 + 工具启停），mock spawn
//   断言 argv 含组装参数；POST /api/projects/restart 走既有重启路由
import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { BUILTIN_TOOL_CATALOG, toolsSpawnArgs } from "../src/api/engine-runtime";
import {
  createProjectConfigStores,
  readProjectPreferences,
  toolsSpawnArgsFromConfig,
} from "../src/api/config-migration";
import { openConfigStore } from "../src/conf/config-store";
import { openMetaDb } from "../src/db/meta";
import { createProjectRoutes } from "../src/api/routes-project";
import { EngineProcessManager, type EngineClientLike, type RpcClientOptions } from "../src/engine/process-manager";
import type { EngineGateway } from "../src/api/engine-runtime";
import type { ProcProbe } from "../src/engine/orphan-reaper";

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** 内存进程探针（带 sleep：就绪轮询/超时竞速依赖） */
class TinyProbe implements ProcProbe {
  readonly pids = new Set<number>();
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
    this.pids.delete(pid);
  }
  async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
  }
}

/** 极简假引擎客户端（routes.test FakeEngineClient 同构）：探针 open_session 真实写盘。 */
class FakeEngineClient implements EngineClientLike {
  static nextPid = 9000;
  readonly spawnOpts: RpcClientOptions;
  process: { pid: number };
  constructor(opts: RpcClientOptions) {
    this.spawnOpts = opts;
    this.process = { pid: ++FakeEngineClient.nextPid };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onEvent(): () => void {
    return () => {};
  }
  getStderr(): string {
    return "";
  }
  async send(message: unknown): Promise<{ success: boolean; data: unknown }> {
    const m = message as { type?: string; sessionPath?: string; cwd?: string };
    if (m.type === "open_session" && typeof m.sessionPath === "string") {
      writeFileSync(
        m.sessionPath,
        `${JSON.stringify({ type: "session", version: 3, id: "probe-durable", cwd: this.spawnOpts.cwd })}\n`,
      );
      return {
        success: true,
        data: { sessionId: "routing-1", state: { sessionId: "holder-1", sessionFile: m.sessionPath } },
      };
    }
    return { success: true, data: { engineVersion: "fake" } };
  }
}

function mkStores(): ReturnType<typeof createProjectConfigStores> {
  const configs = openConfigStore({ globalDir: tmp("tools17-cfg-") });
  return createProjectConfigStores(configs);
}

// ---------------------------------------------------------------- args 组装

describe("toolsSpawnArgs（spawn 透传组装）", () => {
  test("未配置（null/null）→ 空数组，spawn 行为与从前一致", () => {
    expect(toolsSpawnArgs({ tools: null, excludedTools: null })).toEqual([]);
  });

  test("白名单子集 → --tools 逗号连接（未列即禁）", () => {
    expect(toolsSpawnArgs({ tools: ["read", "grep"], excludedTools: null })).toEqual([
      "--tools",
      "read,grep",
    ]);
  });

  test("显式空集 → --no-tools 降级（忽略黑名单）", () => {
    expect(toolsSpawnArgs({ tools: [], excludedTools: null })).toEqual(["--no-tools"]);
    expect(toolsSpawnArgs({ tools: [], excludedTools: ["bash"] })).toEqual(["--no-tools"]);
  });

  test("黑名单子集 → --exclude-tools", () => {
    expect(toolsSpawnArgs({ tools: null, excludedTools: ["write", "bash"] })).toEqual([
      "--exclude-tools",
      "write,bash",
    ]);
  });

  test("黑名单空数组 = 未配置 → 空数组", () => {
    expect(toolsSpawnArgs({ tools: null, excludedTools: [] })).toEqual([]);
  });

  test("双单并存 → --tools 在前 --exclude-tools 在后（引擎侧黑名单后生效）", () => {
    expect(toolsSpawnArgs({ tools: ["read", "bash"], excludedTools: ["bash"] })).toEqual([
      "--tools",
      "read,bash",
      "--exclude-tools",
      "bash",
    ]);
  });

  test("内置工具目录与引擎 CLI help 同源（8 项，含默认关闭的 find/ls/powershell）", () => {
    expect(BUILTIN_TOOL_CATALOG.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "powershell",
    ]);
  });
});

// ---------------------------------------------------------------- 持久化 + 合并读降级

describe("工具启停配置持久化（.ul-omo-webui.json）", () => {
  test("写后新实例重读保持（重启后配置不丢）；文件原文含字段", async () => {
    const proj = tmp("tools17-proj-");
    const storesA = mkStores();
    await storesA(proj).updateProjectConfig({ excludedTools: ["write", "bash"] });
    // 新实例 = 模拟进程重启后重读
    const storesB = mkStores();
    const doc = storesB(proj).readProjectConfig();
    expect(doc.excludedTools).toEqual(["write", "bash"]);
    expect(doc.tools).toBeNull();
    const raw = JSON.parse(readFileSync(join(proj, ".ul-omo-webui.json"), "utf8"));
    expect(raw.excludedTools).toEqual(["write", "bash"]);
    // 清除（null）也持久化
    await storesA(proj).updateProjectConfig({ excludedTools: null });
    expect(storesB(proj).readProjectConfig().excludedTools).toBeNull();
    rmSync(proj, { recursive: true, force: true });
  });

  test("合并读：文件值透传 + 显式空集 degradedNoTools；文件损坏全字段降级", () => {
    const proj = tmp("tools17-proj-");
    const stores = mkStores();
    const meta = openMetaDb({ path: join(tmp("tools17-meta-"), "meta.db") });
    writeFileSync(join(proj, ".ul-omo-webui.json"), JSON.stringify({ version: 1, excludedTools: ["bash"] }));
    let view = readProjectPreferences(stores, meta, proj);
    expect(view.excludedTools).toEqual(["bash"]);
    expect(view.tools).toBeNull();
    expect(view.degradedNoTools).toBe(false);
    expect(view.configError).toBe(false);
    expect(toolsSpawnArgsFromConfig(stores, meta, proj)).toEqual(["--exclude-tools", "bash"]);

    writeFileSync(join(proj, ".ul-omo-webui.json"), JSON.stringify({ version: 1, tools: [] }));
    view = readProjectPreferences(stores, meta, proj);
    expect(view.tools).toEqual([]);
    expect(view.degradedNoTools).toBe(true);
    expect(toolsSpawnArgsFromConfig(stores, meta, proj)).toEqual(["--no-tools"]);

    writeFileSync(join(proj, ".ul-omo-webui.json"), "{broken");
    view = readProjectPreferences(stores, meta, proj);
    expect(view.configError).toBe(true);
    expect(view.tools).toBeNull();
    expect(view.excludedTools).toBeNull();
    expect(view.degradedNoTools).toBe(false);
    expect(toolsSpawnArgsFromConfig(stores, meta, proj)).toEqual([]);

    // 字段形状非法 → 损坏降级（不炸 spawn）
    writeFileSync(join(proj, ".ul-omo-webui.json"), JSON.stringify({ version: 1, tools: "read" }));
    expect(readProjectPreferences(stores, meta, proj).configError).toBe(true);
    rmSync(proj, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- 路由：PATCH + 目录 + 重启

function buildProjectApp() {
  const proj = tmp("tools17-route-");
  const meta = openMetaDb({ path: join(tmp("tools17-meta-"), "meta.db") });
  meta.updateProjectMeta(proj, { lastOpenedAt: new Date().toISOString() });
  const stores = mkStores();
  const restarts: string[] = [];
  const engines = {
    restartProject: async (p: string) => {
      restarts.push(p);
    },
  } as unknown as EngineGateway;
  const app = new Hono();
  app.route("/", createProjectRoutes({ meta, engines, projectConfigs: stores }));
  return { app, proj, stores, restarts };
}

const patch = (app: Hono, body: unknown) =>
  app.request("/api/projects/meta", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /api/projects/meta 工具启停", () => {
  test("excludedTools 写入回读；显式空集响应带 degradedNoTools；null 清除", async () => {
    const { app, proj, stores } = buildProjectApp();
    const res = await patch(app, { path: proj, excludedTools: ["bash", " bash ", "write", "bash"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    // trim + 去空 + 去重（保序）
    expect(body.project.excludedTools).toEqual(["bash", "write"]);
    expect(stores(proj).readProjectConfig().excludedTools).toEqual(["bash", "write"]);

    const resEmpty = await patch(app, { path: proj, excludedTools: ["bash"], tools: [] });
    const bodyEmpty = await resEmpty.json();
    expect(bodyEmpty.project.tools).toEqual([]);
    expect(bodyEmpty.project.degradedNoTools).toBe(true);

    const resClear = await patch(app, { path: proj, tools: null, excludedTools: null });
    const bodyClear = await resClear.json();
    expect(bodyClear.project.tools).toBeNull();
    expect(bodyClear.project.excludedTools).toBeNull();
    expect(bodyClear.project.degradedNoTools).toBeUndefined();
  });

  test("形状非法 → 400；无有效字段 → 400", async () => {
    const { app, proj } = buildProjectApp();
    expect((await patch(app, { path: proj, excludedTools: "bash" })).status).toBe(400);
    expect((await patch(app, { path: proj, tools: [1, 2] })).status).toBe(400);
    expect((await patch(app, { path: proj })).status).toBe(400);
  });

  test("GET /api/projects/tools 返回内置工具目录", async () => {
    const { app } = buildProjectApp();
    const res = await app.request("/api/projects/tools");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools.length).toBeGreaterThanOrEqual(5);
    expect(body.tools[0]).toEqual({ name: "read", builtin: true });
  });
});

// ---------------------------------------------------------------- restart 集成（mock spawn 断言 argv）

describe("工具启停 restart 集成（组合根同构 extraSpawnArgs）", () => {
  test("配置黑名单 → spawn argv 含 --exclude-tools；配置空集 → --no-tools；清除后不含", async () => { // bun test timeout arg below
    const projWith = tmp("tools17-spawn-");
    const stores = mkStores();
    const meta = openMetaDb({ path: join(tmp("tools17-meta-"), "meta.db") });
    writeFileSync(join(projWith, ".ul-omo-webui.json"), JSON.stringify({ version: 1, excludedTools: ["write", "bash"] }));
    // 与组合根 index.ts 同构：权限预设 + 工具启停两类参数合并附加
    const extra = (p: string) => [
      ...toolsSpawnArgsFromConfig(stores, meta, p),
    ];
    const probe = new TinyProbe();
    let client!: FakeEngineClient;
    const manager = new EngineProcessManager({
      clientFactory: (o) => {
        client = new FakeEngineClient(o);
        probe.pids.add(client.process.pid);
        return client;
      },
      probe,
      registryPath: join(projWith, "registry.json"),
      readyProbeIntervalMs: 1,
      readyProbeMaxAttempts: 10,
      crashPollMs: 60_000,
      extraSpawnArgs: extra,
    });
    try {
      await manager.ensureRunning(projWith);
      expect(client.spawnOpts.args).toContain("--exclude-tools");
      expect(client.spawnOpts.args).toContain("write,bash");
      await manager.stopAll();

      // 改配置为显式空集 → 重建进程（restart 通道）argv 含 --no-tools
      writeFileSync(join(projWith, ".ul-omo-webui.json"), JSON.stringify({ version: 1, tools: [] }));
      await manager.ensureRunning(projWith);
      expect(client.spawnOpts.args).toContain("--no-tools");
      expect(client.spawnOpts.args).not.toContain("--exclude-tools");
      await manager.stopAll();

      // null（未配置）→ argv 不含任何工具参数
      writeFileSync(join(projWith, ".ul-omo-webui.json"), JSON.stringify({ version: 1 }));
      await manager.ensureRunning(projWith);
      expect(client.spawnOpts.args).not.toContain("--tools");
      expect(client.spawnOpts.args).not.toContain("--exclude-tools");
      expect(client.spawnOpts.args).not.toContain("--no-tools");
    } finally {
      probe.pids.clear();
      await manager.stopAll();
      rmSync(projWith, { recursive: true, force: true });
    }
  }, 30_000);

  test("POST /api/projects/restart 走既有重启路由（工具启停生效口）", async () => {
    const { app, proj, restarts } = buildProjectApp();
    const res = await app.request("/api/projects/restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: proj }),
    });
    expect(res.status).toBe(200);
    expect(restarts).toEqual([proj]);
  });
});
