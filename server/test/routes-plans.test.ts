// 计划执行进度只读路由 + 解析/绑定纯函数单测（r10 todo 12）。
// fixture：plan-r10-excerpt.md 是真实 r10 计划的逐字摘录（未勾选/已勾选/缩进续行/
// 非数字 F 行全覆盖）；boulder 形状取自真实 .omo/boulder.json。
// 路由面全走 mkdtemp 隔离目录（boulder.json + plans 落临时盘），不触碰真实 agent 目录。
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { clearBoulderCacheForTest } from "../src/api/boulder-store";
import {
  createPlansRoutes,
  loadPlanProgress,
  matchBoundWork,
  parsePlanTodos,
  summarizePlanTodos,
} from "../src/api/routes-plans";

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

const FIXTURE_PLAN = readFileSync(new URL("./fixtures/plan-r10-excerpt.md", import.meta.url).pathname, "utf8");

// ---------------------------------------------------------------- 解析（纯函数）

describe("parsePlanTodos：r10 计划 fixture（真实语法）", () => {
  test("列首数字行全收：9 行（10-18），嵌套续行与 F 行被忽略", () => {
    const rows = parsePlanTodos(FIXTURE_PLAN);
    expect(rows.map((r) => r.num)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    // 缩进续行（What to do / Closes / …）与 F1-F4 不进行集
    expect(rows.some((r) => r.title.includes("What to do"))).toBe(false);
    expect(rows.some((r) => /F\d/.test(r.title))).toBe(false);
    expect(rows.some((r) => r.title.includes("Plan compliance audit"))).toBe(false);
  });

  test("勾选态与标题逐字保留（16 为唯一勾选行）", () => {
    const rows = parsePlanTodos(FIXTURE_PLAN);
    const done = rows.filter((r) => r.done);
    expect(done).toHaveLength(1);
    expect(done[0].num).toBe(16);
    expect(done[0].title).toBe("工具启停 spike：引擎能力面探查");
    expect(rows.find((r) => r.num === 12)?.title).toBe("计划执行进度面板");
  });

  test("汇总：done=1/total=9，当前步=文件序首个未勾选行（含编号前缀）", () => {
    const s = summarizePlanTodos(parsePlanTodos(FIXTURE_PLAN));
    expect(s).toEqual({
      done: 1,
      total: 9,
      currentTitle: "10. 帧桥接 spike：引擎事件帧可达性探查",
    });
  });

  test("全勾选：currentTitle=null", () => {
    const s = summarizePlanTodos([
      { num: 1, title: "a", done: true },
      { num: 2, title: "b", done: true },
    ]);
    expect(s).toEqual({ done: 2, total: 2, currentTitle: null });
  });
});

describe("parsePlanTodos：畸形输入不崩", () => {
  test("空串 / 无 todo 行 / 纯嵌套行 → 空数组", () => {
    expect(parsePlanTodos("")).toEqual([]);
    expect(parsePlanTodos("# 只有标题\n\n正文段落\n")).toEqual([]);
    expect(parsePlanTodos("  - [ ] 1. 缩进行不算\n")).toEqual([]);
  });

  test("CRLF 归一：标题不带 \\r 尾巴", () => {
    const rows = parsePlanTodos("- [x] 3. 标题\r\n- [ ] 4. 次行\r\n");
    expect(rows).toEqual([
      { num: 3, title: "标题", done: true },
      { num: 4, title: "次行", done: false },
    ]);
  });

  test("非数字编号 / 空标题 / 大写 X 不匹配（语法严格档）", () => {
    expect(parsePlanTodos("- [ ] F1. 终验\n")).toEqual([]);
    expect(parsePlanTodos("- [ ] 5.\n")).toEqual([]);
    expect(parsePlanTodos("- [X] 6. 大写\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------- 绑定（纯函数）

/** 真实 boulder.json 形状样例（字段值照抄磁盘实证形态） */
function sampleBoulder(): unknown {
  return {
    schema_version: 2,
    active_work_id: "r10-2026-10-27-batch",
    works: {
      "r9-2026-10-26-batch": {
        work_id: "r9-2026-10-26-batch",
        active_plan: ".omo/plans/r9-2026-10-26-batch.md",
        plan_name: "r9-2026-10-26-batch",
        session_ids: ["senpi:01a17750-052d-7dd1-8a27-fcbce00ff1d4"],
        status: "paused",
      },
      "r10-2026-10-27-batch": {
        work_id: "r10-2026-10-27-batch",
        active_plan: ".omo/plans/r10-2026-10-27-batch.md",
        plan_name: "r10-2026-10-27-batch",
        session_ids: ["senpi:01a17aca-809a-7984-a8fe-8c286eaf9caf"],
        status: "paused",
      },
    },
  };
}

describe("matchBoundWork：会话→work 绑定规则", () => {
  test("绑定会话：senpi: 前缀条目去前缀后与 durable id 精确相等", () => {
    const work = matchBoundWork(sampleBoulder(), "01a17aca-809a-7984-a8fe-8c286eaf9caf");
    expect(work).toEqual({
      workId: "r10-2026-10-27-batch",
      planName: "r10-2026-10-27-batch",
      activePlan: ".omo/plans/r10-2026-10-27-batch.md",
      status: "paused",
    });
  });

  test("status 缺失/非字符串 → status:null（宽松透传，不假设默认值）", () => {
    const boulder = { works: { w: { session_ids: ["senpi:s1"], active_plan: "p.md" } } };
    expect(matchBoundWork(boulder, "s1")?.status).toBeNull();
  });

  test("裸 id 条目（无前缀）同样精确匹配", () => {
    const boulder = {
      works: { w: { session_ids: ["11111111-2222-3333-4444-555555555555"], active_plan: ".omo/plans/w.md" } },
    };
    expect(matchBoundWork(boulder, "11111111-2222-3333-4444-555555555555")?.workId).toBe("w");
  });

  test("其他会话（绑另一 goal）不串台：返回 null", () => {
    // r9 的会话 id 在 works 中，但查的是不存在于任何 work 的 id
    expect(matchBoundWork(sampleBoulder(), "99999999-9999-9999-9999-999999999999")).toBeNull();
  });

  test("畸形输入不崩：无 works / 非对象 / session_ids 非数组 / 缺 active_plan", () => {
    expect(matchBoundWork(null, "x")).toBeNull();
    expect(matchBoundWork({ works: null }, "x")).toBeNull();
    expect(matchBoundWork({ works: {} }, "x")).toBeNull();
    expect(matchBoundWork({ works: { w: { session_ids: "not-array" } } }, "x")).toBeNull();
    const noPlan = { works: { w: { session_ids: ["senpi:x"] } } };
    expect(matchBoundWork(noPlan, "x")).toBeNull();
  });

  test("多 work 同绑一会话：active_work_id 优先", () => {
    const boulder = {
      active_work_id: "later",
      works: {
        early: { session_ids: ["senpi:s1"], active_plan: ".omo/plans/early.md" },
        later: { session_ids: ["senpi:s1"], active_plan: ".omo/plans/later.md" },
      },
    };
    expect(matchBoundWork(boulder, "s1")?.workId).toBe("later");
  });
});

// ---------------------------------------------------------------- 装配 + 路由

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "t12-plan-"));
  tempRoots.push(dir);
  return dir;
}

function writeProjectStore(
  dir: string,
  boulder: unknown,
  plans: Record<string, string> = { "plan.md": FIXTURE_PLAN },
): void {
  mkdirSync(join(dir, ".omo", "plans"), { recursive: true });
  writeFileSync(join(dir, ".omo", "boulder.json"), typeof boulder === "string" ? boulder : JSON.stringify(boulder));
  for (const [name, md] of Object.entries(plans)) {
    writeFileSync(join(dir, ".omo", "plans", name), md);
  }
}

const BOUND_ID = "01a17aca-809a-7984-a8fe-8c286eaf9caf";
const OTHER_ID = "01a17750-052d-7dd1-8a27-fcbce00ff1d4";

function boundBoulder(activePlan = ".omo/plans/plan.md"): unknown {
  return {
    active_work_id: "w",
    works: {
      w: { work_id: "w", active_plan: activePlan, plan_name: "r10-2026-10-27-batch", session_ids: [`senpi:${BOUND_ID}`] },
    },
  };
}

interface RecordedEngineCall {
  method: string;
  sessionId: string;
  input?: unknown;
}

interface Harness {
  app: Hono;
  cwd: string;
  setCwd: (cwd: string | null) => void;
  calls: RecordedEngineCall[];
  /** 覆写引擎行为（默认无旁路副作用直接成功） */
  engines: { abortImpl?: () => Promise<void>; promptImpl?: () => Promise<unknown> };
}

function makeHarness(cwd: string): Harness {
  let current: string | null = cwd;
  const calls: RecordedEngineCall[] = [];
  const engines: Harness["engines"] = {};
  const app = createPlansRoutes({
    engines: {
      resolveSessionRow: async (id: string) =>
        current && (id === BOUND_ID || id === OTHER_ID)
          ? {
              path: join(current, "sessions", `${id}.jsonl`),
              id,
              cwd: current,
              created: "2026-10-27T00:00:00.000Z",
              modified: "2026-10-28T00:00:00.000Z",
              messageCount: 1,
              firstMessage: "",
            }
          : null,
      abort: async (id: string) => {
        calls.push({ method: "abort", sessionId: id });
        if (engines.abortImpl) return engines.abortImpl();
      },
      prompt: async (id: string, input: unknown) => {
        calls.push({ method: "prompt", sessionId: id, input });
        if (engines.promptImpl) return engines.promptImpl();
        return { disposition: "new" };
      },
    } as never,
  });
  return { app, cwd, setCwd: (next) => { current = next; }, calls, engines };
}

afterEach(() => {
  clearBoulderCacheForTest();
});

describe("loadPlanProgress：项目 .omo 存储（临时盘）", () => {
  test("绑定会话：N/M + 当前步 + 计划名", async () => {
    const dir = makeProject();
    writeProjectStore(dir, boundBoulder());
    const snap = await loadPlanProgress(dir, BOUND_ID);
    expect(snap).toEqual({
      bound: true,
      planName: "r10-2026-10-27-batch",
      workId: "w",
      status: null,
      done: 1,
      total: 9,
      currentTitle: "10. 帧桥接 spike：引擎事件帧可达性探查",
    });
  });

  test("无 boulder.json / boulder 损坏 / 无绑定会话 → bound:false", async () => {
    const dir = makeProject();
    // 无 boulder
    expect(await loadPlanProgress(dir, BOUND_ID)).toEqual({ bound: false });
    // 损坏 JSON
    writeProjectStore(dir, "{not json");
    expect(await loadPlanProgress(dir, BOUND_ID)).toEqual({ bound: false });
    // boulder 完好但会话未绑任何 work
    writeProjectStore(dir, boundBoulder());
    expect(await loadPlanProgress(dir, OTHER_ID)).toEqual({ bound: false });
  });

  test("boulder 缺 works → bound:false 不崩", async () => {
    const dir = makeProject();
    writeProjectStore(dir, { schema_version: 2, active_work_id: null });
    expect(await loadPlanProgress(dir, BOUND_ID)).toEqual({ bound: false });
  });

  test("work 已绑但计划文件缺失 → bound:true 且 0/0（展示层隐藏）", async () => {
    const dir = makeProject();
    writeProjectStore(dir, boundBoulder(".omo/plans/absent.md"), {});
    const snap = await loadPlanProgress(dir, BOUND_ID);
    expect(snap).toEqual({ bound: true, planName: "r10-2026-10-27-batch", workId: "w", status: null, done: 0, total: 0, currentTitle: null });
  });

  test("计划 md 无 todo 行 → bound:true 且 0/0", async () => {
    const dir = makeProject();
    writeProjectStore(dir, boundBoulder(), { "plan.md": "# 无 todo 的计划\n\n仅正文。\n" });
    const snap = await loadPlanProgress(dir, BOUND_ID);
    expect(snap).toEqual({ bound: true, planName: "r10-2026-10-27-batch", workId: "w", status: null, done: 0, total: 0, currentTitle: null });
  });

  test("active_plan 越界（逃出项目 cwd）→ 0/0，不读外部文件", async () => {
    const dir = makeProject();
    writeProjectStore(dir, boundBoulder("../../outside.md"), {});
    const snap = await loadPlanProgress(dir, BOUND_ID);
    expect(snap).toEqual({ bound: true, planName: "r10-2026-10-27-batch", workId: "w", status: null, done: 0, total: 0, currentTitle: null });
  });
});

describe("GET /api/sessions/:id/plan-progress（路由）", () => {
  test("绑定会话 200 快照；未绑定会话 200 bound:false；未知会话 404", async () => {
    const dir = makeProject();
    writeProjectStore(dir, boundBoulder());
    const h = makeHarness(dir);

    const ok = await h.app.request(`/api/sessions/${BOUND_ID}/plan-progress`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      bound: true,
      planName: "r10-2026-10-27-batch",
      workId: "w",
      status: null,
      done: 1,
      total: 9,
      currentTitle: "10. 帧桥接 spike：引擎事件帧可达性探查",
    });

    const unbound = await h.app.request(`/api/sessions/${OTHER_ID}/plan-progress`);
    expect(unbound.status).toBe(200);
    expect(await unbound.json()).toEqual({ bound: false });

    const missing = await h.app.request("/api/sessions/unknown-id/plan-progress");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "session_not_found" } });
  });

  test("项目无 .omo 存储（如 worktree 会话）→ 200 bound:false 不崩", async () => {
    const dir = makeProject(); // 空目录，无 .omo
    const h = makeHarness(dir);
    const res = await h.app.request(`/api/sessions/${BOUND_ID}/plan-progress`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bound: false });
  });

  test("快照回传 workId/status：user_paused 态可见（控制面三态数据源）", async () => {
    const dir = makeProject();
    const boulder = boundBoulder() as { works: Record<string, { status: string }> };
    boulder.works.w.status = "user_paused";
    writeProjectStore(dir, boulder);
    const snap = await loadPlanProgress(dir, BOUND_ID);
    expect(snap).toMatchObject({ bound: true, workId: "w", status: "user_paused" });
  });
});

