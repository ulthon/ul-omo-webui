// 笔记行内编辑器（r11 todo7）：列表行点击就地展开，收起/点外部自动保存（存量 PUT、
// 新建 POST），无详情页、无保存按钮。noteId=null 为列表顶新建空行——收起时标题正文
// 全空 → 无痕取消（零请求）。标题可空（服务端空标题合法），正文 textarea 原样换行
// （纯文本语义，不走 Markdown）。dirty 基线：存量笔记以载入
// 值为基线，新建以空稿为基线；dirty 经 dirtyRef 上报宿主（右栏切页签确认契约不变）
// 并挂 beforeunload。版本历史/删除收进「···」菜单，VersionPanel 复用 note-versions。
import { useEffect, useRef, useState } from "react";
import { ChevronUp, History, MoreVertical, Trash2 } from "lucide-react";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { notesApi, type NoteData, type NoteVersionInfo } from "./notes-api";
import { VersionPanel } from "./note-versions";
import { parseTagInput, relTime, tagsToInput } from "./notes-logic";

export interface InlineDraft {
  title: string;
  content: string;
  tagsText: string;
}

/** 新建草稿 dirty 基线：空稿。输入任何内容即偏离基线 → dirty */
const DRAFT_BASELINE: InlineDraft = { title: "", content: "", tagsText: "" };

function sameDraft(a: InlineDraft, b: InlineDraft): boolean {
  return a.title === b.title && a.content === b.content && a.tagsText === b.tagsText;
}

export interface NoteInlineEditorProps {
  /** null = 列表顶新建空行（保存时创建） */
  noteId: string | null;
  project: string;
  dirtyRef: { current: boolean };
  /** 保存成功（created=true 表示新建）后回调：宿主刷新列表并收起本行 */
  onSaved: (noteId: string, created: boolean) => void;
  /** 新建全空取消（零请求）：宿主直接移除空行 */
  onCancel: () => void;
  /** 删除成功：宿主刷新列表 */
  onDeleted: () => void;
}

