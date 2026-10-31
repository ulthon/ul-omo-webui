// 顶栏：项目下拉（含添加项目入口，POST /api/projects 服务端路径校验 + 错误回显）、
// 模型切换下拉（todo 22：选择落 meta_project 偏好，防抖 PATCH；agentsList=false 降级已定——
// 不渲染 agent 下拉，"当前 provider/model"语义由模型下拉承担）、设置入口（r9 2026-10-26
// 批次任务 9：改开独立全屏设置页 pages/settings，设置弹层退役）、连接状态点。
// A3+A6（docs08-r4 任务 6）手机档（<lg）单层重排：[汉堡 | 会话标题+项目名小字（点按开
// 会话切换全屏 sheet，任务 19：recentTop 派生直达切换） | 上下文水位环 | 右栏入口钮 | 设置+连接点]，模型下拉手机档退役（经任务 7
// "更多"ModelChip 到达）；桌面（lg+）布局不动（项目/模型下拉原位）。手机档按 useIsMobile
// 条件渲染（DOM 不存在，非 CSS 隐藏）。
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, FolderOpen, FolderPlus, Keyboard, ListTodo, Menu, Settings, X } from "lucide-react";
import { api } from "@/lib/api";
import type { ModelInfo, SessionListItem, TagDefinition } from "@/lib/api";
import { loadProjectModels, openProject } from "@/lib/bootstrap";
import { useIsMobile } from "@/lib/use-is-mobile";
import { scheduleModelPreferencePersist } from "@/lib/preferences";
import { useUiStore } from "@/stores/ui";
import { useT } from "@/i18n/i18n";
import { useSessionsStore } from "@/stores/sessions";
import {
  crossProjectDecision,
  flattenSessions,
  locateProjectInSidebar,
  recentTop,
} from "@/components/session-list/global-list-data";
import { definedTagKeys, type TagDefs } from "@/components/session-list/tag-data";
import { TagBadges } from "@/components/session-list/tag-badge";
import { formatRelative } from "@/components/session-list/session-item";
import { RowPinnedBadge, RowStatusDot, RowUnreadBadge } from "@/components/session-list/row-bits";
import { AddProjectDialog } from "@/components/layout/add-project-dialog";
import { ShortcutsDialog } from "@/components/layout/shortcuts-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

/** 站点名（engine-upgrade 2026-10-30 批次 todo3）：服务端注入 window.__SITE_NAME__，
 * 未设置/非字符串/空串 → null 不渲染（零新增 i18n 键，直用配置值）；登录页同型读取。 */
