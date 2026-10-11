// 回收站列表（todo 15）：软删笔记列表（删除时间）+ 行内恢复/彻底删除按钮。
// 从 notes-view 拆出（250 LOC 上限）：独立加载态，恢复/删除逻辑由父组件经回调持有。
import { useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { notesApi, type NoteListItem } from "./notes-api";
import { relTime } from "./notes-logic";

interface TrashListProps {
  project: string;
  reloadSeq: number;
  onRestore: (note: NoteListItem) => void;
  onPurge: (note: NoteListItem) => void;
}

export function TrashList({ project, reloadSeq, onRestore, onPurge }: TrashListProps) {
  const [notes, setNotes] = useState<NoteListItem[] | null>(null);

  useEffect(() => {
    let stale = false;
    notesApi
      .list(project, { deleted: true })
      .then((r) => {
        if (!stale) setNotes(r.notes);
      })
      .catch(() => {
        if (!stale) setNotes([]);
      });
    return () => {
      stale = true;
    };
  }, [project, reloadSeq]);

  if (notes === null) {
    return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">加载回收站…</div>;
  }
  if (notes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Trash2 className="size-10 text-muted-foreground/40" />
        <div>
          <p className="text-sm font-medium">回收站为空</p>
          <p className="mt-1 text-xs text-muted-foreground">软删除的笔记会出现在这里</p>
        </div>
      </div>
    );
  }
  return (
    <div className="py-1" data-testid="notes-trash-list">
      {notes.map((note) => (
        <div key={note.id} className="flex min-h-11 items-center gap-2 px-3 py-1.5" data-testid="trash-item">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{note.title}</p>
            <p className="text-[10px] text-muted-foreground">删除于 {relTime(note.deletedAt)}</p>
          </div>
          <button type="button" onClick={() => onRestore(note)} aria-label={`恢复 ${note.title}`} className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground lg:size-8">
            <RotateCcw className="size-3.5" />
          </button>
          <button type="button" onClick={() => onPurge(note)} aria-label={`彻底删除 ${note.title}`} className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-destructive lg:size-8">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
