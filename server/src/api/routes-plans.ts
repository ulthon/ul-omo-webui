// 计划执行进度路由（r10 todo 12）+ 暂停/恢复控制面（2026-10-31 方案 b）：
// 会话绑定的 goal 计划 todo 勾选态速览 + 对绑定 work 的暂停（写 status=user_paused
// + abort 当回合）/ 恢复（写回 active + 固定 prompt 唤醒）。
// 直读项目 .omo 存储两件套——boulder.json（会话→work 绑定）+ plans/*.md（todo 行）。
// 写路径收敛为单文件单字段（boulder.json 绑定 work 的 status），读写机制见
// boulder-store.ts 头注释（tmp+rename 原子写、引擎状态门语义）。
//
// —— 会话→work 绑定规则（2026-10-28 磁盘实证）——
// boulder.json works[*].session_ids 形如 "senpi:01a17aca-…"（agent 前缀 + durable uuid）；
// webui 的 durable 会话 id（磁盘 jsonl header id，resolveSessionRow 的 id 字段）即该 uuid
// 本身（实证：~/.omo/agent/sessions/<encoded-cwd>/*.jsonl header id 与 boulder 条目去前缀
// 后同形）。因此绑定判定 = 条目去掉任意 "<agent>:" 前缀后与 durable id 精确相等：
//   entry === id || entry.endsWith(":" + id)
// 且 boulder.json 只从该会话所属项目 cwd（row.cwd）读取——按项目天然隔离，多项目/
// 多会话不串台（别的会话/别的项目/无 boulder 均得 bound:false，前端整块隐藏）。
// 同一会话被多个 work 绑定时优先 active_work_id，否则取 works 键序第一个。
//
// —— 计划 todo 行语法 ——
// 仅认列首（column-zero）的 `- [ ] N. 标题` / `- [x] N. 标题`（N 为纯数字）；
// 缩进续行（嵌套细节行）与非数字行（终验 F1-F4 等）一律忽略。
// 当前步 = 文件序首个未勾选行（顺序执行语义；全勾选 → currentTitle=null）。
import { readFile } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";
import { ACTIVE_STATUS, USER_PAUSED_STATUS, getBoundWork, setBoundWorkStatus } from "./boulder-store";
import { Hono } from "hono";
import { ApiError, requireParam, route } from "./http";
import type { EngineGateway } from "./engine-runtime";
import type { EngineSessionSummary } from "../adapter/engine-adapter";

/** 单条计划 todo 行（列首 `- [ ] N. 标题` 语法产物） */
export interface PlanTodoRow {
  num: number;
  title: string;
  done: boolean;
}

/** 计划 todo 汇总：N/M + 当前步（首个未勾选行；无未勾选为 null） */
export interface PlanTodoSummary {
  done: number;
  total: number;
  currentTitle: string | null;
}

/** GET /api/sessions/:id/plan-progress 响应：bound:false 时其余字段缺席 */
export interface PlanProgressSnapshot {
  bound: boolean;
  planName?: string;
  done?: number;
  total?: number;
  currentTitle?: string | null;
  /** 绑定 work 的 boulder 键（bound:true 时回传，供控制面定位） */
  workId?: string;
  /** 绑定 work 的 status 原样（引擎无枚举校验，任意字符串透传；缺失为 null）。
   *  "user_paused" = 用户暂停（续跑钩子永久沉默）；"active"/"paused" 为引擎可续跑态。 */
  status?: string | null;
}

/** 列首 todo 行：`- [([ x])] (数字). 标题`——缩进行不匹配（列首锚定），F 前缀行不匹配（纯数字捕获） */
const PLAN_TODO_ROW = /^- \[([ x])\] (\d+)\. (.+)$/;

/** 计划 md → todo 行集：仅列首数字行；CRLF 归一；标题去尾随空白。
 *  任何输入（含空串/无 todo 行）都不抛错——空数组即「无可展示项」。 */
export function parsePlanTodos(md: string): PlanTodoRow[] {
  const rows: PlanTodoRow[] = [];
  for (const rawLine of md.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const m = PLAN_TODO_ROW.exec(line);
    if (!m) continue;
    rows.push({ num: Number(m[2]), title: m[3].trimEnd(), done: m[1] === "x" });
  }
  return rows;
}

/** todo 行集 → 汇总：done/total + 当前步（文件序首个未勾选行，含编号前缀展示） */
export function summarizePlanTodos(rows: PlanTodoRow[]): PlanTodoSummary {
  const current = rows.find((r) => !r.done) ?? null;
  return {
    done: rows.filter((r) => r.done).length,
    total: rows.length,
    currentTitle: current ? `${current.num}. ${current.title}` : null,
  };
}

/** boulder.json 的 work 条目（仅取绑定与计划定位所需字段，宽松形状） */
interface BoulderWork {
  session_ids?: unknown;
  active_plan?: unknown;
  plan_name?: unknown;
  status?: unknown;
}

/** 绑定判定：boulder 会话键形如 "<agent>:<uuid>"，与 durable id（uuid 本身）按
 *  去前缀精确相等匹配。 */
function sessionKeyMatches(entry: unknown, sessionId: string): boolean {
  return typeof entry === "string" && (entry === sessionId || entry.endsWith(`:${sessionId}`));
}

/** boulder.json（宽松 unknown 形状）→ 当前会话绑定的 work 定位；
 *  无 works / 无匹配 / 结构畸形一律 null（调用方按未绑定隐藏，不崩）。 */
