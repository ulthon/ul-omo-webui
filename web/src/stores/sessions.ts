// 会话域：按项目分组的会话列表、搜索 q、归档过滤、当前选中。
// 数据写入来自 GET /api/sessions（组件层触发）与 SSE 元数据事件（todo 14/15 消费）。
// allMode（todo 9）：跨项目聚合视图——refreshSessions 走聚合端点，结果按 project 分组写入。
// 旧 human/all 双视图已移除（W3 todo 9 数据层 + 遗留清理）：列表固定含 fork 会话。
// B1：选中态以 ?session= 参数为 URL 载体（lib/session-url，replaceState），别名 id
// （createSession 回执的未落盘占位会话）不入 URL——选中即清参。
import { create } from "zustand";
import { api, ApiError } from "@/lib/api";
import type { SessionListItem } from "@/lib/api";
import { writeSessionUrl } from "@/lib/session-url";
import { useUiStore } from "@/stores/ui";
import { t } from "@/i18n/i18n";

export type ArchivedFilter = "true" | "false" | "all";

/** 会话运行态（SSE 驱动的状态点覆盖值；不在 runStates 中 = 未见 SSE 事件，用引擎探询 active 兜底）。
 * 一旦写入即权威（GET sessions 的 active 字段在本环境回合结束后不回落——learnings todo 14，
 * agent_end/settled/idle 落 "idle" 压过过期的 active=true）。 */
export type SessionRunState = "running" | "waiting" | "idle" | "error";

/** 无活动回落阈值（W1 缺陷 #3）：running/waiting 最后活动距今超过阈值由周期清扫回落
 * idle（event-dispatch 每 60s 一扫）。waiting 从宽——权限等待合法滞留数小时，30min 只
 * 兜服务端静默孤儿；活跃会话的事件持续刷新活动时刻，永不被清扫。 */
export const RUNNING_STALE_MS = 10 * 60_000;
export const WAITING_STALE_MS = 30 * 60_000;

interface SessionsState {
  /** 按项目绝对路径分组的会话列表 */
  byProject: Record<string, SessionListItem[]>;
  /** 会话运行态覆盖（SSE 事件写入，id → 状态；回合结束清除） */
  runStates: Record<string, SessionRunState>;
  /** 运行态活动时刻账本（W1 缺陷 #3，与 runStates 同键并行）：setRunState 写入、
   * 该会话任何 SSE 事件刷新（touchRunStateAt），周期清扫据此判无活动超时回落。
   * 组件不消费本字段（状态点仍读 runStates，值形状因此不被破坏）。 */
  runStateAt: Record<string, number>;
  /** 全局搜索：标题/会话名子串（服务端实现，此状态作请求参数） */
  q: string;
  archived: ArchivedFilter;
  /** 跨项目聚合视图（todo 9）：true 时 refreshSessions 调聚合端点（不传 project） */
  allMode: boolean;
  /** 标签过滤（todo 11）：多选 OR 语义，refreshSessions 透传 tags 参数（任一命中） */
  tagFilter: string[];
  /** 当前选中会话 id */
  selectedId: string | null;
  /** createSession 回执 id（未落盘占位会话）集合：客户端无法从 id 本身区分别名与真实 id
   * （local- 前缀仅消息条目，messages.ts:110），选中这类会话时 URL 必须清参——刷新命中
   * 占位 id 只会落 listMessages 错误态。adoptSessionId 换真实 id 时移除旧 id。 */
  aliasIds: Record<string, true>;
  loading: boolean;

