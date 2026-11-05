// 任务 14（engine-open-read-batch / F4 二轮 IS-2 残留）：questions/queue 冷态中性快照回归。
// 短板链（f4-fidelity.txt ROUND 2）：chat-view.tsx:224 reconcilePendingState → 并发
// GET /api/sessions/:id/questions + GET /api/sessions/:id/queue → questionsList/queueList
// → runTraced → ensureForSession → openLane → manager.ensureRunning——冷态打开会话即
// spawn 引擎。修复后（门同 usage 任务 13 先例）：
// - 冷态（无活跃绑定）：200 中性空体（queue {steering:[],followUp:[],ordered:[]} /
//   questions []，与 RPC 空回执同构），manager.ensureRunning 计数 0、rpc.openCalls 0、
//   队列/提问 RPC 面零调用（误导性成功输出防线：spawn 计数器断言而非仅无错）
// - 有活跃绑定：照旧 RPC（fake 队列/提问数值原样透传，帧注入 sessionId），无新增 spawn/open
// - 进程停但绑定态残留（stale_state）：仍中性空体，不重拉引擎
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

const PROJECT = "/tmp/opencode/rt-queue-q-proj";
const DURABLE_ID = "01c55555-0000-7000-8000-000000000014";
/** store 行可解析的合法会话文件体（header.timestamp + 一条带时间戳条目，
 *  runtime-usage-neutral.test.ts 同款口径） */
const SESSION_FILE_BODY =
  JSON.stringify({ type: "session", version: 3, id: DURABLE_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: PROJECT }) +
  "\n" +
  JSON.stringify({ type: "message", id: "e1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } }) +
  "\n";

/** fake 引擎 RPC：openSession/队列三查询计数；steering/followUp/pendingQuestions
 *  可注入（有绑定时 RPC 值透传断言源） */
class FakeQueueQuestionsRpc {
  openCalls = 0;
  steeringCalls = 0;
  followUpCalls = 0;
  stateCalls = 0;
  steering: string[] = [];
  followUp: string[] = [];
  state: Record<string, unknown> = {};

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
    return {};
  }
  async getMedia(): Promise<unknown> {
    return { type: "image", data: "", mimeType: "image/png" };
  }
  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    return { entries: [], leafId: null };
  }
  async getSteeringMessages(): Promise<string[]> {
    this.steeringCalls += 1;
    return this.steering;
  }
  async getFollowUpMessages(): Promise<string[]> {
    this.followUpCalls += 1;
    return this.followUp;
  }
  async getState(): Promise<Record<string, unknown>> {
    this.stateCalls += 1;
    return this.state;
  }
}

/** fake 管理器：ensureRunning 仅对未运行路径计数（真实管理器对已运行引擎幂等不
 *  重拉——spawn 计数语义）；status 可注入（stopped 模拟进程停但绑定态残留的 stale 形态） */
