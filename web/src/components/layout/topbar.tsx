// 顶栏：项目下拉（含添加项目入口，POST /api/projects 服务端路径校验 + 错误回显）、
// 模型切换下拉（todo 22：选择落 meta_project 偏好，防抖 PATCH；agentsList=false 降级已定——
// 不渲染 agent 下拉，"当前 provider/model"语义由模型下拉承担）、设置入口（todo 26：外链
// 地址 kv 配置）、连接状态点。
// A3+A6（docs08-r4 任务 6）手机档（<lg）单层重排：[汉堡 | 会话标题+项目名小字（可点开
// 项目菜单） | 上下文水位环 | 右栏入口钮 | 设置+连接点]，模型下拉手机档退役（经任务 7
// "更多"ModelChip 到达）；桌面（lg+）布局不动（项目/模型下拉原位）。手机档按 useIsMobile
// 条件渲染（DOM 不存在，非 CSS 隐藏）。
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Check, ChevronDown, FolderPlus, ListTodo, Menu, Settings } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { ModelInfo } from "@/lib/api";
import { openProject } from "@/lib/bootstrap";
import { useIsMobile } from "@/lib/use-is-mobile";
import { THINKING_EXPANDED_KV, useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";
import {
  PROJECT_SORT_KV,
  locateProjectInSidebar,
  type ProjectSortMode,
} from "@/components/session-list/global-list-data";
import { AddProjectDialog } from "@/components/layout/add-project-dialog";
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
const PERMISSION_PRESET_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "full-access", label: "full-access（全部自动放行）" },
  { value: "workspace", label: "workspace（项目内读写与命令放行，项目外访问询问）" },
  { value: "accept-edits", label: "accept-edits（编辑放行，命令与项目外访问询问）" },
  { value: "auto", label: "auto（安全操作自动放行，其余询问）" },
  { value: "read-only", label: "read-only（只读放行，编辑与命令询问）" },
  { value: "ask", label: "ask（全部询问）" },
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

  const showError = (err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 401) return;
    useUiStore.getState().showToast(err instanceof ApiError ? err.message : fallback, "error");
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
      ui.showToast("权限预设已保存，重启项目引擎后生效", "info");
    } catch (err) {
      showError(err, "保存权限预设失败");
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
      useUiStore.getState().showToast("项目引擎已重启", "info");
    } catch (err) {
      showError(err, "重启失败，请重试");
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <label htmlFor="settings-permission-preset" className="text-sm font-medium">
          权限预设{currentProject && <span className="ml-1.5 font-normal text-muted-foreground" title={currentProject}>{basename(currentProject)}</span>}
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
            <option value="">默认（自动放行）</option>
            {PERMISSION_PRESET_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-sm text-muted-foreground">尚未选择项目，先在顶栏选择或添加一个项目。</p>
        )}
        <p className="text-xs text-muted-foreground">预设随引擎启动参数生效，变更后需重启项目引擎。</p>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          variant="outline"
          data-testid="restart-engine-button"
          disabled={!currentProject || restarting}
          onClick={() => setRestartOpen(true)}
        >
          {restarting ? "重启中…" : "重启引擎"}
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
            <DialogTitle>重启项目引擎</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1.5 text-left">
                <p>
                  将停止并重建「{currentProject ? basename(currentProject) : ""}」的引擎进程：
                  进行中的回合会中断，会话状态在下次访问时自动重建。
                </p>
                <p>引擎无响应或卡死时可用此操作恢复。</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" disabled={restarting} onClick={() => setRestartOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={restarting} data-testid="restart-engine-confirm" onClick={() => void restart()}>
              {restarting ? "重启中…" : "确认重启"}
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
      ui.showToast("已移除项目注册", "info");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      useUiStore.getState().showToast(err instanceof ApiError ? err.message : "移除失败，请重试", "error");
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
      ui.showToast(hidden ? "已隐藏项目，可在\"已隐藏\"筛选中恢复" : "已恢复显示项目", "info");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      useUiStore.getState().showToast(err instanceof ApiError ? err.message : "操作失败，请重试", "error");
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
        取消隐藏
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
        隐藏
      </Button>
    );

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">项目管理</p>
          {/* 正常/已隐藏筛选（A2）：面板内临时视图态（不持久化），计数即容量提示 */}
          <div className="flex shrink-0 items-center rounded-md border p-0.5" role="tablist" aria-label="项目可见性筛选" data-testid="project-visibility-filter">
            <button
              type="button"
              role="tab"
              aria-selected={view === "normal"}
              data-testid="project-filter-normal"
              className={`min-h-7 rounded px-2 text-xs ${view === "normal" ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setView("normal")}
            >
              正常 {projects.length - hiddenCount}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "hidden"}
              data-testid="project-filter-hidden"
              className={`min-h-7 rounded px-2 text-xs ${view === "hidden" ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setView("hidden")}
            >
              已隐藏 {hiddenCount}
            </button>
          </div>
        </div>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚无已注册项目。</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">{view === "hidden" ? "没有已隐藏的项目。" : "全部项目均已隐藏。"}</p>
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
                      title="项目目录已不存在"
                    >
                      已丢失
                    </span>
                  )}
                  {p.projectPath === currentProject && (
                    <span className="shrink-0 text-[10px] leading-none text-muted-foreground">当前</span>
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
                    移除
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
            <DialogTitle>移除项目</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1.5 text-left">
                <p>将移除「{pending ? basename(pending) : ""}」的项目注册。</p>
                <p>
                  若移除的是当前项目，将回到空会话状态；项目内会话数据不受影响，重新添加可恢复置顶/改名/标签。
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" disabled={removing} onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={removing}
              data-testid="project-remove-confirm"
              onClick={() => void remove()}
            >
              {removing ? "移除中…" : "确认移除"}
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
            <DialogTitle>隐藏项目</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1.5 text-left">
                <p>将隐藏「{pendingHide ? basename(pendingHide) : ""}」：侧栏分组不再显示。</p>
                <p>
                  若隐藏的是当前项目，将回到空会话状态；会话数据与置顶/改名/标签不受影响，可随时在"已隐藏"筛选中恢复。
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" disabled={hiding} onClick={() => setPendingHide(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={hiding}
              data-testid="project-hide-confirm"
              onClick={() => pendingHide && void setHidden(pendingHide, true)}
            >
              {hiding ? "隐藏中…" : "确认隐藏"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 设置面板"侧栏"分区（C16 docs08-r3 todo 9）：项目排序三档单选（活动/添加/手动拖拽）。
 * 档位存 meta_kv sidebar.projectSort（走既有 PUT /api/settings，跨设备一致，不落
 * localStorage）；改档即存即生效（session-list 从 ui store 读档位派生分组顺序）。
 * added 档对存量项目（迁移前注册，createdAt 同为迁移时刻）退化为最近打开时间稳定序，
 * 文案如实注明。手动档的拖拽/上移下移交互在侧栏分组头（session-list.tsx）。 */
const PROJECT_SORT_OPTIONS: ReadonlyArray<{ value: ProjectSortMode; label: string }> = [
  { value: "activity", label: "活动时间（默认）" },
  { value: "added", label: "添加时间" },
  { value: "manual", label: "手动拖拽" },
];

function SidebarSortSection() {
  const projectSort = useUiStore((s) => s.projectSort);
  const [saving, setSaving] = useState(false);

  const changeSort = async (mode: ProjectSortMode) => {
    if (mode === projectSort || saving) return;
    setSaving(true);
    try {
      await api.putSettings({ [PROJECT_SORT_KV]: mode });
      useUiStore.getState().setProjectSort(mode);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast(err instanceof ApiError ? err.message : "保存排序设置失败", "error");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">侧栏</p>
        <p className="text-xs text-muted-foreground">项目分组排序</p>
        <div role="radiogroup" aria-label="项目分组排序" data-testid="project-sort-group" className="space-y-1">
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
              {opt.label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          按添加时间排序时，升级前注册的历史项目以最近打开时间为准；手动拖拽在侧栏分组头进行（桌面拖拽，手机用分组头菜单），顺序全设备同步。
        </p>
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

  const changeExpanded = async (expanded: boolean) => {
    if (expanded === thinkingDefaultExpanded || saving) return;
    setSaving(true);
    try {
      await api.putSettings({ [THINKING_EXPANDED_KV]: expanded ? "true" : "false" });
      useUiStore.getState().setThinkingDefaultExpanded(expanded);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast(err instanceof ApiError ? err.message : "保存对话设置失败", "error");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">对话</p>
        <label className="flex min-h-11 items-center gap-2 rounded-md px-1 text-sm hover:bg-accent/50 lg:min-h-7" data-testid="thinking-default-expanded-option">
          <input
            type="checkbox"
            checked={thinkingDefaultExpanded}
            disabled={saving}
            onChange={(e) => void changeExpanded(e.target.checked)}
            className="size-4 accent-primary"
          />
          思考块默认展开
        </label>
        <p className="text-xs text-muted-foreground">
          开启后思考块默认展开，展开时输出自动滚动到底部，手动滚动即停跟随；对之后新出现的思考块生效，全设备同步。
        </p>
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
      setError(err instanceof ApiError ? err.message : "保存失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>
            外链指向反代挂载的自托管工具（如 cgit、filebrowser），留空则隐藏对应入口；项目区管理当前项目的权限预设与引擎进程。
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="settings-git-url" className="text-sm font-medium">
              Git 外链地址
            </label>
            <Input
              id="settings-git-url"
              value={git}
              onChange={(e) => setGit(e.target.value)}
              placeholder="https://git.example.com 或 /git"
              inputMode="url"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="settings-files-url" className="text-sm font-medium">
              文件管理外链地址
            </label>
            <Input
              id="settings-files-url"
              value={files}
              onChange={(e) => setFiles(e.target.value)}
              placeholder="https://files.example.com 或 /files"
              inputMode="url"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={onDone}>
            取消
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </form>
      <ProjectPermissionSection />
      <ProjectManagementSection />
      <SidebarSortSection />
      <ConversationSection />
    </>
  );
}

/** 项目下拉菜单内容：桌面项目下拉与手机档会话身份区共用（任务 6）。
 * openProject（当前项目 + 偏好 + lastOpenedAt + 聚合口径刷新）与
 * locateProjectInSidebar（展开分组滚动置顶）逻辑自原顶栏下拉零改动迁移。 */
function ProjectMenuItems({ onAddProject }: { onAddProject: () => void }) {
  const projects = useUiStore((s) => s.projects);
  const currentProject = useUiStore((s) => s.currentProject);
  return (
    <>
      <DropdownMenuLabel>项目</DropdownMenuLabel>
      {projects.length === 0 && (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">尚无项目，先添加一个</div>
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
        添加项目…
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
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const noModels = modelsLoaded && models.length === 0;
  const modelLabel = noModels
    ? "无可用模型"
    : (selectedModel ?? (models.length > 0 ? `${models[0].provider}/${models[0].id}` : "加载中…"));

  const selectModel = (value: string) => {
    if (useUiStore.getState().selectedModel === value) return;
    useUiStore.getState().setSelectedModel(value);
    scheduleModelPreferencePersist();
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
      <Button variant="ghost" size="icon" className="lg:hidden" aria-label="打开侧栏" onClick={toggleDrawer}>
        <Menu className="size-5" />
      </Button>

      {isMobile ? (
        /* 手机档会话身份区（A3）：标题+项目名两行堆叠 truncate；点按弹项目菜单
           （内容复用桌面项目下拉，openProject/locateProjectInSidebar 零改动） */
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="mobile-session-identity"
              aria-label="会话与项目，点按切换项目"
              className="flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5 rounded-lg px-2 py-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {selectedSession && (
                <span
                  data-testid="topbar-session-title"
                  title={selectedSession.title}
                  className="block w-full truncate text-sm font-medium leading-tight"
                >
                  {selectedSession.title}
                </span>
              )}
              <span
                data-testid="topbar-project-name"
                className="flex w-full min-w-0 items-center gap-0.5 text-[11px] leading-tight text-muted-foreground"
              >
                <span className="min-w-0 truncate">
                  {currentProject ? basename(currentProject) : "选择项目"}
                </span>
                <ChevronDown className="size-3 shrink-0" aria-hidden />
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <ProjectMenuItems onAddProject={() => setAddOpen(true)} />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* 窄屏 max-w 收敛（todo 26 走查修复：390 顶栏溢出 scrollWidth=430；sm 起保持原桌面宽度） */}
            <Button variant="ghost" className="max-w-[32vw] gap-1.5 px-2 sm:max-w-xs">
              <span className="truncate font-medium">
                {currentProject ? basename(currentProject) : "选择项目"}
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
            aria-label="打开任务面板"
            data-testid="todo-panel-toggle"
            onClick={onToggleTodoPanel}
          >
            <ListTodo className="size-5" />
          </Button>
          {/* 设置入口（todo 26）：外链地址 kv 配置。size-11=44px 触控达标 */}
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="设置"
            data-testid="settings-button"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-5" />
          </Button>
          <span
            className={`mr-1 size-2 rounded-full ${connection === "online" ? "bg-emerald-500" : "bg-amber-500"}`}
            title={connection === "online" ? "已连接" : "重连中"}
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
                title={noModels ? "引擎未提供可用模型，发送已禁用" : (selectedModel ?? undefined)}
              >
                <span className={`truncate text-xs ${noModels ? "text-muted-foreground" : ""}`}>{modelLabel}</span>
                {!noModels && <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
              <DropdownMenuLabel>模型</DropdownMenuLabel>
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
          {/* 设置入口（todo 26）：外链地址 kv 配置。size-11=44px 触控达标 */}
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="设置"
            data-testid="settings-button"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-5" />
          </Button>
          <span
            className={`mr-1 size-2 rounded-full ${connection === "online" ? "bg-emerald-500" : "bg-amber-500"}`}
            title={connection === "online" ? "已连接" : "重连中"}
          />
        </div>
      )}

      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
