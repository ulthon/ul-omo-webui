// 后台任务内存账本单测（orphan-ledger 2026-10-31，spike §3 设计）：
// - 账本生命周期：spawn（pending→running）/ 终局快照 / 空快照删键 / 畸形条目窄化；
// - 推导合并：GET /api/sessions 第四态 jsonl-only / ledger-only / both / neither；
// - 引擎死亡失效：账本清项目 + jsonl 假阳性修复（回执已落盘 + 引擎死亡 →
//   background_running 清除；死亡后文件有新活动 → 解除冻结恢复常态推导）。
// 全部确定性：帧直接经 EventBus.publish 注入（真实扇出路径），无 sleep / 轮询。
import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { EventBus } from "../src/engine/events";
import {
  attachBackgroundTaskLedger,
  clearBackgroundTaskLedger,
  handleProjectEngineDeath,
  ledgerHasRunning,
  ledgerRunningSessionIds,
  resetBackgroundTaskLedger,
} from "../src/api/background-task-ledger";
import {
  clearBackgroundStateCache,
  hasRunningBackgroundTask,
  invalidateBackgroundStateOnEngineDeath,
  sessionBackgroundRunning,
} from "../src/api/background-tasks";
import type { EngineGateway, ServerSessionRunState } from "../src/api/engine-runtime";
import { createSessionRoutes } from "../src/api/routes-session";
import { openMetaDb } from "../src/db/meta";
import type { EngineSessionSummary } from "../src/adapter/engine-adapter";

// ---------------------------------------------------------------- 注入工具

function taskUpdatedFrame(projectPath: string, parentSessionId: string, tasks: unknown) {
  return {
    projectPath,
    event: {
      type: "extension_event",
      name: "omo.task.updated",
      sessionId: "rpc-1",
      data: { parent_session_id: parentSessionId, tasks },
    },
  } as const;
}

/** 通过真实 EventBus 扇出注入快照（与 index.ts 装配路径一致） */
function feed(bus: EventBus, projectPath: string, parentSessionId: string, tasks: unknown): void {
  bus.publish(projectPath, taskUpdatedFrame(projectPath, parentSessionId, tasks).event);
}

