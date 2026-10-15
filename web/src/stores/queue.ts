// 排队域（docs08-r4 任务 11，spike 实证口径 .omo/evidence/docs08-r4/task-2-spike.md）：
// 按会话的"待发"列表，数据源三路——queue_update wire 事件（增量，ordered[] 为引擎侧
// 全量真相）、GET queue 快照（断线重连/初次渲染对账，无 enqueueOrder）、本端发送乐观
// 占位（回执 disposition="queued" 后、queue_update 确认前的临时项）。
// 稳定 key 用引擎 enqueueOrder（实例内单调递增）；对账项无序号，展示层退化为下标 key。
// 撤销：引擎只有整队 clearQueue 协议面，单条撤销由 UI 层"清空 + 保留项重新入队"实现，
// 本 store 只负责列表真相的维护。
import { create } from "zustand";
import type { QueueItem, QueueSnapshot } from "@/lib/api";

interface SessionQueue {
  items: QueueItem[];
}

interface QueueState {
  bySession: Record<string, SessionQueue>;

  /** 本端排队发送成功即乐观占位（pending，无序号；queue_update 确认后转正式项） */
  addPending(sessionId: string, text: string, mode: "steer" | "followUp"): void;
  /** queue_update 增量（ordered 为引擎侧全量真相，含出队宣布 ordered:[]）；
   *  按 enqueueOrder 保留已知项的 enqueuedAt，未知项按 text+mode 贪心匹配 */
  applyUpdate(
    sessionId: string,
    ordered: Array<{ text?: unknown; mode?: unknown; enqueueOrder?: unknown }>,
  ): void;
  /** 全量对账（GET queue：steering/followUp 文本数组，无序号；插入档在前，执行序如此） */
  setSnapshot(sessionId: string, snapshot: Pick<QueueSnapshot, "steering" | "followUp">): void;
  clearSession(sessionId: string): void;
}

function modeOf(raw: unknown): "steer" | "followUp" {
  return raw === "steer" ? "steer" : "followUp";
}

function textOf(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function orderOf(raw: unknown): number | null {
  return typeof raw === "number" ? raw : null;
}

/** 用引擎真相重建列表：已知序号项保留 enqueuedAt；无序号项按 text+mode 贪心保留 */
function reconcile(prev: QueueItem[], engine: Array<{ text: string; mode: "steer" | "followUp"; enqueueOrder: number | null }>): QueueItem[] {
  const byOrder = new Map<number, QueueItem>();
  const byText: QueueItem[] = [];
  for (const item of prev) {
    if (item.enqueueOrder !== null) byOrder.set(item.enqueueOrder, item);
    else byText.push(item);
  }
  return engine.map((entry) => {
    const known = entry.enqueueOrder !== null ? byOrder.get(entry.enqueueOrder) : undefined;
    if (known) {
      if (entry.enqueueOrder !== null) byOrder.delete(entry.enqueueOrder);
      return { ...known, text: entry.text, mode: entry.mode, enqueueOrder: entry.enqueueOrder };
    }
    const idx = byText.findIndex((p) => p.text === entry.text && p.mode === entry.mode);
    if (idx >= 0) {
      const [matched] = byText.splice(idx, 1);
      return { ...matched, text: entry.text, mode: entry.mode, enqueueOrder: entry.enqueueOrder };
    }
    return { text: entry.text, mode: entry.mode, enqueueOrder: entry.enqueueOrder, enqueuedAt: Date.now() };
  });
}

export const useQueueStore = create<QueueState>()((set) => ({
  bySession: {},

  addPending: (sessionId, text, mode) =>
    set((s) => {
      const cur = s.bySession[sessionId] ?? { items: [] };
      const now = Date.now();
      // SSE enqueue 帧可能先于 HTTP 回执到达（QA 实测 +2ms 级竞态）：近窗口内已有
      // 同文同档项（含已确认项）则不重复占位，以引擎 queue_update 为准。同文双条
      // 排队（引擎不去重）靠下一条 enqueue 帧的全量 ordered[] 自纠。
      const dup = cur.items.some((i) => i.text === text && i.mode === mode && now - i.enqueuedAt < 5000);
      if (dup) return s;
      const item: QueueItem = { text, mode, enqueueOrder: null, enqueuedAt: now };
      return { bySession: { ...s.bySession, [sessionId]: { items: [...cur.items, item] } } };
    }),

  applyUpdate: (sessionId, ordered) =>
    set((s) => {
      const cur = s.bySession[sessionId] ?? { items: [] };
      const engine = (Array.isArray(ordered) ? ordered : []).map((raw) => ({
        text: textOf(raw?.text),
        mode: modeOf(raw?.mode),
        enqueueOrder: orderOf(raw?.enqueueOrder),
      }));
      return { bySession: { ...s.bySession, [sessionId]: { items: reconcile(cur.items, engine) } } };
    }),

  setSnapshot: (sessionId, snapshot) =>
    set((s) => {
      const cur = s.bySession[sessionId] ?? { items: [] };
      // 执行序：steering 在下一 turn 边界并入，先于 followUp（spike (b)/(c) 实证）
      const engine = [
        ...snapshot.steering.map((text) => ({ text, mode: "steer" as const, enqueueOrder: null })),
        ...snapshot.followUp.map((text) => ({ text, mode: "followUp" as const, enqueueOrder: null })),
      ];
      return { bySession: { ...s.bySession, [sessionId]: { items: reconcile(cur.items, engine) } } };
    }),

  clearSession: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const bySession = { ...s.bySession };
      delete bySession[sessionId];
      return { bySession };
    }),
}));