  setQ(q: string): void;
  setArchived(archived: ArchivedFilter): void;
  /** 聚合视图切换（todo 10 侧栏接线；切换后调用方负责 refreshSessions） */
  setAllMode(allMode: boolean): void;
  /** 标签过滤写入（todo 11；调用方负责随后 refreshSessions） */
  setTagFilter(tags: string[]): void;
  select(id: string | null): void;
  setLoading(loading: boolean): void;
  /** 整体替换某项目的列表（refetch 结果） */
  setSessions(project: string, sessions: SessionListItem[]): void;
  /** 聚合响应写入（todo 9）：按 session.project 分组，整体替换 byProject——
   * 全量 refetch 语义，单项目模式下残留的旧分组与已删除的项目不会滞留 */
  setAllSessions(sessions: SessionListItem[]): void;
  /** 刷新会话列表：allMode 走聚合端点（无 project 参数），否则单项目（现状路径）。
   * 失败非 401 时 toast（与 bootstrap.refreshSessions 语义一致）。 */
  refreshSessions(): Promise<void>;
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
  /** 该会话任一 SSE 事件的活动记账（event-dispatch 调用；无运行态时 no-op） */
  touchRunStateAt(id: string): void;
  /** 无活动超时清扫（W1 缺陷 #3，60s 周期由 event-dispatch 驱动）：running/waiting
   * 最后活动距今超过阈值回落 idle（常量见文件头）。now 供单测注入确定性时刻。 */
  sweepStaleRunStates(now?: number): void;
  /** 未落盘占位行采用真实 id（首条消息落盘后服务端回执带回，缺陷修复：新会话首条
   *  消息不显示）：行 id、当前选中、运行态点一并迁移 */
  adoptSessionId(oldId: string, newId: string): void;
  /** createSession 回执 id 记入别名集合（session-list 新建会话路径调用，先于 select） */
  markAliasId(id: string): void;
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
  runStateAt: {},
  q: "",
  archived: "false",
  allMode: false,
  tagFilter: [],
  selectedId: null,
  aliasIds: {},
  loading: false,

  setQ: (q) => set({ q }),
  setArchived: (archived) => set({ archived }),
  setAllMode: (allMode) => set({ allMode }),
  setTagFilter: (tagFilter) => set({ tagFilter }),
  // B1 URL 同步：选中即 replaceState 写 ?session=；别名 id（未落盘占位会话）不入 URL，
  // 清参而非留陈旧选中（N2：宁缺勿错，避免 URL 指向刷新必错的占位 id）
  select: (id) => {
    const isAlias = id !== null && useSessionsStore.getState().aliasIds[id] === true;
    set({ selectedId: id });
    writeSessionUrl(isAlias ? null : id);
  },
  setLoading: (loading) => set({ loading }),

  setSessions: (project, sessions) =>
    set((s) => ({ byProject: { ...s.byProject, [project]: sessions } })),

  setAllSessions: (sessions) =>
    set(() => {
      const byProject: Record<string, SessionListItem[]> = {};
      for (const session of sessions) {
        (byProject[session.project] ??= []).push(session);
      }
      return { byProject };
    }),

