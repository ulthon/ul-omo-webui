// 任务 13（engine-open-read-batch / F4 IS-2 纯看免拉起）：usage 冷态中性快照回归。
// IS-2 短板链（f4-fidelity.txt）：GET /api/usage → runTraced → ensureForSession
// → openLane → manager.ensureRunning——冷态切会话即 spawn 引擎。修复后：
// - 冷态（无活跃绑定）：200 中性零值体，manager.ensureRunning 计数 0、rpc.openCalls 0
//   （误导性成功输出防线：spawn 计数器断言而非仅无错）
// - 有活跃绑定：照旧 RPC（fake getSessionStats 数值原样透传），无新增 spawn/open
// - 进程停但绑定态残留（stale_state）：仍中性零值，不重拉引擎
// - 未知会话：404 语义不变
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import type { EngineProcessManager } from "../src/engine/process-manager";
import { EngineRuntimeRegistry } from "../src/api/engine-runtime";
import { encodeCwdToSessionDirName } from "../src/adapter/senpi-adapter";
import { createSessionRoutes } from "../src/api/routes-session";
import { openMetaDb } from "../src/db/meta";
import { openConfigStore } from "../src/conf/config-store";
import { createProjectConfigStores } from "../src/api/config-migration";

const PROJECT = "/tmp/opencode/rt-usage-proj";
const DURABLE_ID = "01c33333-0000-7000-8000-000000000013";
/** store 行可解析的合法会话文件体（header.timestamp + 一条带时间戳条目，
 *  runtime-active-reopen.test.ts 同款口径） */
const SESSION_FILE_BODY =
  JSON.stringify({ type: "session", version: 3, id: DURABLE_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: PROJECT }) +
  "\n" +
  JSON.stringify({ type: "message", id: "e1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } }) +
  "\n";

/** fake 引擎 RPC：openSession/getSessionStats 计数；stats 可注入（有绑定时 RPC 值） */
class FakeUsageRpc {
  openCalls = 0;
  statsCalls = 0;
  stats: Record<string, unknown> = {};

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setClientInfo(): Promise<void> {}
  async send(): Promise<{ success: boolean }> {
    return { success: true };
  }
  async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
    return { provider, id: modelId };
  }
  async openSession(options: { sessionPath?: string }): Promise<{
    sessionId: string;
    state: { sessionId: string; sessionFile?: string };
  }> {
    this.openCalls += 1;
    return { sessionId: "rpc-1", state: { sessionId: DURABLE_ID, sessionFile: options.sessionPath } };
  }
  async closeSession(): Promise<void> {}
  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return [];
  }
  async prompt(): Promise<string> {
    return "started";
  }
  async abort(): Promise<void> {}
  onEvent(): () => void {
    return () => {};
  }
  async sendExtensionUIResponse(): Promise<void> {}
  async getAvailableModels(): Promise<unknown[]> {
    return [];
  }
  async getAvailableThinkingLevels(): Promise<string[]> {
    return ["low", "high", "max"];
  }
  async getSessionStats(): Promise<Record<string, unknown>> {
    this.statsCalls += 1;
    return this.stats;
  }
  async getMedia(): Promise<unknown> {
    return { type: "image", data: "", mimeType: "image/png" };
  }
  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    return { entries: [], leafId: null };
  }
  async getState(): Promise<Record<string, unknown>> {
    return {};
  }
}

/** fake 管理器：ensureRunning 仅对未运行路径计数（真实管理器对已运行引擎幂等不
 *  重拉——spawn 计数语义）；status 可注入（stopped 模拟进程停但绑定态残留的 stale 形态） */
class FakeManager {
  ensureRunningCalls = 0;
  status: { state: "ready" | "starting" | "stopped" } = { state: "ready" };
  private readonly running = new Set<string>();
  constructor(private readonly rpc: FakeUsageRpc) {}
  async ensureRunning(sessionPath: string): Promise<void> {
    if (this.running.has(sessionPath)) return;
    this.running.add(sessionPath);
    this.ensureRunningCalls += 1;
  }
  getClient(): FakeUsageRpc {
    return this.rpc;
  }
  getStatus(): { state: string } {
    return this.status;
  }
  onEvent(): () => void {
    return () => {};
  }
  async stop(): Promise<void> {}
  async stopAll(): Promise<void> {}
  reportSessionActive(): void {}
  markUserActivity(): void {}
}

