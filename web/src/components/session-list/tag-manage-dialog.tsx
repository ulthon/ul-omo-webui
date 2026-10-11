// 标签管理弹层（todo 11）：两 scope 分组列表（全局/当前项目），新增/重命名/删除/上移下移。
// 全部经 PUT /api/tags 按 scope 整替：重命名 = 定义文件改名（挂载记录以 (scope,name) 为键
// 不跟随 → 提示存量挂载成为孤儿，不自动迁移）；删除 = 定义删除（挂载成孤儿，列表灰显可清理）；
// 上移下移 = 相邻交换后 sort 重排整替。
import { useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { TagDefinition } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  appendTagEntry,
  removeTagEntry,
  renameTagEntries,
  reorderTagEntries,
  type TagDefs,
} from "./tag-data";

interface TagManageDialogProps {
  /** project 标签的归属项目（当前项目） */
  project: string;
  defs: TagDefs;
  /** 定义集变更通知（父级重拉，列表行孤儿判定与过滤选项同步） */
  onChanged: () => void;
  onClose: () => void;
}

type Scope = "global" | "project";

export function TagManageDialog({ project, defs, onChanged, onClose }: TagManageDialogProps) {
  const showToast = useUiStore((s) => s.showToast);
  // 本地定义副本（提交成功即更新；父级重拉异步完成前弹层内立即可见）
  const [localDefs, setLocalDefs] = useState<TagDefs>(defs);
  const [busy, setBusy] = useState(false);
  // 行内重命名编辑态：正在改名的 (scope, name) 与输入值
  const [editing, setEditing] = useState<{ scope: Scope; from: string; value: string } | null>(null);
  const [newName, setNewName] = useState<Record<Scope, string>>({ global: "", project: "" });
  const [error, setError] = useState<string | null>(null);

  const entriesOf = (scope: Scope): TagDefinition[] => (scope === "global" ? localDefs.global : localDefs.project);

  /** 提交该 scope 整替并更新本地副本（失败保持原状并展示错误） */
  const putScope = async (scope: Scope, next: TagDefinition[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.putTags({ scope, ...(scope === "project" ? { project } : {}), tags: next });
      setLocalDefs((prev) => ({ ...prev, [scope]: res.tags }));
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addTag = async (scope: Scope) => {
    const name = newName[scope].trim();
    if (name === "") {
      setError("标签名不能为空");
      return;
    }
    if (scope === "project" && !project) {
      setError("无当前项目，无法添加项目标签");
      return;
    }
    if (await putScope(scope, appendTagEntry(entriesOf(scope), name))) {
      setNewName((prev) => ({ ...prev, [scope]: "" }));
    }
  };

  const renameTag = async () => {
    if (!editing) return;
    const to = editing.value.trim();
    if (to === "") {
      setError("标签名不能为空");
      return;
    }
    if (to === editing.from) {
      setEditing(null);
      return;
    }
    if (await putScope(editing.scope, renameTagEntries(entriesOf(editing.scope), editing.from, to))) {
      showToast(`已重命名「${editing.from}」→「${to}」；已挂载旧标签的会话将显示为失效标签（灰显），可在列表中清理`);
      setEditing(null);
    }
  };

  const removeTag = async (scope: Scope, name: string) => {
    if (await putScope(scope, removeTagEntry(entriesOf(scope), name))) {
      showToast(`已删除标签「${name}」；挂载记录保留为失效标签（灰显），可在列表中清理`);
    }
  };

  const moveTag = (scope: Scope, name: string, dir: -1 | 1) => {
    void putScope(scope, reorderTagEntries(entriesOf(scope), name, dir));
  };

  const renderGroup = (scope: Scope, label: string) => {
    const entries = entriesOf(scope);
    return (
      <section data-testid={`tag-manage-${scope}`}>
        <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">{label}</h3>
        <ul className="rounded-md border">
          {entries.length === 0 && <li className="px-2 py-2 text-xs text-muted-foreground/60">暂无标签</li>}
          {entries.map((d, i) => {
            const isEditing = editing?.scope === scope && editing.from === d.name;
            return (
              <li key={d.name} className="flex items-center gap-0.5 border-b px-1 py-0.5 last:border-b-0">
                {isEditing ? (
                  <>
                    <Input
                      value={editing.value}
                      autoFocus
                      onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void renameTag();
                        }
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className="h-9 flex-1 text-sm"
                      data-testid="tag-rename-input"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 lg:size-7"
                      disabled={busy}
                      onClick={() => void renameTag()}
                      aria-label="确认重命名"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 lg:size-7"
                      onClick={() => setEditing(null)}
                      aria-label="取消重命名"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate px-1 text-sm" data-testid="tag-manage-name">
                      {d.name}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 lg:size-7"
                      disabled={busy || i === 0}
                      onClick={() => moveTag(scope, d.name, -1)}
                      aria-label={`上移 ${d.name}`}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 lg:size-7"
                      disabled={busy || i === entries.length - 1}
                      onClick={() => moveTag(scope, d.name, 1)}
                      aria-label={`下移 ${d.name}`}
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 lg:size-7"
                      disabled={busy}
                      onClick={() => setEditing({ scope, from: d.name, value: d.name })}
                      aria-label={`重命名 ${d.name}`}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 text-destructive hover:text-destructive lg:size-7"
                      disabled={busy}
                      onClick={() => void removeTag(scope, d.name)}
                      aria-label={`删除 ${d.name}`}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-1.5 flex items-center gap-1.5">
          <Input
            value={newName[scope]}
            onChange={(e) => setNewName((prev) => ({ ...prev, [scope]: e.target.value }))}
            placeholder={`新增${scope === "global" ? "全局" : "项目"}标签`}
            className="h-11 flex-1 text-sm lg:h-8"
            data-testid={`tag-manage-new-input-${scope}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addTag(scope);
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 shrink-0 gap-1 px-2 text-xs lg:h-8"
            disabled={busy}
            onClick={() => void addTag(scope)}
            data-testid={`tag-manage-add-${scope}`}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            添加
          </Button>
        </div>
      </section>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-sm" data-testid="tag-manage-dialog">
        <DialogHeader>
          <DialogTitle>管理标签</DialogTitle>
          <DialogDescription>
            重命名/删除定义不影响已有挂载记录——会话上的旧标签将显示为失效标签（灰显），可点击清理。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {renderGroup("global", "全局标签")}
          {renderGroup("project", `项目标签（${project ? project.split("/").filter(Boolean).pop() : "无当前项目"}）`)}
          {error && (
            <p className="text-xs text-destructive" data-testid="tag-manage-error">
              {error}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
