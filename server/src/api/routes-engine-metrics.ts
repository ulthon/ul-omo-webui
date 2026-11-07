/**
 * 引擎指标采样路由（engine-ux-visibility 任务 1）：GET /api/engines/metrics。
 *
 * 一次性纯读采样，每引擎一行（行键会话级：sessionPath + boundSession）：
 * state/pid/RSS/进程树合计 RSS+子进程数/CPU 瞬时+累计/IO 字节/startedAt/
 * 启动耗时（本次进行中或上次完成值）/上次启动耗时/uptime/绑定会话
 * (id,标题,文件大小)/换件计数/RPC 队列深度/最近错误尾；任务 2 追加探活窗暴露
 * （remainingIdleMs/activityWindowExempt/exemptReason，只读派生自 t7 回收档
 * 状态，见 deriveActivityWindowExposure）。
 *
 * 硬约束（计划 Must-NOT）：
 * - 采样仅在请求处理器内执行——无定时器/无轮询循环；/proc 读取与绑定会话
 *   磁盘读全部发生在请求路径上。
 * - 不触发 ensure/spawn 链：数据源 = manager.getAllStatus()（纯内存快照）+
 *   /proc（linuxProcMetricsSource）+ 会话 jsonl 文件 + meta 库直查，零引擎交互。
 * - 不触碰探活窗（t7）逻辑。
 *
 * stale_state 语义：引擎全无时返回 { engines: [] }（200），不报错——指标是
 * 观测面，引擎缺席是合法状态。与 /api/engines（补 inactive 行）不同：进程
 * 指标对 inactive 行无意义，不补行。
 */

import { Hono, type Context } from "hono";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { route } from "./http";
import type { LogEntry } from "../obs/logger";
import type { EngineReclaimFacts, EngineStatusSnapshot } from "../engine/process-manager";
import type { EngineProcSample, ProcMetricsSampler } from "../engine/proc-metrics";
import { resolveSessionTitle } from "./routes-session";

/** 绑定会话信息（行键会话级设计；单引擎每项目是现状，键不预设单引擎） */
export interface BoundSessionInfo {
  id: string;
  title: string;
  fileSizeBytes: number;
}

/** 最近错误尾条目（log 环派生） */
export interface EngineMetricError {
  t: string;
  ev: string;
  detail: string;
}

/** 引擎指标行（每引擎一行；进程已死/字段不可得时为 null，不缺字段键） */
export interface EngineMetricsRow {
  projectPath: string;
  sessionPath: string;
  state: string;
  pid: number | null;
  rssBytes: number | null;
  /** 自身+全部后代 RSS 合计 */
  treeRssBytes: number | null;
  /** 后代进程数（不含自身） */
  childCount: number;
  /** 树合计 CPU 占比（单核=100%；首次采样无基线为 null） */
  cpuPct: number | null;
  /** 树合计 utime+stime（ms） */
  cpuTotalMs: number | null;
  ioBytes: { readBytes: number; writeBytes: number } | null;
  startedAt: number | null;
  /** starting→ready 耗时：starting 进行中为当前差值，否则为上次完成值 */
  startupMs: number | null;
  /** 上次完成的启动耗时（未完成过一次启动为 null） */
  lastStartupMs: number | null;
  /** ready 起算的存活时长（starting/stopped 等未就绪态为 null） */
  uptimeMs: number | null;
  boundSession: BoundSessionInfo | null;
  /** 换件累计计数（scheduleRestart 进入即 +1，成功不清零） */
  workerRestartCount: number;
  rpcQueueDepth: number;
  recentErrors: EngineMetricError[];
  /** 探活窗暴露（engine-ux-visibility 任务 2）：距下次空闲回收判收的剩余毫秒
 *  （max(0, windowMs - elapsed)，镜像 rescheduleIdleCheck 公式）；豁免/非 ready 态
 *  为 null（无倒计时） */
  remainingIdleMs: number | null;
  /** 当前是否豁免空闲回收（忙判据命中 / never 总逃生口 / 非 ready） */
  activityWindowExempt: boolean;
  /** 豁免原因（机器可读稳定值，见 ActivityWindowExemptReason；非豁免时缺席） */
  exemptReason?: ActivityWindowExemptReason;
}

/** 豁免原因（engine-ux-visibility 任务 2；前端文案自行映射，值保持稳定）：
 *  not_ready=非 ready 态回收定时器未武装；never=idleTimeoutMs<=0 总逃生口；
 *  running_turn=真实回合进行中（探活窗档）；active_sessions=点亮会话非空
 *  （正常档）；pending_permissions=挂起未应答权限/提问；queued_work=排队中
 *  （第四判据）；background_task=后台任务运行中（第三判据）。 */
