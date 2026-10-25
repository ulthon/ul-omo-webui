// 会话第四态「后台运行中」单测（docs08-2026-10-23-24-batch 任务 12）：
// - 纯函数 hasRunningBackgroundTask：spawn 回执启动态/终态回执/完成通知（结构化+文本）/
//   畸形输入（垃圾行、缺字段、重复终态回执）全对抗面；
// - GET /api/sessions：(a) 后台回执无终局 → background_running；(b) 追加完成通知后回落
//   idle；(c) 「服务重启」（清磁盘缓存重读 jsonl）后状态恢复——第四态纯磁盘派生不依赖内存；
// - running/waiting 不被后台态覆盖（三态既有语义不动）。
import { describe, expect, test, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { EngineGateway, ServerSessionRunState } from "../src/api/engine-runtime";
import { createSessionRoutes } from "../src/api/routes-session";
import { openMetaDb } from "../src/db/meta";
import type { EngineSessionSummary } from "../src/adapter/engine-adapter";
import { clearBackgroundStateCache, hasRunningBackgroundTask } from "../src/api/background-tasks";

// ---------------------------------------------------------------- 纯函数

function toolResultLine(toolCallId: string, details: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId, content: [], details } });
}

function completionStructuredLine(taskId: string, status = "completed"): string {
  return JSON.stringify({
    type: "custom_message",
    customType: "omo-senpi:wake",
    content: "task completion",
    details: [{ customType: "senpi-task.completion", details: [{ task_id: taskId, status, duration_ms: 1000 }] }],
  });
}

function completionTextLine(taskId: string): string {
  return JSON.stringify({
    type: "custom_message",
    customType: "omo-senpi:wake",
    content: `task completion name:${taskId} id:${taskId} agent:x status:completed duration:14.92s tokens:1 tools:1 tps:1\nresult:"done"`,
  });
}

describe("hasRunningBackgroundTask（与 web subagent-data.ts dispatched 同口径）", () => {
  test("后台 spawn 回执（running/pending）无终局 → true", () => {
    for (const status of ["running", "pending"]) {
      const text = [toolResultLine("call_1", { run_in_background: true, status, task_id: "st_1" })].join("\n");
      expect(hasRunningBackgroundTask(text)).toBe(true);
    }
  });

  test("前台回执 / 终态回执 / 缺 task_id 的启动态回执 → false", () => {
    expect(hasRunningBackgroundTask(toolResultLine("c", { run_in_background: false, status: "running", task_id: "st" }))).toBe(false);
    expect(hasRunningBackgroundTask(toolResultLine("c", { run_in_background: true, status: "completed", task_id: "st" }))).toBe(false);
    // 启动态但缺 task_id：无法与完成通知配对，宁漏勿错不计入
    expect(hasRunningBackgroundTask(toolResultLine("c", { run_in_background: true, status: "running" }))).toBe(false);
    expect(hasRunningBackgroundTask(toolResultLine("c", {}))).toBe(false);
  });

  test("完成通知（结构化 / 文本兜底）终局化 → false", () => {
    const spawn = toolResultLine("call_1", { run_in_background: true, status: "running", task_id: "st_1" });
    expect(hasRunningBackgroundTask([spawn, completionStructuredLine("st_1")].join("\n"))).toBe(false);
    expect(hasRunningBackgroundTask([spawn, completionTextLine("st_1")].join("\n"))).toBe(false);
  });

  test("同 toolCallId 重复回执：后到的终态覆盖先到的启动态（duplicated-terminal）", () => {
    const text = [
      toolResultLine("call_1", { run_in_background: true, status: "running", task_id: "st_1" }),
      toolResultLine("call_1", { run_in_background: true, status: "completed", task_id: "st_1" }),
    ].join("\n");
    expect(hasRunningBackgroundTask(text)).toBe(false);
  });

  test("畸形输入：垃圾行 / 非 JSON / 撕裂尾行 / 非 Message 条目静默跳过", () => {
    const spawn = toolResultLine("call_1", { run_in_background: true, status: "running", task_id: "st_1" });
    const garbage = ["not json at all", "{ torn line", JSON.stringify({ type: "summary", data: 1 }), ""].join("\n");
    expect(hasRunningBackgroundTask([garbage, spawn].join("\n"))).toBe(true);
    expect(hasRunningBackgroundTask(garbage)).toBe(false);
    expect(hasRunningBackgroundTask("")).toBe(false);
  });

  test("多个后台任务：一个终局一个在途 → true；全部终局 → false", () => {
    const a = toolResultLine("call_1", { run_in_background: true, status: "running", task_id: "st_1" });
    const b = toolResultLine("call_2", { run_in_background: true, status: "pending", task_id: "st_2" });
    expect(hasRunningBackgroundTask([a, b, completionStructuredLine("st_1")].join("\n"))).toBe(true);
    expect(hasRunningBackgroundTask([a, b, completionStructuredLine("st_1"), completionStructuredLine("st_2")].join("\n"))).toBe(false);
  });
});

// ---------------------------------------------------------------- GET /api/sessions

