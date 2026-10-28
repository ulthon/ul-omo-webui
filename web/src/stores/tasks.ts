// 后台任务域（r10 todo 11，spike 实证口径 .omo/evidence/r10/task-10/spike-report.md）：
// 数据源仅一路——引擎 omo.task.updated extension_event 帧（SSE 透传，事件桥零过滤）。
// 帧语义为 FULL SNAPSHOT：data.tasks 是该母会话全部后台任务的整体快照（引擎侧指纹
// 变更才推送 + session_resumed 全量重推），store 直接整包替换、不做 delta 合并——
// 重放/乱序安全（后到的旧快照同样整包覆盖，引擎快照即真相）。
// 路由键 data.parent_session_id = durable 会话 id（wire sessionId 是连接 handle
// "rpc-N"，非会话身份）。零轮询定时器：纯帧驱动。
import { create } from "zustand";

/** 后台任务展示行（wire 字段窄化子集：spike 实证帧形态，未证实字段不引入） */
export interface BackgroundTask {
  id: string;
  status: string;
  /** 展示标签：wire 无 title/activity 字段（spike 表格核实），用 task_summary，缺席回退 name/task_id */
  label: string;
}

/** wire tasks[] 条目窄化：id/status 缺失的畸形条目跳过，全空数组如实透出（空快照 = 活动条消失语义） */
function narrowTasks(raw: unknown): BackgroundTask[] {
  if (!Array.isArray(raw)) return [];
  const out: BackgroundTask[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    const id = typeof t.task_id === "string" && t.task_id ? t.task_id : typeof t.name === "string" ? t.name : "";
    if (!id) continue;
    const summary = typeof t.task_summary === "string" ? t.task_summary : "";
    const name = typeof t.name === "string" ? t.name : "";
    out.push({
      id,
      status: typeof t.status === "string" ? t.status : "",
      label: summary || name || id,
    });
  }
  return out;
}

interface TasksState {
  /** 会话 id → 后台任务全量快照（整包替换语义；无帧 = 无键） */
  bySession: Record<string, BackgroundTask[]>;

  /** omo.task.updated 快照消费（event-dispatch 分发）：整包替换，不做合并 */
  applySnapshot(sessionId: string, rawTasks: unknown): void;
  clearSession(sessionId: string): void;
}

export const useTasksStore = create<TasksState>()((set) => ({
  bySession: {},

  applySnapshot: (sessionId, rawTasks) =>
    set((s) => ({
      bySession: { ...s.bySession, [sessionId]: narrowTasks(rawTasks) },
    })),

  clearSession: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const bySession = { ...s.bySession };
      delete bySession[sessionId];
      return { bySession };
    }),
}));

export { narrowTasks };
