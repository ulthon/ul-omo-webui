// 笔记页签主视图（右栏窄栏版；2026-11-07 平铺直编批）：列表即全文平铺卡片流
//（note-flat-card，标题+content 全文直出，无折叠无摘要），单击卡片任意处就地展开
// 行内编辑器（note-inline-editor，initial 携列表全文免二次 GET），保存后留原位收起。
// 拖拽手柄排序：全量视图（无标签过滤）可拖，乐观重排本地 + PUT /api/notes/reorder
// 落库，失败 toast 回滚重取；标签过滤视图禁拖（子序列重排语义不明）。
// 新建 = 列表顶插空行编辑器，全空收起零请求无痕取消。行内动作钮：复制全文 /
// 复制标题+内容 / 导出 .md / 删除；「···」菜单保留回收站。回收站/标签 chips 不动。
// key={project} 重挂重置全部选中/过滤/回收站态；重取（onChanged）保留旧数据不闪 loading。
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, GripVertical, MoreVertical, NotebookPen, StickyNote, Trash2 } from "lucide-react";
import { useUiStore } from "@/stores/ui";
import { useActiveProject } from "@/stores/sessions";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NoteInlineEditor } from "./note-inline-editor";
import { NoteFlatCard } from "./note-flat-card";
import { notesApi, type NoteData, type NoteListItem } from "./notes-api";
import { TrashList } from "./notes-trash";
import { CenteredHint, EmptyState } from "./notes-empty";
import { collectTags, deriveDisplayTitle, filterNotesByTag } from "./notes-logic";

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

/** 列表项 → 编辑器 initial（列表已带全文，免详情 GET 直进编辑） */
function toInitialData(note: NoteListItem, project: string): NoteData {
  return {
    id: note.id,
    project,
    title: note.title,
    content: note.content,
    tags: note.tags,
    deletedAt: note.deletedAt,
    createdAt: null,
    updatedAt: note.updatedAt,
  };
}