class FakeManager {
  ensureRunningCalls = 0;
  status: { state: "ready" | "starting" | "stopped" } = { state: "ready" };
  private readonly running = new Set<string>();
  constructor(private readonly rpc: FakeQueueQuestionsRpc) {}
  async ensureRunning(sessionPath: string): Promise<void> {
    if (this.running.has(sessionPath)) return;
    this.running.add(sessionPath);
    this.ensureRunningCalls += 1;
  }
  getClient(): FakeQueueQuestionsRpc {
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
  rpc: FakeQueueQuestionsRpc;
  manager: FakeManager;
  registry: EngineRuntimeRegistry;
  app: Hono;
} {
  const root = mkdtempSync(join(tmpdir(), "rt-queue-q-test-"));
  const agentDir = join(root, "agent");
  const sessionPath = join(agentDir, "sessions", encodeCwdToSessionDirName(PROJECT), `${DURABLE_ID}.jsonl`);
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, SESSION_FILE_BODY);
  const rpc = new FakeQueueQuestionsRpc();
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

describe("questions/queue 冷态中性快照（任务 14 / F4 二轮 IS-2 纯看免拉起）", () => {
  test("冷态打开会话：queue+questions 双 200 中性空体，spawn 计数 0（ensureRunning/openSession/队列提问 RPC 全 0）", async () => {
    const { root, rpc, manager, app } = setup();
    try {
      const [queueRes, questionsRes] = await Promise.all([
        app.request(`/api/sessions/${DURABLE_ID}/queue`),
        app.request(`/api/sessions/${DURABLE_ID}/questions`),
      ]);
      expect(queueRes.status).toBe(200);
      expect(questionsRes.status).toBe(200);
      const queueBody = (await queueRes.json()) as {
        sessionId: string;
        steering: string[];
        followUp: string[];
        ordered: unknown[];
      };
      const questionsBody = (await questionsRes.json()) as { sessionId: string; questions: unknown[] };
      // 中性空体：形状与 RPC 空回执同构（route 展开 queue；questions 包一层 questions）
      expect(queueBody.sessionId).toBe(DURABLE_ID);
      expect(queueBody.steering).toEqual([]);
      expect(queueBody.followUp).toEqual([]);
      expect(queueBody.ordered).toEqual([]);
      expect(questionsBody.sessionId).toBe(DURABLE_ID);
      expect(questionsBody.questions).toEqual([]);
      // 误导性成功输出防线：spawn 计数器断言（而非仅无错）——管理器零 ensureRunning、
      // 引擎零 openSession、队列三查询（steering/followUp/get_state）零调用
      expect(manager.ensureRunningCalls).toBe(0);
      expect(rpc.openCalls).toBe(0);
      expect(rpc.steeringCalls).toBe(0);
      expect(rpc.followUpCalls).toBe(0);
      expect(rpc.stateCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("有活跃绑定：RPC 语义不变（queue 提问数值原样透传 + 帧注入 sessionId，无新增 spawn/open）", async () => {
    const { root, rpc, manager, registry, app } = setup();
    try {
      // 建立绑定：messages 走 ensure（openCalls=1）
      await registry.messages(DURABLE_ID);
      expect(rpc.openCalls).toBe(1);
      expect(manager.ensureRunningCalls).toBe(1);

      rpc.steering = ["等回复落定", "换个思路"];
      rpc.followUp = ["接着上一条"];
      rpc.state = {
        pendingQuestions: [
          {
            type: "extension_ui_request",
            method: "question",
            id: "q-1",
            requestId: "req-1",
            toolCallId: "tc-1",
            waitForAnswer: true,
            questions: [{ id: "q-1", header: "确认", question: "选哪个？", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
            timeout: 300_000,
            askedAtMs: 1,
            deadlineAtMs: 300_001,
            remainingMs: 299_999,
          },
        ],
      };
      const [queueRes, questionsRes] = await Promise.all([
        app.request(`/api/sessions/${DURABLE_ID}/queue`),
        app.request(`/api/sessions/${DURABLE_ID}/questions`),
      ]);
      expect(queueRes.status).toBe(200);
      expect(questionsRes.status).toBe(200);
      const queueBody = (await queueRes.json()) as { steering: string[]; followUp: string[]; ordered: unknown[] };
      const questionsBody = (await questionsRes.json()) as { questions: Array<Record<string, unknown>> };
      // queue RPC 值原样透传
      expect(queueBody.steering).toEqual(["等回复落定", "换个思路"]);
      expect(queueBody.followUp).toEqual(["接着上一条"]);
      expect(queueBody.ordered).toEqual([]);
      // questions 帧 RPC 值透传 + 快照帧注入会话归属（runtime 层既有语义）
      expect(questionsBody.questions).toHaveLength(1);
      expect(questionsBody.questions[0]?.id).toBe("q-1");
      expect(questionsBody.questions[0]?.sessionId).toBe(DURABLE_ID);
      // 有绑定时不再走冷态 ensure（spawn/open 计数不增），RPC 面各恰一次
      expect(rpc.steeringCalls).toBe(1);
      expect(rpc.followUpCalls).toBe(1);
      expect(rpc.stateCalls).toBe(1);
      expect(rpc.openCalls).toBe(1);
      expect(manager.ensureRunningCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("进程停但绑定态残留（stale_state）：中性空体，不重拉引擎", async () => {
    const { root, rpc, manager, registry, app } = setup();
    try {
      await registry.messages(DURABLE_ID);
      expect(manager.ensureRunningCalls).toBe(1);
      // 注入：引擎进程已停（探活窗回收后/崩溃后），绑定态残留在表
      manager.status = { state: "stopped" };
      const [queueRes, questionsRes] = await Promise.all([
        app.request(`/api/sessions/${DURABLE_ID}/queue`),
        app.request(`/api/sessions/${DURABLE_ID}/questions`),
      ]);
      expect(queueRes.status).toBe(200);
      expect(questionsRes.status).toBe(200);
      const queueBody = (await queueRes.json()) as { steering: string[]; followUp: string[]; ordered: unknown[] };
      const questionsBody = (await questionsRes.json()) as { questions: unknown[] };
      expect(queueBody.steering).toEqual([]);
      expect(queueBody.ordered).toEqual([]);
      expect(questionsBody.questions).toEqual([]);
      // 不经 ensureRunning 重拉、不触队列/提问 RPC
      expect(manager.ensureRunningCalls).toBe(1);
      expect(rpc.steeringCalls).toBe(0);
      expect(rpc.followUpCalls).toBe(0);
      expect(rpc.stateCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("未知会话：404 语义不变（中性档不吞 resolveSession 结构化错误）", async () => {
    const { root, app } = setup();
    try {
      const [queueRes, questionsRes] = await Promise.all([
        app.request("/api/sessions/01dead-unknown/queue"),
        app.request("/api/sessions/01dead-unknown/questions"),
      ]);
      expect(queueRes.status).toBe(404);
      expect(questionsRes.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