afterEach(() => {
  resetBackgroundTaskLedger();
  clearBackgroundStateCache();
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cleanup: string[] = [];

// ---------------------------------------------------------------- 账本生命周期

describe("后台任务账本（omo.task.updated 快照整包替换）", () => {
  function setup(): EventBus {
    const bus = new EventBus({ capacity: 100 });
    attachBackgroundTaskLedger(bus);
    return bus;
  }

  test("spawn 生命周期：pending → running → 终局快照（running 消失）", () => {
    const bus = setup();
    const project = "/proj-a";
    feed(bus, project, "sess-1", [{ task_id: "st_1", status: "pending", task_summary: "跑测试", updated_at: "t1" }]);
    expect(ledgerHasRunning(project, "sess-1")).toBe(true);
    feed(bus, project, "sess-1", [{ task_id: "st_1", status: "running", task_summary: "跑测试", updated_at: "t2" }]);
    expect(ledgerHasRunning(project, "sess-1")).toBe(true);
    // 终局：FULL SNAPSHOT 语义，任务仍在包内但 status 终态
    feed(bus, project, "sess-1", [{ task_id: "st_1", status: "completed", task_summary: "跑测试", updated_at: "t3" }]);
    expect(ledgerHasRunning(project, "sess-1")).toBe(false);
    // 终局快照后新一轮 spawn 重回启动态（同键整包替换，不残留旧终态）
    feed(bus, project, "sess-1", [{ task_id: "st_2", status: "running", task_summary: "再跑", updated_at: "t4" }]);
    expect(ledgerHasRunning(project, "sess-1")).toBe(true);
  });

  test("空快照删键（快照即真相，重放/乱序安全）", () => {
    const bus = setup();
    feed(bus, "/proj-a", "sess-1", [{ task_id: "st_1", status: "running", task_summary: "x", updated_at: "t" }]);
    feed(bus, "/proj-a", "sess-1", []);
    expect(ledgerHasRunning("/proj-a", "sess-1")).toBe(false);
    expect(ledgerRunningSessionIds("/proj-a")).toEqual([]);
  });

  test("项目隔离：同 durable id 不同项目互不影响", () => {
    const bus = setup();
    feed(bus, "/proj-a", "sess-1", [{ task_id: "st_1", status: "running", task_summary: "x", updated_at: "t" }]);
    expect(ledgerHasRunning("/proj-a", "sess-1")).toBe(true);
    expect(ledgerHasRunning("/proj-b", "sess-1")).toBe(false);
  });

  test("非任务帧 / 畸形条目窄化（web narrowTasks 同构：id 缺失跳过，status 缺失不判启动态）", () => {
    const bus = setup();
    // 非 extension_event / 非任务事件 / 缺 parent_session_id：不进账本
    bus.publish("/proj-a", { type: "message_updated", sessionId: "rpc-1" } as never);
    bus.publish("/proj-a", { type: "extension_event", name: "omo.other", sessionId: "rpc-1", data: {} } as never);
    bus.publish("/proj-a", { type: "extension_event", name: "omo.task.updated", sessionId: "rpc-1", data: {} } as never);
    expect(ledgerHasRunning("/proj-a", "")).toBe(false);
    // tasks 非数组 / 条目畸形：窄化后为空或不判启动态
    feed(bus, "/proj-a", "sess-1", "not-an-array");
    expect(ledgerHasRunning("/proj-a", "sess-1")).toBe(false);
    feed(bus, "/proj-a", "sess-1", [{ status: "running" }, { task_id: "st_9" }, "junk", null]);
    expect(ledgerHasRunning("/proj-a", "sess-1")).toBe(false); // st_9 无 status
  });

  test("clearProject / ledgerRunningSessionIds / handleProjectEngineDeath 清项目", () => {
    const bus = setup();
    feed(bus, "/proj-a", "s1", [{ task_id: "st_1", status: "running", task_summary: "x", updated_at: "t" }]);
    feed(bus, "/proj-a", "s2", [{ task_id: "st_2", status: "pending", task_summary: "y", updated_at: "t" }]);
    feed(bus, "/proj-b", "s3", [{ task_id: "st_3", status: "running", task_summary: "z", updated_at: "t" }]);
    expect(ledgerRunningSessionIds("/proj-a").sort()).toEqual(["s1", "s2"]);
    clearBackgroundTaskLedger("/proj-a");
    expect(ledgerHasRunning("/proj-a", "s1")).toBe(false);
    expect(ledgerHasRunning("/proj-b", "s3")).toBe(true);
  });

  test("退订后帧不再进账本", () => {
    const bus = new EventBus({ capacity: 100 });
    const detach = attachBackgroundTaskLedger(bus);
    detach();
    feed(bus, "/proj-a", "sess-1", [{ task_id: "st_1", status: "running", task_summary: "x", updated_at: "t" }]);
    expect(ledgerHasRunning("/proj-a", "sess-1")).toBe(false);
  });
});

// ---------------------------------------------------------------- 推导合并（jsonl OR ledger）

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
  return {
    cwd: "/proj",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
    ...partial,
  };
}

function toolResultLine(toolCallId: string, details: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId, content: [], details } });
}

function buildApp(engines: EngineGateway): Hono {
  const app = new Hono();
  const metaDir = mkdtempSync(join(tmpdir(), "ledger-meta-"));
  cleanup.push(metaDir);
  const meta = openMetaDb({ path: join(metaDir, "meta.db") });
  app.route("/", createSessionRoutes({ meta, engines }));
  return app;
}

