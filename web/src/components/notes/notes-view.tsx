// 笔记页签主视图（右栏窄栏版，docs08-r3 任务5）：右栏 384 宽单栏两级导航——
// 列表态（标题 + 标签徽标 + 相对时间）/ 回收站 / 笔记屏（note-detail，编辑与
// 预览切换在其头部）一屏只承载一级。切换入口收在面板头部：列表态头部 = 新建 +
// 次级菜单（回收站）；回收站头部 = 返回；笔记屏头部见 note-detail。
// 数据流不变：全量列表（chips 数据源）+ 激活标签单独 GET ?tag=（计划钉死走服务端过滤），
// 响应落地后按当前激活 chip 再过滤一次（filterNotesByTag 防竞态展示错行）。
// 空态各自明确提示：加载失败 / 暂无笔记 / 标签无匹配。
// key={project} 重挂重置全部选中/过滤/回收站态；重取（onChanged）保留旧数据不闪 loading。
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, MoreVertical, NotebookPen, StickyNote, Trash2 } from "lucide-react";
import { useUiStore } from "@/stores/ui";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NoteDetail } from "./note-detail";
import { notesApi, type NoteListItem } from "./notes-api";
import { TrashList } from "./notes-trash";
import { CenteredHint, EmptyState } from "./notes-empty";
import { collectTags, filterNotesByTag, relTime } from "./notes-logic";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; notes: NoteListItem[] };

const CHIP_CLASS = (active: boolean) =>
  `min-h-9 rounded-full border px-2.5 text-xs transition-colors ${
    active ? "border-transparent bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted/50"
  }`;

const HEADER_BTN =
  "flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";

const ICON_BTN =
  "flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";

