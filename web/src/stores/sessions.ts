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
 * agent_end/settled/idle 落 "idle" 压过过期的 active=true）。
 * 第四态 background_running（docs08-2026-10-23-24-batch 任务 12）：服务端从会话 jsonl
 * 派生（spawn 回执未终局）经 GET /api/sessions 行下发，setSessions/setAllSessions 与
 * SSE 重同步（resyncRunStatesFromServer）写入；不压 running/waiting/error（SSE 回合级
 * 真相源优先），完成后服务端行回落 idle 时同步清除。 */
export type SessionRunState = "running" | "waiting" | "idle" | "error" | "background_running";

/** 无活动回落阈值（W1 缺陷 #3）：running/waiting 最后活动距今超过阈值由周期清扫回落
 * idle（event-dispatch 每 60s 一扫）。waiting 从宽——权限等待合法滞留数小时，30min 只
 * 兜服务端静默孤儿；活跃会话的事件持续刷新活动时刻，永不被清扫。 */
export const RUNNING_STALE_MS = 10 * 60_000;
export const WAITING_STALE_MS = 30 * 60_000;
/** 后台态专属阈值（任务 12）：后台任务合法长跑（deep 子任务实录可达数十分钟），
 *  比照 running 10min / waiting 30min 的孤儿兜底档次再放宽一档取 60min——正常长任务
 *  不被误扫；完成通知丢失的孤儿后台态在 1 小时内由清扫器兜底回落（服务端 jsonl
 *  已终局时任何一次列表刷新/重同步会提前回落，清扫器是最后兕底）。 */
export const BACKGROUND_STALE_MS = 60 * 60_000;

interface SessionsState {
  /** 按项目绝对路径分组的会话列表 */
  byProject: Record<string, SessionListItem[]>;
  /** 会话运行态覆盖（SSE 事件写入，id → 状态；回合结束清除） */
  runStates: Record<string, SessionRunState>;
  /** 会话生效模型（"provider/model"；docs08-r6 任务 8 ④⑤⑥）：SSE model_changed 回显
   * 与 prompt 回执 appliedModel 双路写入；adoptSessionId 随换 key 迁移。不在此 = 未知
   * （胶囊待生效徽标按「选中 ≠ 生效」判定、水位环 tooltip/分母校准降级处理）。 */
  appliedModels: Record<string, string>;
  /** 运行态活动时刻账本（W1 缺陷 #3，与 runStates 同键并行）：setRunState 写入、
   * 该会话任何 SSE 事件刷新（touchRunStateAt），周期清扫据此判无活动超时回落。
   * 组件不消费本字段（状态点仍读 runStates，值形状因此不被破坏）。 */
  runStateAt: Record<string, number>;
  /** 运行态写入序号（r10 todo 9 顺序护栏，与 runStates 同键并行）：setRunState 每次
   * 写入自增（含同态写入）。回前台对账（event-dispatch.reconcileRunStateOnVisible）
   * 发起前快照目标会话序号，回包后序号未变才应用——对账在途/之后到达的新帧写入
   * 不被旧对账结果覆盖（新帧胜出）。组件不消费本字段。 */
  runStateSeq: Record<string, number>;
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
  /** adopt 后待服务端确认的行 id 集合（task 19f）：语义同 aliasIds 的整替保护，
   * 但不参与 select 的 URL 清参（真实 id 应入 URL）。服务端列表带回该行后集合项
   * 惰性滞留（合并时同 id 命中即不追回，无副作用）；removeSession 随删清除。 */
  pendingIds: Record<string, true>;
  loading: boolean;

