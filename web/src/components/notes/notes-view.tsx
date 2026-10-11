// 笔记页签主视图（todo 15）：列表（标题 + 标签徽标 + 相对时间）/ 标签过滤 chips /
// 回收站（恢复 + 彻底删除）/ 新建 / 手机两级导航。
// 数据流：全量列表（chips 数据源）+ 激活标签单独 GET ?tag=（计划钉死走服务端过滤），
// 响应落地后按当前激活 chip 再过滤一次（filterNotesByTag 防竞态展示错行）。
// 空态对齐 changes-view 模式：无项目 / 加载失败 / 暂无笔记 / 标签无匹配各自明确提示。
// 手机两级导航：单 state（selectedNoteId/creating）+ 纯 CSS 断点切换（lg 以上双栏常驻）。
// key={project} 重挂重置全部选中/过滤/回收站态；重取（onChanged）保留旧数据不闪 loading。
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, FileText, NotebookPen, StickyNote, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
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
  `min-h-7 rounded-full border px-2.5 text-xs transition-colors ${
    active ? "border-transparent bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted/50"
  }`;

const TOOLBAR_BTN =
  "flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors hover:bg-muted/50 lg:min-h-9";

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
      showToast(err instanceof ApiError ? err.message : String(err), "error");
    }
  };

  const removeNote = async (note: NoteListItem) => {
    if (!window.confirm(`删除笔记「${note.title}」？可在回收站恢复。`)) return;
    try {
      await notesApi.remove(note.id);
      if (selectedNoteId === note.id) setSelectedNoteId(null);
      onChanged();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : String(err), "error");
    }
  };

  const restoreTrashed = async (note: NoteListItem) => {
    try {
      await notesApi.restore(note.id);
      showToast(`已恢复「${note.title}」`);
      onChanged();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : String(err), "error");
    }
  };

  const purgeTrashed = async (note: NoteListItem) => {
    if (!window.confirm(`彻底删除「${note.title}」？此操作不可恢复（含全部历史版本）。`)) return;
    try {
      await notesApi.remove(note.id, true);
      showToast(`已彻底删除「${note.title}」`);
      onChanged();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : String(err), "error");
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
  const detailOpen = creating || selectedNoteId !== null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="notes-view">
      {/* 工具条：标题 + 计数 + 新建 + 回收站入口 */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="text-sm font-medium">笔记</span>
        {ready && !trashMode && <span className="text-xs text-muted-foreground">{visibleNotes.length} 条</span>}
        <div className="ml-auto flex items-center gap-1">
          {!trashMode && ready && (
            <button
              type="button"
              onClick={() => {
                setCreating(true);
                setSelectedNoteId(null);
              }}
              data-testid="note-new-btn"
              className={`${TOOLBAR_BTN} text-muted-foreground hover:text-foreground`}
            >
              <NotebookPen className="size-3.5" />
              新建笔记
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setTrashMode((m) => !m);
              setCreating(false);
              setSelectedNoteId(null);
            }}
            data-testid="note-trash-btn"
            aria-pressed={trashMode}
            className={`${TOOLBAR_BTN} text-muted-foreground hover:text-foreground`}
          >
            {trashMode ? <ArrowLeft className="size-3.5" /> : <Trash2 className="size-3.5" />}
            {trashMode ? "返回笔记" : "回收站"}
          </button>
        </div>
      </div>

      {state.phase === "loading" ? (
        <CenteredHint text="加载笔记…" />
      ) : state.phase === "error" ? (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <p className="text-sm text-muted-foreground">笔记加载失败：{state.message}</p>
          <button type="button" onClick={retry} className="rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-muted">
            重试
          </button>
        </div>
      ) : trashMode ? (
        /* 回收站：独占列表区（恢复/彻底删除行内完成，无详情栏） */
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TrashList key={reloadSeq} project={project} reloadSeq={reloadSeq} onRestore={(n) => void restoreTrashed(n)} onPurge={(n) => void purgeTrashed(n)} />
        </div>
      ) : ready && allNotes.length === 0 && activeTag === null && !detailOpen ? (
        <EmptyState icon={<StickyNote className="size-10 text-muted-foreground/40" />} title="暂无笔记" hint="为当前项目记录第一篇笔记">
          <button type="button" onClick={() => setCreating(true)} data-testid="note-empty-new-btn" className="min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 lg:min-h-9">
            新建笔记
          </button>
        </EmptyState>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[20rem_minmax(0,1fr)]">
          {/* 列表栏：手机未选中时独占；lg 以上常驻左栏 */}
          <aside className={`flex min-h-0 flex-col lg:block lg:border-r ${detailOpen ? "hidden" : ""}`} data-testid="notes-list">
            <div className="flex shrink-0 flex-wrap gap-1.5 border-b px-3 py-2" data-testid="notes-tag-chips">
              <button type="button" onClick={() => void selectTag(null)} aria-pressed={activeTag === null} data-testid="note-tag-chip-all" className={CHIP_CLASS(activeTag === null)}>
                全部
              </button>
              {tags.map((tag) => (
                <button key={tag} type="button" onClick={() => void selectTag(activeTag === tag ? null : tag)} aria-pressed={activeTag === tag} data-testid={`note-tag-chip-${tag}`} className={CHIP_CLASS(activeTag === tag)}>
                  {tag}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {visibleNotes.length === 0 ? (
                <CenteredHint text={activeTag === null ? "没有笔记" : "没有匹配该标签的笔记"} />
              ) : (
                visibleNotes.map((note) => (
                  <div key={note.id} className={`flex min-h-11 items-center gap-2 pl-3 pr-1.5 transition-colors ${selectedNoteId === note.id ? "bg-muted/60" : "hover:bg-muted/40"}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setCreating(false);
                        setSelectedNoteId(note.id);
                      }}
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
                    <button type="button" onClick={() => void removeNote(note)} aria-label={`删除 ${note.title}`} className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-destructive lg:size-8">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>

          {/* 详情栏：手机选中后独占；lg 以上常驻右栏；key 保证笔记切换整体重挂 */}
          <section className={`min-h-0 overflow-hidden ${detailOpen ? "" : "hidden lg:block"}`} data-testid="note-detail-pane">
            {creating || selectedNoteId !== null ? (
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
            ) : (
              <EmptyState icon={<FileText className="size-10 text-muted-foreground/40" />} title="选择一篇笔记" hint="从左侧选择笔记查看，或新建一篇" />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export function NotesView({ dirtyRef }: { dirtyRef: { current: boolean } }) {
  const project = useUiStore((s) => s.currentProject);
  if (!project) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="notes-view">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <span className="text-sm font-medium">笔记</span>
        </div>
        <CenteredHint text="请先添加项目" />
      </div>
    );
  }
  // key=project：项目切换整体重挂，选中/草稿/回收站/标签态全部归零
  return <NotesViewInner key={project} project={project} dirtyRef={dirtyRef} />;
}
