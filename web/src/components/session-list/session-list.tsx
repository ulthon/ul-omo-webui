// 会话列表主组件（计划 todo 15/25）：项目分组（当前项目置顶默认展开，其余组懒加载）、
// 视图切换（人工 / 全部活动）、归档三态、全局搜索（跨项目并行查询合并，结果标注来源项目）、
// 新建会话（空会话未落盘先 upsert 占位，发送首条消息落盘后被刷新数据替换）、
// 未读清零（选中且页面可见时 POST /:id/read，visibilitychange 兜底）、元数据操作弹窗、
// 批量归档/批量删除（todo 25：勾选集合提升到本容器，删除走确认弹窗，逐个调既有 API
// 循环 + 进度反馈，失败逐条报告不中断整批）。
import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, ChevronDown, Filter, ListChecks, Loader2, MessageSquare, Plus, Search, Trash2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { SessionListItem } from "@/lib/api";
import { refreshSessions } from "@/lib/bootstrap";
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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<SessionDialogState | null>(null);
  const [creating, setCreating] = useState(false);
  // 批量模式（todo 25）：勾选集合提升到容器层；归档循环的进度反馈
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ label: string; done: number; total: number } | null>(null);

  useMarkReadOnView();

  // 全局搜索（250ms 防抖）：跨全部已注册项目并行查询（view=all + 含归档，子会话也命中），
  // 合并按置顶优先 + 最后活动倒序；结果标注来源项目。
  const runSearch = useCallback(async (q: string) => {
    if (q === "") {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const ps = useUiStore.getState().projects;
      const groups = await Promise.all(
        ps.map((p) =>
          api
            .listSessions({ project: p.projectPath, view: "all", archived: "all", q })
            .then((r) => r.sessions)
            .catch(() => [] as SessionListItem[]),
        ),
      );
      const merged = groups.flat();
      merged.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.modified.localeCompare(a.modified));
      setSearchResults(merged);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void runSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput, runSearch]);

  // 当前项目变化：仅当前项目组默认展开（当前项目优先展示）
  useEffect(() => {
    setExpandedGroups(currentProject ? { [currentProject]: true } : {});
  }, [currentProject]);

  /** 操作成功后校准：当前项目列表重取（归档/置顶的过滤与排序由服务端口径落地），
   * 搜索模式重跑搜索让结果行即时反映变更 */
  const onChanged = useCallback(() => {
    void refreshSessions();
    const q = searchInput.trim();
    if (q !== "") void runSearch(q);
  }, [searchInput, runSearch]);

  const toggleGroup = async (project: string) => {
    const opening = !expandedGroups[project];
    setExpandedGroups((s) => ({ ...s, [project]: !s[project] }));
    if (opening && project !== currentProject) {
      // 非当前项目组展开即拉取（每次展开重取，口径随当前视图；当前项目由 refreshSessions 维护）
      const { view: v, archived: a } = useSessionsStore.getState();
      try {
        const res = await api.listSessions({ project, view: v, archived: a });
        useSessionsStore.getState().setSessions(project, res.sessions);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) {
          useUiStore.getState().showToast("会话列表加载失败", "error");
        }
      }
    }
  };

  /** 视图/归档切换：当前项目刷新，其余组收起（下次展开按新口径重取） */
  const switchFilter = (patch: { view?: SessionView; archived?: ArchivedFilter }) => {
    const s = useSessionsStore.getState();
    if (patch.view) s.setView(patch.view);
    if (patch.archived) s.setArchived(patch.archived);
    setExpandedGroups(currentProject ? { [currentProject]: true } : {});
    void refreshSessions();
  };

  const createSession = async () => {
    if (!currentProject || creating) return;
    setCreating(true);
    try {
      const { selectedModel } = useUiStore.getState();
      const res = await api.createSession({ project: currentProject, model: selectedModel ?? undefined });
      // 空会话不落盘（引擎实证）——先 upsert 占位行，发送首条消息落盘后刷新即以真实数据替换
      const now = new Date().toISOString();
      useSessionsStore.getState().upsertSession(currentProject, {
        id: res.session.id,
        path: res.session.sessionPath,
        project: currentProject,
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

  // 分组排序：当前项目置顶，其余按 last_opened_at（服务端已 DESC）
  const sortedProjects = [
    ...projects.filter((p) => p.projectPath === currentProject),
    ...projects.filter((p) => p.projectPath !== currentProject),
  ];

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

  /** 当前可见行（搜索结果或已展开分组）——"全选"的范围 */
  const visibleSessions = (): SessionListItem[] => {
    if (searchResults !== null) return searchResults;
    const out: SessionListItem[] = [];
    for (const p of sortedProjects) {
      if (!expandedGroups[p.projectPath]) continue;
      out.push(...(byProject[p.projectPath] ?? []));
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条：新建 + 全局搜索 + 视图/归档切换（搜索模式下隐藏后者）。
          触控目标（todo 26 走查修复）：手机 ≥44px（lg 保持桌面紧凑尺寸） */}
      <div className="shrink-0 space-y-2 border-b px-2 py-2">
        <Button size="sm" className="h-11 w-full gap-1 text-xs lg:h-7" disabled={creating || !currentProject} onClick={() => void createSession()}>
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

      {/* 列表主体 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
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
                onDialog={(kind, session) => setDialog({ kind, session })}
                onChanged={onChanged}
                selectable={batchMode}
                checked={batchMode ? selectedIds.has(s.id) : undefined}
                onToggleCheck={batchMode ? toggleCheck : undefined}
              />
            ))
          )
        ) : (
          sortedProjects.map((p) => {
            const sessions = byProject[p.projectPath];
            const expanded = expandedGroups[p.projectPath] ?? false;
            const isCurrent = p.projectPath === currentProject;
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
              <div key={p.projectPath}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  onClick={() => void toggleGroup(p.projectPath)}
                >
                  <ChevronDown className={`size-3 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`} />
                  <span className={`truncate ${isCurrent ? "font-medium text-foreground" : ""}`} title={p.projectPath}>
                    {basename(p.projectPath)}
                  </span>
                  {isCurrent && <span className="shrink-0 text-[10px] text-muted-foreground/60">当前</span>}
                  <span className="ml-auto shrink-0 tabular-nums">{sessions?.length ?? ""}</span>
                </button>
                {expanded && (
                  <div className="pb-1">
                    {loading && isCurrent && (sessions === undefined || sessions.length === 0) ? (
                      <div className="px-2 py-4 text-center text-xs text-muted-foreground">加载中…</div>
                    ) : sessions === undefined ? (
                      <div className="px-2 py-4 text-center text-xs text-muted-foreground">展开加载…</div>
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
                          onDialog={(kind, session) => setDialog({ kind, session })}
                          onChanged={onChanged}
                          selectable={batchMode}
                          checked={batchMode ? selectedIds.has(s.id) : undefined}
                          onToggleCheck={batchMode ? toggleCheck : undefined}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <SessionDialogs state={dialog} onClose={() => setDialog(null)} onChanged={onChanged} />
    </div>
  );
}