export type ActivityWindowExemptReason =
  | "not_ready"
  | "never"
  | "running_turn"
  | "active_sessions"
  | "pending_permissions"
  | "queued_work"
  | "background_task";

/** 探活窗暴露（engine-ux-visibility 任务 2）：remainingIdleMs 有值 ⟺ 非豁免。 */
export interface ActivityWindowExposure {
  /** 距下次空闲回收判收的剩余毫秒；豁免时 null */
  remainingIdleMs: number | null;
  activityWindowExempt: boolean;
  /** 命中豁免时的原因（非豁免时缺席） */
  exemptReason?: ActivityWindowExemptReason;
}

/**
 * 探活窗暴露纯派生（engine-ux-visibility 任务 2）：由快照 + 回收事实 + 探针面
 * 推 remainingIdleMs/豁免态。判定序严格镜像 process-manager 回收调度本体
 * （rescheduleIdleCheck → reclaimTier → isIdle/isIdleForActivityWindow）：
 *   1. 非 ready 态：回收定时器未武装 → 豁免 not_ready；
 *   2. idleTimeoutMs<=0 总逃生口（两档全停）→ 豁免 never；
 *   3. 档位：activityWindowMs>0 且未发过消息（!userPrompted）→ 探活窗档，
 *      否则正常档（idleTimeoutMs 梯子）；
 *   4. 忙判据按源序取首个命中原因（源序 = isIdle/isIdleForActivityWindow 的
 *      短路序）：探活窗档 agentRunning>0 计忙（点亮 open 不计，GAP-5 口径），
 *      正常档 runningSessions>0 计忙；pendingPermissions/排队/后台两档同序；
 *   5. 空闲：remainingIdleMs = max(windowMs - (now - lastActivityAt), 0)。
 *
 * 只读派生，不驱动任何回收行为；t7 双门/豁免逻辑本体零改动（派生若与本体
 * 判定序漂移，以 process-manager 为准同步本镜像）。
 */
export function deriveActivityWindowExposure(
  st: Pick<EngineStatusSnapshot, "state" | "lastActivityAt" | "runningSessions" | "pendingPermissions">,
  input: {
    facts: EngineReclaimFacts;
    /** RPC 队列深度（>0 即第四判据排队中，与 manager sessionQueuedWork 同源谓词） */
    queueDepth: number;
    /** 后台任务运行探测（第三判据；与 manager sessionBackgroundRunning 同源） */
    backgroundRunning: boolean;
    now: number;
  },
): ActivityWindowExposure {
  if (st.state !== "ready") {
    return { remainingIdleMs: null, activityWindowExempt: true, exemptReason: "not_ready" };
  }
  if (input.facts.idleTimeoutMs <= 0) {
    return { remainingIdleMs: null, activityWindowExempt: true, exemptReason: "never" };
  }
  const activityTier = input.facts.activityWindowMs > 0 && !input.facts.userPrompted;
  let busy: ActivityWindowExemptReason | undefined;
  if (activityTier) {
    busy =
      input.facts.agentRunningCount > 0 ? "running_turn"
      : st.pendingPermissions.length > 0 ? "pending_permissions"
      : input.queueDepth > 0 ? "queued_work"
      : input.backgroundRunning ? "background_task"
      : undefined;
  } else {
    busy =
      st.runningSessions.length > 0 ? "active_sessions"
      : st.pendingPermissions.length > 0 ? "pending_permissions"
      : input.queueDepth > 0 ? "queued_work"
      : input.backgroundRunning ? "background_task"
      : undefined;
  }
  if (busy !== undefined) {
    return { remainingIdleMs: null, activityWindowExempt: true, exemptReason: busy };
  }
  const windowMs = activityTier ? input.facts.activityWindowMs : input.facts.idleTimeoutMs;
  const elapsed = input.now - st.lastActivityAt;
  return { remainingIdleMs: Math.max(windowMs - elapsed, 0), activityWindowExempt: false };
}

/**
 * 日志环 → 引擎最近错误尾（纯函数）：mod=engine 且 warn/error 且 f.sess 等于
 * 引擎键（process-manager 发射点均带 sess 字段——probe_gate/warmup_fail 已随
 * 本任务补齐）。detail 优先 msg/reason，否则结构化字段拼 k=v。
 */
