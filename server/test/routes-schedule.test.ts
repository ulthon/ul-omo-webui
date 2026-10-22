// schedule 定时任务路由 + 存储 + runner 监督单测（docs08 plan 任务 21）。
// 聚焦：CRUD 校验矩阵（schema/上限/会话解析）、取消墓碑、持久化往返、
// abandoned 标记、投递回注鉴权、runner 退出退避重启与关停不重启。
// 全部 mkdtemp 隔离，绝不触碰真实 agent 目录；调度时序一律 fake timers，零真实 sleep。
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { Hono } from "hono";
import {
  cancelScheduleJob,
  createScheduleJob,
  DEFAULT_CAPS,
  listScheduleJobs,
  abandonSessionJobs,
  MAX_PROMPT_BYTES,
  newJobId,
  scheduleDir,
  type ScheduleJob,
} from "../src/api/schedule-store";
import { createScheduleRoutes, createScheduleDeliverHandler, type ScheduleRouteDeps } from "../src/api/routes-schedule";
import { ScheduleRunnerSupervisor } from "../src/engine/schedule-runner";

// ---------------------------------------------------------------- 装配

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "t21-agent-"));
  tempRoots.push(dir);
  return dir;
}

function makeJob(dir: string, over: Partial<ScheduleJob> = {}): ScheduleJob {
  const now = Date.now();
  return {
    version: 1,
    id: newJobId(),
    sessionId: "ses-a",
    sessionFile: join(dir, "sessions", "ses-a.jsonl"),
    cwd: "/proj",
    prompt: "hello",
    createdAt: now,
    dueAt: now + 60_000,
    everyMs: null,
    fireCount: 0,
    lastFiredAt: null,
    lastError: null,
    ...over,
  };
}

interface Harness {
  app: Hono;
  deps: ScheduleRouteDeps & { prompts: Array<{ sessionId: string; text: string }> };
  agentDir: string;
  setSession: (row: { path: string; cwd: string } | null) => void;
  setRunnerAlive: (alive: boolean) => void;
}

function makeHarness(agentDirOverride?: string): Harness {
  const agentDir = agentDirOverride ?? makeAgentDir();
  let session: { path: string; cwd: string } | null = { path: join(agentDir, "sessions", "ses-a.jsonl"), cwd: "/proj" };
  let runnerAlive = false;
  const prompts: Array<{ sessionId: string; text: string }> = [];
  const deps: ScheduleRouteDeps & { prompts: Array<{ sessionId: string; text: string }> } = {
    agentDir,
    resolveSession: async (id) => (session && id === "ses-a" ? session : null),
    promptSession: async (sessionId, text) => {
      prompts.push({ sessionId, text });
      return { disposition: "handled" };
    },
    runnerAlive: () => runnerAlive,
    deliverToken: "test-token",
    prompts,
  };
  const app = new Hono();
  app.post("/api/schedule/deliver", createScheduleDeliverHandler(deps));
  app.route("/", createScheduleRoutes(deps));
  return {
    app,
    deps,
    agentDir,
    setSession: (row) => {
      session = row;
    },
    setRunnerAlive: (alive) => {
      runnerAlive = alive;
    },
  };
}