// ---------------------------------------------------------------- 暂停/恢复路由（方案 b）

/* eslint-disable @typescript-eslint/no-explicit-any */
function readBoulderRaw(dir: string): any {
  return JSON.parse(readFileSync(join(dir, ".omo", "boulder.json"), "utf8"));
}

describe("POST plan-pause / plan-resume（控制面）", () => {
  test("pause：先写 status=user_paused，再调 abort，响应回 workId/status", async () => {
    const dir = makeProject();
    writeProjectStore(dir, boundBoulder());
    const h = makeHarness(dir);
    const order: string[] = [];
    h.engines.abortImpl = async () => {
      // 写盘先于 abort：abort 引发的 settle 走续跑钩子时状态必须已是 user_paused
      order.push(readBoulderRaw(dir).works.w.status);
    };
    const res = await h.app.request(`/api/sessions/${BOUND_ID}/plan-pause`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, workId: "w", status: "user_paused" });
    expect(order).toEqual(["user_paused"]);
    expect(h.calls).toEqual([{ method: "abort", sessionId: BOUND_ID }]);
    expect((readBoulderRaw(dir).works as Record<string, { status: string }>).w.status).toBe("user_paused");
    // 其余字段原样保留（只改 status 的写面收敛）
    expect(readBoulderRaw(dir).active_work_id).toBe("w");
  });

  test("resume：写回 active + 清 stale_since + 刷 updated_at，并发固定唤醒 prompt", async () => {
    const dir = makeProject();
    const boulder = boundBoulder() as { works: Record<string, Record<string, unknown>> };
    boulder.works.w.status = "user_paused";
    boulder.works.w.stale_since = "2026-10-30T00:00:00.000Z";
    boulder.works.w.updated_at = "2026-10-29T00:00:00.000Z";
    writeProjectStore(dir, boulder);
    const h = makeHarness(dir);
    const res = await h.app.request(`/api/sessions/${BOUND_ID}/plan-resume`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, workId: "w", status: "active" });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].method).toBe("prompt");
    expect(h.calls[0].sessionId).toBe(BOUND_ID);
    expect((h.calls[0].input as { text: string }).text).toBe("恢复执行当前计划");
    const work = (readBoulderRaw(dir).works as Record<string, Record<string, unknown>>).w;
    expect(work.status).toBe("active");
    expect("stale_since" in work).toBe(false);
    expect(work.updated_at).not.toBe("2026-10-29T00:00:00.000Z");
  });

  test("pause 幂等：user_paused 态可重复暂停（abort 照发，状态不变）", async () => {
    const dir = makeProject();
    const boulder = boundBoulder() as { works: Record<string, { status: string }> };
    boulder.works.w.status = "user_paused";
    writeProjectStore(dir, boulder);
    const h = makeHarness(dir);
    const res = await h.app.request(`/api/sessions/${BOUND_ID}/plan-pause`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([{ method: "abort", sessionId: BOUND_ID }]);
  });

  test("abort 失败不回滚：盘上 user_paused 已保证持久暂停，响应仍 200", async () => {
    const dir = makeProject();
    writeProjectStore(dir, boundBoulder());
    const h = makeHarness(dir);
    h.engines.abortImpl = async () => {
      throw new Error("engine gone");
    };
    const res = await h.app.request(`/api/sessions/${BOUND_ID}/plan-pause`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((readBoulderRaw(dir).works as Record<string, { status: string }>).w.status).toBe("user_paused");
  });

  test("错误映射：未知会话 404 session_not_found；未绑定 409 plan_not_bound 且零副作用", async () => {
    const dir = makeProject();
    writeProjectStore(dir, boundBoulder());
    const h = makeHarness(dir);
    const missing = await h.app.request("/api/sessions/unknown-id/plan-pause", { method: "POST" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "session_not_found" } });

    const unboundPause = await h.app.request(`/api/sessions/${OTHER_ID}/plan-pause`, { method: "POST" });
    expect(unboundPause.status).toBe(409);
    expect(await unboundPause.json()).toMatchObject({ error: { code: "plan_not_bound" } });
    const unboundResume = await h.app.request(`/api/sessions/${OTHER_ID}/plan-resume`, { method: "POST" });
    expect(unboundResume.status).toBe(409);
    expect(h.calls).toEqual([]); // 未绑定不触发 abort/prompt
    // 未绑定不写盘
    expect((readBoulderRaw(dir).works as Record<string, { status?: string }>).w.status).toBeUndefined();
  });

  test("resume 遇回合进行中：409 already_processing 原样透传（status 已落盘）", async () => {
    const dir = makeProject();
    writeProjectStore(dir, boundBoulder());
    const h = makeHarness(dir);
    h.engines.promptImpl = async () => {
      throw new Error("ApiError: already_processing");
    };
    const res = await h.app.request(`/api/sessions/${BOUND_ID}/plan-resume`, { method: "POST" });
    expect(res.status).toBe(500); // fake 抛普通 Error → 500 兜底；真实网关抛 ApiError(409)
    expect((readBoulderRaw(dir).works as Record<string, { status: string }>).w.status).toBe("active");
  });

  test("boulder 损坏时 pause/resume → 409 plan_not_bound（与引擎视为无 boulder 同语义）", async () => {
    const dir = makeProject();
    writeProjectStore(dir, "{not json");
    const h = makeHarness(dir);
    const res = await h.app.request(`/api/sessions/${BOUND_ID}/plan-pause`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "plan_not_bound" } });
  });

  test("并发写缓解：pause 只改绑定 work 的 status，同文件其他 work 与字段原样保留", async () => {
    const dir = makeProject();
    const boulder = {
      schema_version: 2,
      active_work_id: "w",
      works: {
        w: { work_id: "w", active_plan: ".omo/plans/plan.md", plan_name: "n", session_ids: [`senpi:${BOUND_ID}`], status: "active", note: { keep: 1 } },
        other: { work_id: "other", active_plan: ".omo/plans/plan.md", plan_name: "o", session_ids: ["senpi:someone-else"], status: "active" },
      },
    };
    writeProjectStore(dir, boulder);
    const h = makeHarness(dir);
    await h.app.request(`/api/sessions/${BOUND_ID}/plan-pause`, { method: "POST" });
    const raw = readBoulderRaw(dir) as { schema_version: number; works: Record<string, Record<string, unknown>> };
    expect(raw.schema_version).toBe(2);
    expect(raw.works.w.status).toBe("user_paused");
    expect(raw.works.w.note).toEqual({ keep: 1 });
    expect(raw.works.other.status).toBe("active");
  });
});
