// 笔记编辑表单（todo 15）：标题输入 + 正文 textarea + 标签（逗号分隔自由输入）+ 保存/取消。
// 从 note-detail 拆出（250 LOC 上限）：受控表单，状态由父组件持有（编辑/新建草稿共用）。
import { ArrowLeft } from "lucide-react";

export interface EditDraft {
  title: string;
  content: string;
  tagsText: string;
}

interface NoteEditFormProps {
  heading: string;
  edit: EditDraft;
  saving: boolean;
  saveError: string | null;
  onChange: (draft: EditDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function NoteEditForm({ heading, edit, saving, saveError, onChange, onSave, onCancel }: NoteEditFormProps) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="note-edit-form">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
        <button type="button" onClick={onCancel} aria-label="返回笔记列表" className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground lg:hidden">
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="text-sm font-medium">{heading}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <input
          value={edit.title}
          onChange={(e) => onChange({ ...edit, title: e.target.value })}
          placeholder="标题"
          aria-label="笔记标题"
          data-testid="note-title-input"
          className="h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-colors focus:ring-1 focus:ring-ring lg:h-9"
        />
        <input
          value={edit.tagsText}
          onChange={(e) => onChange({ ...edit, tagsText: e.target.value })}
          placeholder="标签（逗号分隔，可留空）"
          aria-label="笔记标签"
          data-testid="note-tags-input"
          className="h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-colors focus:ring-1 focus:ring-ring lg:h-9"
        />
        <textarea
          value={edit.content}
          onChange={(e) => onChange({ ...edit, content: e.target.value })}
          placeholder="正文（支持 Markdown）"
          aria-label="笔记正文"
          data-testid="note-content-input"
          className="min-h-0 flex-1 resize-none rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed outline-none transition-colors focus:ring-1 focus:ring-ring"
        />
        {saveError !== null && (
          <p className="text-xs text-destructive" role="alert" data-testid="note-save-error">{saveError}</p>
        )}
        <div className="flex shrink-0 items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className="min-h-11 rounded-lg border px-4 text-sm transition-colors hover:bg-muted lg:min-h-9" data-testid="note-cancel-btn">
            取消
          </button>
          <button type="button" onClick={onSave} disabled={saving} data-testid="note-save-btn" className="min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50 lg:min-h-9">
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
