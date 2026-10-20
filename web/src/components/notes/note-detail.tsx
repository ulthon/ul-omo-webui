// 笔记详情（右栏窄栏版，docs08-r3 任务5）：预览（Markdown 渲染，复用 chat/markdown
// 通用组件）/ 编辑（标题 + content + 标签逗号分隔）两态，切换入口在面板头部；
// 历史版本与删除收进头部次级菜单（仅预览态）。noteId=null 为新建草稿态——直接进
// 编辑态，保存时 POST 创建，取消即无痕退出（草稿无预览可回，头部无切换入口）。
// dirty 基线：存量笔记由 startEdit 落定；草稿视为空稿 DRAFT_BASELINE——修复任务3
// 移交缺陷（原实现草稿 baseline 恒 null 使 dirty 恒 false，未保存草稿切页签/刷新
// 都不弹确认），草稿一经输入即 dirty。dirty 经 dirtyRef 上报宿主（右栏切页签确认，
// 契约在 right-rail notesDirtyRef），并在 dirty 时挂 beforeunload 拦截刷新/关闭。
// 宿主以 key={noteId} 挂载本组件：切换笔记整体重挂，本地态随挂载自然重置
// （effect 只发请求不同步 setState——oxlint set-state-in-effect 消警模式，同 todo 20）。
import { useEffect, useState } from "react";
import { ArrowLeft, Eye, History, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { Markdown } from "@/components/chat/markdown";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

/** 草稿 dirty 基线：空稿。草稿输入任何内容即偏离基线 → dirty */
const DRAFT_BASELINE: EditDraft = { title: "", content: "", tagsText: "" };

const BTN_CLASS = "flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";

const ICON_BTN = "flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";

export function NoteDetail({ project, noteId, dirtyRef, onChanged, onCreated, onClose }: NoteDetailProps) {
  const t = useT();
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
        if (!stale) setLoadError(apiErrorMessage(err, "notes.loadFailedBrief"));
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

  // dirty 判定：编辑态且当前值偏离基线。草稿基线恒为空稿（见 DRAFT_BASELINE 注释），
  // 存量笔记基线由 startEdit 落定（edit/baseline 同步设置，null 守卫仅为类型收窄）
  const effectiveBaseline = draft ? DRAFT_BASELINE : baseline;
  const dirty = mode === "edit" && edit !== null && effectiveBaseline !== null && !sameDraft(edit, effectiveBaseline);

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
    if (dirty && !window.confirm(t("notes.detail.discardConfirm"))) return;
    if (draft) {
      onClose();
      return;
    }
    setEdit(null);
    setBaseline(null);
    setSaveError(null);
    setMode("view");
  };

  // 头部返回：编辑态先过 dirty 确认（草稿→无痕退出列表，存量→回预览）；预览态直接回列表
  const back = () => {
    if (draft || mode === "edit") {
      exitEdit();
      return;
    }
    onClose();
  };

  const save = async () => {
    if (!edit || saving) return;
    const title = edit.title.trim();
    if (title.length === 0) {
      setSaveError(t("notes.detail.titleRequired"));
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
      setSaveError(apiErrorMessage(err, "notes.actionFailed"));
    } finally {
      setSaving(false);
    }
  };

  const removeNote = async () => {
    if (noteId === null || !window.confirm(t("notes.deleteConfirm", { title: note?.title ?? "" }))) return;
    try {
      await notesApi.remove(noteId);
      onChanged();
      onClose();
    } catch (err) {
      setSaveError(apiErrorMessage(err, "notes.actionFailed"));
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
      setVersionsError(apiErrorMessage(err, "notes.actionFailed"));
    }
  };

  const restoreVersion = async (version: NoteVersionInfo) => {
    if (noteId === null) return;
    if (!window.confirm(t("notes.detail.restoreVersionConfirm", { time: relTime(version.savedAt) }))) return;
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
      setSaveError(apiErrorMessage(err, "notes.actionFailed"));
    }
  };

  const editForm = (
    <NoteEditForm
      edit={edit ?? DRAFT_BASELINE}
      saving={saving}
      saveError={saveError}
      onChange={setEdit}
      onSave={save}
      onCancel={exitEdit}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="note-detail">
      {/* 面板头部：返回 + 标题 + 编辑/预览切换 + 次级菜单（历史版本/删除，仅预览态） */}
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5" data-testid="note-detail-header">
        <button type="button" onClick={back} aria-label={t("notes.backToList")} data-testid="note-back-btn" className={ICON_BTN}>
          <ArrowLeft className="size-4" />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="note-detail-title">
          {draft ? t("notes.newNote") : (note?.title ?? "")}
        </h2>
        {!draft && mode === "view" && (
          <>
            <button type="button" onClick={startEdit} data-testid="note-mode-toggle" className={BTN_CLASS}>
              <Pencil className="size-3.5" />
              {t("notes.detail.edit")}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" data-testid="note-more-btn" aria-label={t("notes.detail.moreActions")} className={ICON_BTN}>
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
          </>
        )}
        {!draft && mode === "edit" && (
          <button type="button" onClick={exitEdit} data-testid="note-mode-toggle" className={BTN_CLASS}>
            <Eye className="size-3.5" />
            {t("notes.detail.preview")}
          </button>
        )}
      </div>

      {draft || (mode === "edit" && edit !== null) ? (
        editForm
      ) : loadError !== null ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground">{t("notes.loadFailed", { message: loadError })}</p>
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
      ) : note === null ? (
        <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{t("notes.loading")}</div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