async function post(h: Harness, body: unknown): Promise<Response> {
  return h.app.request("/api/schedule", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------- CRUD 校验矩阵

describe("POST /api/schedule 校验矩阵", () => {
  test("happy：201 且直写 pending 文件，cwd/sessionFile 由会话行解析", async () => {
    const h = makeHarness();
    const res = await post(h, { sessionId: "ses-a", prompt: "到点提醒", due: Date.now() + 3600_000 });
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: ScheduleJob & { state: string } };
    expect(job.id).toMatch(/^sch_[a-z0-9]{12}$/);
    expect(job.state).toBe("pending");
    expect(job.cwd).toBe("/proj");
    expect(job.sessionFile).toBe(h.agentDir + "/sessions/ses-a.jsonl");
    expect(job.fireCount).toBe(0);
    const { jobs } = await listScheduleJobs(scheduleDir(h.agentDir));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("pending");
    expect(jobs[0].job.prompt).toBe("到点提醒");
  });

  test("未知会话 404；prompt 空 400；prompt 超 16KiB 400", async () => {
    const h = makeHarness();
    expect((await post(h, { sessionId: "ses-x", prompt: "hi", due: Date.now() + 1000 })).status).toBe(404);
    expect((await post(h, { sessionId: "ses-a", prompt: "  ", due: Date.now() + 1000 })).status).toBe(400);
    const big = "x".repeat(MAX_PROMPT_BYTES + 1);
    const res = await post(h, { sessionId: "ses-a", prompt: big, due: Date.now() + 1000 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_prompt");
    // 16KiB 边界内合法
    expect((await post(h, { sessionId: "ses-a", prompt: "x".repeat(MAX_PROMPT_BYTES), due: Date.now() + 1000 })).status).toBe(201);
  });

  test("due 非法 400；超 366 天 400；过去时刻合法（引擎下次扫描即触发）", async () => {
    const h = makeHarness();
    expect((await post(h, { sessionId: "ses-a", prompt: "p", due: "not-a-date" })).status).toBe(400);
    expect((await post(h, { sessionId: "ses-a", prompt: "p", due: Number.NaN })).status).toBe(400);
    expect((await post(h, { sessionId: "ses-a", prompt: "p", due: Date.now() + 400 * 24 * 3600_000 })).status).toBe(400);
    expect((await post(h, { sessionId: "ses-a", prompt: "p", due: Date.now() - 60_000 })).status).toBe(201);
    expect((await post(h, { sessionId: "ses-a", prompt: "p", due: new Date().toISOString() })).status).toBe(201);
  });

  test("everyMs < 60s 或非整数 400；null/合法值通过", async () => {
    const h = makeHarness();
    expect((await post(h, { sessionId: "ses-a", prompt: "p", due: Date.now() + 1000, everyMs: 30_000 })).status).toBe(400);
    expect((await post(h, { sessionId: "ses-a", prompt: "p", due: Date.now() + 1000, everyMs: 1.5 })).status).toBe(400);
    expect((await post(h, { sessionId: "ses-a", prompt: "p", due: Date.now() + 1000, everyMs: null })).status).toBe(201);
    expect((await post(h, { sessionId: "ses-a", prompt: "p", due: Date.now() + 1000, everyMs: 60_000 })).status).toBe(201);
  });

  test("上限：单会话第 51 条 400 schedule_limit", async () => {
    const h = makeHarness();
    const dir = scheduleDir(h.agentDir);
    mkdirSync(join(dir, "pending"), { recursive: true });
    for (let i = 0; i < DEFAULT_CAPS.perSession; i++) {
      await createScheduleJob(dir, makeJob(dir, { sessionId: "ses-a" }));
    }
    const res = await post(h, { sessionId: "ses-a", prompt: "p", due: Date.now() + 1000 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("schedule_limit");
  });
});

// ---------------------------------------------------------------- GET / DELETE / 持久化

describe("GET 与 DELETE", () => {
  test("GET：跨状态列表按到期升序，invalid 如实回显，runner 存活态透传", async () => {
    const agentDir = makeAgentDir();
    const dir = scheduleDir(agentDir);
    const now = Date.now();
    await createScheduleJob(dir, makeJob(dir, { dueAt: now + 200 }));
    await createScheduleJob(dir, makeJob(dir, { dueAt: now + 100 }));
    // firing/failed 记录（引擎 runner 写入形态，本侧只读）
    mkdirSync(join(dir, "firing"), { recursive: true });
    mkdirSync(join(dir, "failed"), { recursive: true });
    const firingJob = makeJob(dir, { id: "sch_aaaaaaaaaaaa" });
    writeFileSync(join(dir, "firing", `${firingJob.id}@1~123-456.json`), `${JSON.stringify(firingJob, null, 2)}\n`);
    const failedJob = makeJob(dir, { id: "sch_bbbbbbbbbbbb" });
    writeFileSync(join(dir, "failed", `${failedJob.id}@1.json`), `${JSON.stringify(failedJob, null, 2)}\n`);
    writeFileSync(join(dir, "pending", "garbage.json"), "{broken");
    const h = makeHarness(agentDir);
    h.setRunnerAlive(true);
    const res = await h.app.request("/api/schedule");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: (ScheduleJob & { state: string })[]; invalid: unknown[]; runner: { alive: boolean } };
    expect(body.runner.alive).toBe(true);
    expect(body.jobs.map((j) => j.dueAt)).toEqual(body.jobs.map((j) => j.dueAt).sort((a, b) => a - b));
    const states = Object.fromEntries(body.jobs.map((j) => [j.id, j.state]));
    expect(states[firingJob.id]).toBe("firing");
    expect(states[failedJob.id]).toBe("failed");
    expect(body.jobs.filter((j) => j.state === "pending")).toHaveLength(2);
    expect(body.invalid.length).toBeGreaterThanOrEqual(1);
  });

  test("DELETE：pending → cancelled 墓碑移动；二次 404；列表不再含", async () => {
    const h = makeHarness();
    const { job } = (await (await post(h, { sessionId: "ses-a", prompt: "p", due: Date.now() + 1000 })).json()) as { job: ScheduleJob };
    const dir = scheduleDir(h.agentDir);
    const res = await h.app.request(`/api/schedule/${job.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    // 墓碑落位：cancelled/<id>（无 .json，引擎 isCancelled 只看存在性）
    expect(existsSync(join(dir, "cancelled", job.id))).toBe(true);
    expect(existsSync(join(dir, "pending", `${job.id}.json`))).toBe(false);
    expect((await h.app.request(`/api/schedule/${job.id}`, { method: "DELETE" })).status).toBe(404);
    const list = (await (await h.app.request("/api/schedule")).json()) as { jobs: { id: string }[] };
    expect(list.jobs.map((j) => j.id)).not.toContain(job.id);
  });

  test("持久化往返：跨实例写读一致（新 listScheduleJobs 读同目录）", async () => {
    const agentDir = makeAgentDir();
    const dir = scheduleDir(agentDir);
    const job = makeJob(dir, { prompt: "roundtrip" });
    await createScheduleJob(dir, job);
    const { jobs } = await listScheduleJobs(dir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job).toEqual(job);
    // 取消后再读：pending 空，墓碑在
    expect(await cancelScheduleJob(dir, job.id)).toEqual(job);
    expect((await listScheduleJobs(dir)).jobs).toHaveLength(0);
  });

  test("引擎写入形态兼容：sessionFile null 的 pending 记录可解析（对拍发现回归）", async () => {
    const agentDir = makeAgentDir();
    const dir = scheduleDir(agentDir);
    await createScheduleJob(dir, makeJob(dir, { sessionFile: null }));
    const { jobs, invalid } = await listScheduleJobs(dir);
    expect(invalid).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job.sessionFile).toBeNull();
  });

  test("会话删除标记：pending 迁 failed 且 lastError 记 abandoned（任务 21c）", async () => {
    const agentDir = makeAgentDir();
    const dir = scheduleDir(agentDir);
    await createScheduleJob(dir, makeJob(dir, { sessionId: "ses-gone" }));
    await createScheduleJob(dir, makeJob(dir, { sessionId: "ses-kept" }));
    const marked = await abandonSessionJobs(dir, "ses-gone", "abandoned: session deleted");
    expect(marked).toHaveLength(1);
    const { jobs } = await listScheduleJobs(dir);
    const gone = jobs.find((r) => r.job.sessionId === "ses-gone");
    expect(gone?.state).toBe("failed");
    expect(gone?.job.lastError).toBe("abandoned: session deleted");
    expect(jobs.find((r) => r.job.sessionId === "ses-kept")?.state).toBe("pending");
  });
});

// ---------------------------------------------------------------- 投递回注端点

describe("POST /api/schedule/deliver", () => {
  const event = {
    type: "scheduled_prompt",
    id: "sch_aaaaaaaaaaaa",
    sessionId: "ses-a",
    sessionFile: "/x.jsonl",
    cwd: "/proj",
    prompt: "原始 prompt",
    message: "带溯源头的 prompt",
    dueAt: Date.now(),
    firedAt: Date.now(),
    everyMs: null,
    fireCount: 1,
  };

  test("token 错 401；token 对则 prompt 注入既有网关（排队语义在网关内）", async () => {
    const h = makeHarness();
    const bad = await h.app.request("/api/schedule/deliver", {
      method: "POST",
      body: JSON.stringify(event),
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    });
    expect(bad.status).toBe(401);
    const ok = await h.app.request("/api/schedule/deliver", {
      method: "POST",
      body: JSON.stringify(event),
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; disposition: string };
    expect(body).toEqual({ ok: true, disposition: "handled" });
    expect(h.deps.prompts).toEqual([{ sessionId: "ses-a", text: event.message }]);
  });

  test("会话已删除：404 如实失败（runner 归档 failed），prompt 不触发", async () => {
    const h = makeHarness();
    h.setSession(null);
    const res = await h.app.request("/api/schedule/deliver", {
      method: "POST",
      body: JSON.stringify(event),
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(404);
    expect(h.deps.prompts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- runner 监督

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  stderr: EventEmitter | null = new EventEmitter();
  signals: string[] = [];
  kill(sig: string): boolean {
    this.signals.push(sig);
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }
  /** 测试手动模拟进程退出 */
  crash(code: number | null): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

describe("ScheduleRunnerSupervisor", () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  function makeSupervisor(spawnImpl: typeof import("node:child_process").spawn, agentDir: string) {
    return new ScheduleRunnerSupervisor({
      cliPath: "/fake/cli.js",
      agentDir,
      dataDir: agentDir,
      deliverUrl: "http://127.0.0.1:7788/api/schedule/deliver",
      deliverToken: "t",
      spawnImpl: spawnImpl as never,
      backoffBaseMs: 1000,
      backoffMaxMs: 8000,
    });
  }

  test("启动拉起子进程（argv 含 run --watch --exec）；退出后退避重启；重启间隔指数退避", async () => {
    const agentDir = makeAgentDir();
    const children: FakeChild[] = [];
    let failFirst = false;
    const spawnImpl = (() => {
      if (failFirst) throw new Error("spawn boom");
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as never;
    const supervisor = makeSupervisor(spawnImpl, agentDir);
    failFirst = true;
    supervisor.start();
    failFirst = false; // 仅首次 spawn 失败，验证退避重试后拉起
    // 首次 spawn 抛错 → 1s 后重试
    expect(children).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(1);
    expect(supervisor.alive()).toBe(true);
    // 进程崩溃 → 退避 2s 重启
    children[0].crash(null);
    expect(supervisor.alive()).toBe(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);
    // 再次崩溃 → 退避 4s（指数）
    children[1].crash(null);
    await vi.advanceTimersByTimeAsync(3999);
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(3);
    await supervisor.stop();
  });

  test("stop 后子进程退出不再重启；hook 脚本落盘且含 fetch 回注", async () => {
    const agentDir = makeAgentDir();
    const children: FakeChild[] = [];
    const spawnImpl = (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as never;
    const supervisor = makeSupervisor(spawnImpl, agentDir);
    supervisor.start();
    expect(children).toHaveLength(1);
    await supervisor.stop();
    expect(children[0].signals).toContain("SIGTERM");
    children[0].crash(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1);
    const hook = join(agentDir, "schedule-deliver-hook.mjs");
    expect(existsSync(hook)).toBe(true);
    const text = readFileSync(hook, "utf8");
    expect(text).toContain("UL_OMO_WEBUI_SCHEDULE_DELIVER_URL");
    expect(text).toContain("fetch");
  });

  test("连续 spawn 失败达上限 → degraded()（创建降级禁用判定）", async () => {
    const agentDir = makeAgentDir();
    let failures = 0;
    const spawnImpl = (() => {
      failures += 1;
      throw new Error("no bundle");
    }) as never;
    const supervisor = makeSupervisor(spawnImpl, agentDir);
    supervisor.start();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(failures).toBeGreaterThanOrEqual(3);
    expect(supervisor.degraded()).toBe(true);
    await supervisor.stop();
  });
});