async function runStatesOf(app: Hono, project: string): Promise<Map<string, string>> {
  const res = await app.request(`/api/sessions?project=${encodeURIComponent(project)}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  return new Map(body.sessions.map((s: { id: string; runState: string }) => [s.id, s.runState]));
}

describe("GET /api/sessions 第四态 jsonl OR 账本合并", () => {
  test("jsonl-only：回执已落盘无账本帧 → background_running（既有口径不动）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-merge-"));
    cleanup.push(dir);
    const path = join(dir, "s.jsonl");
    writeFileSync(path, toolResultLine("c1", { run_in_background: true, status: "running", task_id: "st_1" }));
    const app = buildApp(new FakeGateway([summary({ id: "durable-1", path })]));
    const states = await runStatesOf(app, dir);
    expect(states.get("durable-1")).toBe("background_running");
  });

  test("ledger-only：abort 竞态回执未落盘，账本帧兜底可见（缺陷本体修复）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-merge-"));
    cleanup.push(dir);
    const path = join(dir, "s.jsonl");
    // jsonl 无任何后台回执（被 abort 销毁的形态）
    writeFileSync(path, toolResultLine("c1", { run_in_background: false, status: "completed", task_id: "st_x" }));
    const bus = new EventBus({ capacity: 100 });
    attachBackgroundTaskLedger(bus);
    feed(bus, dir, "durable-1", [{ task_id: "st_1", status: "running", task_summary: "孤儿", updated_at: "t" }]);
    const app = buildApp(new FakeGateway([summary({ id: "durable-1", path })]));
    const states = await runStatesOf(app, dir);
    expect(states.get("durable-1")).toBe("background_running");
  });

  test("both / neither：双真源一致 background_running；双无回落 idle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-merge-"));
    cleanup.push(dir);
    const bothPath = join(dir, "both.jsonl");
    const neitherPath = join(dir, "neither.jsonl");
    writeFileSync(bothPath, toolResultLine("c1", { run_in_background: true, status: "pending", task_id: "st_1" }));
    writeFileSync(neitherPath, "");
    const bus = new EventBus({ capacity: 100 });
    attachBackgroundTaskLedger(bus);
    feed(bus, dir, "both", [{ task_id: "st_1", status: "running", task_summary: "x", updated_at: "t" }]);
    const app = buildApp(
      new FakeGateway([summary({ id: "both", path: bothPath }), summary({ id: "neither", path: neitherPath })]),
    );
    const states = await runStatesOf(app, dir);
    expect(states.get("both")).toBe("background_running");
    expect(states.get("neither")).toBe("idle");
  });

  test("三态优先：running/waiting 不被账本叠加覆盖（既有语义不动）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-merge-"));
    cleanup.push(dir);
    const path = join(dir, "s.jsonl");
    writeFileSync(path, "");
    const bus = new EventBus({ capacity: 100 });
    attachBackgroundTaskLedger(bus);
    feed(bus, dir, "s", [{ task_id: "st_1", status: "running", task_summary: "x", updated_at: "t" }]);
    const engines = new FakeGateway([summary({ id: "s", path })]);
    engines.runStateMap = new Map([[path, "waiting"]]);
    const states = await runStatesOf(buildApp(engines), dir);
    expect(states.get("s")).toBe("waiting");
  });
});

// ---------------------------------------------------------------- 引擎死亡失效（含假阳性修复）

describe("引擎死亡失效：账本清项目 + jsonl 假阳性冻结", () => {
  test("假阳性场景：回执已落盘 + 引擎死亡 → background_running 清除（第二缺陷修复）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-death-"));
    cleanup.push(dir);
    const path = join(dir, "s.jsonl");
    writeFileSync(path, toolResultLine("c1", { run_in_background: true, status: "running", task_id: "st_1" }));
    expect(hasRunningBackgroundTask(
      toolResultLine("c1", { run_in_background: true, status: "running", task_id: "st_1" }),
    )).toBe(true);
    expect(sessionBackgroundRunning(path)).toBe(true);
    // 引擎死亡（spike §4：owner-fd 看门狗 ≤2s 全树死亡 → 启动态回执可证明已死）
    invalidateBackgroundStateOnEngineDeath([path]);
    expect(sessionBackgroundRunning(path)).toBe(false);
    // 纯重算不变式：jsonl 文本本身未变，抑制只来自死亡冻结
    expect(sessionBackgroundRunning(path)).toBe(false);
  });

  test("死亡后文件有新活动 → 冻结解除，新回执重新派生 background_running（不误伤后续运行）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-death-"));
    cleanup.push(dir);
    const path = join(dir, "s.jsonl");
    writeFileSync(path, toolResultLine("c1", { run_in_background: true, status: "running", task_id: "st_1" }));
    expect(sessionBackgroundRunning(path)).toBe(true);
    invalidateBackgroundStateOnEngineDeath([path]);
    expect(sessionBackgroundRunning(path)).toBe(false);
    // 死亡后新 spawn（jsonl 增长，指纹变化）→ 常态推导恢复
    appendFileSync(path, "\n" + toolResultLine("c2", { run_in_background: true, status: "running", task_id: "st_2" }));
    expect(sessionBackgroundRunning(path)).toBe(true);
  });

  test("handleProjectEngineDeath：账本项目快照清除 + 冻结 jsonl 推导（组合入口）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-death-"));
    cleanup.push(dir);
    const path = join(dir, "s.jsonl");
    writeFileSync(path, toolResultLine("c1", { run_in_background: true, status: "running", task_id: "st_1" }));
    const bus = new EventBus({ capacity: 100 });
    attachBackgroundTaskLedger(bus);
    feed(bus, dir, "s", [{ task_id: "st_1", status: "running", task_summary: "x", updated_at: "t" }]);
    expect(ledgerHasRunning(dir, "s")).toBe(true);
    expect(sessionBackgroundRunning(path)).toBe(true);

    handleProjectEngineDeath(dir, [path]);
    expect(ledgerHasRunning(dir, "s")).toBe(false);
    expect(sessionBackgroundRunning(path)).toBe(false);
  });
});
