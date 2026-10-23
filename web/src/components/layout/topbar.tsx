// 顶栏：项目下拉（含添加项目入口，POST /api/projects 服务端路径校验 + 错误回显）、
// 模型切换下拉（todo 22：选择落 meta_project 偏好，防抖 PATCH；agentsList=false 降级已定——
// 不渲染 agent 下拉，"当前 provider/model"语义由模型下拉承担）、设置入口（todo 26：外链
// 地址 kv 配置）、连接状态点。
// A3+A6（docs08-r4 任务 6）手机档（<lg）单层重排：[汉堡 | 会话标题+项目名小字（点按开
// 会话切换全屏 sheet，任务 19：recentTop 派生直达切换） | 上下文水位环 | 右栏入口钮 | 设置+连接点]，模型下拉手机档退役（经任务 7
// "更多"ModelChip 到达）；桌面（lg+）布局不动（项目/模型下拉原位）。手机档按 useIsMobile
// 条件渲染（DOM 不存在，非 CSS 隐藏）。
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Check, ChevronDown, FolderPlus, Keyboard, ListTodo, Menu, Settings, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { ModelInfo, SessionListItem, TagDefinition } from "@/lib/api";
import { loadProjectModels, openProject } from "@/lib/bootstrap";
import { useIsMobile } from "@/lib/use-is-mobile";
import { THINKING_EXPANDED_KV, TAG_DISPLAY_MODE_KV, useUiStore } from "@/stores/ui";
import { LANGUAGE_KV, useLocaleStore, useT, type Locale, type MessageKey } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { useSessionsStore } from "@/stores/sessions";
import {
  PROJECT_SORT_KV,
  crossProjectDecision,
  flattenSessions,
  locateProjectInSidebar,
  recentTop,
  type ProjectSortMode,
} from "@/components/session-list/global-list-data";
import { definedTagKeys, type TagDefs, type TagDisplayMode } from "@/components/session-list/tag-data";
import { TagBadges } from "@/components/session-list/tag-badge";
import { AddProjectDialog } from "@/components/layout/add-project-dialog";
import { ShortcutsDialog } from "@/components/layout/shortcuts-dialog";
import { TipsSection } from "@/components/layout/tips-section";
import { ScheduleSection } from "@/components/schedule/schedule-section";
import { ModelsDiscoverSection } from "@/components/models/models-discover-section";
import { TrafficSection } from "@/components/stats/traffic-section";
import { ContextWaterRing } from "@/components/layout/context-ring";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

// 偏好持久化防抖（todo 22 连续切换不炸）：已迁移 lib/preferences 共用（W2 todo 8 起输入区
// 模型 chip 与思考档 chip 走同一条 latest-wins PATCH 路径），此处仅保留选择动作。
import { scheduleModelPreferencePersist } from "@/lib/preferences";

/** 外链地址设置（todo 26）：kv 键 external-git-url / external-files-url，留空即隐藏对应入口。
 * 反代按路径挂载的自托管工具（cgit/filebrowser），web 只做入口不做页面。
 * 表单体条件挂载（open && <Form>）：每次打开全新初始态，初始值即 store 最新值，无 effect 同步。 */
function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && <SettingsForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** 项目权限预设合法档位（镜像引擎包 @code-yeongyu/senpi 的 PERMISSION_PRESET_NAMES，
 * 2026.10.10 版 bundle 实证；各档描述按引擎 PERMISSION_PRESET_RULES 如实转述）。
 * 空值 = 无预设 = 引擎默认行为（full-access 全部自动放行）。 */
const PERMISSION_PRESET_OPTIONS: ReadonlyArray<{ value: string; labelKey: MessageKey }> = [
  { value: "full-access", labelKey: "login.topbar.presetFullAccess" },
  { value: "workspace", labelKey: "login.topbar.presetWorkspace" },
  { value: "accept-edits", labelKey: "login.topbar.presetAcceptEdits" },
  { value: "auto", labelKey: "login.topbar.presetAuto" },
  { value: "read-only", labelKey: "login.topbar.presetReadOnly" },
  { value: "ask", labelKey: "login.topbar.presetAsk" },
];

