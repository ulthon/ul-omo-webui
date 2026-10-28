// 会话列表（W3 todo 10 单列表重构）：侧栏唯一列表——全部注册项目的会话按项目分组平铺，
// 分组头可折叠（localStorage 按项目记忆），顶部"最近会话"区跨项目按 modified 取最新 8 条直达。
// 跨项目点击统一 handler（分组行/搜索结果行/行内子会话行/最近区行共用）：同项目仅 select；
// 跨项目轻量切换 currentProject + 应用该项目偏好模型（跳过 lastOpenedAt PATCH）。
// 数据来自 store.refreshSessions 的聚合分支（todo 9）；旧 human/all 分段控件已删——
// 列表固定含 fork 会话（血缘归组），fork 行标题带「(fork #N)」后缀、来源徽标改 GitFork+fork。
// 归档三态/搜索/批量模式照常工作，
// 搜索走聚合端点并固定 archived=all（归档会话与 fork 子会话仍可被搜到）。
// 纯逻辑（分组排序/最近选取/折叠记忆/跨项目判定）在 global-list-data.ts；fork 编号在
// session-item.tsx 的 buildForkIndexes（列表加载时整表一次算好缓存），单测锁定。
// 既有能力保持：未读清零（选中且页面可见时 POST /:id/read，visibilitychange 兜底）、
// 元数据操作弹窗、批量归档/批量删除（todo 25：勾选集合提升到本容器，删除走确认弹窗）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, ChevronDown, EyeOff, Filter, ListChecks, Loader2, MessageSquare, MoreVertical, Plus, Search, Tag, Trash2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { SessionListItem, TagDefinition } from "@/lib/api";
import { loadProjectModels } from "@/lib/bootstrap";
import { useSessionsStore, type ArchivedFilter } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
// tSnap：异步续体（await 之后/promise 回调）取词用快照态；渲染期文本走 useT 响应式
import { t as tSnap, useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  GROUP_VISIBLE_LIMIT,
  GROUP_VISIBLE_STEP,
  LOCATE_EVENT,
  PROJECT_ORDER_KV,
  crossProjectDecision,
  flattenSessions,
  groupOrder,
  isGroupExpanded,
  recentTop,
  writeCollapsed,
} from "./global-list-data";
import { SessionItem, buildForkIndexes } from "./session-item";
import { SessionDialogs, type SessionDialogState } from "./dialogs";
import { TagDropdown } from "./tag-dropdown";
import { TagManageDialog, type TagManageScope, type TagOrphanCleanup } from "./tag-manage-dialog";
import { definedTagKeys, dedupeTagDefs, mergeTagOptions, tagColorMap, type TagDefs } from "./tag-data";

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
  const projectSort = useUiStore((s) => s.projectSort);
  const projectOrder = useUiStore((s) => s.projectOrder);
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
  // 每组可见条数（r9 wave1）：按项目键控，缺省 = GROUP_VISIBLE_LIMIT（10）。值 Infinity =
  // topbar「定位」触发的临时全展——仅本次会话内有效，刷新重挂载回落默认；切项目不重置，
  // 与 groupOverrides 同为会话内覆盖语义。搜索/批量模式渲染全量，不读此值。
  const [groupVisible, setGroupVisible] = useState<Record<string, number>>({});
  const [recentOpen, setRecentOpen] = useState(true);
  const [dialog, setDialog] = useState<SessionDialogState | null>(null);
  const [creating, setCreating] = useState(false);
  // 批量模式（todo 25）：勾选集合提升到容器层；归档循环的进度反馈
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  // 标签（todo 11）：两源定义集（涉及项目合并；perProjectDefs 保留项目归属）、
  // 打标签下拉集合（docs08-r3 任务 13：sessions + 锚点元素，null=关闭）、
  // 管理弹层域（docs08-r3 任务 11 拆域：null=关闭，否则 global 或 { projectPath }）
  const [tagDefs, setTagDefs] = useState<TagDefs | null>(null);
  const [perProjectDefs, setPerProjectDefs] = useState<Record<string, TagDefinition[]>>({});
  const [tagDropdown, setTagDropdown] = useState<{ sessions: SessionListItem[]; anchor: HTMLElement } | null>(null);
  const [manageScope, setManageScope] = useState<TagManageScope | null>(null);
  // 项目隐藏（A2 docs08-r3 任务 10）：当前项目隐藏需确认弹层（回空会话态），非当前直接执行
  const [hidePending, setHidePending] = useState<string | null>(null);
  const [hiding, setHiding] = useState(false);

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
      // 定位同时临时全展该组（r9 wave1）：Infinity 语义见 groupVisible 声明处
      setGroupVisible((s) => ({ ...s, [project]: Number.POSITIVE_INFINITY }));
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

  // 全局搜索（250ms 防抖）：走聚合端点，固定 archived=all（与既有搜索语义一致：
  // 归档会话与 fork 子会话仍可被搜到）；单请求替代此前跨项目并行 GET，排序沿用服务端口径。
  const runSearch = useCallback(async (q: string) => {
    if (q === "") {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const res = await api.listSessions({ archived: "all", q });
      setSearchResults(res.sessions);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast(tSnap("sessionList.list.searchFailed"), "error");
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

  const t = useT();
  const toggleGroup = (project: string) => {
    const next = !isGroupExpanded(project, currentProject, groupOverrides[project]);
    setGroupOverrides((s) => ({ ...s, [project]: next }));
    writeCollapsed(project, !next);
  };

  /** 归档切换：聚合口径整体重取（参数跨项目生效，全部组数据同步换口径） */
  const switchFilter = (patch: { archived?: ArchivedFilter }) => {
    const s = useSessionsStore.getState();
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
        const meta = ui.projects.find((p) => p.projectPath === project);
        // 偏好先行与 openProject 同口径（模型 + 思考档）；随后 await 模型解析完成再建会话
        // （docs08-r5 任务 2：回退链 项目偏好 > 引擎默认 > 列表首项 落定后才发请求，
        // 请求携带解析所得 model 与 thinkingLevel——未解析完不建，避免落回引擎隐式默认）
        ui.setSelectedModel(meta?.preferredModel ?? null);
        ui.setSelectedThinkingLevel(meta?.preferredThinkingLevel ?? null);
        await loadProjectModels(project);
      }
      const { selectedModel, selectedThinkingLevel } = useUiStore.getState();
      const res = await api.createSession({
        project,
        model: selectedModel ?? undefined,
        thinkingLevel: selectedThinkingLevel ?? undefined,
      });
      // 空会话不落盘（引擎实证）——先 upsert 占位行，发送首条消息落盘后刷新即以真实数据替换
      const now = new Date().toISOString();
      useSessionsStore.getState().upsertSession(project, {
        id: res.session.id,
        path: res.session.sessionPath,
        project,
        title: t("sessionList.list.untitledTitle"),
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
      // B1：仅 durable=false 的回执 id 是未落盘别名（客户端无法从 id 本身区分，local-
      // 前缀仅消息条目）——记入别名集合，select 时清 ?session= 参数（刷新命中占位 id
      // 必落错误态）。durable=true 的回执 id 即磁盘真实 id，选中即写入 URL；此后首条
      // 发送不会换 key（adoptSessionId 只服务 durable=false 路径）。
      if (!res.session.durable) {
        useSessionsStore.getState().markAliasId(res.session.id);
      } else {
        // durable=true 路径（task 19h）：行仅 upsert 本地副本，记入整替保护集合，
        // 直到服务端列表按 id/path 带回真实行——否则探询刷新冲掉后实时路径补不回
        useSessionsStore.getState().markPendingId(res.session.id);
      }
      useSessionsStore.getState().select(res.session.id);
      // F-1（docs08-r4 验证波 F3）：手机档抽屉内新建会话后自动收起（与 selectSession 同一
      // 关闭路径；桌面侧栏常驻，drawerOpen 无视觉效果，写 false 无害且与现状一致）
      ui.setDrawerOpen(false);
      useUiStore.getState().showToast(t("sessionList.list.createdToast"));
    } catch (err) {
      useUiStore.getState().showToast(apiErrorMessage(err, "sessionList.list.createFailed"), "error");
    } finally {
      setCreating(false);
    }
  };

  // 分组排序（C16 docs08-r3 todo 9）：当前项目组置顶规则不变；其余项目按档位排序——
  // activity=现状（各组最新 modified 降序）、added=createdAt 升序（存量行退化
  // lastOpenedAt 稳定序）、manual=kv 手动序（未列项目按 activity 规则追加）。
  // A2 客户端防御过滤（双保险第二道）：hidden 分组在此剔除——服务端聚合已滤
  // hidden 项目会话（byProject 无该键），但空分组渲染自 ui store projects，
  // 不滤则隐藏项目的空分组头仍会出现。
  const sortedProjects = useMemo(
    () =>
      groupOrder(projects.filter((p) => !p.hidden).map((p) => p.projectPath), byProject, currentProject, {
        mode: projectSort,
        manualOrder: projectOrder,
        meta: Object.fromEntries(
          projects.map((p) => [p.projectPath, { createdAt: p.createdAt ?? null, lastOpenedAt: p.lastOpenedAt }]),
        ),
      }),
    [projects, byProject, currentProject, projectSort, projectOrder],
  );

  /** 隐藏/恢复项目（A2 docs08-r3 任务 10）：软标记 PUT 后 refetch projects（hidden 驱动
   * 上面 sortedProjects 的防御过滤）+ refreshSessions（服务端聚合口径同步换）；
   * 隐藏的是当前项目时复用注销的回空会话态流程（清 currentProject + 选中会话），
   * 非当前项目不动选中。 */
  const hideProject = async (projectPath: string, hidden: boolean) => {
    if (hiding) return;
    setHiding(true);
    try {
      await api.putProjectHidden(projectPath, hidden);
      setHidePending(null);
      const res = await api.listProjects();
      const ui = useUiStore.getState();
      ui.setProjects(res.projects);
      if (hidden && ui.currentProject === projectPath) {
        ui.setCurrentProject(null);
        useSessionsStore.getState().select(null);
      }
      void useSessionsStore.getState().refreshSessions();
      ui.showToast(hidden ? t("sessionList.list.projectHidden") : t("sessionList.list.projectShown"), "info");
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast(apiErrorMessage(err, "sessionList.list.operationFailed"), "error");
      }
    } finally {
      setHiding(false);
    }
  };

  // ---- 手动排序（C16 todo 9，仅 manual 档）：本地先行更新 + kv 持久（跨设备一致）----
  /** 顺序落 kv：本地 store 先行（即时生效），PUT 失败仅提示（下次 bootstrap 重读 kv 纠偏） */
  const persistManualOrder = useCallback(async (nextOrder: string[]) => {
    useUiStore.getState().setProjectOrder(nextOrder);
    try {
      await api.putSettings({ [PROJECT_ORDER_KV]: JSON.stringify(nextOrder) });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast(t("sessionList.list.saveManualOrderFailed"), "error");
      }
    }
  }, [t]);

  /** 把某项目移到当前展示序的目标位（当前项目组置顶规则不动——kv 序仅作用于其余组） */
  const moveProjectTo = useCallback(
    (srcPath: string, targetPath: string) => {
      const order = useUiStore.getState().projectOrder;
      // 基准：现有 kv 序（过滤掉已注销路径）∪ 当前未列项目按展示序追加，保证拖拽增量可预期
      const registered = useUiStore.getState().projects.map((p) => p.projectPath);
      const base = [
        ...order.filter((p) => registered.includes(p)),
        ...sortedProjects.filter((p) => p !== currentProject && !order.includes(p)),
      ].filter((p, i, arr) => arr.indexOf(p) === i);
      const from = base.indexOf(srcPath);
      const to = base.indexOf(targetPath);
      if (from < 0 || to < 0 || from === to) return;
      const next = [...base];
      next.splice(from, 1);
      next.splice(to, 0, srcPath);
      void persistManualOrder(next);
    },
    [currentProject, sortedProjects, persistManualOrder],
  );

  /** 上移/下移一位（manual 档；入口在分组头唯一 DropdownMenu——手机与桌面同菜单） */
  const moveProjectByStep = useCallback(
    (projectPath: string, delta: -1 | 1) => {
      const order = useUiStore.getState().projectOrder;
      const registered = useUiStore.getState().projects.map((p) => p.projectPath);
      const base = [
        ...order.filter((p) => registered.includes(p)),
        ...sortedProjects.filter((p) => p !== currentProject && !order.includes(p)),
      ].filter((p, i, arr) => arr.indexOf(p) === i);
      const from = base.indexOf(projectPath);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= base.length) return;
      const next = [...base];
      next.splice(from, 1);
      next.splice(to, 0, projectPath);
      void persistManualOrder(next);
    },
    [currentProject, sortedProjects, persistManualOrder],
  );

  // 桌面拖拽状态（HTML5 DnD，仅 manual 档分组头）：dragger 存被拖路径，drop 目标经
  // dataTransfer 传递路径字符串；stale state（拖拽中途刷新）无持久副作用——未 drop 即无写
  const manual = projectSort === "manual";
  const dragProjectRef = useRef<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  // 最近会话：跨项目按 modified 取最新 8 条（置顶自然参与）
  const recent = useMemo(() => recentTop(flattenSessions(byProject)), [byProject]);
  // fork 编号表（W3 todo 10）：列表加载时对整份数据一次算好缓存（byProject 引用不变即不重算），
  // 编号 = 同父兄弟按 sessionPath 升序位次；最近区/搜索结果/行内子会话行共用同一张表。
  const forkIndexes = useMemo(() => buildForkIndexes(flattenSessions(byProject)), [byProject]);

  // ---- 标签（todo 11）----

  const tagFilter = useSessionsStore((s) => s.tagFilter);

  /** 两源定义集加载：全局 + 全部注册项目的项目级标签合并。
   * 用注册全集而非"列表涉及项目"——标签过滤会收缩 byProject（服务端过滤只返回命中行），
   * 若按列表键集拉取，过滤生效中项目级选项会从下拉里消失（stale state 对抗类）。 */
  const reloadTagDefs = useCallback(async () => {
    const { projects: registered } = useUiStore.getState();
    try {
      const global = await api.listTags();
      const projectLists = await Promise.all(
        registered.map((p) => api.listTags(p.projectPath).then((r) => r.project).catch(() => [] as TagDefinition[])),
      );
      setTagDefs({ global: global.global, project: projectLists.flat() });
      // 项目归属保留（任务 11 拆域）：管理弹框项目入口需要该项目的单项目列表，
      // 合并集会把其他项目的定义整替进本项目
      setPerProjectDefs(Object.fromEntries(registered.map((p, i) => [p.projectPath, projectLists[i]])));
    } catch (err) {
      // 标签守卫（docs08 2026-10-23/24 批次任务 10）：非 401 失败不再写空定义集——
      // 空集会把全部挂载误判为孤儿，配合旧“点按即清理”就是静默删库路径。
      // 保留 null（未就绪）：definedKeys 为 null，孤儿判定整体跳过（TagBadges
      // 不渲染，管理/打标入口 disabled），等下次签名变更重拉。
      if (err instanceof ApiError && err.status === 401) return;
      // 不写任何状态：tagDefs/perProjectDefs 维持加载前值（初始 null）
    }
  }, []);

  const projectKeysSig = useMemo(
    () => projects.map((p) => p.projectPath).sort().join("\u0000"),
    [projects],
  );
  useEffect(() => {
    // 经微任务启动加载：reloadTagDefs 内的 setTagDefs 全在 await 之后的异步段，
    // 但 oxlint set-state-in-effect 对 effect 同步调用图直接可达的 setState 一律告警——
    // queueMicrotask 把启动切出同步图（等价改写，非 disable）；async 函数体本就异步调度，
    // 加载语义与"末次签名获胜"的竞态行为不变。
    queueMicrotask(() => void reloadTagDefs());
  }, [projectKeysSig, reloadTagDefs]);

  const definedKeys = useMemo(() => (tagDefs ? definedTagKeys(tagDefs) : null), [tagDefs]);
  const tagOptions = useMemo(() => (tagDefs ? mergeTagOptions(tagDefs) : []), [tagDefs]);
  /** 筛选面（下拉选项+chips）名称→有效色（todo 20：显式色 ?? hash，永远文字+色点） */
  const filterTagColors = useMemo(() => (tagDefs ? tagColorMap(tagDefs) : new Map<string, string>()), [tagDefs]);

  /** 过滤 chips 勾选切换（多选 OR 语义）：写 store 后整体重取（refreshSessions 透传 tags） */
  const toggleTagFilter = (name: string) => {
    const s = useSessionsStore.getState();
    s.setTagFilter(s.tagFilter.includes(name) ? s.tagFilter.filter((t) => t !== name) : [...s.tagFilter, name]);
    void useSessionsStore.getState().refreshSessions();
  };

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
      setBatchProgress({ label: archived ? t("sessionList.list.archiving") : t("sessionList.list.unarchiving"), done: i, total: ids.length });
      try {
        await api.patchSessionMeta(ids[i], { archived });
      } catch {
        failed.push(ids[i]);
      }
    }
    setBatchProgress({ label: archived ? t("sessionList.list.archiving") : t("sessionList.list.unarchiving"), done: ids.length, total: ids.length });
    setBatchBusy(false);
    setBatchProgress(null);
    setSelectedIds(new Set());
    if (failed.length === 0) {
      useUiStore
        .getState()
        .showToast(t(archived ? "sessionList.list.archivedN" : "sessionList.list.unarchivedN", { n: ids.length }));
    } else {
      useUiStore.getState().showToast(
        t("sessionList.list.batchArchiveResult", {
          ok: ids.length - failed.length,
          total: ids.length,
          failed: failed.length,
        }),
        "error",
      );
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

  /** 行内菜单分流（todo 11 / 任务 13）：rename/delete 走既有弹窗单例；tags 打开锚定
   *  下拉（锚点 = 行菜单钮元素，由 session-item 传入） */
  const handleItemDialog = useCallback(
    (kind: "rename" | "delete" | "tags" | "schedule", session: SessionListItem, anchor?: HTMLElement) => {
      if (kind === "tags") {
        if (anchor) setTagDropdown({ sessions: [session], anchor });
        return;
      }
      setDialog({ kind, session });
    },
    [],
  );

  const archivedLabel =
    archived === "false" ? t("sessionList.list.filterUnarchived") : archived === "true" ? t("sessionList.list.filterArchived") : t("sessionList.list.filterIncludingArchived");

  // ---- 打标签下拉（docs08-r3 任务 13）----

  /** 「管理…」落点域（任务 13 规则写死）：单会话 = 会话所属项目（无所属项目退 global
   *  仅全局组）；批量 = 选中集全部同属一项目才用该项目，跨项目 null（按钮置灰） */
  const tagDropdownScope = useMemo<TagManageScope | null>(() => {
    if (!tagDropdown) return null;
    if (tagDropdown.sessions.length === 1) {
      const p = tagDropdown.sessions[0].project;
      return p ? { projectPath: p } : "global";
    }
    const projects = new Set(tagDropdown.sessions.map((s) => s.project));
    return projects.size === 1 ? { projectPath: [...projects][0] } : null;
  }, [tagDropdown]);

  /** 下拉两段列表的定义集：单会话/同项目批量 = 该项目的单项目列表（perProjectDefs，
   *  与管理弹框单组契约同源）；跨项目批量 = 合并集去重（与管理无关，仅展示勾选） */
  const tagDropdownDefs = useMemo<TagDefs | null>(() => {
    if (!tagDropdown || !tagDefs) return null;
    const projects = new Set(tagDropdown.sessions.map((s) => s.project));
    if (projects.size === 1) {
      const p = [...projects][0];
      return { global: tagDefs.global, project: perProjectDefs[p] ?? [] };
    }
    return dedupeTagDefs(tagDefs);
  }, [tagDropdown, tagDefs, perProjectDefs]);

  /** 管理弹框孤儿清理清单（任务 10）：定义就绪时按当前 definedKeys 算本 scope 相关的
   * 孤儿挂载（global 域 = 全部会话 global 挂载；project 域 = 仅该项目会话）；
   * definedKeys 为 null（未就绪）时返回 null——定义未知不判定孤儿，更不提供删除 */
  const orphanCleanups = useMemo<TagOrphanCleanup[] | null>(() => {
    if (!manageScope || !definedKeys) return null;
    const out: TagOrphanCleanup[] = [];
    for (const s of flattenSessions(byProject)) {
      if (typeof manageScope === "object" && s.project !== manageScope.projectPath) continue;
      const orphans = (s.tags ?? []).filter(
        (t) =>
          (typeof manageScope === "object" ? t.scope === "project" : t.scope === "global") &&
          !definedKeys.has(`${t.scope}\u0000${t.name}`),
      );
      if (orphans.length === 0) continue;
      const keep = (s.tags ?? []).filter((t) => !orphans.some((o) => o.scope === t.scope && o.name === t.name));
      out.push({ sessionId: s.id, sessionTitle: s.renamedTitle ?? s.title ?? s.id, orphans, keep });
    }
    return out;
  }, [manageScope, definedKeys, byProject]);

  /** 批量模式行 props（todo 25：勾选集合提升到本容器） */
  const itemBatchProps = (s: SessionListItem) =>
    batchMode
      ? { selectable: true, checked: selectedIds.has(s.id), onToggleCheck: toggleCheck }
      : { selectable: false };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条：新建 + 全局搜索 + 批量/归档/标签（搜索模式下隐藏后者）。
          触控目标（todo 26 走查修复）：手机 ≥44px（lg 保持桌面紧凑尺寸）。
          A1（docs08-r4 任务 5）：手机档容器内边距与纵向节奏收紧（p/space 1.5），
          lg 档维持原 p-2/space-y-2；"新建会话"固定在 currentProject 创建
          （分组头 "+" 才是跨项目落点）。 */}
      <div className="shrink-0 space-y-1.5 border-b px-1.5 py-1.5 lg:space-y-2 lg:px-2 lg:py-2">
        {/* 点击时刻实时读 currentProject：跨项目点击后 300ms 内 React 提交可能未完成，
            render 闭包值会滞后并把 createSession 的落点拉回旧项目（S7 QA 实证） */}
        <Button size="sm" className="h-11 w-full gap-1 text-xs lg:h-7" disabled={creating || !currentProject} onClick={() => void createSession(useUiStore.getState().currentProject)}>
          {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          {t("sessionList.list.newSession")}
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("sessionList.list.searchPlaceholder")}
            className="h-11 pl-7 pr-7 text-xs lg:h-7"
          />
          {searchInput && (
            <button
              type="button"
              aria-label={t("sessionList.list.clearSearch")}
              className="absolute right-1.5 top-1/2 size-7 -translate-y-1/2 rounded text-muted-foreground hover:bg-muted"
              onClick={() => setSearchInput("")}
            >
              <X className="mx-auto size-3.5" />
            </button>
          )}
        </div>
        {searchResults === null && (
          <div className="flex items-center gap-1 lg:gap-1.5">
            {/* 批量/归档/标签（W3 todo 10：分段控件已删，单列表唯一口径）。
                whitespace-nowrap + shrink-0 保 390px 窄视口下工具条单行不折行。 */}
            <Button
              variant="ghost"
              size="sm"
              className={`ml-auto h-11 shrink-0 whitespace-nowrap gap-1 px-1.5 text-xs lg:h-6 ${batchMode ? "text-foreground" : "text-muted-foreground"}`}
              onClick={() => (batchMode ? exitBatch() : setBatchMode(true))}
              data-testid="batch-toggle"
            >
              <ListChecks className="size-3" />
              {t("sessionList.list.batch")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-11 shrink-0 whitespace-nowrap gap-1 px-1.5 text-xs text-muted-foreground lg:h-6">
                  <Filter className="size-3" />
                  {archivedLabel}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => switchFilter({ archived: "false" })}>
                  {t("sessionList.list.filterUnarchived")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => switchFilter({ archived: "true" })}>
                  {t("sessionList.list.filterArchived")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => switchFilter({ archived: "all" })}>
                  {t("sessionList.list.filterAll")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {/* 标签过滤下拉（todo 11）：多选 chips OR 语义（任一命中）；CheckboxItem preventDefault
                保持菜单打开支持连续勾选；底部"管理标签"入口。 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-11 shrink-0 whitespace-nowrap gap-1 px-1.5 text-xs lg:h-6 ${tagFilter.length > 0 ? "text-foreground" : "text-muted-foreground"}`}
                  data-testid="tag-filter-btn"
                >
                  <Tag className="size-3" />
                  {tagFilter.length > 0 ? t("sessionList.list.tagFilter", { n: tagFilter.length }) : t("sessionList.list.tags")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 w-44 overflow-y-auto" data-testid="tag-filter-menu">
                {tagOptions.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("sessionList.list.noTags")}</div>
                ) : (
                  tagOptions.map((name) => (
                    <DropdownMenuCheckboxItem
                      key={name}
                      checked={tagFilter.includes(name)}
                      onSelect={(e) => {
                        e.preventDefault();
                        toggleTagFilter(name);
                      }}
                      data-testid={`tag-filter-option-${name}`}
                    >
                      {/* 筛选面永远文字+色点（todo 20 (e)：不做颜色模式，色点 = tagColor 有效色） */}
                      <span
                        aria-hidden
                        className="mr-1 inline size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: filterTagColors.get(name) }}
                      />
                      {name}
                    </DropdownMenuCheckboxItem>
                  ))
                )}
                <DropdownMenuSeparator />
                {/* 全局入口（任务 11 拆域）：恒 global，与当前项目无关 */}
                <DropdownMenuItem onSelect={() => setManageScope("global")} data-testid="manage-tags-item">
                  {t("sessionList.list.manageTags")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {/* 已选标签 chips（todo 11）：点击移除（OR 语义下缩小命中集） */}
        {tagFilter.length > 0 && (
          <div className="flex flex-wrap gap-1" data-testid="tag-filter-chips">
            {tagFilter.map((name) => (
              <button
                key={name}
                type="button"
                className="inline-flex min-h-7 items-center gap-0.5 rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                title={t("sessionList.list.removeFilterTag")}
                data-tag-chip={name}
                onClick={() => toggleTagFilter(name)}
              >
                <span
                  aria-hidden
                  className="inline size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: filterTagColors.get(name) }}
                />
                {name}
                <X className="size-2.5" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 批量操作条（todo 25）：勾选集合上的归档/删除（删除走确认弹窗）+ 全选 + 进度 */}
      {batchMode && (
        <div className="flex shrink-0 items-center gap-1 border-b px-1.5 py-1.5 text-xs lg:px-2" data-testid="batch-bar">
          <span className="text-muted-foreground">{t("sessionList.list.selectedCount", { n: selectedIds.size })}</span>
          <Button variant="ghost" size="sm" className="h-11 px-1.5 text-xs lg:h-6" disabled={batchBusy} onClick={selectAllVisible}>
            {t("sessionList.list.selectAll")}
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
            {archived === "true" ? t("sessionList.list.unarchive") : t("sessionList.list.archive")}
          </Button>
          {/* 批量打标签（任务 13）：锚定下拉对选中集合循环 PUT 勾选即存，进度反馈在下拉内；
              锚点 = 本钮（点击时刻的 DOM 元素存入 state） */}
          <Button
            variant="ghost"
            size="sm"
            className="h-11 gap-1 px-1.5 text-xs lg:h-6"
            disabled={batchBusy || selectedIds.size === 0 || !tagDefs}
            onClick={(e) => setTagDropdown({ sessions: findSessions(selectedIds), anchor: e.currentTarget })}
            data-testid="batch-tag-btn"
          >
            <Tag className="size-3" />
            {t("sessionList.list.tagSessions")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-11 gap-1 px-1.5 text-xs text-destructive hover:text-destructive lg:h-6"
            disabled={batchBusy || selectedIds.size === 0}
            onClick={openBatchDelete}
          >
            <Trash2 className="size-3" />
            {t("common.delete")}
          </Button>
          {batchProgress && (
            <span className="text-muted-foreground" data-testid="batch-progress">
              {batchProgress.label} {batchProgress.done}/{batchProgress.total}…
            </span>
          )}
          <Button variant="ghost" size="sm" className="ml-auto h-11 px-1.5 text-xs lg:h-6" disabled={batchBusy} onClick={exitBatch}>
            {t("sessionList.list.done")}
          </Button>
        </div>
      )}

      {/* 列表主体（滚动容器）：最近会话区 + 全部项目分组
          （A1 docs08-r4 任务 5：手机档 p-1，lg 档维持 p-1.5） */}
      <div ref={listBodyRef} data-testid="session-scroll" className="min-h-0 flex-1 overflow-y-auto p-1 lg:p-1.5">
        {searchResults !== null ? (
          searching && searchResults.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">{t("sessionList.list.searching")}</div>
          ) : searchResults.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">{t("sessionList.list.noMatch")}</div>
          ) : (
            searchResults.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                forkIndexes={forkIndexes}
                projectLabel={basename(s.project)}
                onSelect={selectSession}
                onDialog={handleItemDialog}
                definedKeys={definedKeys}
                defs={tagDefs}
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
                  className="flex min-h-11 w-full items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground lg:min-h-7 lg:px-1.5"
                  onClick={() => setRecentOpen((v) => !v)}
                >
                  <ChevronDown className={`size-3 shrink-0 transition-transform ${recentOpen ? "" : "-rotate-90"}`} />
                  {t("sessionList.list.recent")}
                  <span className="ml-auto shrink-0 tabular-nums">{recent.length}</span>
                </button>
                {recentOpen &&
                  recent.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      forkIndexes={forkIndexes}
                      projectLabel={basename(s.project)}
                      onSelect={selectSession}
                      onDialog={handleItemDialog}
                      definedKeys={definedKeys}
                      defs={tagDefs}
                      onChanged={onChanged}
                      {...itemBatchProps(s)}
                    />
                  ))}
              </div>
            )}
            {recent.length > 0 && sortedProjects.length > 0 && <div className="mx-1.5 border-t" />}

            {sortedProjects.map((projectPath, index) => {
              const sessions = byProject[projectPath];
              const expanded = isGroupExpanded(projectPath, currentProject, groupOverrides[projectPath]);
              const isCurrent = projectPath === currentProject;
              // 唯一列表（W3 todo 10）：子会话按血缘归到父项下。
              // 父不在当前数据集（如归档过滤只返回归档子会话）时子会话按孤儿顶层平铺，不丢行。
              const pathSet = new Set((sessions ?? []).map((s) => s.path));
              const tops = (sessions ?? []).filter(
                (s) => s.parentSessionPath === null || !pathSet.has(s.parentSessionPath),
              );
              // 分组截断（r9 wave1）：默认只渲染前 GROUP_VISIBLE_LIMIT 条顶层行；搜索/批量模式全量不截断
              // （搜索模式分组本就不渲染，此处对批量模式豁免）；locate 全展走 Infinity。
              const visibleLimit =
                searchResults !== null || batchMode
                  ? Number.POSITIVE_INFINITY
                  : (groupVisible[projectPath] ?? GROUP_VISIBLE_LIMIT);
              const shownTops = tops.slice(0, visibleLimit);
              const remainingTops = tops.length - shownTops.length;
              return (
                <div key={projectPath} data-project-group={projectPath}>
                  {/* 分组头（C16 todo 9）：manual 档下整行作为桌面 HTML5 拖拽源/目标。
                      右侧为分组头唯一 DropdownMenu（A2 docs08-r3 任务 10 吸收任务 9 的
                      手机过渡"上移/下移"菜单而成，手机与桌面同菜单）：排序组（仅 manual 档）
                      /"隐藏该项目"（当前项目带确认弹层）/「管理标签」（任务 11 已接线：scope=本分组项目）。 */}
                  <div
                    className={`flex items-center gap-0.5 ${manual && dragOverPath === projectPath ? "rounded-md outline outline-1 outline-primary/50" : ""}`}
                    draggable={manual}
                    data-testid="group-header"
                    onDragStart={(e) => {
                      dragProjectRef.current = projectPath;
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", projectPath);
                    }}
                    onDragEnd={() => {
                      dragProjectRef.current = null;
                      setDragOverPath(null);
                    }}
                    onDragOver={(e) => {
                      if (!manual || dragProjectRef.current === null || dragProjectRef.current === projectPath) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragOverPath(projectPath);
                    }}
                    onDragLeave={(e) => {
                      if (!manual) return;
                      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                      setDragOverPath((cur) => (cur === projectPath ? null : cur));
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverPath(null);
                      const src = e.dataTransfer.getData("text/plain") || dragProjectRef.current;
                      dragProjectRef.current = null;
                      if (!src || src === projectPath) return;
                      moveProjectTo(src, projectPath);
                    }}
                  >
                    <button
                      type="button"
                      data-testid="group-toggle"
                      aria-expanded={expanded}
                      className={`flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground lg:min-h-7 lg:px-1.5 ${manual ? "cursor-grab active:cursor-grabbing" : ""}`}
                      onClick={() => toggleGroup(projectPath)}
                    >
                      <ChevronDown className={`size-3 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`} />
                      <span className={`truncate ${isCurrent ? "font-medium text-foreground" : ""}`} title={projectPath}>
                        {basename(projectPath)}
                      </span>
                      {isCurrent && <span className="shrink-0 text-[10px] text-muted-foreground/60">{t("sessionList.list.current")}</span>}
                      {/* 空项目组显示但标注 0（todo 10） */}
                      <span className="ml-auto shrink-0 tabular-nums">{sessions?.length ?? 0}</span>
                    </button>
                    {/* 分组头唯一菜单（A2）：三组语义——排序（仅 manual 档）/隐藏/管理标签（任务 11 已接线）。
                        菜单 onSelect 内实时读 currentProject（跨项目点击后 render 闭包可能滞后）。 */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          data-testid="group-menu"
                          aria-label={t("sessionList.list.groupMenu", { name: basename(projectPath) })}
                          className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:size-6"
                        >
                          <MoreVertical className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" data-testid="group-menu-content">
                        {manual && (
                          <>
                            <DropdownMenuItem
                              disabled={index <= 0}
                              data-testid="group-move-up"
                              onSelect={() => moveProjectByStep(projectPath, -1)}
                            >
                              {t("sessionList.list.moveUp")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={index >= sortedProjects.length - 1}
                              data-testid="group-move-down"
                              onSelect={() => moveProjectByStep(projectPath, 1)}
                            >
                              {t("sessionList.list.moveDown")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                          </>
                        )}
                        <DropdownMenuItem
                          data-testid="group-hide"
                          onSelect={() => {
                            if (useUiStore.getState().currentProject === projectPath) {
                              setHidePending(projectPath);
                            } else {
                              void hideProject(projectPath, true);
                            }
                          }}
                        >
                          <EyeOff className="mr-2 size-3.5" />
                          {t("sessionList.list.hideProject")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {/* 项目入口（任务 11 拆域接线）：管理弹框 scope = 本分组项目 */}
                        <DropdownMenuItem
                          data-testid="group-manage-tags"
                          onSelect={() => setManageScope({ projectPath })}
                        >
                          {t("sessionList.list.manageTags")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {/* 分组头 "+"：在该项目内新建并轻量切到该项目（todo 10 新建会话落点） */}
                    <button
                      type="button"
                      data-testid="group-new"
                      aria-label={t("sessionList.list.newInProject", { name: basename(projectPath) })}
                      title={t("sessionList.list.newInProject", { name: basename(projectPath) })}
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
                        <div className="px-2 py-4 text-center text-xs text-muted-foreground">{t("sessionList.list.loading")}</div>
                      ) : tops.length === 0 ? (
                        <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
                          <MessageSquare className="size-6 text-muted-foreground/40" />
                          <p className="text-xs text-muted-foreground">{t("sessionList.list.empty")}</p>
                        </div>
                      ) : (
                        <>
                          {shownTops.map((s) => (
                            <SessionItem
                              key={s.id}
                              session={s}
                              forkIndexes={forkIndexes}
                              onSelect={selectSession}
                              onDialog={handleItemDialog}
                              definedKeys={definedKeys}
                              defs={tagDefs}
                              onChanged={onChanged}
                              {...itemBatchProps(s)}
                            />
                          ))}
                          {remainingTops > 0 && (
                            <button
                              type="button"
                              data-testid="group-load-more"
                              className="flex min-h-11 w-full items-center justify-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground lg:min-h-7 lg:px-1.5"
                              onClick={() =>
                                setGroupVisible((s) => ({
                                  ...s,
                                  [projectPath]: (s[projectPath] ?? GROUP_VISIBLE_LIMIT) + GROUP_VISIBLE_STEP,
                                }))
                              }
                            >
                              {t("sessionList.list.loadMore")}
                              {t("sessionList.list.loadMoreRemaining", { n: remainingTops })}
                            </button>
                          )}
                        </>
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
      {/* 隐藏当前项目确认（A2）：回空会话态是可感知变化，确认弹层防误触；非当前项目直接隐藏不弹 */}
      <Dialog
        open={hidePending !== null}
        onOpenChange={(open) => {
          if (!hiding) setHidePending(open ? hidePending : null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("sessionList.list.hideProjectTitle")}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1.5 text-left">
                <p>{t("sessionList.list.hideProjectDesc1", { name: hidePending ? basename(hidePending) : "" })}</p>
                <p>{t("sessionList.list.hideProjectDesc2")}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" disabled={hiding} onClick={() => setHidePending(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={hiding}
              data-testid="group-hide-confirm"
              onClick={() => hidePending && void hideProject(hidePending, true)}
            >
              {hiding ? t("sessionList.list.hiding") : t("sessionList.list.confirmHide")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {tagDropdown && tagDropdownDefs && (
        <TagDropdown
          anchor={tagDropdown.anchor}
          sessions={tagDropdown.sessions}
          defs={tagDropdownDefs}
          manageScope={tagDropdownScope}
          onManage={() => {
            setTagDropdown(null);
            if (tagDropdownScope) setManageScope(tagDropdownScope);
          }}
          onClose={() => {
            setTagDropdown(null);
            onChanged();
          }}
        />
      )}
      {manageScope && tagDefs && (
        <TagManageDialog
          scope={manageScope}
          /* 单组契约：弹框只用 scope 对应组——项目入口传该项目的单项目列表
           *（合并集会把其他项目的定义整替进本项目），全局入口只传 global 组 */
          defs={
            typeof manageScope === "object"
              ? { global: [], project: perProjectDefs[manageScope.projectPath] ?? [] }
              : { global: tagDefs.global, project: [] }
          }
          orphanCleanups={orphanCleanups ?? undefined}
          onChanged={() => void reloadTagDefs()}
          onClose={() => setManageScope(null)}
        />
      )}
    </div>
  );
}
