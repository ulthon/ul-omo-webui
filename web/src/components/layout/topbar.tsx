// 顶栏：项目下拉（含添加项目入口，POST /api/projects 服务端路径校验 + 错误回显）、
// agent/模型切换占位（agentsList=false 降级已定：显示"无 agent 枚举"+ 当前模型）、连接状态点。
import { useState } from "react";
import type { FormEvent } from "react";
import { Check, ChevronDown, FolderPlus, Menu } from "lucide-react";
import { api, ApiError } from "@/lib/api";
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
  const selectedModel = useUiStore((s) => s.selectedModel);
  const toggleDrawer = useUiStore((s) => s.toggleDrawer);
  const [addOpen, setAddOpen] = useState(false);

  const modelLabel = selectedModel ?? (models.length > 0 ? `${models[0].provider}/${models[0].id}` : null);

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

      <div className="ml-auto flex items-center gap-3">
        {/* agent/模型切换占位：真实切换交互由 todo 22 实现 */}
        <div className="hidden text-right text-xs leading-tight text-muted-foreground sm:block">
          <div>{agentsDegraded ? "无 agent 枚举" : "agent"}</div>
          <div className="max-w-[220px] truncate" title={modelLabel ?? undefined}>
            {modelLabel ?? "无可用模型"}
          </div>
        </div>
        <span
          className={`size-2 rounded-full ${connection === "online" ? "bg-emerald-500" : "bg-amber-500"}`}
          title={connection === "online" ? "已连接" : "重连中"}
        />
      </div>

      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
    </header>
  );
}