/** 设置面板项目区：权限预设下拉（选中即 PATCH 落服务端 kv）+ 重启引擎按钮。
 * 预设是引擎 spawn 参数级配置，变更后需重启项目引擎生效（按钮即生效口）。
 * 重启期间浏览器与服务端的 SSE 不受影响（事件流由服务端发出，引擎重建会推
 * engine_reclaimed 等事件，断线自动重连/心跳为既有通道，无需额外兜底）。 */
function ProjectPermissionSection() {
  const currentProject = useUiStore((s) => s.currentProject);
  const preset = useUiStore((s) => s.projects.find((p) => p.projectPath === s.currentProject)?.permissionPreset ?? null);
  const [saving, setSaving] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const t = useT();
  /** 错误 toast 统一出口（任务11）：401 静默（登录态由全局跳转接管）；其余经 apiErrorMessage——
   * 命中错误码映射出词典文案，未命中透传服务端原文，纯 Error/非 Error 走兜底键。 */
  const showError = (err: unknown, fallbackKey: MessageKey) => {
    if (err instanceof ApiError && err.status === 401) return;
    useUiStore.getState().showToast(apiErrorMessage(err, fallbackKey), "error");
  };

  const changePreset = async (value: string) => {
    if (!currentProject || saving) return;
    const next = value === "" ? null : value;
    if (next === preset) return;
    setSaving(true);
    try {
      await api.patchProjectMeta({ path: currentProject, permissionPreset: next });
      const ui = useUiStore.getState();
      ui.setProjects(ui.projects.map((p) => (p.projectPath === currentProject ? { ...p, permissionPreset: next } : p)));
      ui.showToast(t("login.topbar.presetSaved"), "info");
    } catch (err) {
      showError(err, "login.topbar.presetSaveFailed");
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    if (!currentProject || restarting) return;
    setRestarting(true);
    try {
      await api.restartProject(currentProject);
      setRestartOpen(false);
      useUiStore.getState().showToast(t("login.topbar.engineRestarted"), "info");
    } catch (err) {
      showError(err, "login.topbar.restartFailed");
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <label htmlFor="settings-permission-preset" className="text-sm font-medium">
          {t("login.topbar.presetLabel")}{currentProject && <span className="ml-1.5 font-normal text-muted-foreground" title={currentProject}>{basename(currentProject)}</span>}
        </label>
        {currentProject ? (
          <select
            id="settings-permission-preset"
            data-testid="permission-preset-select"
            value={preset ?? ""}
            disabled={saving}
            onChange={(e) => void changePreset(e.target.value)}
            className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">{t("login.topbar.presetDefault")}</option>
            {PERMISSION_PRESET_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-sm text-muted-foreground">{t("login.topbar.noProjectSelected")}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("login.topbar.presetEngineNote")}</p>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          variant="outline"
          data-testid="restart-engine-button"
          disabled={!currentProject || restarting}
          onClick={() => setRestartOpen(true)}
        >
          {restarting ? t("login.topbar.restarting") : t("login.topbar.restartEngine")}
        </Button>
      </div>

      <Dialog
        open={restartOpen}
        onOpenChange={(open) => {
          if (!restarting) setRestartOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("login.topbar.restartTitle")}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1.5 text-left">
                <p>
                  {t("login.topbar.restartDesc", { name: currentProject ? basename(currentProject) : "" })}
                </p>
                <p>{t("login.topbar.restartRecoverNote")}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" disabled={restarting} onClick={() => setRestartOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" disabled={restarting} data-testid="restart-engine-confirm" onClick={() => void restart()}>
              {restarting ? t("login.topbar.restarting") : t("login.topbar.confirmRestart")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 项目管理区（W1 缺陷 #1）：列出全部已注册项目（ui store projects，bootstrap 预载 +
 * 注销后 refetch 刷新），死项目（GET /api/projects missing 字段）带「已丢失」徽标。
 * 每行「移除」按钮（44px 触控）弹确认对话框；确认后 DELETE /api/projects（只删注册行，
 * 会话数据与会话 meta 原样保留）→ refetch projects；移除的是当前项目时清 currentProject
 * 与选中会话（回到空会话状态），非当前项目不动选中。项目切换下拉保持纯切换语义，
 * 管理动作只在本区提供（设置 = 管理心智）。
 * A2（docs08-r3 任务 10）：顶部"正常/已隐藏"筛选分段控件 + 每行「隐藏/取消隐藏」按钮
 * （PUT /api/projects/hidden 软标记，注册行与会话 meta 保留）；隐藏当前项目复用注销的
 * 回空会话态流程；hidden 行不加额外徽标（筛选视图本身即可见性，missing 徽标沿用现状）。 */
export function ProjectManagementSection() {
  const projects = useUiStore((s) => s.projects);
  const currentProject = useUiStore((s) => s.currentProject);
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [view, setView] = useState<"normal" | "hidden">("normal");
  const [pendingHide, setPendingHide] = useState<string | null>(null);
  const [hiding, setHiding] = useState(false);
  // 「添加项目」入口（docs08-r7 任务 4）：设置面板头部按钮，复用同弹框组件
  const [addOpen, setAddOpen] = useState(false);

  const t = useT();
  const remove = async () => {
    const target = pending;
    if (!target || removing) return;
    setRemoving(true);
    try {
      await api.removeProject(target);
      setPending(null);
      // refetch 权威口径刷新列表（顺带吸收并发变化），再按需清理选中态
      const res = await api.listProjects();
      const ui = useUiStore.getState();
      ui.setProjects(res.projects);
      if (ui.currentProject === target) {
        ui.setCurrentProject(null);
        useSessionsStore.getState().select(null);
      }
      ui.showToast(t("login.topbar.removedToast"), "info");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      useUiStore.getState().showToast(apiErrorMessage(err, "login.topbar.removeFailed"), "error");
    } finally {
      setRemoving(false);
    }
  };

  /** 隐藏/取消隐藏（A2）：软标记 PUT 后 refetch 权威刷新；隐藏的是当前项目时复用
   * 注销的回空会话态流程（清 currentProject + 选中会话），非当前项目不动选中。 */
  const setHidden = async (target: string, hidden: boolean) => {
    if (hiding) return;
    setHiding(true);
    try {
      await api.putProjectHidden(target, hidden);
      setPendingHide(null);
      const res = await api.listProjects();
      const ui = useUiStore.getState();
      ui.setProjects(res.projects);
      if (hidden && ui.currentProject === target) {
        ui.setCurrentProject(null);
        useSessionsStore.getState().select(null);
      }
      ui.showToast(hidden ? t("login.topbar.hiddenToast") : t("login.topbar.unhiddenToast"), "info");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      useUiStore.getState().showToast(apiErrorMessage(err, "login.topbar.operationFailed"), "error");
    } finally {
      setHiding(false);
    }
  };

  const hiddenCount = projects.filter((p) => p.hidden === true).length;
  const visible = projects.filter((p) => (view === "hidden") === (p.hidden === true));

  const hideButtonOf = (p: (typeof projects)[number]) =>
    p.hidden === true ? (
      <Button
        type="button"
        variant="outline"
        className="min-h-11 shrink-0 px-3"
        data-testid="project-unhide-button"
        disabled={hiding}
        onClick={() => void setHidden(p.projectPath, false)}
      >
        {t("login.topbar.unhide")}
      </Button>
    ) : (
      <Button
        type="button"
        variant="outline"
        className="min-h-11 shrink-0 px-3"
        data-testid="project-hide-button"
        disabled={hiding}
        onClick={() =>
          p.projectPath === currentProject ? setPendingHide(p.projectPath) : void setHidden(p.projectPath, true)
        }
      >
        {t("login.topbar.hide")}
      </Button>
    );

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{t("login.topbar.management")}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* 添加项目（任务 4 双入口之二）：头部小钮复用 AddProjectDialog */}
            <Button
              type="button"
              variant="outline"
              className="min-h-7 px-2 text-xs"
              data-testid="project-add-button"
              onClick={() => setAddOpen(true)}
            >
              <FolderPlus className="mr-1 size-3.5" />
              {t("login.topbar.addProjectShort")}
            </Button>
            {/* 正常/已隐藏筛选（A2）：面板内临时视图态（不持久化），计数即容量提示 */}
            <div className="flex shrink-0 items-center rounded-md border p-0.5" role="tablist" aria-label={t("login.topbar.visibilityFilter")} data-testid="project-visibility-filter">
            <button
              type="button"
              role="tab"
              aria-selected={view === "normal"}
              data-testid="project-filter-normal"
              className={`min-h-7 rounded px-2 text-xs ${view === "normal" ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setView("normal")}
            >
              {t("login.topbar.filterNormal", { n: projects.length - hiddenCount })}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "hidden"}
              data-testid="project-filter-hidden"
              className={`min-h-7 rounded px-2 text-xs ${view === "hidden" ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setView("hidden")}
            >
              {t("login.topbar.filterHidden", { n: hiddenCount })}
            </button>
            </div>
          </div>
        </div>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("login.topbar.noProjects")}</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">{view === "hidden" ? t("login.topbar.noHiddenProjects") : t("login.topbar.allHidden")}</p>
        ) : (
          <ul className="space-y-1">
            {visible.map((p) => (
              <li
                key={p.projectPath}
                className="flex items-center justify-between gap-2"
                data-testid="project-management-row"
              >
                <span className="flex min-w-0 items-center gap-1.5" title={p.projectPath}>
                  <span className="truncate text-sm">{basename(p.projectPath)}</span>
                  {p.missing && (
                    <span
                      className="inline-flex shrink-0 items-center rounded border bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground"
                      title={t("login.topbar.missingTitle")}
                    >
                      {t("login.topbar.missingBadge")}
                    </span>
                  )}
                  {p.projectPath === currentProject && (
                    <span className="shrink-0 text-[10px] leading-none text-muted-foreground">{t("login.topbar.currentBadge")}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {hideButtonOf(p)}
                  <Button
                    type="button"
                    variant="destructive"
                    className="min-h-11 shrink-0 px-3"
                    data-testid="project-remove-button"
                    onClick={() => setPending(p.projectPath)}
                  >
                    {t("login.topbar.remove")}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!removing) setPending(open ? pending : null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("login.topbar.removeTitle")}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1.5 text-left">
                <p>{t("login.topbar.removeDesc", { name: pending ? basename(pending) : "" })}</p>
                <p>{t("login.topbar.removeDescNote")}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" disabled={removing} onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={removing}
              data-testid="project-remove-confirm"
              onClick={() => void remove()}
            >
              {removing ? t("login.topbar.removing") : t("login.topbar.confirmRemove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 隐藏当前项目确认（A2）：回空会话态是可感知变化，确认弹层防误触；非当前项目直接隐藏不弹 */}
      <Dialog
        open={pendingHide !== null}
        onOpenChange={(open) => {
          if (!hiding) setPendingHide(open ? pendingHide : null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("login.topbar.hideTitle")}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1.5 text-left">
                <p>{t("login.topbar.hideDesc", { name: pendingHide ? basename(pendingHide) : "" })}</p>
                <p>{t("login.topbar.hideDescNote")}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" disabled={hiding} onClick={() => setPendingHide(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={hiding}
              data-testid="project-hide-confirm"
              onClick={() => pendingHide && void setHidden(pendingHide, true)}
            >
              {hiding ? t("login.topbar.hiding") : t("login.topbar.confirmHide")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
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
                <span className="min-w-0 truncate text-base font-medium leading-snug" title={s.title}>
                  {s.title}
                </span>
                <TagBadges session={s} definedKeys={definedKeys} defs={tagDefs} />
              </span>
              <span
                className="block w-full min-w-0 truncate text-xs leading-snug text-muted-foreground"
                title={s.project}
              >
                {basename(s.project)}
              </span>
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

/** 设置面板"侧栏"分区（C16 docs08-r3 todo 9）：项目排序三档单选（活动/添加/手动拖拽）。
 * 档位存 meta_kv sidebar.projectSort（走既有 PUT /api/settings，跨设备一致，不落
 * localStorage）；改档即存即生效（session-list 从 ui store 读档位派生分组顺序）。
 * added 档对存量项目（迁移前注册，createdAt 同为迁移时刻）退化为最近打开时间稳定序，
 * 文案如实注明。手动档的拖拽/上移下移交互在侧栏分组头（session-list.tsx）。 */
const PROJECT_SORT_OPTIONS: ReadonlyArray<{ value: ProjectSortMode; labelKey: MessageKey }> = [
  { value: "activity", labelKey: "login.topbar.sortActivity" },
  { value: "added", labelKey: "login.topbar.sortAdded" },
  { value: "manual", labelKey: "login.topbar.sortManual" },
];

function SidebarSortSection() {
  const projectSort = useUiStore((s) => s.projectSort);
  const [saving, setSaving] = useState(false);

  const t = useT();
  const changeSort = async (mode: ProjectSortMode) => {
    if (mode === projectSort || saving) return;
    setSaving(true);
    try {
      await api.putSettings({ [PROJECT_SORT_KV]: mode });
      useUiStore.getState().setProjectSort(mode);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast(apiErrorMessage(err, "login.topbar.sortSaveFailed"), "error");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("login.topbar.sidebarHeading")}</p>
        <p className="text-xs text-muted-foreground">{t("login.topbar.projectSort")}</p>
        <div role="radiogroup" aria-label={t("login.topbar.projectSort")} data-testid="project-sort-group" className="space-y-1">
          {PROJECT_SORT_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex min-h-11 items-center gap-2 rounded-md px-1 text-sm hover:bg-accent/50 lg:min-h-7" data-testid={`project-sort-option-${opt.value}`}>
              <input
                type="radio"
                name="project-sort"
                value={opt.value}
                checked={projectSort === opt.value}
                disabled={saving}
                onChange={() => void changeSort(opt.value)}
                className="size-4 accent-primary"
              />
              {t(opt.labelKey)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("login.topbar.sortNote")}
        </p>
      </div>
    </div>
  );
}

/** 设置面板"标签"分区（docs08-r7 任务 20）：标签展示模式二档单选（文字/色格）。
 * 档位存 meta_kv tags.displayMode（走既有 PUT /api/settings，跨设备一致，不落
 * localStorage）；改档即存即生效（TagBadges 从 ui store 读档渲染，行级标签 display
 * 覆盖之上才是全局档；筛选/选择/管理面永远文字+色点不受影响）。导出供单测。 */
const TAG_DISPLAY_OPTIONS: ReadonlyArray<{ value: TagDisplayMode; labelKey: MessageKey }> = [
  { value: "text", labelKey: "login.topbar.tagDisplayText" },
  { value: "grid", labelKey: "login.topbar.tagDisplayGrid" },
];

export function TagDisplaySection() {
  const tagDisplayMode = useUiStore((s) => s.tagDisplayMode);
  const [saving, setSaving] = useState(false);

  const t = useT();
  const changeMode = async (mode: TagDisplayMode) => {
    if (mode === tagDisplayMode || saving) return;
    setSaving(true);
    try {
      await api.putSettings({ [TAG_DISPLAY_MODE_KV]: mode });
      useUiStore.getState().setTagDisplayMode(mode);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast(apiErrorMessage(err, "login.topbar.tagDisplaySaveFailed"), "error");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("login.topbar.tagsHeading")}</p>
        <div role="radiogroup" aria-label={t("login.topbar.tagDisplayMode")} data-testid="tag-display-mode-group" className="space-y-1">
          {TAG_DISPLAY_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex min-h-11 items-center gap-2 rounded-md px-1 text-sm hover:bg-accent/50 lg:min-h-7"
              data-testid={`tag-display-mode-option-${opt.value}`}
            >
              <input
                type="radio"
                name="tag-display-mode"
                value={opt.value}
                checked={tagDisplayMode === opt.value}
                disabled={saving}
                onChange={() => void changeMode(opt.value)}
                className="size-4 accent-primary"
              />
              {t(opt.labelKey)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("login.topbar.tagDisplayNote")}</p>
      </div>
    </div>
  );
}

/** 设置面板"对话"分区（docs08-r5 任务 13）：思考块默认展开开关。
 * 布尔存 meta_kv chat.thinkingDefaultExpanded（"true"/"false" 字符串，走既有
 * PUT /api/settings，跨设备一致）；改档即存即生效（ThinkingBlock 挂载时读 ui store
 * 快照，已挂载块不受影响——展开/折叠仍是会话内瞬态）。导出供单测。 */
export function ConversationSection() {
  const thinkingDefaultExpanded = useUiStore((s) => s.thinkingDefaultExpanded);
  const [saving, setSaving] = useState(false);

  const t = useT();
  const changeExpanded = async (expanded: boolean) => {
    if (expanded === thinkingDefaultExpanded || saving) return;
    setSaving(true);
    try {
      await api.putSettings({ [THINKING_EXPANDED_KV]: expanded ? "true" : "false" });
      useUiStore.getState().setThinkingDefaultExpanded(expanded);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast(apiErrorMessage(err, "login.topbar.chatSaveFailed"), "error");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("login.topbar.chatHeading")}</p>
        <label className="flex min-h-11 items-center gap-2 rounded-md px-1 text-sm hover:bg-accent/50 lg:min-h-7" data-testid="thinking-default-expanded-option">
          <input
            type="checkbox"
            checked={thinkingDefaultExpanded}
            disabled={saving}
            onChange={(e) => void changeExpanded(e.target.checked)}
            className="size-4 accent-primary"
          />
          {t("login.topbar.thinkingExpanded")}
        </label>
        <p className="text-xs text-muted-foreground">
          {t("login.topbar.thinkingNote")}
        </p>
      </div>
    </div>
  );
}

/** 语言档位选项：标签用各语言自我称谓入字典（login.topbar.langZh/langEn，两档同值） */
const LANGUAGE_OPTIONS: ReadonlyArray<{ value: Locale; labelKey: MessageKey }> = [
  { value: "zh-CN", labelKey: "login.topbar.langZh" },
  { value: "en", labelKey: "login.topbar.langEn" },
];

/** 设置面板"语言"分区（任务2）：界面语言二档单选（中文/English），档位存 meta_kv
 * ui.language（字符串值契约），改档即 PUT；PUT 成功后 setLocale（同步 document.lang
 * 与 localStorage 镜像）。kv 为权威存储，localStorage 仅作登录页先行值缓存。 */
export function LanguageSection() {
  const locale = useLocaleStore((s) => s.locale);
  const [saving, setSaving] = useState(false);

  const t = useT();
  const changeLocale = async (next: Locale) => {
    if (next === locale || saving) return;
    setSaving(true);
    try {
      await api.putSettings({ [LANGUAGE_KV]: next });
      useLocaleStore.getState().setLocale(next);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast(apiErrorMessage(err, "login.topbar.langSaveFailed"), "error");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("login.topbar.languageHeading")}</p>
        <div role="radiogroup" aria-label={t("login.topbar.uiLanguage")} data-testid="language-group" className="space-y-1">
          {LANGUAGE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex min-h-11 items-center gap-2 rounded-md px-1 text-sm hover:bg-accent/50 lg:min-h-7"
              data-testid={`language-option-${opt.value}`}
            >
              <input
                type="radio"
                name="ui-language"
                value={opt.value}
                checked={locale === opt.value}
                disabled={saving}
                onChange={() => void changeLocale(opt.value)}
                className="size-4 accent-primary"
              />
              {t(opt.labelKey)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("login.topbar.langNote")}</p>
      </div>
    </div>
  );
}

function SettingsForm({ onDone }: { onDone: () => void }) {
  const gitUrl = useUiStore((s) => s.externalLinks.gitUrl);
  const filesUrl = useUiStore((s) => s.externalLinks.filesUrl);
  const [git, setGit] = useState(gitUrl ?? "");
  const [files, setFiles] = useState(filesUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const t = useT();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const next = { gitUrl: git.trim(), filesUrl: files.trim() };
      await api.putSettings({ "external-git-url": next.gitUrl, "external-files-url": next.filesUrl });
      useUiStore.getState().setExternalLinks({ gitUrl: next.gitUrl || null, filesUrl: next.filesUrl || null });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("login.topbar.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{t("login.topbar.settings")}</DialogTitle>
          <DialogDescription>
            {t("login.topbar.settingsDesc")}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="settings-git-url" className="text-sm font-medium">
              {t("login.topbar.gitUrlLabel")}
            </label>
            <Input
              id="settings-git-url"
              value={git}
              onChange={(e) => setGit(e.target.value)}
              placeholder={t("login.topbar.gitUrlPlaceholder")}
              inputMode="url"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="settings-files-url" className="text-sm font-medium">
              {t("login.topbar.filesUrlLabel")}
            </label>
            <Input
              id="settings-files-url"
              value={files}
              onChange={(e) => setFiles(e.target.value)}
              placeholder={t("login.topbar.filesUrlPlaceholder")}
              inputMode="url"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? t("login.topbar.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </form>
      <ProjectPermissionSection />
      <ProjectManagementSection />
      <SidebarSortSection />
      <TagDisplaySection />
      <ModelsDiscoverSection />
      <TrafficSection />
      <ScheduleSection />
      <ConversationSection />
      <TipsSection />
      <LanguageSection />
    </>
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
  const isMobile = useIsMobile();
  const [addOpen, setAddOpen] = useState(false);
  // 会话切换全屏 sheet 开合（任务 19）：手机档身份区触发钮点按置位，选完/关钮/Esc 关
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
            className="flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5 rounded-lg px-2 py-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
                {currentProject ? basename(currentProject) : t("login.topbar.chooseProject")}
              </span>
              <ChevronDown className="size-3 shrink-0" aria-hidden />
            </span>
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
            {/* 窄屏 max-w 收敛（todo 26 走查修复：390 顶栏溢出 scrollWidth=430；sm 起保持原桌面宽度） */}
            <Button variant="ghost" className="max-w-[32vw] gap-1.5 px-2 sm:max-w-xs">
              <span className="truncate font-medium">
                {currentProject ? basename(currentProject) : t("login.topbar.chooseProject")}
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
        /* 手机档右簇（A3+A6）：水位环（无会话/无数据不挂载）→ 右栏入口 → 设置+连接点。
           模型下拉手机档退役（任务 7 "更多"ModelChip 承接，中间态无模型切换入口为
           计划内顺序状态） */
        <div className="flex shrink-0 items-center gap-0.5">
          {selectedSession && <ContextWaterRing sessionId={selectedSession.id} />}
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
          {/* 快捷键帮助（docs08-r7 任务 12）：顶栏帮助钮挂载对话框，手机档即无键盘入口 */}
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
          {/* 设置入口（todo 26）：外链地址 kv 配置。size-11=44px 触控达标 */}
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={t("login.topbar.settings")}
            data-testid="settings-button"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-5" />
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
          {/* 设置入口（todo 26）：外链地址 kv 配置。size-11=44px 触控达标 */}
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={t("login.topbar.settings")}
            data-testid="settings-button"
            onClick={() => setSettingsOpen(true)}
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
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ShortcutsDialog open={shortcutsHelpOpen} onOpenChange={setShortcutsHelpOpen} />
    </header>
  );
}