export function NoteInlineEditor({ noteId, project, dirtyRef, onSaved, onCancel, onDeleted }: NoteInlineEditorProps) {
  const t = useT();
  const draft = noteId === null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const disposedRef = useRef(false);
  const [note, setNote] = useState<NoteData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);
  const [edit, setEdit] = useState<InlineDraft | null>(draft ? DRAFT_BASELINE : null);
  const [baseline, setBaseline] = useState<InlineDraft | null>(draft ? DRAFT_BASELINE : null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<NoteVersionInfo[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // 存量笔记载入：挂载即拉详情（列表项不含 content）。key 重挂保证初始干净，
  // effect 只发请求不同步 setState（oxlint set-state-in-effect 消警模式）
  useEffect(() => {
    if (noteId === null) return;
    let stale = false;
    notesApi
      .get(noteId)
      .then((r) => {
        if (stale) return;
        const initial = { title: r.note.title, content: r.note.content, tagsText: tagsToInput(r.note.tags) };
        setNote(r.note);
        setEdit(initial);
        setBaseline(initial);
      })
      .catch((err: unknown) => {
        if (!stale) setLoadError(apiErrorMessage(err, "notes.loadFailedBrief"));
      });
    return () => {
      stale = true;
    };
  }, [noteId, retrySeq]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      dirtyRef.current = false;
    };
  }, [dirtyRef]);

  const dirty = edit !== null && baseline !== null && !sameDraft(edit, baseline) && !saving;

  // dirty 上报宿主（right-rail 切页签确认契约）+ beforeunload（刷新/关闭拦截）
  useEffect(() => {
    dirtyRef.current = dirty;
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

  const collapse = () => {
    if (saving) return;
    // 新建全空 → 无痕取消，零请求
    if (draft && (edit === null || (edit.title.trim() === "" && edit.content.trim() === ""))) {
      dirtyRef.current = false;
      onCancel();
      return;
    }
    void save();
  };

  const save = async () => {
    if (edit === null || saving) return;
    setSaving(true);
    setSaveError(null);
    const payload = {
      title: edit.title.trim(),
      content: edit.content,
      tags: parseTagInput(edit.tagsText),
    };
    try {
      if (draft) {
        const { note: created } = await notesApi.create({ project, ...payload });
        if (!disposedRef.current) dirtyRef.current = false;
        onSaved(created.id, true);
      } else {
        const { note: updated } = await notesApi.update(noteId, payload);
        if (!disposedRef.current) dirtyRef.current = false;
        onSaved(updated.id, false);
      }
    } catch (err) {
      if (!disposedRef.current) {
        setSaveError(apiErrorMessage(err, "notes.actionFailed"));
        setSaving(false);
      }
    }
  };

  const removeNote = async () => {
    if (draft || !window.confirm(t("notes.deleteConfirm", { title: deriveTitle() }))) return;
    try {
      await notesApi.remove(noteId);
      onDeleted();
    } catch (err) {
      setSaveError(apiErrorMessage(err, "notes.actionFailed"));
    }
  };

  function deriveTitle(): string {
    return edit?.title.trim() || (note?.title ?? "");
  }

  const openVersions = async () => {
    if (versionsOpen) {
      setVersionsOpen(false);
      return;
    }
    setVersionsOpen(true);
    if (noteId === null) return;
    setVersions(null);
    setVersionsError(null);
    try {
      const { versions: list } = await notesApi.versions(noteId);
      setVersions(list);
    } catch (err) {
      setVersionsError(apiErrorMessage(err, "notes.actionFailed"));
    }
  };

  const restoreVersion = async (version: NoteVersionInfo) => {
    if (noteId === null) return;
    if (!window.confirm(t("notes.detail.restoreVersionConfirm", { time: relTime(version.savedAt) }))) return;
    try {
      const { note: restored } = await notesApi.restoreVersion(noteId, version.id);
      const restoredDraft = { title: restored.title, content: restored.content, tagsText: tagsToInput(restored.tags) };
      setNote(restored);
      setEdit(restoredDraft);
      setBaseline(restoredDraft);
      setVersionsOpen(false);
      setVersions(null);
    } catch (err) {
      setVersionsError(apiErrorMessage(err, "notes.actionFailed"));
    }
  };

  // 点外部（收起=自动保存）：radix 菜单/弹层渲染在 portal（容器外），忽略之，
  // 否则点「···」菜单项会同时触发收起与菜单动作竞态
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (target.closest("[data-radix-popper-content-wrapper]")) return;
      if (containerRef.current && !containerRef.current.contains(target)) collapse();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // collapse 闭包需随渲染更新（draft/edit/saving 变化），每次渲染重挂监听；
    // 重复 add/removeEventListener 开销可忽略，换 ref 中转无必要
  });

  const inputCls =
    "w-full rounded-lg border bg-background px-3 text-sm outline-none transition-colors focus:ring-1 focus:ring-ring";
  const menuBtn =
    "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";

  return (
    <div
      ref={containerRef}
      data-testid="note-inline-editor"
      data-note-id={noteId ?? "draft"}
      className="flex flex-col gap-2 border-b border-t bg-muted/20 px-3 py-2"
    >
      {loadError !== null ? (
        <div className="flex items-center gap-3 py-2">
          <p className="flex-1 text-sm text-muted-foreground">{t("notes.loadFailed", { message: loadError })}</p>
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              setRetrySeq((n) => n + 1);
            }}
            className="rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            {t("notes.retry")}
          </button>
        </div>
      ) : edit === null ? (
        <p className="py-2 text-sm text-muted-foreground" data-testid="note-editor-loading">
          {t("notes.loading")}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            <input
              value={edit.title}
              onChange={(e) => setEdit({ ...edit, title: e.target.value })}
              placeholder={t("notes.edit.titlePlaceholder")}
              aria-label={t("notes.edit.titleAria")}
              data-testid="note-title-input"
              className={`h-8 min-w-0 flex-1 ${inputCls}`}
            />
            {!draft && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" data-testid="note-row-more-btn" aria-label={t("notes.detail.moreActions")} className={menuBtn}>
                    <MoreVertical className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                  <DropdownMenuItem onSelect={() => void openVersions()} data-testid="note-menu-versions">
                    <History className="mr-2 size-4" />
                    {t("notes.detail.versionHistory")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    data-testid="note-menu-delete"
                    onSelect={() => void removeNote()}
                  >
                    <Trash2 className="mr-2 size-4" />
                    {t("notes.detail.deleteNote")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button
              type="button"
              onClick={collapse}
              aria-label={t("notes.view.collapseEditor")}
              data-testid="note-collapse-btn"
              className={menuBtn}
            >
              <ChevronUp className="size-4" />
            </button>
          </div>
          <textarea
            value={edit.content}
            onChange={(e) => setEdit({ ...edit, content: e.target.value })}
            placeholder={t("notes.edit.contentPlaceholder")}
            aria-label={t("notes.edit.contentAria")}
            data-testid="note-content-input"
            className={`${inputCls} min-h-28 resize-y p-2.5 font-mono text-xs leading-relaxed`}
          />
          <input
            value={edit.tagsText}
            onChange={(e) => setEdit({ ...edit, tagsText: e.target.value })}
            placeholder={t("notes.edit.tagsPlaceholder")}
            aria-label={t("notes.edit.tagsAria")}
            data-testid="note-tags-input"
            className={`h-8 ${inputCls}`}
          />
          {versionsOpen && (
            <VersionPanel versions={versions} error={versionsError} onRestore={(v) => void restoreVersion(v)} onClose={() => setVersionsOpen(false)} />
          )}
          {saveError !== null && (
            <p className="text-xs text-destructive" role="alert" data-testid="note-save-error">
              {saveError}
            </p>
          )}
          {saving && (
            <p className="text-xs text-muted-foreground" data-testid="note-saving">
              {t("notes.view.saving")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
