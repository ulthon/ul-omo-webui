// 常用语单 scope 组编辑器（todo 14）：条目列表的行内编辑、删除（确认）、上移/下移
// （44px 触控）与新增（内容输入，前端拦截空内容与超 4KB）。只做单组渲染与本地编辑态，
// 提交一律回调 onSubmit(整替后的该组条目) 由父级 putScope（SnippetManage）。
import { useState } from "react";
import { ArrowDown, ArrowUp, History, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import type { SnippetEntry } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/i18n";
import { isSnippetOverLimit, moveSnippet, snippetPreview } from "./snippet-logic";

export function SnippetGroupEditor({
  scope,
  label,
  entries,
  busy,
  canEdit,
  showImportButton,
  onImportOpen,
  onSubmit,
}: {
  scope: "global" | "project";
  label: string;
  entries: SnippetEntry[];
  /** 父级 PUT 进行中：操作按钮禁用 */
  busy: boolean;
  /** project scope 且无当前项目时禁写（新增/编辑/删除/移动全禁） */
  canEdit: boolean;
  showImportButton: boolean;
  onImportOpen: () => void;
  /** 提交整替后的该组条目；resolve(true) 表示成功（新增输入清空/编辑态退出），false 保持原状 */
  onSubmit: (next: SnippetEntry[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<{ index: number; value: string } | null>(null);
  const [newValue, setNewValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const t = useT();
  const validateContent = (content: string): string | null => {
    if (content.trim() === "") return t("composer.snippet.contentRequired");
    if (isSnippetOverLimit(content)) return t("composer.snippet.contentOverLimit");
    return null;
  };

  const fail = (message: string) => {
    setError(message);
    return false;
  };

  const addSnippet = async () => {
    if (!canEdit) return fail(t("composer.snippet.noProjectAdd"));
    const problem = validateContent(newValue);
    if (problem) return fail(problem);
    if (await onSubmit([...entries, { content: newValue, sort: 0 }])) setNewValue("");
    return true;
  };

  const confirmEdit = async () => {
    if (!editing) return;
    const problem = validateContent(editing.value);
    if (problem) {
      setError(problem);
      return;
    }
    if (await onSubmit(entries.map((e, i) => (i === editing.index ? { ...e, content: editing.value } : e)))) {
      setEditing(null);
    }
  };

  const removeSnippet = async (index: number) => {
    if (!canEdit) return;
    if (!window.confirm(t("composer.snippet.confirmDelete"))) return;
    if (await onSubmit(entries.filter((_, i) => i !== index))) setEditing(null);
  };

  const move = (index: number, dir: -1 | 1) => {
    // 移动重排 index，正在编辑的行取消编辑（防编辑态错位到相邻条目）
    setEditing(null);
    onSubmit(moveSnippet(entries, index, dir));
  };

  return (
    <section data-testid={`snippet-manage-${scope}`}>
      <div className="flex items-center justify-between px-1 pb-1">
        <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
        {showImportButton && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-11 gap-1 px-1.5 text-xs lg:h-7"
            disabled={busy}
            onClick={onImportOpen}
            data-testid="snippet-import-open"
          >
            <History className="size-3.5" />
            {t("composer.snippet.importTitle")}
          </Button>
        )}
      </div>
      <ul className="rounded-md border">
        {entries.length === 0 && <li className="px-2 py-2 text-xs text-muted-foreground/60">{t("composer.snippet.noEntriesManage")}</li>}
        {entries.map((e, i) => {
          const isEditing = editing?.index === i;
          return (
            <li key={i} className="flex items-stretch gap-0.5 border-b px-1 py-0.5 last:border-b-0">
              {isEditing ? (
                <>
                  <textarea
                    value={editing.value}
                    autoFocus
                    rows={2}
                    onChange={(ev) => setEditing({ ...editing, value: ev.target.value })}
                    className="min-h-11 flex-1 resize-y rounded border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:border-ring"
                    data-testid="snippet-edit-input"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-11 shrink-0 lg:size-7"
                    disabled={busy}
                    onClick={confirmEdit}
                    aria-label={t("composer.snippet.confirmEdit")}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-11 shrink-0 lg:size-7"
                    onClick={() => setEditing(null)}
                    aria-label={t("composer.snippet.cancelEdit")}
                  >
                    <X className="size-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 self-center truncate px-1 text-sm" title={e.content}>
                    {snippetPreview(e.content)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-11 shrink-0 lg:size-7"
                    disabled={busy || !canEdit || i === 0}
                    onClick={() => move(i, -1)}
                    aria-label={t("composer.snippet.moveUp", { preview: snippetPreview(e.content, 20) })}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-11 shrink-0 lg:size-7"
                    disabled={busy || !canEdit || i === entries.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={t("composer.snippet.moveDown", { preview: snippetPreview(e.content, 20) })}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-11 shrink-0 lg:size-7"
                    disabled={busy || !canEdit}
                    onClick={() => setEditing({ index: i, value: e.content })}
                    aria-label={t("composer.snippet.editItem", { preview: snippetPreview(e.content, 20) })}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-11 shrink-0 text-destructive hover:text-destructive lg:size-7"
                    disabled={busy || !canEdit}
                    onClick={() => void removeSnippet(i)}
                    aria-label={t("composer.snippet.removeItem", { preview: snippetPreview(e.content, 20) })}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-1.5 flex items-start gap-1.5">
        <textarea
          value={newValue}
          onChange={(ev) => setNewValue(ev.target.value)}
          placeholder={scope === "global" ? t("composer.snippet.newGlobalPlaceholder") : t("composer.snippet.newProjectPlaceholder")}
          rows={2}
          disabled={!canEdit}
          className="min-h-11 flex-1 resize-y rounded border border-input bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring disabled:opacity-50"
          data-testid={`snippet-new-input-${scope}`}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 shrink-0 gap-1 px-2 text-xs lg:h-9 lg:self-start"
          disabled={busy || !canEdit}
          onClick={() => void addSnippet()}
          data-testid={`snippet-add-${scope}`}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          {t("composer.snippet.add")}
        </Button>
      </div>
      {error && (
        <p className="px-1 pt-1 text-xs text-destructive" data-testid={`snippet-manage-error-${scope}`}>
          {error}
        </p>
      )}
    </section>
  );
}