  setQ(q: string): void;
  setArchived(archived: ArchivedFilter): void;
  /** 聚合视图切换（todo 10 侧栏接线；切换后调用方负责 refreshSessions） */
  setAllMode(allMode: boolean): void;
  /** 标签过滤写入（todo 11；调用方负责随后 refreshSessions） */
  setTagFilter(tags: string[]): void;
  select(id: string | null): void;
  setLoading(loading: boolean): void;
  /** 整体替换某项目的列表（refetch 结果）：仍在 aliasIds 的占位行不被服务端响应冲掉
   * （mergeAliasRows 原位追回 + 按 path 去重，docs08-r6 任务 7） */
  setSessions(project: string, sessions: SessionListItem[]): void;
  /** 聚合响应写入（todo 9）：按 session.project 分组，整体替换 byProject——
   * 全量 refetch 语义，单项目模式下残留的旧分组与已删除的项目不会滞留；
   * 别名占位行同 setSessions 口径追回（含聚合响应消失的项目键，docs08-r6 任务 7） */
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
  /** 会话生效模型写入（幂等：同值不产生新引用，订阅者不重渲染） */
  setAppliedModel(id: string, model: string): void;
  clearRunState(id: string): void;
  /** 该会话任一 SSE 事件的活动记账（event-dispatch 调用；无运行态时 no-op） */
  touchRunStateAt(id: string): void;
  /** 无活动超时清扫（W1 缺陷 #3，60s 周期由 event-dispatch 驱动）：running/waiting
   * 最后活动距今超过阈值回落 idle（常量见文件头）。now 供单测注入确定性时刻。 */
  sweepStaleRunStates(now?: number): void;
  /** 未落盘占位行采用真实 id（首条消息落盘后服务端回执带回，缺陷修复：新会话首条
   *  消息不显示）：行 id、当前选中、运行态点一并迁移 */
  adoptSessionId(oldId: string, newId: string): void;
  /** 发消息即上浮（docs08 2026-10-23/24 批次任务 13）：本地乐观把该会话行移到
   *  服务端排序口径（byPinnedThenModified 镜像：置顶优先 + modified 降序）应有的
   *  位置——置顶行永不下沉，非置顶行浮到非置顶区之首；modified 同步写当前时刻，
   *  后续 refreshSessions 返回服务端真相时位置已一致，无视觉跳变。行不存在（如
   *  adopt 换 key 竞态窗口）时 no-op，刷新时点兜底。 */
  floatSessionUp(id: string): void;
  /** createSession 回执 id 记入别名集合（session-list 新建会话路径调用，先于 select） */
  markAliasId(id: string): void;
  /** durable=true 创建回执 id 记入整替保护集合（task 19h）：真实创建路径无别名换 key，
   * 行仅 upsert 本地副本，随后 hydration 探询刷新会用尚未含新会话的服务端列表整替冲掉
   * 它（SSE 实时路径仅 patchSession，无行 no-op 无法补回）——并入 19f 的保护，直到
   * 服务端列表按 id/path 带回真实行。 */
  markPendingId(id: string): void;
}

/** 服务端行 → runStates 的后台态同步（任务 12）：行 runState=background_running 且
 *  当前态非 running/waiting/error（SSE 回合级优先）时写入；行已非后台且当前态是
 *  background_running 时清除（终局回落——jsonl 终态回执后任何一次列表刷新即收敛）。
 *  纯同步函数，返回增量分片（无变化返回空对象不产生新引用）。 */
function syncBackgroundStates(
  s: Pick<SessionsState, "runStates" | "runStateAt">,
  rows: SessionListItem[],
): Partial<Pick<SessionsState, "runStates" | "runStateAt">> {
  let runStates = s.runStates;
  let runStateAt = s.runStateAt;
  for (const row of rows) {
    const cur = runStates[row.id];
    if (row.runState === "background_running") {
      if (cur === "running" || cur === "waiting" || cur === "error" || cur === "background_running") continue;
      runStates = { ...runStates, [row.id]: "background_running" };
      runStateAt = { ...runStateAt, [row.id]: Date.now() };
    } else if (cur === "background_running") {
      const next = { ...runStates };
      delete next[row.id];
      const nextAt = { ...runStateAt };
      delete nextAt[row.id];
      runStates = next;
      runStateAt = nextAt;
    }
  }
  return runStates === s.runStates ? {} : { runStates, runStateAt };
}

/** 整替合并的保护键（IS-5 task 19f）：别名 id（aliasIds）+ 已 adopt 真实 id 但服务端
 * 列表尚未带回的行（pendingIds）。adoptSessionId 把别名行换 key 到真实 id 时同步把
 * 保护迁到 pendingIds——否则 adopt 后必然的 hydration 探询刷新（ChatSession 按
 * sessionId 重挂载触发）会用尚未含新会话的服务端列表把行冲掉，SSE 实时路径又只有
 * patchSession（无行 no-op）无法补回，占位行直到下次刷新才重现（F3 IS-5 FAIL 根因）。 */
