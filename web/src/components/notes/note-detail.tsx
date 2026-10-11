// 笔记详情（todo 15）：查看（Markdown 渲染，复用 chat/markdown 的通用 Markdown 组件）/
// 编辑（标题 + content + 标签逗号分隔）/ 版本面板（列表 + 恢复）。
// 进入笔记默认查看态（计划钉死）；noteId=null 为新建草稿态——直接进编辑态，保存时 POST
// 创建，取消即无痕退出。dirty 状态经 dirtyRef 上报宿主（shell 切页签确认用），
// 并在 dirty 时挂 beforeunload 拦截刷新/关闭（未保存提示三例之二）。
// 宿主以 key={noteId} 挂载本组件：切换笔记即整体重挂，本地态随挂载自然重置
// （effect 只发请求不同步 setState——oxlint set-state-in-effect 消警模式，同 todo 20）。
import { useEffect, useState } from "react";
import { ArrowLeft, History, Pencil, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { Markdown } from "@/components/chat/markdown";
import { notesApi, type NoteData, type NoteVersionInfo } from "./notes-api";
import { NoteEditForm, type EditDraft } from "./note-edit-form";
import { VersionPanel } from "./note-versions";
import { parseTagInput, relTime, tagsToInput } from "./notes-logic";

export interface NoteDetailProps {
  project: string;
  /** null = 新建草稿（保存时创建） */
  noteId: string | null;
  /** 编辑未保存标记：宿主切页签前读取做确认 */
  dirtyRef: { current: boolean };
  /** 保存/恢复成功后通知宿主刷新列表 */
  onChanged: () => void;
  /** 创建成功（宿主把选中项切到新 id）；仅草稿态保存后回调 */
  onCreated: (id: string) => void;
  onClose: () => void;
}

function sameDraft(a: EditDraft, b: EditDraft): boolean {
  return a.title === b.title && a.content === b.content && a.tagsText === b.tagsText;
}

const BTN_CLASS =
  "flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors hover:bg-muted/50 lg:min-h-9";

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

export function NoteDetail({ project, noteId, dirtyRef, onChanged, onCreated, onClose }: NoteDetailProps) {
  const draft = noteId === null;
  const [note, setNote] = useState<NoteData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);
  const [mode, setMode] = useState<"view" | "edit">(draft ? "edit" : "view");
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [baseline, setBaseline] = useState<EditDraft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<NoteVersionInfo[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // 详情加载：key 重挂保证初始干净，effect 只发请求（异步落地才 setState）
  useEffect(() => {
    if (noteId === null) return;
    let stale = false;
    notesApi
      .get(noteId)
      .then((r) => {
        if (!stale) setNote(r.note);
      })
      .catch((err: unknown) => {
        if (!stale) setLoadError(errorMessage(err));
      });
    return () => {
      stale = true;
    };
  }, [noteId, retrySeq]);

  const startEdit = () => {
    if (!note) return;
    const initial = { title: note.title, content: note.content, tagsText: tagsToInput(note.tags) };
    setEdit(initial);
    setBaseline(initial);
    setSaveError(null);
    setMode("edit");
  };

  const dirty = mode === "edit" && edit !== null && baseline !== null && !sameDraft(edit, baseline);

  // dirty 上报宿主 + beforeunload（刷新/关闭拦截）
  useEffect(() => {
    dirtyRef.current = dirty;
    return () => {
      dirtyRef.current = false;
    };
  }, [dirty, dirtyRef]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const exitEdit = () => {
    if (dirty && !window.confirm("有未保存的修改，确定放弃吗？")) return;
    if (draft) {
      onClose();
      return;
    }
    setEdit(null);
    setBaseline(null);
    setSaveError(null);
    setMode("view");
  };

  const save = async () => {
    if (!edit || saving) return;
    const title = edit.title.trim();
    if (title.length === 0) {
      setSaveError("标题不能为空");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const tags = parseTagInput(edit.tagsText);
      if (draft) {
        const { note: created } = await notesApi.create({ project, title, content: edit.content, tags });
        onCreated(created.id);
      } else {
        const { note: updated } = await notesApi.update(noteId, { title, content: edit.content, tags });
        setNote(updated);
      }
      setEdit(null);
      setBaseline(null);
      setMode("view");
      setVersionsOpen(false);
      setVersions(null);
      onChanged();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const removeNote = async () => {
    if (noteId === null || !window.confirm(`删除笔记「${note?.title ?? ""}」？可在回收站恢复。`)) return;
    try {
      await notesApi.remove(noteId);
      onChanged();
      onClose();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const openVersions = async () => {
    setVersionsOpen((open) => !open);
    if (versionsOpen || noteId === null) return;
    setVersions(null);
    setVersionsError(null);
    try {
      const { versions: list } = await notesApi.versions(noteId);
      setVersions(list);
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : String(err));
    }
  };

  const restoreVersion = async (version: NoteVersionInfo) => {
    if (noteId === null) return;
    if (!window.confirm(`恢复到 ${relTime(version.savedAt)} 的版本？当前正文将被覆盖（可再从版本历史找回）。`)) return;
    try {
      const { note: restored } = await notesApi.restoreVersion(noteId, version.id);
      setNote(restored);
      setVersionsOpen(false);
      setVersions(null);
      setMode("view");
      setEdit(null);
      setBaseline(null);
      onChanged();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    }
  };

  // ---- 渲染 ----
  if (draft) {
    return (
      <NoteEditForm
        heading="新建笔记"
        edit={edit ?? { title: "", content: "", tagsText: "" }}
        saving={saving}
        saveError={saveError}
        onChange={setEdit}
        onSave={save}
        onCancel={exitEdit}
      />
    );
  }

  if (loadError !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">笔记加载失败：{loadError}</p>
        <button
          type="button"
          onClick={() => {
            setLoadError(null);
            setRetrySeq((n) => n + 1);
          }}
          className="rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
        >
          重试
        </button>
      </div>
    );
  }

  if (note === null) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">加载笔记…</div>;
  }

  if (mode === "edit" && edit !== null) {
    return (
      <NoteEditForm
        heading="编辑笔记"
        edit={edit}
        saving={saving}
        saveError={saveError}
        onChange={setEdit}
        onSave={save}
        onCancel={exitEdit}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="note-detail">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
        <button type="button" onClick={onClose} aria-label="返回笔记列表" className={`${BTN_CLASS} text-muted-foreground hover:text-foreground lg:hidden`}>
          <ArrowLeft className="size-4" />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="note-detail-title">{note.title}</h2>
        <span className="text-[10px] text-muted-foreground">更新于 {relTime(note.updatedAt)}</span>
        <button type="button" onClick={startEdit} data-testid="note-edit-btn" className={`${BTN_CLASS} text-muted-foreground hover:text-foreground`}>
          <Pencil className="size-3.5" />
          编辑
        </button>
        <button type="button" onClick={() => void openVersions()} data-testid="note-versions-btn" aria-expanded={versionsOpen} className={`${BTN_CLASS} text-muted-foreground hover:text-foreground`}>
          <History className="size-3.5" />
          历史版本
        </button>
        <button type="button" onClick={() => void removeNote()} aria-label="删除笔记" className={`${BTN_CLASS} text-muted-foreground hover:text-destructive`}>
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {note.tags.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1.5 px-3 pt-2">
          {note.tags.map((tag) => (
            <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {tag}
            </span>
          ))}
        </div>
      )}

      {versionsOpen && (
        <VersionPanel versions={versions} error={versionsError} onRestore={(v) => void restoreVersion(v)} onClose={() => setVersionsOpen(false)} />
      )}

      {saveError !== null && (
        <p className="shrink-0 px-3 py-1.5 text-xs text-destructive" role="alert">{saveError}</p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="note-content">
        <Markdown text={note.content} />
      </div>
    </div>
  );
}
