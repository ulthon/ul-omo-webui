// 后台任务内存账本（orphan-ledger 2026-10-31，spike 报告 §3）。
//
// 根因：abort 竞态可销毁 spawn 回执的 jsonl 落盘（r11 §3.2），服务端纯 jsonl 推导
// （background-tasks.ts）无源可读 → 活着的后台任务对 UI 完全不可见（假阴性）。
// 帧取证（spike §2）：omo.task.updated 在 spawn 时刻上线且先于 jsonl 回执，帧语义为
// FULL SNAPSHOT（data.tasks 整包），路由键 data.parent_session_id 即 durable 会话 id。
//
// 设计约束：
// - 模块级单例 + 纯内存 Map（与 background-tasks.ts 的模块级 cache 同风格）；零轮询、
//   零定时器、零磁盘写——唯一数据源是事件桥的实时扇出（EventBus.subscribe，无重放）。
// - 不做持久化：服务重启必然经历孤儿清扫（reapOrphans 杀光遗留引擎），持久化会复活
//   一批刚被杀死的条目，主动制造假阳性（spike §4）。失可见性窗口由 jsonl 推导兜底。
// - 帧过滤与条目窄化和 web/src/lib/event-dispatch.ts + stores/tasks.ts narrowTasks
//   完全同构（服务端独立实现，不跨包 import web 模块）。
import type { BridgeEvent } from "../engine/events";
import { invalidateBackgroundStateOnEngineDeath } from "./background-tasks";

/** 启动态词表：与 background-tasks.ts STARTUP_STATUSES 同词表（宁漏勿错） */
const RUNNING_STATUSES = new Set(["running", "pending"]);

/** 账本条目（wire 字段窄化子集，web narrowTasks 同款：未证实字段不引入） */
export interface LedgerTask {
  taskId: string;
  status: string;
  /** 展示标签：task_summary 优先，回退 name / task_id */
  label: string;
  updatedAt: string;
}

/** durable 会话 id → 全量任务快照（键含项目路径，多项目隔离；空快照即删键） */
const snapshots = new Map<string, LedgerTask[]>();

function ledgerKey(project: string, sessionId: string): string {
  return `${project}\n${sessionId}`;
}

/** wire tasks[] 条目窄化（web stores/tasks.ts narrowTasks 同构）：id/status 缺失的畸形条目跳过 */
function narrowTasks(raw: unknown): LedgerTask[] {
  if (!Array.isArray(raw)) return [];
  const out: LedgerTask[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    const taskId = typeof t.task_id === "string" && t.task_id ? t.task_id : typeof t.name === "string" ? t.name : "";
    if (!taskId) continue;
    const summary = typeof t.task_summary === "string" ? t.task_summary : "";
    const name = typeof t.name === "string" ? t.name : "";
    out.push({
      taskId,
      status: typeof t.status === "string" ? t.status : "",
      label: summary || name || taskId,
      updatedAt: typeof t.updated_at === "string" ? t.updated_at : "",
    });
  }
  return out;
}

/**
 * 装配进事件桥（进程启动期一次，index.ts 事件桥装配块）：订阅实时扇出，过滤
 * omo.task.updated 帧并整包替换快照（空数组清键——快照即真相，重放/乱序安全，
 * 与 web applySnapshot 同语义）。返回退订函数（server 关停时调用）。
 */
export function attachBackgroundTaskLedger(bus: {
  subscribe(listener: (event: BridgeEvent) => void): () => void;
}): () => void {
  return bus.subscribe((bridge) => {
    const event = bridge.event as { type?: unknown; name?: unknown; data?: unknown } | null;
    if (!event || event.type !== "extension_event" || event.name !== "omo.task.updated") return;
    const data = (event.data ?? null) as { parent_session_id?: unknown; tasks?: unknown } | null;
    if (!data || typeof data.parent_session_id !== "string" || data.parent_session_id === "") return;
    const tasks = narrowTasks(data.tasks);
    const key = ledgerKey(bridge.projectPath, data.parent_session_id);
    if (tasks.length === 0) snapshots.delete(key);
    else snapshots.set(key, tasks);
  });
}

/** 该 durable 会话在账本下是否有启动态任务（快照存在且任一 status ∈ 启动态词表） */
export function ledgerHasRunning(project: string, sessionId: string): boolean {
  const tasks = snapshots.get(ledgerKey(project, sessionId));
  if (!tasks) return false;
  return tasks.some((t) => RUNNING_STATUSES.has(t.status));
}

/** 该项目下账本报告为启动态的 durable 会话 id 列表（引擎死亡失效路径用） */
export function ledgerRunningSessionIds(project: string): string[] {
  const prefix = `${project}\n`;
  const out: string[] = [];
  for (const key of snapshots.keys()) {
    if (!key.startsWith(prefix)) continue;
    if ((snapshots.get(key) ?? []).some((t) => RUNNING_STATUSES.has(t.status))) {
      out.push(key.slice(prefix.length));
    }
  }
  return out;
}

/** 清空该项目全部快照（引擎死亡 / 空闲回收 / 显式停止时调用） */
export function clearBackgroundTaskLedger(project: string): void {
  const prefix = `${project}\n`;
  for (const key of [...snapshots.keys()]) {
    if (key.startsWith(prefix)) snapshots.delete(key);
  }
}

/**
 * 引擎死亡失效（spike §3.3 + §5.2 第二缺陷）：引擎进程死亡（崩溃 / 空闲回收 / 显式
 * 停止）经 owner-fd 看门狗在 ≤2s 内杀死全部任务子会话（spike §4 实证），此刻账本
 * 快照与 jsonl 推导的启动态回执都是「可证明已死」的陈旧状态：
 * - 账本：直接清项目快照；
 * - jsonl 推导：回执已落盘时纯重算仍为 true（假阳性永不自愈），须冻结磁盘状态——
 *   invalidateBackgroundStateOnEngineDeath 记录死亡时刻的文件指纹，推导面据此抑制，
 *   文件再有增长（死亡后新活动）即解除抑制恢复常态推导。
 */
export function handleProjectEngineDeath(project: string, sessionPaths: string[]): void {
  clearBackgroundTaskLedger(project);
  invalidateBackgroundStateOnEngineDeath(sessionPaths);
}

/** 单测隔离用：清空全部账本状态 */
export function resetBackgroundTaskLedger(): void {
  snapshots.clear();
}
