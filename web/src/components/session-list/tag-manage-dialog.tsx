// 标签管理弹层（docs08-r3 任务 11 拆域）：scope 参数化——"global" 或 { projectPath }，
// 只渲染对应单组；新增/重命名/删除/上移下移全部经 PUT /api/tags 按 scope 整替：
// 重命名 = 定义文件改名（挂载记录以 (scope,name) 为键不跟随 → 提示存量挂载成为孤儿，
// 不自动迁移）；删除 = 定义删除（挂载成孤儿，灰显）；上移下移 = 相邻交换后
// sort 重排整替。入口显式传入 scope，不再依赖"当前项目"推断。
// 孤儿清理（docs08 2026-10-23/24 批次任务 10）：点按徽标不再直接删，清理入口集中到
// 本弹框——按会话列出本 scope 相关孤儿挂载，两段式确认（点「清理」变确认锺再点才发
// 整替请求，source 标识写服务端审计行）。
import { useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { TagDefinition } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";
import { useT } from "@/i18n/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  appendTagEntry,
  removeTagEntry,
  renameTagEntries,
  reorderTagEntries,
  resetTagColor,
  setTagColor,
  setTagDisplay,
  tagColor,
  type TagDefs,
  type TagDisplayMode,
  type TagRef,
} from "./tag-data";

/** 管理弹框的域：全局标签集，或指定项目的项目标签集（projectPath 必由入口显式给出） */
export type TagManageScope = "global" | { projectPath: string };

/** 本弹框可清理的一条孤儿挂载记录：父级按 definedKeys 算好孤儿与保留集 */
export interface TagOrphanCleanup {
  sessionId: string;
  sessionTitle: string;
  orphans: TagRef[];
  keep: TagRef[];
}

interface TagManageDialogProps {
  /** 本弹框管理的域（单组）：global 或 { projectPath } */
  scope: TagManageScope;
  /** 定义集初始值（仅本 scope 对应组被使用；父级保证组内容与 scope 一致） */
  defs: TagDefs;
  /** 本 scope 相关的孤儿挂载清单（父级按 definedKeys 算好；缺省/空 = 不渲染清理区） */
  orphanCleanups?: TagOrphanCleanup[];
  /** 定义集变更通知（父级重拉，列表行孤儿判定与过滤选项同步） */
  onChanged: () => void;
  onClose: () => void;
}

type Scope = "global" | "project";

