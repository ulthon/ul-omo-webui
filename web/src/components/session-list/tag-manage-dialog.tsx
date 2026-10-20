// 标签管理弹层（docs08-r3 任务 11 拆域）：scope 参数化——"global" 或 { projectPath }，
// 只渲染对应单组；新增/重命名/删除/上移下移全部经 PUT /api/tags 按 scope 整替：
// 重命名 = 定义文件改名（挂载记录以 (scope,name) 为键不跟随 → 提示存量挂载成为孤儿，
// 不自动迁移）；删除 = 定义删除（挂载成孤儿，列表灰显可清理）；上移下移 = 相邻交换后
// sort 重排整替。入口显式传入 scope，不再依赖"当前项目"推断。
import { useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { TagDefinition } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { t } from "@/i18n/i18n";
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

/** 管理弹框的域：全局标签集，或指定项目的项目标签集（projectPath 必由入口显式给出） */
export type TagManageScope = "global" | { projectPath: string };

interface TagManageDialogProps {
  /** 本弹框管理的域（单组）：global 或 { projectPath } */
  scope: TagManageScope;
  /** 定义集初始值（仅本 scope 对应组被使用；父级保证组内容与 scope 一致） */
  defs: TagDefs;
  /** 定义集变更通知（父级重拉，列表行孤儿判定与过滤选项同步） */
  onChanged: () => void;
  onClose: () => void;
}

type Scope = "global" | "project";

export function TagManageDialog({ scope, defs, onChanged, onClose }: TagManageDialogProps) {
  const showToast = useUiStore((s) => s.showToast);
  const isProject = typeof scope === "object";
  const project = isProject ? scope.projectPath : "";
  const groupScope: Scope = isProject ? "project" : "global";
  // 本地定义副本（提交成功即更新；父级重拉异步完成前弹层内立即可见）
  const [localDefs, setLocalDefs] = useState<TagDefs>(defs);
  const [busy, setBusy] = useState(false);
  // 行内重命名编辑态：正在改名的名字与输入值（单组，无 scope 维度）
  const [editing, setEditing] = useState<{ from: string; value: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const entriesOf = (): TagDefinition[] => localDefs[groupScope];

  /** 提交本 scope 整替并更新本地副本（失败保持原状并展示错误） */
  const putScope = async (next: TagDefinition[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.putTags({
        scope: groupScope,
        ...(isProject ? { project } : {}),
        tags: next,
      });
      setLocalDefs((prev) => ({ ...prev, [groupScope]: res.tags }));
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("sessionList.tagManage.saveFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addTag = async () => {
    const name = newName.trim();
    if (name === "") {
      setError(t("sessionList.tagManage.nameRequired"));
      return;
    }
    if (await putScope(appendTagEntry(entriesOf(), name))) {
      setNewName("");
    }
  };

  const renameTag = async () => {
    if (!editing) return;
    const to = editing.value.trim();
    if (to === "") {
      setError(t("sessionList.tagManage.nameRequired"));
      return;
    }
    if (to === editing.from) {
      setEditing(null);
      return;
    }
    if (await putScope(renameTagEntries(entriesOf(), editing.from, to))) {
      showToast(t("sessionList.tagManage.renamedToast", { from: editing.from, to }));
      setEditing(null);
    }
  };

  const removeTag = async (name: string) => {
    if (await putScope(removeTagEntry(entriesOf(), name))) {
      showToast(t("sessionList.tagManage.deletedToast", { name }));
    }
  };

  const moveTag = (name: string, dir: -1 | 1) => {
    void putScope(reorderTagEntries(entriesOf(), name, dir));
  };

  const renderGroup = () => {
    const entries = entriesOf();
    return (
      <section data-testid={`tag-manage-${groupScope}`}>
        <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">
          {isProject
            ? t("sessionList.tagManage.projectGroup", { name: project.split("/").filter(Boolean).pop() ?? project })
            : t("sessionList.tagManage.globalGroup")}
        </h3>
        <ul className="rounded-md border">
          {entries.length === 0 && <li className="px-2 py-2 text-xs text-muted-foreground/60">{t("sessionList.tagManage.noTags")}</li>}
          {entries.map((d, i) => {
            const isEditing = editing?.from === d.name;
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
                      aria-label={t("sessionList.tagManage.confirmRename")}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 lg:size-7"
                      onClick={() => setEditing(null)}
                      aria-label={t("sessionList.tagManage.cancelRename")}
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
                      onClick={() => moveTag(d.name, -1)}
                      aria-label={t("sessionList.tagManage.moveUp", { name: d.name })}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 lg:size-7"
                      disabled={busy || i === entries.length - 1}
                      onClick={() => moveTag(d.name, 1)}
                      aria-label={t("sessionList.tagManage.moveDown", { name: d.name })}
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 lg:size-7"
                      disabled={busy}
                      onClick={() => setEditing({ from: d.name, value: d.name })}
                      aria-label={t("sessionList.tagManage.rename", { name: d.name })}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 text-destructive hover:text-destructive lg:size-7"
                      disabled={busy}
                      onClick={() => void removeTag(d.name)}
                      aria-label={t("sessionList.tagManage.delete", { name: d.name })}
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
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={isProject ? t("sessionList.tagManage.newProjectPlaceholder") : t("sessionList.tagManage.newGlobalPlaceholder")}
            className="h-11 flex-1 text-sm lg:h-8"
            data-testid={`tag-manage-new-input-${groupScope}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addTag();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 shrink-0 gap-1 px-2 text-xs lg:h-8"
            disabled={busy}
            onClick={() => void addTag()}
            data-testid={`tag-manage-add-${groupScope}`}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            {t("sessionList.tagManage.add")}
          </Button>
        </div>
      </section>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-sm" data-testid="tag-manage-dialog">
        <DialogHeader>
          <DialogTitle>{t("sessionList.tagManage.title")}</DialogTitle>
          <DialogDescription>{t("sessionList.tagManage.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {renderGroup()}
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