function NotesViewInner({ project, dirtyRef }: { project: string; dirtyRef: { current: boolean } }) {
  const showToast = useUiStore((s) => s.showToast);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [reloadSeq, setReloadSeq] = useState(0);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [trashMode, setTrashMode] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [tagNotes, setTagNotes] = useState<NoteListItem[] | null>(null);
  const tagReqRef = useRef(0);

  // 主列表加载：初始/重挂即 loading 态，重取（onChanged）不闪 loading（保留旧数据直至新数据落地）
  useEffect(() => {
    let stale = false;
    notesApi
      .list(project)
      .then((r) => {
        if (!stale) setState({ phase: "ready", notes: r.notes });
      })
      .catch((err: unknown) => {
        if (!stale) setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      stale = true;
    };
  }, [project, reloadSeq]);

  const onChanged = useCallback(() => {
    setReloadSeq((n) => n + 1);
  }, []);

  const t = useT();
  const selectTag = async (tag: string | null) => {
    setActiveTag(tag);
    if (tag === null) {
      setTagNotes(null);
      return;
    }
    const seq = ++tagReqRef.current;
    try {
      const { notes } = await notesApi.list(project, { tag });
      if (tagReqRef.current === seq) setTagNotes(notes);
    } catch (err) {
      if (tagReqRef.current === seq) setTagNotes([]);
      showToast(apiErrorMessage(err, "notes.actionFailed"), "error");
    }
  };

  const removeNote = async (note: NoteListItem) => {
    if (!window.confirm(t("notes.deleteConfirm", { title: note.title }))) return;
    try {
      await notesApi.remove(note.id);
      if (selectedNoteId === note.id) setSelectedNoteId(null);
      onChanged();
    } catch (err) {
      showToast(apiErrorMessage(err, "notes.actionFailed"), "error");
    }
  };

  const restoreTrashed = async (note: NoteListItem) => {
    try {
      await notesApi.restore(note.id);
      showToast(t("notes.view.restoredToast", { title: note.title }));
      onChanged();
    } catch (err) {
      showToast(apiErrorMessage(err, "notes.actionFailed"), "error");
    }
  };

  const purgeTrashed = async (note: NoteListItem) => {
    if (!window.confirm(t("notes.view.purgeConfirm", { title: note.title }))) return;
    try {
      await notesApi.remove(note.id, true);
      showToast(t("notes.view.purgedToast", { title: note.title }));
      onChanged();
    } catch (err) {
      showToast(apiErrorMessage(err, "notes.actionFailed"), "error");
    }
  };

  const retry = () => {
    setState({ phase: "loading" });
    setReloadSeq((n) => n + 1);
  };

  const ready = state.phase === "ready";
  const allNotes = ready ? state.notes : [];
  const tags = ready ? collectTags(allNotes) : [];
  const visibleNotes = activeTag === null ? allNotes : filterNotesByTag(tagNotes ?? [], activeTag);

  // 笔记屏（两级导航第二级）：整栏替换，头部与编辑/预览切换由 NoteDetail 渲染；
  // dirty 经 dirtyRef 透传（右栏切页签 guard 契约，容器在 right-rail）
  if (creating || selectedNoteId !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="notes-view">
        <NoteDetail
          key={creating ? "draft" : selectedNoteId}
          project={project}
          noteId={selectedNoteId}
          dirtyRef={dirtyRef}
          onChanged={onChanged}
          onCreated={(id) => {
            setCreating(false);
            setSelectedNoteId(id);
          }}
          onClose={() => {
            setCreating(false);
            setSelectedNoteId(null);
          }}
        />
      </div>
    );
  }

  // 回收站屏：独占整栏（恢复/彻底删除行内完成，无详情栏）
  if (trashMode) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="notes-view">
        <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
          <button type="button" onClick={() => setTrashMode(false)} aria-label={t("notes.backToList")} data-testid="note-trash-back" className={ICON_BTN}>
            <ArrowLeft className="size-4" />
          </button>
          <span className="text-sm font-medium">{t("notes.trashLabel")}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TrashList key={reloadSeq} project={project} reloadSeq={reloadSeq} onRestore={(n) => void restoreTrashed(n)} onPurge={(n) => void purgeTrashed(n)} />
        </div>
      </div>
    );
  }

  // 列表态（面板头部：标题 + 计数 + 新建 + 次级菜单）
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="notes-view">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="text-sm font-medium">{t("notes.panelTitle")}</span>
        {ready && <span className="text-xs text-muted-foreground">{t("notes.view.count", { n: visibleNotes.length })}</span>}
        <div className="ml-auto flex items-center gap-1">
          {ready && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              data-testid="note-new-btn"
              className={HEADER_BTN}
            >
              <NotebookPen className="size-4" />
              {t("notes.newNote")}
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" data-testid="note-more-btn" aria-label={t("notes.view.moreActions")} className={ICON_BTN}>
                <MoreVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onSelect={() => setTrashMode(true)} data-testid="note-menu-trash">
                <Trash2 className="mr-2 size-4" />
                {t("notes.trashLabel")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {state.phase === "loading" ? (
        <CenteredHint text={t("notes.loading")} />
      ) : state.phase === "error" ? (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <p className="text-sm text-muted-foreground">{t("notes.loadFailed", { message: state.message })}</p>
          <button type="button" onClick={retry} className="rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-muted">
            {t("notes.retry")}
          </button>
        </div>
      ) : ready && allNotes.length === 0 && activeTag === null ? (
        <EmptyState icon={<StickyNote className="size-10 text-muted-foreground/40" />} title={t("notes.view.emptyTitle")} hint={t("notes.view.emptyHint")}>
          <button type="button" onClick={() => setCreating(true)} data-testid="note-empty-new-btn" className="min-h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90">
            {t("notes.newNote")}
          </button>
        </EmptyState>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap gap-1.5 border-b px-3 py-2" data-testid="notes-tag-chips">
            <button type="button" onClick={() => void selectTag(null)} aria-pressed={activeTag === null} data-testid="note-tag-chip-all" className={CHIP_CLASS(activeTag === null)}>
              {t("notes.view.filterAll")}
            </button>
            {tags.map((tag) => (
              <button key={tag} type="button" onClick={() => void selectTag(activeTag === tag ? null : tag)} aria-pressed={activeTag === tag} data-testid={`note-tag-chip-${tag}`} className={CHIP_CLASS(activeTag === tag)}>
                {tag}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="notes-list">
            {visibleNotes.length === 0 ? (
              <CenteredHint text={activeTag === null ? t("notes.view.noNotes") : t("notes.view.noTagMatch")} />
            ) : (
              visibleNotes.map((note) => (
                <div key={note.id} className="flex min-h-11 items-center gap-2 pl-3 pr-1.5 transition-colors hover:bg-muted/40">
                  <button
                    type="button"
                    onClick={() => setSelectedNoteId(note.id)}
                    className="flex min-h-11 min-w-0 flex-1 flex-col justify-center py-1 text-left"
                    data-testid="note-item"
                  >
                    <span className="truncate text-sm">{note.title}</span>
                    <span className="flex items-center gap-1.5">
                      {note.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
                          {tag}
                        </span>
                      ))}
                      <span className="text-[10px] text-muted-foreground">{relTime(note.updatedAt)}</span>
                    </span>
                  </button>
                  <button type="button" onClick={() => void removeNote(note)} aria-label={t("notes.view.deleteItem", { title: note.title })} className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-destructive">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function NotesView({ dirtyRef }: { dirtyRef: { current: boolean } }) {
  const project = useUiStore((s) => s.currentProject);
  const t = useT();
  if (!project) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="notes-view">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <span className="text-sm font-medium">{t("notes.panelTitle")}</span>
        </div>
        <CenteredHint text={t("notes.addProjectFirst")} />
      </div>
    );
  }
  // key=project：项目切换整体重挂，选中/草稿/回收站/标签态全部归零
  return <NotesViewInner key={project} project={project} dirtyRef={dirtyRef} />;
}
