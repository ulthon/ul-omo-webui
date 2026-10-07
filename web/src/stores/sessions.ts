// 会话域：按项目分组的会话列表、视图（human|all）、搜索 q、归档过滤、当前选中。
// 数据写入来自 GET /api/sessions（组件层触发）与 SSE 元数据事件（todo 14/15 消费）。
import { create } from "zustand";
import type { SessionListItem } from "@/lib/api";

export type SessionView = "human" | "all";
export type ArchivedFilter = "true" | "false" | "all";

/** 会话运行态（SSE 驱动的状态点覆盖值；不在 runStates 中 = 未见 SSE 事件，用引擎探询 active 兜底）。
 * 一旦写入即权威（GET sessions 的 active 字段在本环境回合结束后不回落——learnings todo 14，
 * agent_end/settled/idle 落 "idle" 压过过期的 active=true）。 */
export type SessionRunState = "running" | "waiting" | "idle" | "error";

interface SessionsState {
  /** 按项目绝对路径分组的会话列表 */
  byProject: Record<string, SessionListItem[]>;
  /** 会话运行态覆盖（SSE 事件写入，id → 状态；回合结束清除） */
  runStates: Record<string, SessionRunState>;
  /** 默认只列人工会话（服务端 view=human 已过滤 fork） */
  view: SessionView;
  /** 全局搜索：标题/会话名子串（服务端实现，此状态作请求参数） */
  q: string;
  archived: ArchivedFilter;
  /** 当前选中会话 id */
  selectedId: string | null;
  loading: boolean;

  setView(view: SessionView): void;
  setQ(q: string): void;
  setArchived(archived: ArchivedFilter): void;
  select(id: string | null): void;
  setLoading(loading: boolean): void;
  /** 整体替换某项目的列表（refetch 结果） */
  setSessions(project: string, sessions: SessionListItem[]): void;
  /** 单条插入或替换（SSE 驱动的局部更新） */
  upsertSession(project: string, session: SessionListItem): void;
  /** 元数据局部更新：置顶/归档/重命名/未读清零等 */
  patchSession(id: string, patch: Partial<SessionListItem>): void;
  /** 未读计数 +1（SSE 新消息且非查看态；跨项目查找） */
  bumpUnread(id: string): void;
  removeSession(id: string): void;
  /** 运行态写入/清除（todo 15 event-dispatch 调用） */
  setRunState(id: string, state: SessionRunState): void;
  clearRunState(id: string): void;
}

function replaceIn(list: SessionListItem[], session: SessionListItem): SessionListItem[] {
  const idx = list.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = session;
    return next;
  }
  return [...list, session];
}

export const useSessionsStore = create<SessionsState>()((set) => ({
  byProject: {},
  runStates: {},
  view: "human",
  q: "",
  archived: "false",
  selectedId: null,
  loading: false,

  setView: (view) => set({ view }),
  setQ: (q) => set({ q }),
  setArchived: (archived) => set({ archived }),
  select: (id) => set({ selectedId: id }),
  setLoading: (loading) => set({ loading }),

  setSessions: (project, sessions) =>
    set((s) => ({ byProject: { ...s.byProject, [project]: sessions } })),

  upsertSession: (project, session) =>
    set((s) => {
      const list = s.byProject[project] ?? [];
      return { byProject: { ...s.byProject, [project]: replaceIn(list, session) } };
    }),

  patchSession: (id, patch) =>
    set((s) => {
      let changed = false;
      const byProject: Record<string, SessionListItem[]> = {};
      for (const [project, list] of Object.entries(s.byProject)) {
        const idx = list.findIndex((item) => item.id === id);
        if (idx < 0) {
          byProject[project] = list;
          continue;
        }
        changed = true;
        const next = list.slice();
        next[idx] = { ...list[idx], ...patch };
        byProject[project] = next;
      }
      return changed ? { byProject } : s;
    }),

  removeSession: (id) =>
    set((s) => {
      let changed = false;
      const byProject: Record<string, SessionListItem[]> = {};
      for (const [project, list] of Object.entries(s.byProject)) {
        const filtered = list.filter((item) => item.id !== id);
        if (filtered.length !== list.length) changed = true;
        byProject[project] = filtered;
      }
      const selectedId = s.selectedId === id ? null : s.selectedId;
      return changed || selectedId !== s.selectedId ? { byProject, selectedId } : s;
    }),

  bumpUnread: (id) =>
    set((s) => {
      let changed = false;
      const byProject: Record<string, SessionListItem[]> = {};
      for (const [project, list] of Object.entries(s.byProject)) {
        const idx = list.findIndex((item) => item.id === id);
        if (idx < 0) {
          byProject[project] = list;
          continue;
        }
        changed = true;
        const next = list.slice();
        next[idx] = { ...list[idx], unreadCount: list[idx].unreadCount + 1 };
        byProject[project] = next;
      }
      return changed ? { byProject } : s;
    }),

  setRunState: (id, state) =>
    set((s) => (s.runStates[id] === state ? s : { runStates: { ...s.runStates, [id]: state } })),

  clearRunState: (id) =>
    set((s) => {
      if (!(id in s.runStates)) return s;
      const runStates = { ...s.runStates };
      delete runStates[id];
      return { runStates };
    }),
}));
