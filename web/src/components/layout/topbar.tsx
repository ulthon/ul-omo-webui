// 顶栏：项目下拉（含添加项目入口，POST /api/projects 服务端路径校验 + 错误回显）、
// 模型切换下拉（todo 22：选择落 meta_project 偏好，防抖 PATCH；agentsList=false 降级已定——
// 不渲染 agent 下拉，"当前 provider/model"语义由模型下拉承担）、设置入口（todo 26：外链
// 地址 kv 配置）、连接状态点。
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Check, ChevronDown, FolderPlus, Menu, Settings } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { ModelInfo } from "@/lib/api";
import { openProject } from "@/lib/bootstrap";
import { useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";
import { locateProjectInSidebar } from "@/components/session-list/global-list-data";
import { AddProjectDialog } from "@/components/layout/add-project-dialog";
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
 * 管理动作只在本区提供（设置 = 管理心智）。 */
export function ProjectManagementSection() {
  const projects = useUiStore((s) => s.projects);
  const currentProject = useUiStore((s) => s.currentProject);
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

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

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">项目管理</p>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚无已注册项目。</p>
        ) : (
          <ul className="space-y-1">
            {projects.map((p) => (
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
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11 shrink-0 px-3"
                  data-testid="project-remove-button"
                  onClick={() => setPending(p.projectPath)}
                >
                  移除
                </Button>
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
    </>
  );
}

export function Topbar() {
  const connection = useUiStore((s) => s.connection);
  const projects = useUiStore((s) => s.projects);
  const currentProject = useUiStore((s) => s.currentProject);
  const models = useUiStore((s) => s.models);
  const modelsLoaded = useUiStore((s) => s.modelsLoaded);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const toggleDrawer = useUiStore((s) => s.toggleDrawer);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
          <DropdownMenuItem onSelect={() => setAddOpen(true)}>
            <FolderPlus className="mr-2 size-4" />
            添加项目…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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

      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
