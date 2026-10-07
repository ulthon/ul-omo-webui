// 顶栏：项目下拉（含添加项目入口，POST /api/projects 服务端路径校验 + 错误回显）、
// 模型切换下拉（todo 22：选择落 meta_project 偏好，防抖 PATCH；agentsList=false 降级已定——
// 不渲染 agent 下拉，"当前 provider/model"语义由模型下拉承担）、连接状态点。
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Check, ChevronDown, FolderPlus, Menu } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { ModelInfo } from "@/lib/api";
import { openProject } from "@/lib/bootstrap";
import { useUiStore } from "@/stores/ui";
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

// 偏好持久化防抖（todo 22 连续切换不炸）：连续选择只落最后一次；触发时再读 store 当前值，
// 项目已切换时写入的是新项目自己的当前选择（与 openProject 应用的偏好一致，幂等无害）。
const PREFERENCE_DEBOUNCE_MS = 600;
let prefTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersistPreference(): void {
  if (prefTimer) clearTimeout(prefTimer);
  prefTimer = setTimeout(async () => {
    prefTimer = null;
    const ui = useUiStore.getState();
    const project = ui.currentProject;
    const model = ui.selectedModel;
    if (!project || !model) return;
    try {
      await api.patchProjectMeta({ path: project, preferredModel: model });
      // 本地 projects 同步偏好：切走再切回时 openProject 直接读到最新值，不等服务端 refetch
      ui.setProjects(ui.projects.map((p) => (p.projectPath === project ? { ...p, preferredModel: model } : p)));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast("保存模型偏好失败", "error");
      }
    }
  }, PREFERENCE_DEBOUNCE_MS);
}

function AddProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.addProject(path.trim());
      const { projects } = await api.listProjects();
      useUiStore.getState().setProjects(projects);
      setPath("");
      onOpenChange(false);
      await openProject(path.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "添加失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>添加项目</DialogTitle>
            <DialogDescription>输入服务器上的项目目录绝对路径，服务端校验存在性与合法性。</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-2">
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/user/my-project"
              autoFocus
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={submitting || !path.trim()}>
              {submitting ? "添加中…" : "添加"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Topbar() {
  const connection = useUiStore((s) => s.connection);
  const projects = useUiStore((s) => s.projects);
  const currentProject = useUiStore((s) => s.currentProject);
  const agentsDegraded = useUiStore((s) => s.agentsDegraded);
  const models = useUiStore((s) => s.models);
  const modelsLoaded = useUiStore((s) => s.modelsLoaded);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const toggleDrawer = useUiStore((s) => s.toggleDrawer);
  const [addOpen, setAddOpen] = useState(false);

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
    schedulePersistPreference();
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
      <Button variant="ghost" size="icon" className="lg:hidden" aria-label="打开侧栏" onClick={toggleDrawer}>
        <Menu className="size-5" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="max-w-[45vw] gap-1.5 px-2 sm:max-w-xs">
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
                if (p.projectPath !== currentProject) void openProject(p.projectPath);
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

      <div className="ml-auto flex items-center gap-2">
        {/* agent 语义：引擎无 agent 枚举协议面（verification/05 P1-5），如实降级展示，不做假下拉 */}
        {agentsDegraded && (
          <span
            className="hidden text-xs text-muted-foreground sm:block"
            title="引擎无 agent 枚举协议面，agent 随 provider/model 默认"
          >
            无 agent 枚举
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              data-testid="model-switch"
              disabled={noModels}
              className="max-w-[45vw] gap-1.5 px-2 sm:max-w-[240px]"
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
        <span
          className={`size-2 rounded-full ${connection === "online" ? "bg-emerald-500" : "bg-amber-500"}`}
          title={connection === "online" ? "已连接" : "重连中"}
        />
      </div>

      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
    </header>
  );
}