function NotesViewInner({ project, dirtyRef }: { project: string; dirtyRef: { current: boolean } }) {
  const showToast = useUiStore((s) => s.showToast);
  const pushGlobalError = useUiStore((s) => s.pushGlobalError);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [reloadSeq, setReloadSeq] = useState(0);
  /** 就地展开的行内编辑器：存量笔记 id 或 "draft"（列表顶新建空行）；null = 全部收起 */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [trashMode, setTrashMode] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [tagNotes, setTagNotes] = useState<NoteListItem[] | null>(null);
  /** 拖拽排序（HTML5 DnD，同 session-list 模式）：拖起 id 与悬停目标 id */
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
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
    setExpandedId(null);
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
      pushGlobalError(apiErrorMessage(err, "notes.actionFailed"));
    }
  };

  /** 拖拽落点提交：乐观重排本地全量列表 + 整序落库；失败 toast 并重取（服务端序为准） */
  const commitReorder = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId || state.phase !== "ready") return;
      const notes = [...state.notes];
      const from = notes.findIndex((n) => n.id === fromId);
      const to = notes.findIndex((n) => n.id === toId);
      if (from < 0 || to < 0) return;
      const [moved] = notes.splice(from, 1);
      notes.splice(to, 0, moved);
      setState({ phase: "ready", notes });
      notesApi
        .reorder(project, notes.map((n) => n.id))
        .catch((err: unknown) => {
          pushGlobalError(apiErrorMessage(err, "notes.actionFailed"));
          onChanged();
        });
    },
    [state, project, showToast, onChanged],
  );

  const removeNote = async (note: NoteListItem) => {
    if (!window.confirm(t("notes.deleteConfirm", { title: note.title }))) return;
    try {
      await notesApi.remove(note.id);
      if (expandedId === note.id) setExpandedId(null);
      onChanged();
    } catch (err) {
      pushGlobalError(apiErrorMessage(err, "notes.actionFailed"));
    }
  };

  const restoreTrashed = async (note: NoteListItem) => {
    try {
      await notesApi.restore(note.id);
      showToast(t("notes.view.restoredToast", { title: note.title }));
      onChanged();
    } catch (err) {
      pushGlobalError(apiErrorMessage(err, "notes.actionFailed"));
    }
  };

  const purgeTrashed = async (note: NoteListItem) => {
    if (!window.confirm(t("notes.view.purgeConfirm", { title: note.title }))) return;
    try {
      await notesApi.remove(note.id, true);
      showToast(t("notes.view.purgedToast", { title: note.title }));
      onChanged();
    } catch (err) {
      pushGlobalError(apiErrorMessage(err, "notes.actionFailed"));
    }
  };

  const retry = () => {
    setState({ phase: "loading" });
    setReloadSeq((n) => n + 1);
  };

  const startNew = () => {
    setExpandedId("draft");
  };

  const ready = state.phase === "ready";
  const allNotes = ready ? state.notes : [];
  const tags = ready ? collectTags(allNotes) : [];
  const visibleNotes = activeTag === null ? allNotes : filterNotesByTag(tagNotes ?? [], activeTag);
  // 拖拽仅全量视图开放（过滤子序列重排语义不明）；拖起/展开中禁其余手柄防抢事件
  const dragEnabled = activeTag === null;

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

  // 列表态（面板头部：标题 + 计数 + 新建 + 次级菜单）；行内编辑就地展开，无第二级导航
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="notes-view">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="text-sm font-medium">{t("notes.panelTitle")}</span>
        {ready && <span className="text-xs text-muted-foreground">{t("notes.view.count", { n: visibleNotes.length })}</span>}
        <div className="ml-auto flex items-center gap-1">
          {ready && (
            <button
              type="button"
              onClick={startNew}
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
      ) : ready && allNotes.length === 0 && activeTag === null && expandedId !== "draft" ? (
        <EmptyState icon={<StickyNote className="size-10 text-muted-foreground/40" />} title={t("notes.view.emptyTitle")} hint={t("notes.view.emptyHint")}>
          <button type="button" onClick={startNew} data-testid="note-empty-new-btn" className="min-h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90">
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
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2" data-testid="notes-list">
            {expandedId === "draft" && (
              <NoteInlineEditor
                noteId={null}
                project={project}
                dirtyRef={dirtyRef}
                onSaved={() => {
                  setExpandedId(null);
                  onChanged();
                }}
                onCancel={() => setExpandedId(null)}
                onDeleted={() => {
                  setExpandedId(null);
                  onChanged();
                }}
              />
            )}
            {visibleNotes.length === 0 && expandedId !== "draft" ? (
              <CenteredHint text={activeTag === null ? t("notes.view.noNotes") : t("notes.view.noTagMatch")} />
            ) : (
              visibleNotes.map((note) =>
                expandedId === note.id ? (
                  <NoteInlineEditor
                    key={note.id}
                    noteId={note.id}
                    project={project}
                    dirtyRef={dirtyRef}
                    initial={toInitialData(note, project)}
                    onSaved={() => {
                      setExpandedId(null);
                      onChanged();
                    }}
                    onCancel={() => setExpandedId(null)}
                    onDeleted={() => {
                      setExpandedId(null);
                      onChanged();
                    }}
                  />
                ) : (
                  <div
                    key={note.id}
                    onDragOver={
                      dragEnabled && dragId !== null && dragId !== note.id
                        ? (e) => {
                            e.preventDefault();
                            setOverId(note.id);
                          }
                        : undefined
                    }
                    onDrop={
                      dragEnabled && dragId !== null && dragId !== note.id
                        ? (e) => {
                            e.preventDefault();
                            const from = dragId;
                            setDragId(null);
                            setOverId(null);
                            commitReorder(from, note.id);
                          }
                        : undefined
                    }
                    className={overId === note.id && dragId !== null && dragId !== note.id ? "rounded-lg ring-1 ring-primary/60" : undefined}
                  >
                    <NoteFlatCard
                      note={note}
                      onClick={() => setExpandedId(note.id)}
                      footerExtra={
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeNote(note);
                          }}
                          aria-label={t("notes.view.deleteItem", { title: deriveDisplayTitle(note.title, note.preview, t("notes.view.untitled")) })}
                          data-testid={`note-delete-${note.id}`}
                          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      }
                      dragHandle={
                        dragEnabled ? (
                          <span
                            draggable={dragId === null}
                            onDragStart={(e) => {
                              setDragId(note.id);
                              e.dataTransfer.effectAllowed = "move";
                              try {
                                e.dataTransfer.setData("text/plain", note.id);
                              } catch {
                                /* IE 型 setData 异常不阻断拖拽本体 */
                              }
                            }}
                            onDragEnd={() => {
                              setDragId(null);
                              setOverId(null);
                            }}
                            aria-label={t("notes.view.dragSort")}
                            title={t("notes.view.dragSort")}
                            data-testid={`note-drag-handle-${note.id}`}
                            className="mt-px flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-foreground"
                          >
                            <GripVertical className="size-3.5" />
                          </span>
                        ) : undefined
                      }
                    />
                  </div>
                ),
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function NotesView({ dirtyRef }: { dirtyRef: { current: boolean } }) {
  // 项目源：选中会话派生（会话根架构 W1 t3）；未选中/未命中为 null 走空态，key 仍随项目整体重挂
  const project = useActiveProject();
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