export function matchBoundWork(
  boulder: unknown,
  sessionId: string,
): { workId: string; planName: string; activePlan: string; status: string | null } | null {
  if (typeof boulder !== "object" || boulder === null) return null;
  const works = (boulder as { works?: unknown }).works;
  if (typeof works !== "object" || works === null) return null;
  const activeWorkId = (boulder as { active_work_id?: unknown }).active_work_id;
  const matches: string[] = [];
  for (const [workId, raw] of Object.entries(works as Record<string, unknown>)) {
    const work = raw as BoulderWork;
    if (!Array.isArray(work?.session_ids)) continue;
    if (work.session_ids.some((entry) => sessionKeyMatches(entry, sessionId))) matches.push(workId);
  }
  if (matches.length === 0) return null;
  // 多命中（罕见）：active_work_id 优先，其余取键序第一个
  const workId = matches.includes(String(activeWorkId)) ? String(activeWorkId) : matches[0];
  const work = (works as Record<string, BoulderWork>)[workId];
  const activePlan = typeof work.active_plan === "string" && work.active_plan !== "" ? work.active_plan : "";
  const planName = typeof work.plan_name === "string" && work.plan_name !== "" ? work.plan_name : workId;
  const status = typeof work.status === "string" ? work.status : null;
  if (activePlan === "") return null;
  return { workId, planName, activePlan, status };
}

/** 项目 cwd + 会话 id → 计划进度快照（全只读）。
 *  boulder 缺失/损坏/无绑定 → bound:false；work 已绑定但计划文件不可读/无 todo 行 →
 *  bound:true 且 total=0（绑定真实存在，仅无可展示数据——前端按 total=0 隐藏）。 */
export async function loadPlanProgress(cwd: string, sessionId: string): Promise<PlanProgressSnapshot> {
  let boulder: unknown;
  try {
    boulder = JSON.parse(await readFile(resolvePath(cwd, ".omo", "boulder.json"), "utf8"));
  } catch {
    return { bound: false };
  }
  const work = matchBoundWork(boulder, sessionId);
  if (!work) return { bound: false };
  const { status, workId, planName } = work;
  // 计划路径以 cwd 为基解析，且必须落在 cwd 内（active_plan 来自外部文件，防越界读）
  const planPath = resolvePath(cwd, work.activePlan);
  if (planPath !== cwd && !planPath.startsWith(cwd + sep)) {
    return { bound: true, planName, workId, status, done: 0, total: 0, currentTitle: null };
  }
  let summary: PlanTodoSummary = { done: 0, total: 0, currentTitle: null };
  try {
    summary = summarizePlanTodos(parsePlanTodos(await readFile(planPath, "utf8")));
  } catch {
    // 计划文件缺失/不可读：保持 0/0 空汇总（bound 真实，展示层隐藏）
  }
  return { bound: true, planName, workId, status, ...summary };
}

/** 会话行网关（结构能力探测先例同 routes-session.ts）：真实 registry 提供
 *  resolveSessionRow（纯读不 spawn），fake 测试按需提供。 */
type SessionRowGateway = EngineGateway & {
  resolveSessionRow?: (sessionId: string) => Promise<EngineSessionSummary | null>;
};

export interface PlansRouteDeps {
  engines: SessionRowGateway;
}

/** 恢复唤醒固定 prompt：回合结束后 agent_settled → 续跑钩子状态门放行 → 自动续跑链恢复 */
const RESUME_PROMPT = "恢复执行当前计划";

export function createPlansRoutes(deps: PlansRouteDeps): Hono {
  const app = new Hono();

  /** 解析会话行 + 定位绑定 work；未注册会话 404 / 未绑定 409（控制面共用前置） */
  const requireBoundWork = async (sessionId: string): Promise<{ cwd: string; workId: string }> => {
    const row = await deps.engines.resolveSessionRow?.(sessionId);
    if (!row) throw new ApiError(404, "session_not_found", `会话不存在：${sessionId}`);
    const bound = await getBoundWork(row.cwd, sessionId);
    if (!bound) throw new ApiError(409, "plan_not_bound", `会话未绑定任何执行中计划：${sessionId}`);
    return { cwd: row.cwd, workId: bound.workId };
  };

  // 暂停：先写盘（status=user_paused）后 abort——abort 引发的 settle 会立刻走续跑
  // 钩子，此时状态已是 user_paused，钩子判定 not-continuable，双保险。abort 失败
  // 不回滚：盘上状态已保证持久暂停，当回合最多多跑到自然结束。
  app.post(
    "/api/sessions/:id/plan-pause",
    route(async (c) => {
      const sessionId = requireParam(c, "id");
      const { cwd, workId } = await requireBoundWork(sessionId);
      await setBoundWorkStatus(cwd, sessionId, USER_PAUSED_STATUS);
      await deps.engines.abort(sessionId).catch(() => undefined);
      return c.json({ ok: true, workId, status: USER_PAUSED_STATUS });
    }),
  );

  // 恢复：改回 active + 发固定 prompt 唤醒。回合进行中 prompt 抛 409 already_processing
  // 原样透传（errors 词典已映射）；status 已落盘，唤醒可由下一次会话活动自然补上。
  app.post(
    "/api/sessions/:id/plan-resume",
    route(async (c) => {
      const sessionId = requireParam(c, "id");
      const { cwd, workId } = await requireBoundWork(sessionId);
      await setBoundWorkStatus(cwd, sessionId, ACTIVE_STATUS);
      await deps.engines.prompt(sessionId, { text: RESUME_PROMPT });
      return c.json({ ok: true, workId, status: ACTIVE_STATUS });
    }),
  );
  app.get(
    "/api/sessions/:id/plan-progress",
    route(async (c) => {
      const sessionId = requireParam(c, "id");
      const row = await deps.engines.resolveSessionRow?.(sessionId);
      if (!row) throw new ApiError(404, "session_not_found", `会话不存在：${sessionId}`);
      return c.json(await loadPlanProgress(row.cwd, sessionId));
    }),
  );
  return app;
}
