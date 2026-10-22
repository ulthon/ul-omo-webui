// schedule 定时任务 REST 路由（docs08 plan 任务 21）：
// - GET  /api/schedule            直读 <agentDir>/schedule/{pending,firing,failed}
// - POST /api/schedule            直写 pending job 文件（schema 对齐引擎）
// - DELETE /api/schedule/:id      pending → cancelled 墓碑移动
// - POST /api/schedule/deliver    runner --exec 投递桥回注端点（免登录中间件，
//                                  按每次启动随机 bearer token 鉴权，挂载在
//                                  /api/* 鉴权之前——见 index.ts 装配）
// 到期触发由托管的引擎 runner（schedule-runner.ts）负责，本路由只管 CRUD 与回注。
import { Hono, type Context } from "hono";
import { ApiError, parseJsonBody, requireParam, route } from "./http";
import {
  cancelScheduleJob,
  createScheduleJob,
  JOB_ID_RE,
  listScheduleJobs,
  MAX_PROMPT_BYTES,
  MAX_SCHEDULE_AHEAD_MS,
  MIN_EVERY_MS,
  newJobId,
  ScheduleLimitError,
  scheduleDir,
  type ScheduleJob,
} from "./schedule-store";

/** 路由依赖：会话行解析（cwd/sessionFile）与 prompt 注入走既有网关能力 */
export interface ScheduleRouteDeps {
  agentDir: string;
  /** 会话 id → 会话行（纯读不 spawn）；未知会话 null */
  resolveSession: (sessionId: string) => Promise<{ path: string; cwd: string } | null>;
  /** 到期 prompt 注入（排队语义在网关内自动生效）；返回 disposition 回执 */
  promptSession: (sessionId: string, text: string) => Promise<{ disposition: string }>;
  /** 托管 runner 存活态（GET 回显给前端状态列） */
  runnerAlive: () => boolean;
  /** 降级判定（spawn 连续失败）：真时创建禁用（列表/取消只读） */
  degraded?: () => boolean;
  /** 投递回注 bearer token（组合根每次启动随机生成） */
  deliverToken: string;
}

/** due 入参解析：epoch ms 数字或 ISO 字符串；非法/超远期 400（过去时刻合法——引擎下次扫描即触发） */
function parseDueMs(raw: unknown, now: number): number {
  let ms: number;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    ms = raw;
  } else if (typeof raw === "string" && raw !== "") {
    ms = Date.parse(raw);
  } else {
    throw new ApiError(400, "invalid_due", "due 必须是 epoch 毫秒数字或 ISO 时间字符串");
  }
  if (!Number.isFinite(ms)) throw new ApiError(400, "invalid_due", "due 无法解析为有效时间");
  if (ms > now + MAX_SCHEDULE_AHEAD_MS) {
    throw new ApiError(400, "invalid_due", "due 超出最远可预约范围（366 天）");
  }
  return ms;
}

function parseEveryMs(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new ApiError(400, "invalid_every", "everyMs 必须是整数毫秒或 null");
  }
  if (raw < MIN_EVERY_MS) {
    throw new ApiError(400, "invalid_every", `everyMs 最小 ${MIN_EVERY_MS}（runner 轮询语义下更密只会漂移）`);
  }
  if (raw > MAX_SCHEDULE_AHEAD_MS) {
    throw new ApiError(400, "invalid_every", "everyMs 超出上限（366 天）");
  }
  return raw;
}

export function createScheduleRoutes(deps: ScheduleRouteDeps): Hono {
  const app = new Hono();
  const dir = scheduleDir(deps.agentDir);

  // 列表：直读三状态目录；jobs 按到期升序；invalid 如实回显；runner 存活态供状态列
  app.get("/api/schedule", route(async (c: Context) => {
    const { jobs, invalid } = await listScheduleJobs(dir);
    return c.json({
      jobs: jobs.map((r) => ({ ...r.job, state: r.state, ...(r.occurrence === undefined ? {} : { occurrence: r.occurrence }) })),
      invalid,
      runner: { alive: deps.runnerAlive() },
    });
  }));

  // 创建：schema 对齐引擎 job 文件；cwd/sessionFile 由会话行解析（不信任客户端）
  app.post("/api/schedule", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const sessionId = body.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new ApiError(400, "invalid_session", "sessionId 必填");
    }
    const row = await deps.resolveSession(sessionId);
    if (!row) throw new ApiError(404, "session_not_found", `会话不存在：${sessionId}`);
    // 降级纪律（计划任务 21：--exec 不可用两路皆败时）：创建禁用，列表/取消仍可用
    if (deps.degraded?.()) {
      throw new ApiError(503, "schedule_runner_unavailable", "定时任务 runner 不可用，创建已降级禁用（列表/取消仍可用）");
    }
    if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
      throw new ApiError(400, "invalid_prompt", "prompt 必填且不能为空");
    }
    if (Buffer.byteLength(body.prompt, "utf8") > MAX_PROMPT_BYTES) {
      throw new ApiError(400, "invalid_prompt", `prompt 超过 ${MAX_PROMPT_BYTES} 字节上限`);
    }
    const now = Date.now();
    const dueAt = parseDueMs(body.due, now);
    const everyMs = parseEveryMs(body.everyMs);
    const job: ScheduleJob = {
      version: 1,
      id: newJobId(),
      sessionId,
      sessionFile: row.path,
      cwd: row.cwd,
      prompt: body.prompt,
      createdAt: now,
      dueAt,
      everyMs,
      fireCount: 0,
      lastFiredAt: null,
      lastError: null,
    };
    try {
      await createScheduleJob(dir, job);
    } catch (err) {
      if (err instanceof ScheduleLimitError) throw new ApiError(400, "schedule_limit", err.message);
      throw err;
    }
    return c.json({ job: { ...job, state: "pending" as const } }, 201);
  }));

  // 取消：pending → cancelled 墓碑移动；不存在 404（已在触发中/已取消/非法 id 同形）
  app.delete("/api/schedule/:id", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const job = await cancelScheduleJob(dir, id);
    if (!job) throw new ApiError(404, "not_found", `定时任务不存在：${id}`);
    return c.json({ ok: true, id });
  }));

  return app;
}

/**
 * 投递回注端点 handler（index.ts 挂载在 /api/* 鉴权之前；自带 bearer token 校验）。
 * 引擎 runner --exec 钩子把事件 JSON POST 到这里，经既有 prompt 网关入会话——
 * 排队/steer 语义在网关内自动生效。会话已删除时按 404 如实失败（runner 归档 failed）。
 */
export function createScheduleDeliverHandler(deps: ScheduleRouteDeps) {
  return route(async (c: Context) => {
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${deps.deliverToken}`) {
      throw new ApiError(401, "unauthorized", "投递回注 token 无效");
    }
    const event = await parseJsonBody(c);
    const sessionId = event.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new ApiError(400, "invalid_event", "事件缺少 sessionId");
    }
    const message = typeof event.message === "string" ? event.message : event.prompt;
    if (typeof message !== "string" || message === "") {
      throw new ApiError(400, "invalid_event", "事件缺少 prompt/message");
    }
    const row = await deps.resolveSession(sessionId);
    if (!row) throw new ApiError(404, "session_not_found", `会话不存在：${sessionId}`);
    const receipt = await deps.promptSession(sessionId, message);
    return c.json({ ok: true, disposition: receipt.disposition });
  });
}

/** id 契约复导出（测试与任务 22 消费同一来源） */
export const SCHEDULE_JOB_ID_RE = JOB_ID_RE;
