// 会话列表（todo 10 全局平铺重构）：侧栏默认全局视图——全部注册项目的会话按项目分组平铺，
// 分组头可折叠（localStorage 按项目记忆），顶部"最近会话"区跨项目按 modified 取最新 8 条直达。
// 跨项目点击统一 handler（分组行/搜索结果行/钻取子会话行/最近区行共用）：同项目仅 select；
// 跨项目轻量切换 currentProject + 应用该项目偏好模型（跳过 lastOpenedAt PATCH）。
// 数据来自 store.refreshSessions 的聚合分支（todo 9）；视图切换/归档三态/搜索/批量模式在全局视图照常工作，
// 搜索改走聚合端点并固定 view=all&archived=all（归档会话与 fork 子会话仍可被搜到）。
// 纯逻辑（分组排序/最近选取/折叠记忆/跨项目判定）在 global-list-data.ts，单测锁定。
// 既有能力保持：未读清零（选中且页面可见时 POST /:id/read，visibilitychange 兜底）、
// 元数据操作弹窗、批量归档/批量删除（todo 25：勾选集合提升到本容器，删除走确认弹窗）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, ChevronDown, Filter, ListChecks, Loader2, MessageSquare, Plus, Search, Trash2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { SessionListItem } from "@/lib/api";
import { loadProjectModels } from "@/lib/bootstrap";
import { useSessionsStore, type ArchivedFilter, type SessionView } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  LOCATE_EVENT,
  crossProjectDecision,
  flattenSessions,
  groupOrder,
  isGroupExpanded,
  recentTop,
  writeCollapsed,
} from "./global-list-data";
import { SessionItem } from "./session-item";
import { SessionDialogs, type SessionDialogState } from "./dialogs";

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** 选中且页面可见 → 已读上报（"任一设备查看即清零"；仅未读 > 0 时发请求） */
function useMarkReadOnView(): void {
  const selectedId = useSessionsStore((s) => s.selectedId);
  useEffect(() => {
    const mark = () => {
      const { selectedId: id, byProject } = useSessionsStore.getState();
      if (!id || typeof document === "undefined" || document.visibilityState !== "visible") return;
      let unread = 0;
      for (const list of Object.values(byProject)) {
        const hit = list.find((s) => s.id === id);
        if (hit) {
          unread = hit.unreadCount;
          break;
        }
      }
      if (unread === 0) return;
      api
        .markRead(id)
        .then(() => {
          useSessionsStore.getState().patchSession(id, { unreadCount: 0, lastRead: new Date().toISOString() });
        })
        .catch(() => {
          // 网络瞬断容错；下次选中/回前台再报
        });
    };
    mark();
    const onVis = () => {
      if (document.visibilityState === "visible") mark();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [selectedId]);
}

export function SessionList() {
  const currentProject = useUiStore((s) => s.currentProject);
  const projects = useUiStore((s) => s.projects);
  const view = useSessionsStore((s) => s.view);
  const archived = useSessionsStore((s) => s.archived);
  const byProject = useSessionsStore((s) => s.byProject);
  const loading = useSessionsStore((s) => s.loading);

  const [searchInput, setSearchInput] = useState("");
  const [searchResults, setSearchResults] = useState<SessionListItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  // 组展开态：本次会话内的显式点按覆盖；持久记忆走 localStorage（isGroupExpanded 内读取），
  // 都缺省时当前项目组展开、其余折叠。不做 currentProject 同步 effect——默认展开随
  // currentProject 变化由派生规则自然生效，显式覆盖按记忆语义保留。
  const [groupOverrides, setGroupOverrides] = useState<Record<string, boolean>>({});
  const [recentOpen, setRecentOpen] = useState(true);
  const [dialog, setDialog] = useState<SessionDialogState | null>(null);
  const [creating, setCreating] = useState(false);
  // 批量模式（todo 25）：勾选集合提升到容器层；归档循环的进度反馈
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ label: string; done: number; total: number } | null>(null);

  const listBodyRef = useRef<HTMLDivElement | null>(null);

  useMarkReadOnView();

  // 默认全局视图（todo 10）：进入时置 allMode 并按聚合口径刷新（幂等）
  useEffect(() => {
    const s = useSessionsStore.getState();
    if (!s.allMode) s.setAllMode(true);
    void s.refreshSessions();
  }, []);

  // topbar 项目切换器的"定位"动作：展开该组 + 滚动置顶（数据刷新由 openProject 的
  // 聚合分支 refreshSessions 负责，这里只做侧栏视口动作）
  useEffect(() => {
    const onLocate = (e: Event) => {
      const project = (e as CustomEvent).detail;
      if (typeof project !== "string") return;
      setGroupOverrides((s) => ({ ...s, [project]: true }));
      writeCollapsed(project, false);
      // 展开渲染在下一帧，rAF 后再定位
      requestAnimationFrame(() => {
        listBodyRef.current
          ?.querySelector(`[data-project-group="${CSS.escape(project)}"]`)
          ?.scrollIntoView({ block: "start" });
      });
    };
    window.addEventListener(LOCATE_EVENT, onLocate);
    return () => window.removeEventListener(LOCATE_EVENT, onLocate);
  }, []);

  // 全局搜索（250ms 防抖）：走聚合端点，固定 view=all + archived=all（与既有搜索语义一致：
  // 归档会话与 fork 子会话仍可被搜到）；单请求替代此前跨项目并行 GET，排序沿用服务端口径。
  const runSearch = useCallback(async (q: string) => {
    if (q === "") {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const res = await api.listSessions({ view: "all", archived: "all", q });
      setSearchResults(res.sessions);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast("搜索失败", "error");
      }
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void runSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput, runSearch]);

  /** 操作成功后校准：聚合口径整体重取（归档/置顶的过滤与排序由服务端口径落地），
   * 搜索模式重跑搜索让结果行即时反映变更 */
  const onChanged = useCallback(() => {
    void useSessionsStore.getState().refreshSessions();
    const q = searchInput.trim();
    if (q !== "") void runSearch(q);
  }, [searchInput, runSearch]);

  const toggleGroup = (project: string) => {
    const next = !isGroupExpanded(project, currentProject, groupOverrides[project]);
    setGroupOverrides((s) => ({ ...s, [project]: next }));
    writeCollapsed(project, !next);
  };

  /** 视图/归档切换：聚合口径整体重取（全局视图下两组参数跨项目生效，全部组数据同步换口径） */
  const switchFilter = (patch: { view?: SessionView; archived?: ArchivedFilter }) => {
    const s = useSessionsStore.getState();
    if (patch.view) s.setView(patch.view);
    if (patch.archived) s.setArchived(patch.archived);
    void s.refreshSessions();
  };

  /** 跨项目点击统一 handler（分组行/搜索结果行/钻取子会话行/最近区行共用，todo 10）：
   * 同项目仅 select；跨项目轻量切换 currentProject + 应用该项目偏好模型（模型列表按需补拉），
   * 跳过 lastOpenedAt PATCH——聊一句不应改项目排序，但偏好不能漏应用
   * （否则跨项目跳转后首条 prompt 带旧项目模型，输入历史也记错项目）。 */
  const selectSession = useCallback((session: SessionListItem) => {
    const ui = useUiStore.getState();
    useSessionsStore.getState().select(session.id);
    const decision = crossProjectDecision(session.project, ui.currentProject, ui.projects);
    if (decision.switchProject) {
      ui.setCurrentProject(session.project);
      ui.setSelectedModel(decision.preferredModel);
      if (ui.models.length === 0) void loadProjectModels(session.project);
    }
    // 抽屉态（lg 以下）选中会话后自动收起（todo 26 既有行为，统一收口到共享 handler）
    ui.setDrawerOpen(false);
  }, []);

  /** 新建会话：工具条按钮在 currentProject 创建；分组头 "+" 在该项目内创建
   * （创建后轻量切到该项目——当前项目=正在聊的会话的项目语义，todo 10）。 */
  const createSession = async (project: string | null) => {
    if (!project || creating) return;
    setCreating(true);
    try {
      const ui = useUiStore.getState();
      if (ui.currentProject !== project) {
        ui.setCurrentProject(project);
        const preferred = ui.projects.find((p) => p.projectPath === project)?.preferredModel ?? null;
        ui.setSelectedModel(preferred);
        if (ui.models.length === 0) void loadProjectModels(project);
      }
      const { selectedModel } = useUiStore.getState();
      const res = await api.createSession({ project, model: selectedModel ?? undefined });
      // 空会话不落盘（引擎实证）——先 upsert 占位行，发送首条消息落盘后刷新即以真实数据替换
      const now = new Date().toISOString();
      useSessionsStore.getState().upsertSession(project, {
        id: res.session.id,
        path: res.session.sessionPath,
        project,
        title: "新会话",
        name: null,
        renamedTitle: null,
        parentSessionPath: null,
        created: now,
        modified: now,
        messageCount: 0,
        firstMessage: "",
        pinned: false,
        archivedAt: null,
        unreadCount: 0,
        lastRead: null,
        active: null,
      });
      useSessionsStore.getState().select(res.session.id);
      useUiStore.getState().showToast("会话已创建，发送首条消息后保存");
    } catch (err) {
      useUiStore.getState().showToast(err instanceof ApiError ? err.message : "创建失败", "error");
    } finally {
      setCreating(false);
    }
  };

  // 分组排序：当前项目组最前，其余按各组最新 modified 降序（纯函数 groupOrder）
  const sortedProjects = useMemo(
    () => groupOrder(projects.map((p) => p.projectPath), byProject, currentProject),
    [projects, byProject, currentProject],
  );
  // 最近会话：跨项目按 modified 取最新 8 条（置顶自然参与）
  const recent = useMemo(() => recentTop(flattenSessions(byProject)), [byProject]);

  // ---- 批量操作（todo 25）----

  const exitBatch = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
    setBatchProgress(null);
  };

  const toggleCheck = (session: SessionListItem) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(session.id)) next.delete(session.id);
      else next.add(session.id);
      return next;
    });
  };

  /** 当前可见行（搜索结果或最近区 + 已展开分组）——"全选"的范围 */
  const visibleSessions = (): SessionListItem[] => {
    if (searchResults !== null) return searchResults;
    const out: SessionListItem[] = [...recent];
    for (const projectPath of sortedProjects) {
      if (!isGroupExpanded(projectPath, currentProject, groupOverrides[projectPath])) continue;
      out.push(...(byProject[projectPath] ?? []));
    }
    return out;
  };

  const selectAllVisible = () => {
    setSelectedIds(new Set(visibleSessions().map((s) => s.id)));
  };

  /** 按 id 跨项目查会话行（批量删除弹窗取标题用） */
  const findSessions = (ids: Set<string>): SessionListItem[] => {
    const out: SessionListItem[] = [];
    for (const list of Object.values(byProject)) {
      for (const s of list) if (ids.has(s.id)) out.push(s);
    }
    return out;
  };

  /** 批量归档/取消归档：逐个调既有 PATCH 循环 + 进度反馈，失败逐条收集不中断整批 */
  const runBatchArchive = async (archived: boolean) => {
    if (batchBusy || selectedIds.size === 0) return;
    setBatchBusy(true);
    const ids = [...selectedIds];
    const failed: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      setBatchProgress({ label: archived ? "归档中" : "取消归档中", done: i, total: ids.length });
      try {
        await api.patchSessionMeta(ids[i], { archived });
      } catch {
        failed.push(ids[i]);
      }
    }
    setBatchProgress({ label: archived ? "归档中" : "取消归档中", done: ids.length, total: ids.length });
    setBatchBusy(false);
    setBatchProgress(null);
    setSelectedIds(new Set());
    if (failed.length === 0) {
      useUiStore.getState().showToast(`已${archived ? "归档" : "取消归档"} ${ids.length} 个会话`);
    } else {
      useUiStore
        .getState()
        .showToast(`${ids.length - failed.length}/${ids.length} 成功，${failed.length} 个失败（见网络日志）`, "error");
    }
    onChanged();
  };

  /** 批量删除入口：确认弹窗托管在 SessionDialogs（>20 个强化确认 + 进度） */
  const openBatchDelete = () => {
    if (selectedIds.size === 0) return;
    const sessions = findSessions(selectedIds);
    setDialog({
      kind: "batch-delete",
      ids: sessions.map((s) => s.id),
      titles: sessions.map((s) => s.title),
    });
  };

  const archivedLabel = archived === "false" ? "未归档" : archived === "true" ? "已归档" : "含归档";

  /** 批量模式行 props（todo 25：勾选集合提升到本容器） */
  const itemBatchProps = (s: SessionListItem) =>
    batchMode
      ? { selectable: true, checked: selectedIds.has(s.id), onToggleCheck: toggleCheck }
      : { selectable: false };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条：新建 + 全局搜索 + 视图/归档切换（搜索模式下隐藏后者）。
          触控目标（todo 26 走查修复）：手机 ≥44px（lg 保持桌面紧凑尺寸）。
          "新建会话"固定在 currentProject 创建（全局视图下分组头 "+" 才是跨项目落点）。 */}
      <div className="shrink-0 space-y-2 border-b px-2 py-2">
        <Button size="sm" className="h-11 w-full gap-1 text-xs lg:h-7" disabled={creating || !currentProject} onClick={() => void createSession(currentProject)}>
          {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          新建会话
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="搜索全部项目的会话…"
            className="h-11 pl-7 pr-7 text-xs lg:h-7"
          />
          {searchInput && (
            <button
              type="button"
              aria-label="清空搜索"
              className="absolute right-1.5 top-1/2 size-7 -translate-y-1/2 rounded text-muted-foreground hover:bg-muted"
              onClick={() => setSearchInput("")}
            >
              <X className="mx-auto size-3.5" />
            </button>
          )}
        </div>
        {searchResults === null && (
          <div className="flex items-center gap-1.5">
            <div className="flex rounded-md border p-0.5 text-xs">
              <button
                type="button"
                className={`rounded px-2 py-2 lg:py-0.5 ${view === "human" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => switchFilter({ view: "human" })}
              >
                人工
              </button>
              <button
                type="button"
                className={`rounded px-2 py-2 lg:py-0.5 ${view === "all" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => switchFilter({ view: "all" })}
              >
                全部活动
              </button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className={`ml-auto h-11 gap-1 px-1.5 text-xs lg:h-6 ${batchMode ? "text-foreground" : "text-muted-foreground"}`}
              onClick={() => (batchMode ? exitBatch() : setBatchMode(true))}
              data-testid="batch-toggle"
            >
              <ListChecks className="size-3" />
              批量
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-11 gap-1 px-1.5 text-xs text-muted-foreground lg:h-6">
                  <Filter className="size-3" />
                  {archivedLabel}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => switchFilter({ archived: "false" })}>未归档</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => switchFilter({ archived: "true" })}>已归档</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => switchFilter({ archived: "all" })}>全部</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {/* 批量操作条（todo 25）：勾选集合上的归档/删除（删除走确认弹窗）+ 全选 + 进度 */}
      {batchMode && (
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5 text-xs" data-testid="batch-bar">
          <span className="text-muted-foreground">已选 {selectedIds.size}</span>
          <Button variant="ghost" size="sm" className="h-11 px-1.5 text-xs lg:h-6" disabled={batchBusy} onClick={selectAllVisible}>
            全选
          </Button>
          {/* todo 26 走查修复：已归档视图下批量动作应为取消归档（原写死归档，归档会话无法批量恢复） */}
          <Button
            variant="ghost"
            size="sm"
            className="h-11 gap-1 px-1.5 text-xs lg:h-6"
            disabled={batchBusy || selectedIds.size === 0}
            onClick={() => void runBatchArchive(archived !== "true")}
          >
            {archived === "true" ? <ArchiveRestore className="size-3" /> : <Archive className="size-3" />}
            {archived === "true" ? "取消归档" : "归档"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-11 gap-1 px-1.5 text-xs text-destructive hover:text-destructive lg:h-6"
            disabled={batchBusy || selectedIds.size === 0}
            onClick={openBatchDelete}
          >
            <Trash2 className="size-3" />
            删除
          </Button>
          {batchProgress && (
            <span className="text-muted-foreground" data-testid="batch-progress">
              {batchProgress.label} {batchProgress.done}/{batchProgress.total}…
            </span>
          )}
          <Button variant="ghost" size="sm" className="ml-auto h-11 px-1.5 text-xs lg:h-6" disabled={batchBusy} onClick={exitBatch}>
            完成
          </Button>
        </div>
      )}

      {/* 列表主体（滚动容器）：最近会话区 + 全部项目分组 */}
      <div ref={listBodyRef} data-testid="session-scroll" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {searchResults !== null ? (
          searching && searchResults.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">搜索中…</div>
          ) : searchResults.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">无匹配会话</div>
          ) : (
            searchResults.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                showSource
                projectLabel={basename(s.project)}
                expandable={s.parentSessionPath === null}
                onSelect={selectSession}
                onDialog={(kind, session) => setDialog({ kind, session })}
                onChanged={onChanged}
                {...itemBatchProps(s)}
              />
            ))
          )
        ) : (
          <>
            {/* 最近会话区（todo 10）：跨项目按 modified 最新 8 条，独立可折叠，行复用 SessionItem 标注来源项目 */}
            {recent.length > 0 && (
              <div className="pb-1" data-testid="recent-section">
                <button
                  type="button"
                  data-testid="recent-toggle"
                  aria-expanded={recentOpen}
                  className="flex min-h-11 w-full items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground lg:min-h-7"
                  onClick={() => setRecentOpen((v) => !v)}
                >
                  <ChevronDown className={`size-3 shrink-0 transition-transform ${recentOpen ? "" : "-rotate-90"}`} />
                  最近会话
                  <span className="ml-auto shrink-0 tabular-nums">{recent.length}</span>
                </button>
                {recentOpen &&
                  recent.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      showSource={view === "all"}
                      projectLabel={basename(s.project)}
                      expandable={s.parentSessionPath === null}
                      onSelect={selectSession}
                      onDialog={(kind, session) => setDialog({ kind, session })}
                      onChanged={onChanged}
                      {...itemBatchProps(s)}
                    />
                  ))}
              </div>
            )}
            {recent.length > 0 && sortedProjects.length > 0 && <div className="mx-1.5 border-t" />}

            {sortedProjects.map((projectPath) => {
              const sessions = byProject[projectPath];
              const expanded = isGroupExpanded(projectPath, currentProject, groupOverrides[projectPath]);
              const isCurrent = projectPath === currentProject;
              // all 视图分层：子会话按血缘归到父项下；human 视图列表本身全是顶层。
              // 父不在当前数据集（如归档过滤只返回归档子会话）时子会话按孤儿顶层平铺，不丢行。
              const pathSet = new Set((sessions ?? []).map((s) => s.path));
              const tops = (sessions ?? []).filter(
                (s) => s.parentSessionPath === null || !pathSet.has(s.parentSessionPath),
              );
              const isTop = (s: SessionListItem) => s.parentSessionPath === null;
              const childMap = new Map<string, SessionListItem[]>();
              for (const s of sessions ?? []) {
                if (s.parentSessionPath) {
                  const list = childMap.get(s.parentSessionPath);
                  if (list) list.push(s);
                  else childMap.set(s.parentSessionPath, [s]);
                }
              }
              return (
                <div key={projectPath} data-project-group={projectPath}>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      data-testid="group-toggle"
                      aria-expanded={expanded}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground lg:min-h-7"
                      onClick={() => toggleGroup(projectPath)}
                    >
                      <ChevronDown className={`size-3 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`} />
                      <span className={`truncate ${isCurrent ? "font-medium text-foreground" : ""}`} title={projectPath}>
                        {basename(projectPath)}
                      </span>
                      {isCurrent && <span className="shrink-0 text-[10px] text-muted-foreground/60">当前</span>}
                      {/* 空项目组显示但标注 0（todo 10） */}
                      <span className="ml-auto shrink-0 tabular-nums">{sessions?.length ?? 0}</span>
                    </button>
                    {/* 分组头 "+"：在该项目内新建并轻量切到该项目（todo 10 新建会话落点） */}
                    <button
                      type="button"
                      data-testid="group-new"
                      aria-label={`在 ${basename(projectPath)} 新建会话`}
                      title={`在 ${basename(projectPath)} 新建会话`}
                      disabled={creating}
                      className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:size-6"
                      onClick={(e) => {
                        e.stopPropagation();
                        void createSession(projectPath);
                      }}
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                  {expanded && (
                    <div className="pb-1">
                      {loading && sessions === undefined ? (
                        <div className="px-2 py-4 text-center text-xs text-muted-foreground">加载中…</div>
                      ) : tops.length === 0 ? (
                        <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
                          <MessageSquare className="size-6 text-muted-foreground/40" />
                          <p className="text-xs text-muted-foreground">暂无会话</p>
                        </div>
                      ) : (
                        tops.map((s) => (
                          <SessionItem
                            key={s.id}
                            session={s}
                            showSource={view === "all"}
                            knownChildren={childMap.get(s.path)}
                            expandable={isTop(s)}
                            childrenOpen={view === "all"}
                            onSelect={selectSession}
                            onDialog={(kind, session) => setDialog({ kind, session })}
                            onChanged={onChanged}
                            {...itemBatchProps(s)}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      <SessionDialogs state={dialog} onClose={() => setDialog(null)} onChanged={onChanged} />
    </div>
  );
}