class FakeGateway implements EngineGateway {
  constructor(readonly sessions: EngineSessionSummary[]) {}
  runStateMap: Map<string, "running" | "waiting"> | null = null;
  async sessionsList(): Promise<EngineSessionSummary[]> {
    return this.sessions;
  }
  async createSession(): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new Error("unused");
  }
  async messages(): Promise<never> {
    throw new Error("unused");
  }
  async prompt(): Promise<{ disposition: string }> {
    throw new Error("unused");
  }
  async queueList(): Promise<never> {
    throw new Error("unused");
  }
  async queueClear(): Promise<never> {
    throw new Error("unused");
  }
  async abort(): Promise<void> {}
  async permissionRespond(): Promise<void> {}
  async questionsList(): Promise<never> {
    throw new Error("unused");
  }
  async usage(): Promise<never> {
    throw new Error("unused");
  }
  async modelsList(): Promise<never[]> {
    return [];
  }
  async commandsList(): Promise<null> {
    return null;
  }
  async deleteSession(): Promise<{ sessionPath: string; fileExisted: boolean }> {
    throw new Error("unused");
  }
  async exportSessionHtml(): Promise<never> {
    throw new Error("unused");
  }
  async forkSession(): Promise<never> {
    throw new Error("unused");
  }
  async peekActiveSessionPaths(): Promise<string[] | null> {
    return null;
  }
  peekRunStates?: (project: string) => Promise<Map<string, ServerSessionRunState> | null> = async () =>
    this.runStateMap ? new Map(this.runStateMap) : new Map();
  async restartProject(): Promise<void> {}
  async stopAll(): Promise<void> {}
}

function summary(partial: Partial<EngineSessionSummary> & { id: string; path: string }): EngineSessionSummary {
  return { cwd: "/proj", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessage: "hello", ...partial };
}

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearBackgroundStateCache();
});

function buildApp(engines: EngineGateway): Hono {
  const app = new Hono();
  const metaDir = mkdtempSync(join(tmpdir(), "bg-meta-"));
  cleanup.push(metaDir);
  const meta = openMetaDb({ path: join(metaDir, "meta.db") });
  app.route("/", createSessionRoutes({ meta, engines }));
  return app;
}

describe("GET /api/sessions 第四态派生", () => {
  test("(a) 后台回执无终局 → background_running；无后台回执行 → idle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-sessions-"));
    const bgPath = join(dir, "bg.jsonl");
    const plainPath = join(dir, "plain.jsonl");
    writeFileSync(bgPath, toolResultLine("call_1", { run_in_background: true, status: "running", task_id: "st_1" }));
    writeFileSync(plainPath, toolResultLine("call_2", { run_in_background: false, status: "completed", task_id: "st_2" }));
    const engines = new FakeGateway([
      summary({ id: "bg", path: bgPath }),
      summary({ id: "plain", path: plainPath }),
    ]);
    const app = buildApp(engines);
    const res = await app.request(`/api/sessions?project=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = new Map(body.sessions.map((s: { id: string; runState: string }) => [s.id, s.runState]));
    expect(byId.get("bg")).toBe("background_running");
    expect(byId.get("plain")).toBe("idle");
  });

  test("(b) 追加完成通知后回落 idle（mtime/size 失效重读）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-terminal-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, toolResultLine("call_1", { run_in_background: true, status: "running", task_id: "st_1" }));
    const app = buildApp(new FakeGateway([summary({ id: "s", path })]));
    const first = await (await app.request(`/api/sessions?project=${encodeURIComponent(dir)}`)).json();
    expect(first.sessions[0].runState).toBe("background_running");
    appendFileSync(path, completionStructuredLine("st_1") + "\n");
    const second = await (await app.request(`/api/sessions?project=${encodeURIComponent(dir)}`)).json();
    expect(second.sessions[0].runState).toBe("idle");
  });

  test("(c) 服务重启模拟：清磁盘缓存（重启后内存态全失）重读 jsonl 恢复 background_running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-restart-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, toolResultLine("call_1", { run_in_background: true, status: "pending", task_id: "st_1" }));
    const app = buildApp(new FakeGateway([summary({ id: "s", path })]));
    const first = await (await app.request(`/api/sessions?project=${encodeURIComponent(dir)}`)).json();
    expect(first.sessions[0].runState).toBe("background_running");
    // 重启 = 缓存全空 + 全新路由实例，仅凭 jsonl 恢复
    clearBackgroundStateCache();
    const app2 = buildApp(new FakeGateway([summary({ id: "s", path })]));
    const second = await (await app2.request(`/api/sessions?project=${encodeURIComponent(dir)}`)).json();
    expect(second.sessions[0].runState).toBe("background_running");
  });

  test("三态优先：running/waiting 行不被后台态覆盖（既有语义不动）", async () => {
    const dir = mkdirSync(join(tmpdir(), "bg-priority-"), { recursive: true }) as string;
    cleanup.push(dir);
    const path = join(dir, "s.jsonl");
    writeFileSync(path, toolResultLine("call_1", { run_in_background: true, status: "running", task_id: "st_1" }));
    const engines = new FakeGateway([summary({ id: "s", path })]);
    engines.runStateMap = new Map([[path, "waiting"]]);
    const app = buildApp(engines);
    const body = await (await app.request(`/api/sessions?project=${encodeURIComponent(dir)}`)).json();
    expect(body.sessions[0].runState).toBe("waiting");
    engines.runStateMap = new Map([[path, "running"]]);
    const body2 = await (await app.request(`/api/sessions?project=${encodeURIComponent(dir)}`)).json();
    expect(body2.sessions[0].runState).toBe("running");
  });
});
