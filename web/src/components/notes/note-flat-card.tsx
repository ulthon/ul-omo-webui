// 笔记平铺卡片（2026-11-07 平铺直编批）：列表即全文的展示形态——标题+正文全文平铺\n// 摊开（正文纯文本换行语义 whitespace-pre-wrap，不走 Markdown），无折叠无摘要。\n// 单击卡片任意处进入就地编辑（宿主把卡片换成 NoteInlineEditor，同容器同密度，\n// 无形态跳变）；操作按钮与拖拽手柄由宿主以 footerExtra/dragHandle 注入（页签全量，\n// 总览精简）。导出 .md / 复制的文本组装也在此（与展示同源）。
import { Copy, CopyPlus, Download } from "lucide-react";
import { useT } from "@/i18n/i18n";
import { copyText } from "@/lib/clipboard";
import { useUiStore } from "@/stores/ui";
import { deriveDisplayTitle, relTime } from "./notes-logic";
import type { NoteListItem } from "./notes-api";

/** 导出单条 .md 的文本组装：标题作一级标题，正文原样（纯文本语义）；标题空则只有正文 */
export function noteToMarkdown(note: NoteListItem): string {
  const title = note.title.trim();
  return title.length > 0 ? `# ${title}\n\n${note.content}` : note.content;
}

/** 复制「标题+内容」的文本组装（与导出同形，便于粘贴到任何地方） */
export function noteTitleContentText(note: NoteListItem): string {
  return noteToMarkdown(note).trim();
}

/** 导出文件名：展示标题去文件系统危险字符，空白回退 note */
export function noteExportFilename(note: NoteListItem, untitledLabel: string): string {
  const display = deriveDisplayTitle(note.title, note.preview, untitledLabel);
  const safe = display.replace(/[\\/:*?\"<>|]/g, "_").trim();
  return `${safe.length > 0 ? safe : "note"}.md`;
}

export function downloadNoteMarkdown(note: NoteListItem, untitledLabel: string): void {
  const blob = new Blob([noteToMarkdown(note)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = noteExportFilename(note, untitledLabel);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const ACTION_BTN =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground";

/** 平铺卡片。onClick 由宿主提供（进入就地编辑）；footerExtra 注入宿主特有动作。 */
export function NoteFlatCard({
  note,
  onClick,
  footerExtra,
  dragHandle,
  testid = "note-item",
}: {
  note: NoteListItem;
  onClick: () => void;
  footerExtra?: React.ReactNode;
  dragHandle?: React.ReactNode;
  testid?: string;
}) {
  const t = useT();
  const showToast = useUiStore((s) => s.showToast);
  const untitled = t("notes.view.untitled");
  const displayTitle = deriveDisplayTitle(note.title, note.preview, untitled);

  const copyContent = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyText(note.content);
    showToast(t(ok ? "notes.view.copiedToast" : "notes.view.copyFailed"), ok ? "info" : "error");
  };
  const copyTitleContent = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyText(noteTitleContentText(note));
    showToast(t(ok ? "notes.view.copiedToast" : "notes.view.copyFailed"), ok ? "info" : "error");
  };
  const exportMd = (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      downloadNoteMarkdown(note, untitled);
    } catch {
      showToast(t("notes.view.copyFailed"), "error");
    }
  };

  return (
    <div
      onClick={onClick}
      className="flex cursor-text flex-col gap-1.5 rounded-lg border bg-background px-3 py-2.5 transition-colors hover:border-muted-foreground/30"
      data-testid={testid}
      data-note-id={note.id}
    >
      <div className="flex items-start gap-1">
        {dragHandle}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          aria-label={t("notes.view.editHint", { title: displayTitle })}
          className="min-w-0 flex-1 cursor-text text-left"
        >
          <span className="block whitespace-pre-wrap break-words text-sm font-medium leading-relaxed">
            {displayTitle}
          </span>
        </button>
      </div>
      <span className="min-w-0 cursor-text text-left">
        {note.content.trim().length > 0 && (
          <span className="block whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
            {note.content}
          </span>
        )}
      </span>
      <div className="flex items-center gap-1.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {note.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
              {tag}
            </span>
          ))}
          <span className="text-[10px] text-muted-foreground">{relTime(note.updatedAt)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => void copyContent(e)}
            aria-label={t("notes.view.copyContent")}
            title={t("notes.view.copyContent")}
            data-testid={`note-copy-content-${note.id}`}
            className={ACTION_BTN}
          >
            <Copy className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => void copyTitleContent(e)}
            aria-label={t("notes.view.copyTitleContent")}
            title={t("notes.view.copyTitleContent")}
            data-testid={`note-copy-title-content-${note.id}`}
            className={ACTION_BTN}
          >
            <CopyPlus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={exportMd}
            aria-label={t("notes.view.exportMd")}
            title={t("notes.view.exportMd")}
            data-testid={`note-export-md-${note.id}`}
            className={ACTION_BTN}
          >
            <Download className="size-3.5" />
          </button>
          {footerExtra}
        </span>
      </div>
    </div>
  );
}