export function deriveRecentErrors(
  entries: readonly LogEntry[],
  sessionPath: string,
  limit = 5,
): EngineMetricError[] {
  const out: EngineMetricError[] = [];
  for (const e of entries) {
    if (e.mod !== "engine") continue;
    if (e.lvl !== "warn" && e.lvl !== "error") continue;
    if (e.f?.sess !== sessionPath) continue;
    const f = e.f;
    let detail = "";
    if (typeof f?.msg === "string") detail = f.msg;
    else if (typeof f?.reason === "string") detail = f.reason;
    else if (f) {
      detail = Object.entries(f)
        .filter(([k]) => k !== "proj" && k !== "sess")
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(" ")
        .slice(0, 200);
    }
    out.push({ t: e.t, ev: e.ev, detail });
  }
  return out.slice(-limit);
}

/** jsonl 文件首块解析结果（读前 LEAD_BYTES 字节；不足截断时按已读行尽力解析） */
export interface SessionLead {
  /** durable 会话 id（header 行） */
  id?: string;
  /** 会话名（session-info custom 条目；无则缺省） */
  name?: string;
  /** 首条用户消息文本（content 数组 text 拼接） */
  firstMessage: string;
}

/** 首块读取上界：会话首条用户消息恒在文件头部，128KB 足够覆盖 */
const LEAD_BYTES = 128 * 1024;

/** 解析 jsonl 首块文本（纯函数；header 行/用户消息行/会话名条目尽力提取） */
export function parseSessionLead(text: string): SessionLead {
  const lead: SessionLead = { firstMessage: "" };
  let firstMessageDone = false;
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      continue; // 半行（截断边界）或损坏行
    }
    if (lead.id === undefined && entry.type === "session" && typeof entry.id === "string") {
      lead.id = entry.id;
      continue;
    }
    if (!firstMessageDone && entry.type === "message") {
      const msg = entry.message as { role?: unknown; content?: unknown } | undefined;
      if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
      const parts: string[] = [];
      for (const c of msg.content) {
        if (c && typeof c === "object" && (c as { type?: unknown }).type === "text") {
          const t = (c as { text?: unknown }).text;
          if (typeof t === "string") parts.push(t);
        }
      }
      if (parts.length > 0) {
        lead.firstMessage = parts.join(" ");
        firstMessageDone = true;
      }
      continue;
    }
    if (lead.name === undefined && entry.type === "custom") {
      const custom = String(entry.customType ?? "");
      const data = entry.data as { name?: unknown } | undefined;
      if (custom.includes("session-info") && typeof data?.name === "string" && data.name !== "") {
        lead.name = data.name;
      }
    }
  }
  return lead;
}

