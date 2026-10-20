// 笔记编辑表单（右栏窄栏版，docs08-r3 任务5）：标题输入 + 正文 textarea +
// 标签（逗号分隔自由输入）+ 保存/取消。头部（返回/标题/编辑预览切换）由宿主
// NoteDetail 的面板头部承载，本件只渲染表单本体。受控表单，状态由父组件持有
// （编辑/新建草稿共用）。
import { t } from "@/i18n/i18n";

export interface EditDraft {
  title: string;
  content: string;
  tagsText: string;
}

interface NoteEditFormProps {
  edit: EditDraft;
  saving: boolean;
  saveError: string | null;
  onChange: (draft: EditDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function NoteEditForm({ edit, saving, saveError, onChange, onSave, onCancel }: NoteEditFormProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3" data-testid="note-edit-form">
      <input
        value={edit.title}
        onChange={(e) => onChange({ ...edit, title: e.target.value })}
        placeholder={t("notes.edit.titlePlaceholder")}
        aria-label={t("notes.edit.titleAria")}
        data-testid="note-title-input"
        className="h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-colors focus:ring-1 focus:ring-ring"
      />
      <input
        value={edit.tagsText}
        onChange={(e) => onChange({ ...edit, tagsText: e.target.value })}
        placeholder={t("notes.edit.tagsPlaceholder")}
        aria-label={t("notes.edit.tagsAria")}
        data-testid="note-tags-input"
        className="h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-colors focus:ring-1 focus:ring-ring"
      />
      <textarea
        value={edit.content}
        onChange={(e) => onChange({ ...edit, content: e.target.value })}
        placeholder={t("notes.edit.contentPlaceholder")}
        aria-label={t("notes.edit.contentAria")}
        data-testid="note-content-input"
        className="min-h-0 flex-1 resize-none rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed outline-none transition-colors focus:ring-1 focus:ring-ring"
      />
      {saveError !== null && (
        <p className="text-xs text-destructive" role="alert" data-testid="note-save-error">{saveError}</p>
      )}
      <div className="flex shrink-0 items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-9 rounded-lg border px-4 text-sm transition-colors hover:bg-muted" data-testid="note-cancel-btn">
          {t("notes.edit.cancel")}
        </button>
        <button type="button" onClick={onSave} disabled={saving} data-testid="note-save-btn" className="min-h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
          {saving ? t("notes.edit.saving") : t("notes.edit.save")}
        </button>
      </div>
    </div>
  );
}