function setup(): {
  root: string;
  sessionPath: string;
  rpc: FakeUsageRpc;
  manager: FakeManager;
  registry: EngineRuntimeRegistry;
  app: Hono;
} {
  const root = mkdtempSync(join(tmpdir(), "rt-usage-test-"));
  const agentDir = join(root, "agent");
  const sessionPath = join(agentDir, "sessions", encodeCwdToSessionDirName(PROJECT), `${DURABLE_ID}.jsonl`);
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, SESSION_FILE_BODY);
  const rpc = new FakeUsageRpc();
  const manager = new FakeManager(rpc);
  const registry = new EngineRuntimeRegistry(manager as unknown as EngineProcessManager, {
    listProjects: () => [PROJECT],
    agentDir,
  });
  const meta = openMetaDb({ path: join(root, "meta.db") });
  const configs = openConfigStore({ globalDir: join(root, "global") });
  const app = new Hono();
  app.route("/", createSessionRoutes({ meta, engines: registry, configs, projectConfigs: createProjectConfigStores(configs) }));
  return { root, sessionPath, rpc, manager, registry, app };
}

describe("usage 冷态中性快照（任务 13 / F4 IS-2 纯看免拉起）", () => {
  test("冷态切会话：200 中性零值体，spawn 计数 0（ensureRunning/openSession/getSessionStats 全 0）", async () => {
    const { root, sessionPath, rpc, manager, app } = setup();
    try {
      const res = await app.request(`/api/usage?session=${DURABLE_ID}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessionId: string;
        usage: {
          sessionId: string;
          sessionFile: string | undefined;
          userMessages: number;
          totalMessages: number;
          tokens: { total: number };
          cost: number;
          contextUsage?: { tokens: number; contextWindow: number; percent: number };
          turnSpeed?: unknown;
        };
      };
      expect(body.sessionId).toBe(DURABLE_ID);
      // 中性零值：形状与 RPC 响应同构（mapUsageStats 字段面），数值全零
      expect(body.usage.sessionId).toBe(DURABLE_ID);
      expect(body.usage.sessionFile).toBe(sessionPath);
      expect(body.usage.userMessages).toBe(0);
      expect(body.usage.totalMessages).toBe(0);
      expect(body.usage.tokens.total).toBe(0);
      expect(body.usage.cost).toBe(0);
      expect(body.usage.contextUsage).toEqual({ tokens: 0, contextWindow: 0, percent: 0 });
      expect(body.usage.turnSpeed).toBeUndefined();
      // 误导性成功输出防线：spawn 计数器断言（而非仅无错）——管理器零 ensureRunning、
      // 引擎零 openSession、零 getSessionStats
      expect(manager.ensureRunningCalls).toBe(0);
      expect(rpc.openCalls).toBe(0);
      expect(rpc.statsCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("有活跃绑定：RPC 语义不变（stats 原样透传，无新增 spawn/open）", async () => {
    const { root, rpc, manager, registry, app } = setup();
    try {
      // 建立绑定：messages 走 ensure（openCalls=1）
      await registry.messages(DURABLE_ID);
      expect(rpc.openCalls).toBe(1);
      expect(manager.ensureRunningCalls).toBe(1);

      rpc.stats = {
        sessionId: DURABLE_ID,
        userMessages: 3,
        assistantMessages: 2,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 6,
        tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
        cost: 1.25,
        contextUsage: { tokens: 8000, contextWindow: 200000, percent: 4 },
      };
      const res = await app.request(`/api/usage?session=${DURABLE_ID}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        usage: { totalMessages: number; tokens: { total: number }; cost: number; contextUsage?: { percent: number } };
      };
      expect(body.usage.totalMessages).toBe(6);
      expect(body.usage.tokens.total).toBe(165);
      expect(body.usage.cost).toBe(1.25);
      expect(body.usage.contextUsage?.percent).toBe(4);
      // 有绑定时不再走冷态 ensure（spawn/open 计数不增）
      expect(rpc.statsCalls).toBe(1);
      expect(rpc.openCalls).toBe(1);
      expect(manager.ensureRunningCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("进程停但绑定态残留（stale_state）：中性零值，不重拉引擎", async () => {
    const { root, rpc, manager, registry, app } = setup();
    try {
      await registry.messages(DURABLE_ID);
      expect(manager.ensureRunningCalls).toBe(1);
      // 注入：引擎进程已停（探活窗回收后/崩溃后），绑定态残留在表
      manager.status = { state: "stopped" };
      const res = await app.request(`/api/usage?session=${DURABLE_ID}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { usage: { totalMessages: number; tokens: { total: number } } };
      expect(body.usage.totalMessages).toBe(0);
      expect(body.usage.tokens.total).toBe(0);
      // 不经 ensureRunning 重拉、不触引擎 RPC
      expect(manager.ensureRunningCalls).toBe(1);
      expect(rpc.statsCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("未知会话：404 语义不变（中性档不吞 resolveSession 结构化错误）", async () => {
    const { root, app } = setup();
    try {
      const res = await app.request("/api/usage?session=01dead-unknown");
      expect(res.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