/** 读会话 jsonl 文件首块（openSync+readSync 有界读，不整文件载入） */
function readSessionLead(sessionPath: string): SessionLead | null {
  let fd: number;
  try {
    fd = openSync(sessionPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(LEAD_BYTES);
    const n = readSync(fd, buf, 0, LEAD_BYTES, 0);
    return parseSessionLead(buf.subarray(0, n).toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** meta 库取数面（boundSession 标题链用；测试注入 fake） */
export interface BoundSessionMetaSource {
  getSessionMeta(sessionId: string): { renamedTitle: string | null } | null;
  getSessionGeneratedTitle(sessionId: string): string | null;
}

/**
 * 绑定会话解析器工厂（组合根接线用）：jsonl 首块（durable id/会话名/首条用户
 * 消息）+ meta 标题（renamed/generated）+ 文件大小，标题链复用
 * resolveSessionTitle（与 /api/sessions 列表同链同截断）。纯读磁盘/meta，
 * 零引擎交互。文件不可读或 header 无 id 返回 null（starting 早期未落盘等）。
 */
export function makeBoundSessionResolver(meta: BoundSessionMetaSource) {
  return (sessionPath: string): BoundSessionInfo | null => {
    const lead = readSessionLead(sessionPath);
    if (!lead || lead.id === undefined) return null;
    let fileSizeBytes: number;
    try {
      fileSizeBytes = statSync(sessionPath).size;
    } catch {
      return null;
    }
    const m = meta.getSessionMeta(lead.id);
    const title = resolveSessionTitle({
      renamedTitle: m?.renamedTitle ?? null,
      name: lead.name ?? null,
      generatedTitle: meta.getSessionGeneratedTitle(lead.id),
      firstMessage: lead.firstMessage,
    });
    return { id: lead.id, title, fileSizeBytes };
  };
}

/** 单行组装（纯函数）：快照 + /proc 采样 + 会话/错误/队列/探活窗注入面 → 指标行 */
export function buildMetricsRow(
  st: EngineStatusSnapshot,
  proc: EngineProcSample | null,
  extra: {
    boundSession: BoundSessionInfo | null;
    recentErrors: EngineMetricError[];
    rpcQueueDepth: number;
    now: number;
    /** 回收事实（manager.getReclaimFacts 同步读；列表与事实同一同步块内必非空）。
 *  缺席时探活窗字段降级（无倒计时、非豁免），不虚构档位 */
    reclaimFacts: EngineReclaimFacts | undefined;
    /** 后台任务运行探测（第三判据；同源注入） */
    backgroundRunning: boolean;
  },
): EngineMetricsRow {
  const now = extra.now;
  const procSample: EngineProcSample | null =
    proc && st.pid !== undefined && proc.pid === st.pid ? proc : null;
  const starting = st.state === "starting" && st.startingAt !== undefined;
  return {
    projectPath: st.projectPath,
    sessionPath: st.sessionPath,
    state: st.state,
    pid: st.pid ?? null,
    rssBytes: procSample?.rssBytes ?? null,
    treeRssBytes: procSample?.treeRssBytes ?? null,
    childCount: procSample?.childCount ?? 0,
    cpuPct: procSample?.cpuPct ?? null,
    cpuTotalMs: procSample?.cpuTotalMs ?? null,
    ioBytes: procSample?.ioBytes ?? null,
    startedAt: st.startedAt ?? null,
    startupMs: starting
      ? Math.max(now - (st.startingAt as number), 0)
      : st.lastStartupMs ?? null,
    lastStartupMs: st.lastStartupMs ?? null,
    uptimeMs: st.startedAt !== undefined ? Math.max(now - st.startedAt, 0) : null,
    boundSession: extra.boundSession,
    workerRestartCount: st.restartCount,
    rpcQueueDepth: extra.rpcQueueDepth,
    recentErrors: extra.recentErrors,
    ...(extra.reclaimFacts !== undefined
      ? deriveActivityWindowExposure(st, {
          facts: extra.reclaimFacts,
          queueDepth: extra.rpcQueueDepth,
          backgroundRunning: extra.backgroundRunning,
          now,
        })
      : { remainingIdleMs: null, activityWindowExempt: false }),
  };
}

export interface EngineMetricsDeps {
  /** 引擎状态快照（纯读：manager.getAllStatus()；不触发 ensure/spawn） */
  listStatuses(): EngineStatusSnapshot[];
  /** /proc 采样器（纯读；组合根用 ProcMetricsSampler 进程级单例，cpuPct 基线
 *  跨请求保持；结构面便于测试注入） */
  sampler: { sample(pid: number, nowMs: number): EngineProcSample };
  /** 绑定会话解析（纯读磁盘+meta；makeBoundSessionResolver 产出） */
  resolveBoundSession(sessionPath: string): BoundSessionInfo | null;
  /** 引擎最近错误尾（log 环派生；deriveRecentErrors 接线） */
  recentErrors(sessionPath: string): EngineMetricError[];
  /** RPC 队列深度（组合根 queue_update 帧跟踪派生） */
  rpcQueueDepth(sessionPath: string): number;
  /** 空闲回收事实（manager.getReclaimFacts 只读接线；纯读零副作用，
 *  与 listStatuses 同一请求同步块内调用） */
  reclaimFacts(sessionPath: string): EngineReclaimFacts | undefined;
  /** 后台任务运行探测（与 manager sessionBackgroundRunning 同源注入；纯读） */
  backgroundRunning(sessionPath: string): boolean;
  now(): number;
}

export function createEngineMetricsRoutes(deps: EngineMetricsDeps): Hono {
  const app = new Hono();
  app.get("/api/engines/metrics", route(async (c: Context) => {
    // 全部采样在请求内一次完成；引擎缺席 = 空列表（stale_state 语义）
    const now = deps.now();
    const rows = deps.listStatuses().map((st) =>
      buildMetricsRow(
        st,
        st.pid !== undefined ? deps.sampler.sample(st.pid, now) : null,
        {
          boundSession: deps.resolveBoundSession(st.sessionPath),
          recentErrors: deps.recentErrors(st.sessionPath),
          rpcQueueDepth: deps.rpcQueueDepth(st.sessionPath),
          reclaimFacts: deps.reclaimFacts(st.sessionPath),
          backgroundRunning: deps.backgroundRunning(st.sessionPath),
          now,
        },
      ),
    );
    return c.json({ engines: rows });
  }));
  return app;
}