function readSiteName(): string | null {
  const v = (window as { __SITE_NAME__?: unknown }).__SITE_NAME__;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** 手机档会话切换全屏 sheet（docs08-r7 任务 19，替代原任务 15 下拉菜单）：触发器
 * 点按开 Radix Dialog 全屏页——头部「会话」标题+关闭钮（焦点陷阱/Esc 关闭由 Dialog
 * 原语承担），列表区 recentTop(flattenSessions(byProject))（跨项目 modified 降序 8 条，
 * 派生复用不复制），尾部「添加项目…」（任务 4 双入口之一）；抽屉承载全量列表/搜索/
 * 新建，sheet 内不做（计划 Must NOT）。定制行=标题(text-base≥16px font-medium)+项目
 * 名副行(text-xs muted)+标签徽标（TagBadges 文字形态，任务 20 色格在其内部升级，此处
 * 预留 slot）；行 min-h-11(44px) 触控达标、双行紧凑。头部/尾部按 env(safe-area-inset-*)
 * 让位（任务 6 viewport-fit=cover 先例）。点击直达切换：决策核复用 crossProjectDecision
 * （跨项目 setCurrentProject + setSelectedModel 偏好模型 + 模型按需补拉），选完关 sheet。
 * 标签定义两源键集（global+全部注册项目）沿侧栏 reloadTagDefs 同构，仅 sheet 打开时拉；
 * 失败静默 null→徽标整体不渲染（同侧栏防闪烁语义）。 */
export function SessionSwitcherSheet({
  open,
  onOpenChange,
  onAddProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddProject: () => void;
}) {
  const byProject = useSessionsStore((s) => s.byProject);
  const recent = useMemo(() => recentTop(flattenSessions(byProject)), [byProject]);
  // 两源定义集（todo 20 v2：色源与 display 覆盖判定需完整定义，非仅键集）；
  // definedKeys 仍由定义集派生（孤儿判定基准不变）
  const [tagDefs, setTagDefs] = useState<TagDefs | null>(null);
  const definedKeys = useMemo(() => (tagDefs ? definedTagKeys(tagDefs) : null), [tagDefs]);
  const t = useT();

  // 打开期间加载两源标签定义键集（孤儿判定基准）；卸载/关开竞态用 alive 守卫，
  // 失败不 toast（徽标缺席即可感知，不打扰切换主路径）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      const { projects: registered } = useUiStore.getState();
      try {
        const globalDefs = await api.listTags();
        const projectLists = await Promise.all(
          registered.map((p) =>
            api
              .listTags(p.projectPath)
              .then((r) => r.project)
              .catch(() => [] as TagDefinition[]),
          ),
        );
        if (alive) setTagDefs({ global: globalDefs.global, project: projectLists.flat() });
      } catch {
        if (alive) setTagDefs(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  const select = (s: SessionListItem) => {
    const ui = useUiStore.getState();
    useSessionsStore.getState().select(s.id);
    const decision = crossProjectDecision(s.project, ui.currentProject, ui.projects);
    if (decision.switchProject) {
      ui.setCurrentProject(s.project);
      ui.setSelectedModel(decision.preferredModel);
      if (ui.models.length === 0) void loadProjectModels(s.project);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="session-switcher-sheet"
        data-presentation="fullscreen-sheet"
        className="inset-0 flex h-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-background p-0 text-base text-foreground ring-0 data-open:slide-in-from-bottom-2 data-open:zoom-in-100 sm:max-w-none"
      >
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b px-3 pt-[env(safe-area-inset-top)]">
          <DialogTitle className="text-base font-semibold">{t("login.topbar.switcherSheetTitle")}</DialogTitle>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label={t("login.topbar.switcherSheetClose")}
              data-testid="session-switcher-sheet-close"
            >
              <X className="size-5" />
            </Button>
          </DialogClose>
        </header>
        <div data-testid="session-switcher-sheet-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
          <p className="px-4 pb-1 pt-2 text-xs font-medium text-muted-foreground">{t("sessionList.list.recent")}</p>
          {recent.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground">{t("sessionList.list.empty")}</p>
          )}
          {recent.map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid="sheet-session-item"
              data-session-id={s.id}
              onClick={() => select(s)}
              className="flex min-h-11 w-full flex-col justify-center gap-0.5 px-4 py-1.5 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent/50 active:bg-accent"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <RowStatusDot session={s} />
                {s.pinned && <RowPinnedBadge />}
                <span className="min-w-0 truncate text-base font-medium leading-snug" title={s.title}>
                  {s.title}
                </span>
                <TagBadges session={s} definedKeys={definedKeys} defs={tagDefs} />
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <span className="text-xs text-muted-foreground/70">{formatRelative(s.modified)}</span>
                  <RowUnreadBadge count={s.unreadCount} />
                </span>
              </span>
              <span
                className="block w-full min-w-0 truncate text-xs leading-snug text-muted-foreground"
                title={s.project}
              >
                {basename(s.project)}
              </span>
              {/* 最后消息预览（r10 todo 8）：仅 sheet 行渲染，单行截断；无消息不渲染
                  空行（桌面会话列表不出现预览，session-item 不消费该字段） */}
              {s.preview && (
                <span data-testid="sheet-session-preview" className="block w-full min-w-0 truncate text-xs leading-snug text-muted-foreground" title={s.preview}>
                  {s.preview}
                </span>
              )}
            </button>
          ))}
        </div>
        <footer className="shrink-0 border-t bg-background pb-[max(env(safe-area-inset-bottom),8px)]">
          <button
            type="button"
            data-testid="mobile-add-project"
            onClick={onAddProject}
            className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-base outline-none hover:bg-accent/50 focus-visible:bg-accent/50 active:bg-accent"
          >
            <FolderPlus className="size-4 shrink-0" />
            {t("login.topbar.addProject")}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/** 项目下拉菜单内容：桌面项目下拉与手机档会话身份区共用（任务 6）。
 * openProject（当前项目 + 偏好 + lastOpenedAt + 聚合口径刷新）与
 * locateProjectInSidebar（展开分组滚动置顶）逻辑自原顶栏下拉零改动迁移。 */
function ProjectMenuItems({ onAddProject }: { onAddProject: () => void }) {
  const projects = useUiStore((s) => s.projects);
  const currentProject = useUiStore((s) => s.currentProject);
  const t = useT();
  return (
    <>
      <DropdownMenuLabel>{t("login.topbar.projectMenu")}</DropdownMenuLabel>
      {projects.length === 0 && (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">{t("login.topbar.noProjectsMenu")}</div>
      )}
      {projects.map((p) => (
        <DropdownMenuItem
          key={p.projectPath}
          onSelect={() => {
            // "定位 + 切换"（todo 10）：仍走 openProject（当前项目 + 偏好 + lastOpenedAt +
            // 聚合口径刷新），叠加侧栏动作展开该组并滚动置顶；侧栏保持全局平铺不切单项目视图
            if (p.projectPath !== currentProject) void openProject(p.projectPath);
            locateProjectInSidebar(p.projectPath);
          }}
        >
          <Check
            className={`size-4 shrink-0 ${p.projectPath === currentProject ? "opacity-100" : "opacity-0"}`}
          />
          <span className="ml-2 truncate" title={p.projectPath}>
            {basename(p.projectPath)}
          </span>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onAddProject}>
        <FolderPlus className="mr-2 size-4" />
        {t("login.topbar.addProject")}
      </DropdownMenuItem>
    </>
  );
}

export function Topbar({ onToggleTodoPanel }: { onToggleTodoPanel: () => void }) {
  const connection = useUiStore((s) => s.connection);
  const currentProject = useUiStore((s) => s.currentProject);
  const models = useUiStore((s) => s.models);
  const modelsLoaded = useUiStore((s) => s.modelsLoaded);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const toggleDrawer = useUiStore((s) => s.toggleDrawer);
  const setSettingsPageOpen = useUiStore((s) => s.setSettingsPageOpen);
  const setFilesPageOpen = useUiStore((s) => s.setFilesPageOpen);
  const isMobile = useIsMobile();
  const [addOpen, setAddOpen] = useState(false);
  // 会话切换全屏 sheet 开合（任务 19）：手机档身份区触发钮点按置位，选完/关钮/Esc 关
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // 快捷键帮助开关（docs08-r7 任务 12）：帮助钮 onClick 置位，shell 的 ?/Ctrl+K 触发同写
  const shortcutsHelpOpen = useUiStore((s) => s.shortcutsHelpOpen);
  const setShortcutsHelpOpen = useUiStore((s) => s.setShortcutsHelpOpen);

  // 会话身份（A3 手机档）：选中会话自 byProject 反查（id 唯一，命中即返回原引用，
  // 选择器引用稳定）。标题显示服务端合并值 title（renamedTitle ?? name ?? firstMessage）。
  const selectedSession = useSessionsStore((s) => {
    if (!s.selectedId) return null;
    for (const list of Object.values(s.byProject)) {
      const hit = list.find((item) => item.id === s.selectedId);
      if (hit) return hit;
    }
    return null;
  });

  // 过滤决策（todo 22 决策点）：GET /api/models 无活跃会话时返回全 provider 超集（todo 9 降级
  // 直读 models-store.json）。选择"全列展示、按 provider 分组"而非按当前会话 provider 过滤：
  // (1) models-store 即凭证可用的权威集合；(2) 引擎 setModel 接受任意 provider/model，
  // 跨 provider 切换合法；(3) UI 无会话级 provider 依据（GET /api/sessions 不含 model 字段）。
  const providerGroups = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return [...byProvider.entries()];
  }, [models]);

  const t = useT();
  // 站点名（todo3）：标题区小字，桌面/手机档同显；身份钮纵向内边距随三行行高压缩
  const siteName = readSiteName();
  const identityPad = siteName ? "py-0.5" : "py-1";
  const noModels = modelsLoaded && models.length === 0;
  const modelLabel = noModels
    ? t("login.topbar.noModels")
    : (selectedModel ?? (models.length > 0 ? `${models[0].provider}/${models[0].id}` : t("login.topbar.modelLoading")));

  const selectModel = (value: string) => {
    if (useUiStore.getState().selectedModel === value) return;
    useUiStore.getState().setSelectedModel(value);
    scheduleModelPreferencePersist();
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
      <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t("login.topbar.openSidebar")} onClick={toggleDrawer}>
        <Menu className="size-5" />
      </Button>

      {isMobile ? (
        /* 手机档会话身份区（A3 + 任务 19）：标题+项目名两行堆叠 truncate（字大微调：
           标题 text-base、项目名 text-xs）；点按开全屏会话切换 sheet（recentTop 跨项目
           8 条 + 尾部「添加项目…」；汉堡抽屉不动，桌面项目下拉不动） */
        <>
          <button
            type="button"
            data-testid="mobile-session-identity"
            aria-label={t("login.topbar.sessionIdentity")}
            aria-haspopup="dialog"
            aria-expanded={switcherOpen}
            className={`flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5 rounded-lg px-2 ${identityPad} text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50`}
            onClick={() => setSwitcherOpen(true)}
          >
            {selectedSession && (
              <span
                data-testid="topbar-session-title"
                title={selectedSession.title}
                className="block w-full truncate text-base font-medium leading-tight"
              >
                {selectedSession.title}
              </span>
            )}
            <span
              data-testid="topbar-project-name"
              className="flex w-full min-w-0 items-center gap-0.5 text-xs leading-tight text-muted-foreground"
            >
              <span className="min-w-0 truncate">
                {/* 会话身份块的项目名随选中会话走（2026-10-31 缺陷：刷新水合后全局
                    currentProject 可能是最近项目，与选中会话不同源；重选才同步）。桌面
                    项目选择器钮仍用 currentProject（那是选项目入口非会话身份）。 */}
                {selectedSession
                  ? basename(selectedSession.project)
                  : currentProject
                    ? basename(currentProject)
                    : t("login.topbar.chooseProject")}
              </span>
              <ChevronDown className="size-3 shrink-0" aria-hidden />
            </span>
            {/* 站点名小字第三行（todo3）：text-[11px] leading-none 控制三行总高，
                配合上方 py-0.5 仍收在 h-14 顶栏内；未设置整行不渲染 */}
            {siteName && (
              <span
                data-testid="topbar-site-name"
                className="block w-full truncate text-[11px] leading-none text-muted-foreground"
              >
                {siteName}
              </span>
            )}
          </button>
          <SessionSwitcherSheet
            open={switcherOpen}
            onOpenChange={setSwitcherOpen}
            onAddProject={() => {
              setSwitcherOpen(false);
              setAddOpen(true);
            }}
          />
        </>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* 站点名小字（todo3）：标题钮内第二行，h-auto 覆盖默认 h-8 让两行立起，
                chevron 位置不变（图标布局不动）；未设置单行原样 */}
            <Button
              variant="ghost"
              className={`max-w-[32vw] gap-1.5 px-2 sm:max-w-xs ${siteName ? "h-auto py-1" : ""}`}
            >
              <span className="flex min-w-0 flex-col items-start gap-0.5">
                <span className="max-w-full truncate font-medium">
                  {currentProject ? basename(currentProject) : t("login.topbar.chooseProject")}
                </span>
                {siteName && (
                  <span
                    data-testid="topbar-site-name"
                    className="max-w-full truncate text-[11px] font-normal leading-tight text-muted-foreground"
                  >
                    {siteName}
                  </span>
                )}
              </span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <ProjectMenuItems onAddProject={() => setAddOpen(true)} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {isMobile ? (
        /* 手机档右簇（r10 todo 6 减负后）：右栏入口钮 + 连接点。水位环迁输入框下方
           细条（context-usage-bar），文件/设置入口迁汉堡抽屉底部菜单（shell.tsx
           AppSidebar），顶栏仅剩汉堡+右栏钮 2 图标（GAP-6）。模型下拉手机档退役
           （任务 7 "更多"ModelChip 承接，中间态无模型切换入口为计划内顺序状态） */
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={t("login.topbar.openTodoPanel")}
            data-testid="todo-panel-toggle"
            onClick={onToggleTodoPanel}
          >
            <ListTodo className="size-5" />
          </Button>
          <span
            className={`mr-1 size-2 rounded-full ${connection === "online" ? "bg-emerald-500" : "bg-amber-500"}`}
            title={connection === "online" ? t("login.topbar.online") : t("login.topbar.reconnecting")}
          />
        </div>
      ) : (
        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                data-testid="model-switch"
                disabled={noModels}
                className="max-w-[26vw] gap-1.5 px-2 sm:max-w-[240px]"
                title={noModels ? t("login.topbar.noModelsTitle") : (selectedModel ?? undefined)}
              >
                <span className={`truncate text-xs ${noModels ? "text-muted-foreground" : ""}`}>{modelLabel}</span>
                {!noModels && <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
              <DropdownMenuLabel>{t("login.topbar.modelMenu")}</DropdownMenuLabel>
              {providerGroups.map(([provider, list]) => (
                <div key={provider}>
                  <div className="px-2 py-1 text-[11px] text-muted-foreground" title={provider}>
                    {provider}
                  </div>
                  {list.map((m) => {
                    const value = `${m.provider}/${m.id}`;
                    return (
                      <DropdownMenuItem key={value} onSelect={() => selectModel(value)}>
                        <Check className={`size-4 shrink-0 ${selectedModel === value ? "opacity-100" : "opacity-0"}`} />
                        <span className="ml-2 truncate" title={value}>
                          {m.id}
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* 快捷键帮助（docs08-r7 任务 12）：顶栏帮助钮挂载对话框 */}
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={t("shortcuts.title")}
            title={t("shortcuts.title")}
            data-testid="shortcuts-help-button"
            onClick={() => setShortcutsHelpOpen(true)}
          >
            <Keyboard className="size-5" />
          </Button>
          {/* 文件管理入口（builtin-file-management 任务 1）：打开独立全屏文件管理页 */}
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={t("files.entry.openAria")}
            data-testid="files-button"
            onClick={() => setFilesPageOpen(true)}
          >
            <FolderOpen className="size-5" />
          </Button>
          {/* 设置入口（r9 2026-10-26 批次任务 9）：打开独立全屏设置页。size-11=44px 触控达标 */}
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={t("login.topbar.settings")}
            data-testid="settings-button"
            onClick={() => setSettingsPageOpen(true)}
          >
            <Settings className="size-5" />
          </Button>
          <span
            className={`mr-1 size-2 rounded-full ${connection === "online" ? "bg-emerald-500" : "bg-amber-500"}`}
            title={connection === "online" ? t("login.topbar.online") : t("login.topbar.reconnecting")}
          />
        </div>
      )}

      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
      <ShortcutsDialog open={shortcutsHelpOpen} onOpenChange={setShortcutsHelpOpen} />
    </header>
  );
}