function mergeKeys(s: Pick<SessionsState, "aliasIds" | "pendingIds">): Record<string, true> {
  return Object.keys(s.pendingIds).length === 0 ? s.aliasIds : { ...s.aliasIds, ...s.pendingIds };
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

/** 整替合并保占位（docs08-r6 任务 7）：服务端列表整替后，把仍在 aliasIds 且不在服务端
 * 列表（id 与 path 双查）的别名占位行按旧列表原索引追回（原位，相对次序保持）；服务端
 * 已有同 path 行（首条消息落盘后刷新带回真实行）时弃别名行选 durable 行，防同路径双行。
 * 仅认 aliasIds 集合：removeSession 清别名后残留的旧行不会被追回（已删会话不复活）。 */
function mergeAliasRows(
  prev: SessionListItem[],
  next: SessionListItem[],
  aliasIds: Record<string, true>,
): SessionListItem[] {
  const nextIds = new Set(next.map((s) => s.id));
  const nextPaths = new Set(next.map((s) => s.path));
  const restore: { index: number; row: SessionListItem }[] = [];
  for (let i = 0; i < prev.length; i++) {
    const row = prev[i];
    if (!(row.id in aliasIds)) continue;
    if (nextIds.has(row.id)) continue; // 服务端已含该行（如已落盘），整替即得，不追
    if (nextPaths.has(row.path)) continue; // 同 path durable 行已在：弃别名行，防双行
    restore.push({ index: i, row });
  }
  if (restore.length === 0) return next;
  const merged = next.slice();
  for (const { index, row } of restore) {
    merged.splice(Math.min(index, merged.length), 0, row);
  }
  return merged;
}

export const useSessionsStore = create<SessionsState>()((set) => ({
  byProject: {},
  runStates: {},
  appliedModels: {},
  runStateAt: {},
  runStateSeq: {},
  q: "",
  archived: "false",
  allMode: false,
  tagFilter: [],
  selectedId: null,
  aliasIds: {},
  pendingIds: {},
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
    set((s) => ({
      byProject: { ...s.byProject, [project]: mergeAliasRows(s.byProject[project] ?? [], sessions, mergeKeys(s)) },
      ...syncBackgroundStates(s, sessions),
    })),

  setAllSessions: (sessions) =>
    set((s) => {
      const byProject: Record<string, SessionListItem[]> = {};      for (const session of sessions) {
        (byProject[session.project] ??= []).push(session);
      }
      // 占位行追回（docs08-r6 任务 7）：聚合键内的按项目合并；聚合响应里消失的旧项目
      // 键，若仍有别名占位行则以追回结果重建键（新建会话后立即切项目/搜索冲刷窗口行不丢）
      for (const [project, list] of Object.entries(byProject)) {
        const prev = s.byProject[project];
        if (prev) byProject[project] = mergeAliasRows(prev, list, mergeKeys(s));
      }
      for (const [project, prev] of Object.entries(s.byProject)) {
        if (project in byProject) continue;
        const restored = mergeAliasRows(prev, [], mergeKeys(s));
        if (restored.length > 0) byProject[project] = restored;
      }
      return { byProject, ...syncBackgroundStates(s, sessions) };
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
      let pendingIds = s.pendingIds;
      if (id in s.pendingIds) {
        pendingIds = { ...s.pendingIds };
        delete pendingIds[id];
        changed = true;
      }
      return changed || selectedId !== s.selectedId ? { byProject, selectedId, aliasIds, pendingIds } : s;
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
      // 顺序护栏（r10 todo 9）：每次写入自增（含同态写入——同态帧同样晚于对账快照，
      // 旧对账结果一律让位于新帧）。同态路径 runStates 引用仍不变，状态点订阅者不重
      // 渲染（runStateSeq 非组件消费字段）。
      const runStateSeq = { ...s.runStateSeq, [id]: (s.runStateSeq[id] ?? 0) + 1 };
      if (s.runStates[id] === state) {
        // 同态写入只刷新活动时刻（runStates 引用不变，状态点订阅者不重渲染）
        return s.runStateAt[id] === now
          ? { runStateSeq }
          : { runStateAt: { ...s.runStateAt, [id]: now }, runStateSeq };
      }
      return {
        runStates: { ...s.runStates, [id]: state },
        runStateAt: { ...s.runStateAt, [id]: now },
        runStateSeq,
      };
    }),

  setAppliedModel: (id, model) =>
    set((s) => (s.appliedModels[id] === model ? s : { appliedModels: { ...s.appliedModels, [id]: model } })),

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
        if (state !== "running" && state !== "waiting" && state !== "background_running") continue;
        const at = s.runStateAt[id];
        if (at === undefined) continue; // 账本缺时刻（外部直写残留）不判超时，宁可不回落
        const staleMs =
          state === "running" ? RUNNING_STALE_MS : state === "waiting" ? WAITING_STALE_MS : BACKGROUND_STALE_MS;
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
      let appliedModels = s.appliedModels;
      if (oldId in s.appliedModels) {
        appliedModels = { ...s.appliedModels };
        appliedModels[newId] = appliedModels[oldId];
        delete appliedModels[oldId];
      }
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
      // 别名集合随换 key 移除旧 id（新 id 是真实落盘 id，不入集合——URL 语义不变）；
      // 整替保护同步迁入 pendingIds（task 19f）：adopt 后 hydration 探询刷新的服务端
      // 列表尚无新会话，缺保护则占位行被冲掉且实时路径无法补回
      let aliasIds = s.aliasIds;
      let pendingIds = s.pendingIds;
      if (oldId in s.aliasIds) {
        aliasIds = { ...s.aliasIds };
        delete aliasIds[oldId];
        pendingIds = { ...pendingIds, [newId]: true };
      }
      return changed || selectedId !== s.selectedId || runStates !== s.runStates || appliedModels !== s.appliedModels || aliasIds !== s.aliasIds || pendingIds !== s.pendingIds
        ? { byProject, selectedId, runStates, runStateAt, appliedModels, aliasIds, pendingIds }
        : s;
    });
    // 选中态换 key：URL 同步换写真实 id（URL 里若是别名 id，此处原地纠正）
    if (wasSelected && oldId !== newId) writeSessionUrl(newId);
  },

  floatSessionUp: (id) =>
    set((s) => {
      const now = new Date().toISOString();
      for (const [project, list] of Object.entries(s.byProject)) {
        const idx = list.findIndex((item) => item.id === id);
        if (idx < 0) continue;
        const next = list.slice();
        next[idx] = { ...next[idx], modified: now };
        // 服务端 byPinnedThenModified 镜像（routes-session.ts:196）；Array.sort 稳定，
        // 未动行保持既有（服务端）相对序，乐观位与刷新后位一致
        next.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.modified.localeCompare(a.modified));
        return { byProject: { ...s.byProject, [project]: next } };
      }
      return s;
    }),

  markAliasId: (id) =>
    set((s) => {
      let aliasIds = s.aliasIds;
      let runStates = s.runStates;
      let runStateAt = s.runStateAt;
      let changed = false;
      if (!(id in aliasIds)) {
        aliasIds = { ...aliasIds, [id]: true };
        changed = true;
      }
      // 入口归零（r11 todo 12c）：createSession 回执落地即清该 id 的运行态残留——创建
      // RPC 冷启动窗口内（引擎 spawn 数秒）boot 帧可按回执键抢先写入 waiting/running
      // （durable=false 回执 id 可为 routing handle，engine-runtime createSession 别名
      // 路径 `let id = opened.sessionId`），空会话没有任何回合收尾帧可清，只能入口处
      // 一次性归零。幂等语义保留：无新增且无残留时返回原引用。
      if (id in runStates || id in runStateAt) {
        runStates = { ...runStates };
        delete runStates[id];
        runStateAt = { ...runStateAt };
        delete runStateAt[id];
        changed = true;
      }
      return changed ? { aliasIds, runStates, runStateAt } : s;
    }),

  markPendingId: (id) =>
    set((s) => {
      let pendingIds = s.pendingIds;
      let runStates = s.runStates;
      let runStateAt = s.runStateAt;
      let changed = false;
      if (!(id in pendingIds)) {
        pendingIds = { ...pendingIds, [id]: true };
        changed = true;
      }
      // 入口归零（r11 todo 12c）：同 markAliasId——durable=true 回执落地时创建 RPC
      // 窗口内的 boot 残留（回执键等待/运行态）一并清零。
      if (id in runStates || id in runStateAt) {
        runStates = { ...runStates };
        delete runStates[id];
        runStateAt = { ...runStateAt };
        delete runStateAt[id];
        changed = true;
      }
      return changed ? { pendingIds, runStates, runStateAt } : s;
    }),
}));