export function TagManageDialog({ scope, defs, orphanCleanups, onChanged, onClose }: TagManageDialogProps) {
  const showToast = useUiStore((s) => s.showToast);
  const t = useT();
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
  // 孤儿清理两段式确认：confirmId = 已点「清理」待二次确认的会话 id；busyId = 请求中
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [cleanBusyId, setCleanBusyId] = useState<string | null>(null);

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

  /** 孤儿清理执行（仅在两段式确认后可达）：整替去孤儿 + 审计 source + 行内数据同步 */
  const cleanOrphanMounts = async (entry: TagOrphanCleanup) => {
    if (cleanBusyId) return;
    setCleanBusyId(entry.sessionId);
    setError(null);
    try {
      const res = await api.setSessionTags(entry.sessionId, entry.keep, "tag-manage-dialog:orphan-clean");
      useSessionsStore.getState().patchSession(entry.sessionId, { tags: res.tags });
      setConfirmId(null);
      showToast(t("sessionList.tagBadge.cleaned"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("sessionList.tagBadge.cleanFailed"));
    } finally {
      setCleanBusyId(null);
    }
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
                    {/* 行前取色 swatch（todo 20 b）：原生 color picker，开开预填当前有效色
                        （显式色 ?? hash 自动色）；保存走整替 PUT，失败行内错误不消失 */}
                    <label
                      className="relative size-4 shrink-0 cursor-pointer rounded-sm border border-border/60"
                      style={{ backgroundColor: tagColor(d) }}
                      title={t("sessionList.tagManage.takeColor", { name: d.name })}
                      data-testid={`tag-color-swatch-${d.name}`}
                    >
                      <input
                        type="color"
                        value={tagColor(d)}
                        disabled={busy}
                        onChange={(e) => void putScope(setTagColor(entriesOf(), d.name, e.target.value))}
                        className="absolute inset-0 size-full cursor-pointer opacity-0"
                        aria-label={t("sessionList.tagManage.takeColor", { name: d.name })}
                      />
                    </label>
                    {/* 「自动」重置：剃显式色回 hash 自动色（无显式色时禁用） */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 lg:size-7"
                      disabled={busy || d.color === undefined}
                      onClick={() => void putScope(resetTagColor(entriesOf(), d.name))}
                      aria-label={t("sessionList.tagManage.autoColor", { name: d.name })}
                      title={t("sessionList.tagManage.autoColor", { name: d.name })}
                      data-testid={`tag-color-auto-${d.name}`}
                    >
                      <RotateCcw className="size-3" />
                    </Button>
                    {/* 展示覆盖三态（todo 20 b/e）：""=跟随全局 / text=强制文字 / grid=强制色格；
                        行级规则见 rowTagDisplayMode（text 覆盖优先进整行回退文字） */}
                    <select
                      value={d.display ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        void putScope(
                          setTagDisplay(entriesOf(), d.name, e.target.value === "" ? undefined : (e.target.value as TagDisplayMode)),
                        )
                      }
                      aria-label={t("sessionList.tagManage.displayLabel", { name: d.name })}
                      title={t("sessionList.tagManage.displayLabel", { name: d.name })}
                      data-testid={`tag-display-select-${d.name}`}
                      className="h-6 w-16 shrink-0 rounded border bg-transparent px-0.5 text-[11px] text-foreground"
                    >
                      <option value="">{t("sessionList.tagManage.displayFollow")}</option>
                      <option value="text">{t("sessionList.tagManage.displayText")}</option>
                      <option value="grid">{t("sessionList.tagManage.displayGrid")}</option>
                    </select>
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

  /** 孤儿挂载清理区（任务 10）：本 scope 相关孤儿逐会话列出，两段式确认后整替删除 */
  const renderOrphanCleanup = () => {
    if (!orphanCleanups || orphanCleanups.length === 0) return null;
    return (
      <section data-testid="tag-orphan-cleanup">
        <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">
          {t("sessionList.tagManage.orphanSection")}
        </h3>
        <ul className="rounded-md border">
          {orphanCleanups.map((entry) => {
            const confirming = confirmId === entry.sessionId;
            return (
              <li key={entry.sessionId} className="flex items-center gap-1 border-b px-1 py-0.5 last:border-b-0">
                <span className="min-w-0 flex-1 truncate px-1 text-sm" title={entry.sessionTitle}>
                  {entry.sessionTitle}
                </span>
                <span className="flex shrink-0 flex-wrap justify-end gap-0.5">
                  {entry.orphans.map((tag) => (
                    <span
                      key={`${tag.scope}:${tag.name}`}
                      className="rounded border border-dashed px-1 py-px text-[10px] leading-none text-muted-foreground/50"
                      data-testid="tag-orphan-name"
                    >
                      {tag.name}
                    </span>
                  ))}
                </span>
                {!confirming ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-11 shrink-0 text-destructive hover:text-destructive lg:size-7"
                    onClick={() => setConfirmId(entry.sessionId)}
                    aria-label={t("sessionList.tagManage.orphanClean", { title: entry.sessionTitle })}
                    data-testid="tag-orphan-clean"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="h-11 shrink-0 px-2 text-xs lg:h-7"
                    disabled={cleanBusyId === entry.sessionId}
                    onClick={() => void cleanOrphanMounts(entry)}
                    data-testid="tag-orphan-clean-confirm"
                  >
                    {cleanBusyId === entry.sessionId ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {t("sessionList.tagManage.orphanCleanConfirm")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-sm" data-testid="tag-manage-dialog">
        <DialogHeader>
          <DialogTitle>{t("sessionList.tagManage.title")}</DialogTitle>
          <DialogDescription>{t("sessionList.tagManage.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {renderGroup()}
          {renderOrphanCleanup()}
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
