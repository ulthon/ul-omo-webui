// 版本历史面板（todo 15）：列表（savedAt 相对时间 + preview）+ 逐项恢复按钮。
// 从 note-detail 拆出（250 LOC 上限）：纯展示组件，加载/恢复逻辑由父组件持有。
import { X } from "lucide-react";
import { useT } from "@/i18n/i18n";
import type { NoteVersionInfo } from "./notes-api";
import { relTime } from "./notes-logic";

interface VersionPanelProps {
  versions: NoteVersionInfo[] | null;
  error: string | null;
  onRestore: (version: NoteVersionInfo) => void;
  onClose: () => void;
}

export function VersionPanel({ versions, error, onRestore, onClose }: VersionPanelProps) {
  const t = useT();
  return (
    <div className="shrink-0 border-b bg-muted/30 px-3 py-2" data-testid="note-versions-panel">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-xs font-medium">{t("notes.versions.title")}</span>
        {versions !== null && <span className="text-[10px] text-muted-foreground">{t("notes.versions.count", { n: versions.length })}</span>}
        <button type="button" onClick={onClose} aria-label={t("notes.versions.collapse")} className="ml-auto flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50">
          <X className="size-3.5" />
        </button>
      </div>
      {error !== null ? (
        <p className="text-xs text-destructive">{t("notes.versions.loadFailed", { error })}</p>
      ) : versions === null ? (
        <p className="text-xs text-muted-foreground">{t("notes.versions.loading")}</p>
      ) : versions.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("notes.versions.empty")}</p>
      ) : (
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {versions.map((v) => (
            <li key={v.id} className="flex items-start gap-2 rounded-lg bg-background px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-muted-foreground" title={v.savedAt}>{relTime(v.savedAt)}</p>
                <p className="truncate text-xs">{v.preview || t("notes.versions.emptyPreview")}</p>
              </div>
              <button type="button" onClick={() => onRestore(v)} className="flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
                {t("notes.versions.restore")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