  refreshSessions: async () => {
    const { allMode, archived, q, tagFilter, setLoading } = useSessionsStore.getState();
    // 标签过滤（todo 11）：非空时透传 tags（多参数 OR 语义）
    const tags = tagFilter.length > 0 ? tagFilter : undefined;
    setLoading(true);
    try {
      if (allMode) {
        const res = await api.listSessions({ archived, q: q || undefined, tags });
        useSessionsStore.getState().setAllSessions(res.sessions);
        return;
      }
      const { currentProject } = useUiStore.getState();
      if (!currentProject) return;
      const res = await api.listSessions({ project: currentProject, archived, q: q || undefined, tags });
      useSessionsStore.getState().setSessions(currentProject, res.sessions);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast(t("common.lib.sessionListLoadFailed"), "error");
      }
    } finally {
      useSessionsStore.getState().setLoading(false);
    }
  },

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

  removeSession: (id) => {
    const wasSelected = useSessionsStore.getState().selectedId === id;
    set((s) => {
      let changed = false;
      const byProject: Record<string, SessionListItem[]> = {};
      for (const [project, list] of Object.entries(s.byProject)) {
        const filtered = list.filter((item) => item.id !== id);
        if (filtered.length !== list.length) changed = true;
        byProject[project] = filtered;
      }
      const selectedId = s.selectedId === id ? null : s.selectedId;
      let aliasIds = s.aliasIds;
      if (id in s.aliasIds) {
        aliasIds = { ...s.aliasIds };
        delete aliasIds[id];
        changed = true;
      }
      return changed || selectedId !== s.selectedId ? { byProject, selectedId, aliasIds } : s;
    });
    // 删除的是当前选中会话：URL 同步清参回空态
    if (wasSelected) writeSessionUrl(null);
  },

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
    set((s) => {
      const now = Date.now();
      if (s.runStates[id] === state) {
        // 同态写入只刷新活动时刻（runStates 引用不变，状态点订阅者不重渲染）
        return s.runStateAt[id] === now ? s : { runStateAt: { ...s.runStateAt, [id]: now } };
      }
      return {
        runStates: { ...s.runStates, [id]: state },
        runStateAt: { ...s.runStateAt, [id]: now },
      };
    }),

  clearRunState: (id) =>
    set((s) => {
      if (!(id in s.runStates)) return s;
      const runStates = { ...s.runStates };
      delete runStates[id];
      const runStateAt = { ...s.runStateAt };
      delete runStateAt[id];
      return { runStates, runStateAt };
    }),

  touchRunStateAt: (id) =>
    set((s) => (id in s.runStateAt ? { runStateAt: { ...s.runStateAt, [id]: Date.now() } } : s)),

  sweepStaleRunStates: (now = Date.now()) =>
    set((s) => {
      let next: Record<string, SessionRunState> | null = null;
      for (const [id, state] of Object.entries(s.runStates)) {
        if (state !== "running" && state !== "waiting") continue;
        const at = s.runStateAt[id];
        if (at === undefined) continue; // 账本缺时刻（外部直写残留）不判超时，宁可不回落
        const staleMs = state === "running" ? RUNNING_STALE_MS : WAITING_STALE_MS;
        if (now - at <= staleMs) continue;
        (next ??= { ...s.runStates })[id] = "idle";
      }
      return next === null ? s : { runStates: next };
    }),

  adoptSessionId: (oldId, newId) => {
    const wasSelected = useSessionsStore.getState().selectedId === oldId;
    set((s) => {
      if (oldId === newId) return s;
      let changed = false;
      const byProject: Record<string, SessionListItem[]> = {};
      for (const [project, list] of Object.entries(s.byProject)) {
        const idx = list.findIndex((item) => item.id === oldId);
        if (idx < 0) {
          byProject[project] = list;
          continue;
        }
        changed = true;
        const next = list.slice();
        next[idx] = { ...list[idx], id: newId };
        byProject[project] = next;
      }
      const selectedId = s.selectedId === oldId ? newId : s.selectedId;
      let runStates = s.runStates;
      let runStateAt = s.runStateAt;
      if (oldId in s.runStates) {
        runStates = { ...s.runStates };
        runStates[newId] = runStates[oldId];
        delete runStates[oldId];
        if (oldId in runStateAt) {
          runStateAt = { ...runStateAt };
          runStateAt[newId] = runStateAt[oldId];
          delete runStateAt[oldId];
        }
      }
      // 别名集合随换 key 移除旧 id（新 id 是真实落盘 id，不入集合）
      let aliasIds = s.aliasIds;
      if (oldId in s.aliasIds) {
        aliasIds = { ...s.aliasIds };
        delete aliasIds[oldId];
      }
      return changed || selectedId !== s.selectedId || runStates !== s.runStates || aliasIds !== s.aliasIds
        ? { byProject, selectedId, runStates, runStateAt, aliasIds }
        : s;
    });
    // 选中态换 key：URL 同步换写真实 id（URL 里若是别名 id，此处原地纠正）
    if (wasSelected && oldId !== newId) writeSessionUrl(newId);
  },

  markAliasId: (id) =>
    set((s) => (id in s.aliasIds ? s : { aliasIds: { ...s.aliasIds, [id]: true } })),
}));
