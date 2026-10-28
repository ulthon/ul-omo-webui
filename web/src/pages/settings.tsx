// 设置独立全屏页（r9 2026-10-26 批次任务 9）：顶栏设置弹层退役，全部现有设置项迁入
// 本页，分组收拢——项目区（权限预设+引擎重启、项目管理、发现模型）与全局区（外链
// 地址、侧栏排序、标签展示、流量统计、扩展凭证、定时任务、对话、提示、语言）。
// 页面由 shell 依据 ui store settingsPageOpen 条件渲染（fixed 全屏覆盖层，shell 本体
// 保持挂载：SSE 连接与引导状态不因进设置页中断），返回按钮回原视图。
// 各分区实现自 topbar.tsx 原样迁移（含确认对话框与既有 data-testid），行为不变。
import { useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, FolderPlus } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { THINKING_EXPANDED_KV, TAG_DISPLAY_MODE_KV, useUiStore } from "@/stores/ui";
import { LANGUAGE_KV, useLocaleStore, useT, type Locale, type MessageKey } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { useSessionsStore } from "@/stores/sessions";
import { PROJECT_SORT_KV, type ProjectSortMode } from "@/components/session-list/global-list-data";
import { ModelsDiscoverSection } from "@/components/models/models-discover-section";
import { RebindSection } from "@/components/settings/rebind-section";
import { ToolsSection } from "@/components/settings/tools-section";
import { TrafficSection } from "@/components/stats/traffic-section";
import { ExtensionsSection } from "@/components/extensions/extensions-section";
import { AuthSection } from "@/components/settings/auth-section";
import { ScheduleSection } from "@/components/schedule/schedule-section";
import { TipsSection } from "@/components/layout/tips-section";
import { AddProjectDialog } from "@/components/layout/add-project-dialog";
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

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
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

/** 设置页项目区：权限预设下拉（选中即 PATCH 落服务端 kv）+ 重启引擎按钮。
 * 预设是引擎 spawn 参数级配置，变更后需重启项目引擎生效（按钮即生效口）。
 * 重启期间浏览器与服务端的 SSE 不受影响（事件流由服务端发出，引擎重建会推
 * engine_reclaimed 等事件，断线自动重连/心跳为既有通道，无需额外兜底）。 */
export function ProjectPermissionSection() {
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
  // 「添加项目」入口（docs08-r7 任务 4）：设置页头部按钮，复用同弹框组件
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
            {/* 正常/已隐藏筛选（A2）：页面内临时视图态（不持久化），计数即容量提示 */}
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

/** 设置页"侧栏"分区（C16 docs08-r3 todo 9）：项目排序三档单选（活动/添加/手动拖拽）。
 * 档位存 meta_kv sidebar.projectSort（走既有 PUT /api/settings，跨设备一致，不落
 * localStorage）；改档即存即生效（session-list 从 ui store 读档位派生分组顺序）。
 * added 档对存量项目（迁移前注册，createdAt 同为迁移时刻）退化为最近打开时间稳定序，
 * 文案如实注明。手动档的拖拽/上移下移交互在侧栏分组头（session-list.tsx）。 */
const PROJECT_SORT_OPTIONS: ReadonlyArray<{ value: ProjectSortMode; labelKey: MessageKey }> = [
  { value: "activity", labelKey: "login.topbar.sortActivity" },
  { value: "added", labelKey: "login.topbar.sortAdded" },
  { value: "manual", labelKey: "login.topbar.sortManual" },
];

export function SidebarSortSection() {
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

/** 设置页"标签"分区（docs08-r7 任务 20）：标签展示模式二档单选（文字/色格）。
 * 档位存 meta_kv tags.displayMode（走既有 PUT /api/settings，跨设备一致，不落
 * localStorage）；改档即存即生效（TagBadges 从 ui store 读档渲染，行级标签 display
 * 覆盖之上才是全局档；筛选/选择/管理面永远文字+色点不受影响）。导出供单测。 */
const TAG_DISPLAY_OPTIONS: ReadonlyArray<{ value: "text" | "grid"; labelKey: MessageKey }> = [
  { value: "text", labelKey: "login.topbar.tagDisplayText" },
  { value: "grid", labelKey: "login.topbar.tagDisplayGrid" },
];

export function TagDisplaySection() {
  const tagDisplayMode = useUiStore((s) => s.tagDisplayMode);
  const [saving, setSaving] = useState(false);

  const t = useT();
  const changeMode = async (mode: "text" | "grid") => {
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

/** 设置页"对话"分区（docs08-r5 任务 13）：思考块默认展开开关。
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

/** 设置页"语言"分区（任务2）：界面语言二档单选（中文/English），档位存 meta_kv
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

/** 外链地址分区（todo 26 自弹层迁移）：kv 键 external-git-url / external-files-url，
 * 留空即隐藏对应入口。反代按路径挂载的自托管工具（cgit/filebrowser），web 只做入口
 * 不做页面。 */
function ExternalLinksSection() {
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
      useUiStore.getState().showToast(t("login.settingsPage.saved"), "info");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("login.topbar.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border-t pt-1">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm font-medium">{t("login.topbar.settingsDesc")}</p>
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
        <div className="flex justify-end">
          <Button type="submit" disabled={submitting}>
            {submitting ? t("login.topbar.saving") : t("common.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** 设置独立全屏页：fixed 覆盖层（shell 本体保持挂载，SSE 不中断），头部返回钮 +
 * 标题，正文按项目区/全局区分组收拢全部设置项。 */
export function SettingsPage() {
  const t = useT();
  const setSettingsPageOpen = useUiStore((s) => s.setSettingsPageOpen);
  return (
    <div
      data-testid="settings-page"
      data-presentation="fullscreen-page"
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-background"
    >
      <header className="sticky top-0 z-10 flex min-h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t("login.settingsPage.back")}
          data-testid="settings-back-button"
          onClick={() => setSettingsPageOpen(false)}
        >
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="text-base font-semibold">{t("login.topbar.settings")}</h1>
      </header>
      <div className="mx-auto w-full max-w-2xl px-4 pb-[max(env(safe-area-inset-bottom),16px)] pt-4">
        <section aria-labelledby="settings-project-group">
          <h2 id="settings-project-group" className="pb-2 text-sm font-semibold text-muted-foreground">
            {t("login.settingsPage.projectGroup")}
          </h2>
          <ProjectPermissionSection />
          <ToolsSection />
          <ProjectManagementSection />
          <RebindSection />
          <ModelsDiscoverSection />
        </section>
        <section aria-labelledby="settings-global-group" className="mt-6">
          <h2 id="settings-global-group" className="pb-2 text-sm font-semibold text-muted-foreground">
            {t("login.settingsPage.globalGroup")}
          </h2>
          <ExternalLinksSection />
          <SidebarSortSection />
          <TagDisplaySection />
          <TrafficSection />
          <AuthSection />
          <ExtensionsSection />
          <ScheduleSection />
          <ConversationSection />
          <TipsSection />
          <LanguageSection />
        </section>
      </div>
    </div>
  );
}
