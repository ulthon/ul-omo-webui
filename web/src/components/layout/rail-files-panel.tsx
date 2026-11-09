// 右栏"文件"页签面板（files-panel-oc 任务 1；#36 响应式改版）：窄容器（≤600，实测
// ResizeObserver）保持纵向堆叠（树/列表/预览上下三层）；>600 切 OC 考据横向形态——
// 左树固定 14rem + 右侧内容区，601-899 列表/预览上下分，≥900 三列横排。能力与独立
// 文件页
// （pages/files.tsx）对齐——树浏览 + 列表 + 预览 + 在线编辑（CodeMirror + 乐观锁）
// + 上传（逐个排队 + 进度）+ 删除 + 重命名/移动，冲突三选/保存冲突弹窗同源复用
// fs-dialogs。窄栏简化：右键菜单收进列表行内图标钮（能力不缺），排序固定目录
// 优先 + 名称升序；项目来源 = 当前会话派生项目（useActiveProject），无会话时
// 回退项目表首个（与 files.tsx 同判据），不做项目切换器。
// 复用件（只读 import）：file-tree/file-preview、files/file-editor、files/fs-dialogs、
// lib/api.ts fs 方法；不改右栏拖宽机制，不加服务端路由。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { HTMLAttributes } from "react";
import {
  ArrowRightLeft,
  ChevronRight,
  Download,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { api, ApiError, FsUploadConflictError } from "@/lib/api";
import type { FsFileResponse, FsTreeEntry } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { useUiStore } from "@/stores/ui";
import { useActiveProject } from "@/stores/sessions";
import { FileTree } from "@/components/file-tree/file-tree";
import { FilePreview } from "@/components/file-tree/file-preview";
import { FileEditor } from "@/components/files/file-editor";
import { editBlockReasonKey, isEditableFile } from "@/components/files/edit-eligibility";
import { DeleteConfirmDialog, FsConflictDialog } from "@/components/files/fs-dialogs";
import {
  RAIL_FILES_LIST_DEFAULT,
  RAIL_FILES_LIST_MAX,
  RAIL_FILES_LIST_MIN,
  RAIL_FILES_TREE_DEFAULT,
  RAIL_FILES_TREE_MAX,
  RAIL_FILES_TREE_MIN,
  clampRailFilesListWidth,
  clampRailFilesTreeWidth,
  readRailFilesListWidthPreference,
  readRailFilesTreeWidthPreference,
  writeRailFilesListWidthPreference,
  writeRailFilesTreeWidthPreference,
} from "@/components/layout/rail-files-resize";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type OpDialogKind = "newFile" | "newDir" | "rename" | "move";

/** 打开中的操作对话框（value 为目标相对路径输入框当前值） */
interface OpDialog {
  kind: OpDialogKind;
  /** rename/move 的源路径；新建类为 null */
  from: string | null;
  value: string;
}

/** 上传队列单项（逐个排队，progress 为字节） */
interface UploadItem {
  id: number;
  name: string;
  loaded: number;
  total: number;
  status: "uploading" | "done" | "failed" | "canceled";
}

/** 删除确认目标（目录时弹窗内拉直接子条目数） */
interface DeleteConfirmState {
  path: string;
  isDir: boolean;
}

/** 冲突三选状态：move 409 与 upload 409（形状与 files.tsx 一致） */
interface ConflictState {
  kind: "move" | "upload";
  from: string | null;
  target: string;
  file: File | null;
  uploadId: number | null;
  existing: { path?: string; kind?: string; size?: number } | null;
}

/** fs/tree 条目 + 服务端增补的 size/mtime（同 files.tsx 本地扩展） */
interface ListEntry extends FsTreeEntry {
  size: number | null;
  mtime: number | null;
}

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let i = -1;
  do {
    value /= 1024;
    i += 1;
  } while (value >= 1024 && i < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

const TYPE_KEY: Record<FsTreeEntry["type"], "files.type.directory" | "files.type.file" | "files.type.symlink" | "files.type.other"> = {
  directory: "files.type.directory",
  file: "files.type.file",
  symlink: "files.type.symlink",
  other: "files.type.other",
};

const DIALOG_TITLE_KEY: Record<OpDialogKind, "files.dialog.newFileTitle" | "files.dialog.newDirTitle" | "files.dialog.renameTitle" | "files.dialog.moveTitle"> = {
  newFile: "files.dialog.newFileTitle",
  newDir: "files.dialog.newDirTitle",
  rename: "files.dialog.renameTitle",
  move: "files.dialog.moveTitle",
};

/** 目录恒优先 + 名称升序（窄栏固定序，不做排序切换） */
function compareEntries(a: ListEntry, b: ListEntry): number {
  const dirDelta = Number(b.type === "directory") - Number(a.type === "directory");
  if (dirDelta !== 0) return dirDelta;
  return a.name.localeCompare(b.name);
}

export type FilesRailLayout = "stacked" | "split" | "columns";

/** 纯函数：容器宽 → 布局档（#36）：≤600 纵向堆叠（树/列表/预览上下三层，原形态）；
 *  601-899 两栏（OC 考据形态：左树固定 14rem + 右侧内容区，列表/预览上下分）；
 *  ≥900 三列横排（树 | 列表 | 预览）。容器宽由 ResizeObserver 实测驱动。 */
export function filesRailLayout(width: number): FilesRailLayout {
  if (width <= 600) return "stacked";
  if (width < 900) return "split";
  return "columns";
}

export function RailFilesPanel() {
  const t = useT();
  const pushGlobalError = useUiStore((s) => s.pushGlobalError);
  const storeProjects = useUiStore((s) => s.projects);
  const setStoreProjects = useUiStore((s) => s.setProjects);
  const activeProject = useActiveProject();

  // 项目表：读 bootstrap 填充的 ui store；空时自拉一次兜底（写回 store）
  const projects = storeProjects;
  useEffect(() => {
    if (projects.length > 0) return;
    let cancelled = false;
    api
      .listProjects()
      .then((res) => {
        if (!cancelled) setStoreProjects(res.projects);
      })
      .catch(() => {
        // 拉取失败静默：无项目时面板显示空态
      });
    return () => {
      cancelled = true;
    };
  }, [projects.length, setStoreProjects]);

  // 生效项目：选中会话派生的活跃项目在表内优先，否则列表首个
  const project = useMemo(() => {
    if (activeProject && projects.some((p) => p.projectPath === activeProject)) return activeProject;
    return projects[0]?.projectPath ?? null;
  }, [projects, activeProject]);

  const [dir, setDir] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // 在线编辑态：editingPath + 编辑器脏态上报（FileEditor 契约，NotesView 先例）
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const editDirtyRef = useRef(false);
  const guardDirty = () => {
    if (!editDirtyRef.current) return true;
    if (window.confirm(t("files.edit.confirmLeave"))) {
      editDirtyRef.current = false;
      return true;
    }
    return false;
  };
  const leaveEdit = () => {
    if (!guardDirty()) return;
    setEditingPath(null);
  };
  const saveEditingFile = useCallback(
    async (content: string, expectations: { mtimeNs: string; size: number }) => {
      if (!project || !editingPath) throw new Error("save target missing");
      return api.fsSaveFile(project, editingPath, content, {
        expectedMtimeNs: expectations.mtimeNs,
        expectedSize: expectations.size,
      });
    },
    [project, editingPath],
  );

  // 当前目录列表：项目或路径变化即重取，键名缓存比对防切窗口串态（同 files.tsx）
  const [{ key: loadedKey, entries, listError }, setList] = useState<{ key: string; entries: FsTreeEntry[] | null; listError: boolean }>({
    key: "",
    entries: null,
    listError: false,
  });
  const loadDir = useCallback(
    (proj: string, path: string) => {
      const key = `${proj}|${path}`;
      api
        .fsTree(proj, path || undefined)
        .then((res) => {
          setList({ key, entries: res.entries, listError: false });
        })
        .catch((err: unknown) => {
          setList({ key, entries: null, listError: true });
          pushGlobalError(apiErrorMessage(err, "files.list.loadFailed"));
        });
    },
    [pushGlobalError],
  );
  useEffect(() => {
    if (!project) return;
    loadDir(project, dir);
  }, [project, dir, loadDir]);
  const currentKey = project ? `${project}|${dir}` : "";
  const loaded = loadedKey === currentKey && !listError ? entries : null;
  const sorted = useMemo(() => (loaded ? ([...loaded] as ListEntry[]).sort(compareEntries) : null), [loaded]);

  // 树刷新版本：任意写操作成功后 +1，FileTree 以 key 重挂载自取
  const [treeVersion, setTreeVersion] = useState(0);
  const [dialog, setDialog] = useState<OpDialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadDirRef = useRef<string>("");
  const uploadSeqRef = useRef(0);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [deleteChildCount, setDeleteChildCount] = useState<number | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const uploadConflictChoiceRef = useRef<((decision: "overwrite" | "cancel") => void) | null>(null);

  // 删除确认弹窗打开且目标为目录时拉一次直接子条目数
  useEffect(() => {
    if (!deleteConfirm || !deleteConfirm.isDir || !project) return;
    let cancelled = false;
    api
      .fsTree(project, deleteConfirm.path)
      .then((res) => {
        if (!cancelled) setDeleteChildCount(res.entries.length);
      })
      .catch(() => {
        if (!cancelled) setDeleteChildCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [deleteConfirm, project]);

  const refetchAfterOp = useCallback(() => {
    if (project) loadDir(project, dir);
    setTreeVersion((v) => v + 1);
  }, [project, dir, loadDir]);

  const confirmDelete = async () => {
    if (!project || !deleteConfirm || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await api.fsDelete(project, deleteConfirm.path);
      if (selected === deleteConfirm.path) setSelected(null);
      setDeleteConfirm(null);
      refetchAfterOp();
    } catch (err) {
      if (err instanceof ApiError && err.code === "engine_busy") {
        pushGlobalError(t("files.confirm.engineBusy"));
      } else {
        pushGlobalError(apiErrorMessage(err, "files.op.deleteFailed"));
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  const resolveMoveConflict = async (choice: "overwrite" | "rename") => {
    if (!project || !conflict || conflict.kind !== "move" || conflict.from === null || conflictBusy) return;
    setConflictBusy(true);
    try {
      await api.fsMove(
        project,
        conflict.from,
        conflict.target,
        choice === "overwrite" ? { overwrite: true } : { conflict: "rename" },
      );
      setConflict(null);
      refetchAfterOp();
    } catch (err) {
      pushGlobalError(apiErrorMessage(err, "files.op.moveFailed"));
    } finally {
      setConflictBusy(false);
    }
  };

  const resolveUploadConflict = (choice: "overwrite" | "cancel") => {
    uploadConflictChoiceRef.current?.(choice);
  };

  const downloadEntry = (path: string) => {
    if (!project) return;
    const a = document.createElement("a");
    a.href = api.fsDownloadUrl(project, path);
    a.download = baseName(path);
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const openUploadPicker = (targetDir: string) => {
    uploadDirRef.current = targetDir;
    fileInputRef.current?.click();
  };

  const onFilesPicked = async (fileList: FileList | null) => {
    // 先快照 FileList 再清空 input.value（同一活对象，顺序不可反）
    const proj = project;
    const files = Array.from(fileList ?? []);
    if (!proj || files.length === 0) return;
    const targetDir = uploadDirRef.current;
    const input = fileInputRef.current;
    if (input) input.value = "";
    for (const file of files) {
      const id = ++uploadSeqRef.current;
      setUploadQueue((q) => [...q, { id, name: file.name, loaded: 0, total: file.size, status: "uploading" }]);
      try {
        await api.fsUpload(proj, targetDir, file, {
          onProgress: (loadedBytes, total) =>
            setUploadQueue((q) => q.map((it) => (it.id === id ? { ...it, loaded: loadedBytes, total } : it))),
        });
        setUploadQueue((q) => q.map((it) => (it.id === id ? { ...it, status: "done" } : it)));
      } catch (err) {
        if (err instanceof FsUploadConflictError) {
          // 409 target_exists：三选弹窗（保留两者置灰），决策经 resolver 阻塞队列
          const decision = await new Promise<"overwrite" | "cancel">((resolve) => {
            uploadConflictChoiceRef.current = resolve;
            setConflict({
              kind: "upload",
              from: null,
              target: targetDir,
              file,
              uploadId: id,
              existing: err.existing,
            });
          });
          uploadConflictChoiceRef.current = null;
          if (decision === "cancel") {
            setUploadQueue((q) => q.map((it) => (it.id === id ? { ...it, status: "canceled" } : it)));
          } else {
            try {
              await api.fsUpload(proj, targetDir, file, {
                overwrite: true,
                onProgress: (loadedBytes, total) =>
                  setUploadQueue((q) => q.map((it) => (it.id === id ? { ...it, loaded: loadedBytes, total } : it))),
              });
              setUploadQueue((q) => q.map((it) => (it.id === id ? { ...it, status: "done" } : it)));
            } catch (retryErr) {
              setUploadQueue((q) => q.map((it) => (it.id === id ? { ...it, status: "failed" } : it)));
              pushGlobalError(apiErrorMessage(retryErr, "files.op.uploadFailed"));
            }
          }
        } else {
          setUploadQueue((q) => q.map((it) => (it.id === id ? { ...it, status: "failed" } : it)));
          pushGlobalError(apiErrorMessage(err, "files.op.uploadFailed"));
        }
      }
    }
    refetchAfterOp();
  };

  /** 对话框提交：新建走当前目录拼接；重命名/移动交 fsMove（to 支持跨目录） */
  const runDialog = async () => {
    if (!project || !dialog || dialogBusy) return;
    const target = dialog.value.trim();
    if (!target || target === ".") return;
    setDialogBusy(true);
    const kind = dialog.kind;
    try {
      if (kind === "newFile") {
        await api.fsCreateFile(project, joinRel(dir, target));
      } else if (kind === "newDir") {
        await api.fsMkdir(project, joinRel(dir, target));
      } else if (dialog.from !== null) {
        await api.fsMove(project, dialog.from, target);
      }
      setDialog(null);
      refetchAfterOp();
    } catch (err) {
      if (kind === "move" && dialog.from !== null && err instanceof ApiError && err.status === 409 && err.code === "target_exists") {
        setDialog(null);
        setConflict({ kind: "move", from: dialog.from, target, file: null, uploadId: null, existing: null });
        return;
      }
      const fallbackKey =
        kind === "newFile"
          ? "files.op.createFileFailed"
          : kind === "newDir"
            ? "files.op.createDirFailed"
            : kind === "rename"
              ? "files.op.renameFailed"
              : "files.op.moveFailed";
      pushGlobalError(apiErrorMessage(err, fallbackKey));
    } finally {
      setDialogBusy(false);
    }
  };

  const openEntry = (entry: FsTreeEntry) => {
    const path = joinRel(dir, entry.name);
    if (entry.type === "directory") {
      if (editingPath && !guardDirty()) return;
      setEditingPath(null);
      setDir(path);
      return;
    }
    if (editingPath && !guardDirty()) return;
    setEditingPath(null);
    setSelected(path);
  };

  const onTreeDirectoryOpen = (path: string) => {
    if (editingPath && !guardDirty()) return;
    setEditingPath(null);
    setDir(path);
  };
  const onSelectTreePath = (path: string | null) => {
    if (path !== null && editingPath && !guardDirty()) return;
    setEditingPath(null);
    setSelected(path);
  };

  const breadcrumbs = useMemo(() => dir.split("/").filter(Boolean), [dir]);

  // 容器宽实测（#36）：ResizeObserver（nav-rail 先例）→ 布局档。观察不到时维持 0（窄档），
  // 既有窄栏形态不受影响；happy-dom 等无实现环境同样落窄档。
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((observed) => {
      const rect = observed[0]?.contentRect;
      setContainerWidth(rect ? Math.round(rect.width) : el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout = filesRailLayout(containerWidth);

  // 宽档横向列宽拖拽记忆（rail-files-resize）：仿 pages/files.tsx 手柄模式——state +
  // ref 镜像，pointer capture 拖拽实时钳制，pointerup 落记忆，双击重置默认；树手柄
  // 右移变宽，列表手柄左移变宽（预览列恒为剩余宽自适应）。纵向堆叠档不消费。
  const [treeWidth, setTreeWidth] = useState(() => readRailFilesTreeWidthPreference());
  const [listWidth, setListWidth] = useState(() => readRailFilesListWidthPreference());
  const treeWidthRef = useRef(treeWidth);
  const listWidthRef = useRef(listWidth);
  const treeDragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const listDragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const applyTreeWidth = (next: number) => {
    treeWidthRef.current = next;
    setTreeWidth(next);
  };
  const applyListWidth = (next: number) => {
    listWidthRef.current = next;
    setListWidth(next);
  };
  const onTreePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    treeDragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: treeWidthRef.current };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onListPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    listDragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: listWidthRef.current };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  // 树手柄右移变宽；列表手柄左移变宽（方向相反，delta 取负）
  const onTreePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = treeDragRef.current;
    if (!drag) return;
    applyTreeWidth(clampRailFilesTreeWidth(drag.startWidth + (e.clientX - drag.startX)));
  };
  const onListPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = listDragRef.current;
    if (!drag) return;
    applyListWidth(clampRailFilesListWidth(drag.startWidth - (e.clientX - drag.startX)));
  };
  // pointerup：落记忆；pointercancel：只终止拖拽（宽度已实时钳制，记忆留给下次完整拖拽）
  const onTreePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!treeDragRef.current) return;
    treeDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    writeRailFilesTreeWidthPreference(treeWidthRef.current);
  };
  const onListPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!listDragRef.current) return;
    listDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    writeRailFilesListWidthPreference(listWidthRef.current);
  };
  const onTreePointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    treeDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onListPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    listDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  // 键盘微调（可聚焦分隔条）：方向键 ±16px 并即时记忆；方向随手柄拖向（树右宽/列表左宽）
  const onTreeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight") {
      applyTreeWidth(clampRailFilesTreeWidth(treeWidthRef.current + 16));
      writeRailFilesTreeWidthPreference(treeWidthRef.current);
    } else if (e.key === "ArrowLeft") {
      applyTreeWidth(clampRailFilesTreeWidth(treeWidthRef.current - 16));
      writeRailFilesTreeWidthPreference(treeWidthRef.current);
    }
  };
  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      applyListWidth(clampRailFilesListWidth(listWidthRef.current + 16));
      writeRailFilesListWidthPreference(listWidthRef.current);
    } else if (e.key === "ArrowRight") {
      applyListWidth(clampRailFilesListWidth(listWidthRef.current - 16));
      writeRailFilesListWidthPreference(listWidthRef.current);
    }
  };
  const onTreeDoubleClick = () => {
    applyTreeWidth(RAIL_FILES_TREE_DEFAULT);
    writeRailFilesTreeWidthPreference(RAIL_FILES_TREE_DEFAULT);
  };
  const onListDoubleClick = () => {
    applyListWidth(RAIL_FILES_LIST_DEFAULT);
    writeRailFilesListWidthPreference(RAIL_FILES_LIST_DEFAULT);
  };
  /** 骑跨栏缘的拖宽手柄（role=separator，w-1.5 命中区），属性同 files.tsx 形态 */
  const resizeHandle = (
    testId: string,
    ariaLabel: string,
    value: number,
    min: number,
    max: number,
    handlers: Pick<
      HTMLAttributes<HTMLDivElement>,
      "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onKeyDown" | "onDoubleClick"
    >,
  ) => (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={testId}
      className="z-10 w-1.5 shrink-0 cursor-col-resize touch-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
      {...handlers}
    />
  );

  const editAction = (data: FsFileResponse) => {
    const label = t("files.edit.button");
    if (!isEditableFile(data)) {
      const reason = t(editBlockReasonKey(data));
      return (
        <button
          type="button"
          data-testid="rail-files-edit-button"
          data-ineligible="true"
          disabled
          title={reason}
          aria-label={`${label}：${reason}`}
          className="flex h-9 shrink-0 cursor-not-allowed items-center gap-1.5 rounded-lg border border-input px-3 text-xs text-muted-foreground"
        >
          <Pencil className="size-4" aria-hidden />
          {label}
        </button>
      );
    }
    return (
      <button
        type="button"
        data-testid="rail-files-edit-button"
        onClick={() => {
          editDirtyRef.current = false;
          setEditingPath(selected);
        }}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-input px-3 text-xs transition-colors hover:bg-muted/50"
      >
        <Pencil className="size-4" aria-hidden />
        {label}
      </button>
    );
  };

  const toolbar = (
    <div data-testid="rail-files-toolbar" className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
      <Button variant="outline" size="sm" data-testid="rail-files-toolbar-new-file" onClick={() => setDialog({ kind: "newFile", from: null, value: "" })}>
        {t("files.toolbar.newFile")}
      </Button>
      <Button variant="outline" size="sm" data-testid="rail-files-toolbar-new-dir" onClick={() => setDialog({ kind: "newDir", from: null, value: "" })}>
        {t("files.toolbar.newDir")}
      </Button>
      <Button variant="outline" size="sm" data-testid="rail-files-toolbar-upload" onClick={() => openUploadPicker(dir)}>
        <Upload className="size-4" aria-hidden />
        {t("files.toolbar.upload")}
      </Button>
      <Button variant="ghost" size="sm" data-testid="rail-files-toolbar-refresh" aria-label={t("files.toolbar.refresh")} onClick={refetchAfterOp}>
        <RefreshCw className="size-4" aria-hidden />
      </Button>
    </div>
  );

  const uploadPanel =
    uploadQueue.length > 0 ? (
      <div data-testid="rail-files-upload-queue" className="shrink-0 border-b px-2 py-1 text-xs">
        <div className="mb-0.5 font-medium text-muted-foreground">{t("files.upload.queueTitle")}</div>
        {uploadQueue.map((it) => {
          const percent = it.total > 0 ? Math.min(100, Math.round((it.loaded / it.total) * 100)) : 0;
          return (
            <div key={it.id} data-testid={`rail-files-upload-item-${it.name}`} data-status={it.status} className="py-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate" title={it.name}>
                  {it.name}
                </span>
                <span className={it.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                  {it.status === "uploading"
                    ? t("files.upload.uploading")
                    : it.status === "done"
                      ? t("files.upload.done")
                      : it.status === "canceled"
                        ? t("files.upload.canceled")
                        : t("files.upload.failed")}
                </span>
              </div>
              {it.status === "uploading" ? (
                <div
                  className="mt-0.5 h-1 w-full overflow-hidden rounded bg-muted"
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    ) : null;

  const dialogNode = dialog ? (
    <Dialog open onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <DialogContent data-testid="rail-files-dialog">
        <DialogHeader>
          <DialogTitle>{t(DIALOG_TITLE_KEY[dialog.kind])}</DialogTitle>
          <DialogDescription>
            {dialog.kind === "newFile" || dialog.kind === "newDir" ? t("files.dialog.nameLabel") : t("files.dialog.targetLabel")}
          </DialogDescription>
        </DialogHeader>
        <input
          data-testid="rail-files-dialog-input"
          aria-label={dialog.kind === "newFile" || dialog.kind === "newDir" ? t("files.dialog.nameLabel") : t("files.dialog.targetLabel")}
          value={dialog.value}
          autoFocus
          onChange={(e) => setDialog((d) => (d ? { ...d, value: e.target.value } : d))}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runDialog();
          }}
          className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <DialogFooter>
          <Button variant="outline" data-testid="rail-files-dialog-cancel" onClick={() => setDialog(null)}>
            {t("files.dialog.cancel")}
          </Button>
          <Button data-testid="rail-files-dialog-confirm" disabled={dialogBusy} onClick={() => void runDialog()}>
            {t("files.dialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null;

  const treeContent = (
    <FileTree key={treeVersion} project={project} selectedPath={selected} onSelect={onSelectTreePath} onDirectoryOpen={onTreeDirectoryOpen} />
  );
  const listContent = (
    <>
      {listError ? (
        <div data-testid="rail-files-list-error" className="py-3 text-center text-xs text-destructive">
          {t("files.list.loadFailed")}
        </div>
      ) : null}
      {sorted?.length === 0 ? (
        <div data-testid="rail-files-list-empty" className="py-3 text-center text-xs text-muted-foreground">
          {t("files.list.empty")}
        </div>
      ) : null}
      {sorted?.map((entry) => {
        const path = joinRel(dir, entry.name);
        const isDir = entry.type === "directory";
        const iconBtn =
          "flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";
        return (
          <div key={entry.name} data-testid={`rail-files-row-${entry.name}`} className="flex items-center gap-1 border-b border-border/40 py-0.5">
            <button
              type="button"
              data-testid={`rail-files-row-name-${entry.name}`}
              onClick={() => openEntry(entry)}
              className="min-w-0 flex-1 truncate rounded text-left text-sm transition-colors hover:text-primary"
              title={path}
            >
              {isDir ? <span className="mr-1" aria-hidden>▸</span> : null}
              {entry.name}
            </button>
            <span className="shrink-0 text-xs text-muted-foreground">
              {entry.size == null ? t(TYPE_KEY[entry.type]) : formatSize(entry.size)}
            </span>
            {isDir ? (
              <button
                type="button"
                data-testid={`rail-files-upload-here-${entry.name}`}
                aria-label={t("files.menu.uploadHere")}
                title={t("files.menu.uploadHere")}
                onClick={() => openUploadPicker(path)}
                className={iconBtn}
              >
                <Upload className="size-3.5" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                data-testid={`rail-files-download-${entry.name}`}
                aria-label={t("files.menu.download")}
                title={t("files.menu.download")}
                onClick={() => downloadEntry(path)}
                className={iconBtn}
              >
                <Download className="size-3.5" aria-hidden />
              </button>
            )}
            <button
              type="button"
              data-testid={`rail-files-rename-${entry.name}`}
              aria-label={t("files.menu.rename")}
              title={t("files.menu.rename")}
              onClick={() => setDialog({ kind: "rename", from: path, value: baseName(path) })}
              className={iconBtn}
            >
              <Pencil className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              data-testid={`rail-files-move-${entry.name}`}
              aria-label={t("files.menu.move")}
              title={t("files.menu.move")}
              onClick={() => setDialog({ kind: "move", from: path, value: path })}
              className={iconBtn}
            >
              <ArrowRightLeft className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              data-testid={`rail-files-delete-${entry.name}`}
              aria-label={t("files.menu.remove")}
              title={t("files.menu.remove")}
              onClick={() => {
                setDeleteChildCount(null);
                setDeleteConfirm({ path, isDir });
              }}
              className={iconBtn}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
    </>
  );
  const previewContent = selected ? (
    editingPath === selected ? (
      <FileEditor key={selected} project={project} path={selected} dirtyRef={editDirtyRef} onBack={leaveEdit} onSave={saveEditingFile} />
    ) : (
      <FilePreview key={selected} project={project} path={selected} renderActions={editAction} enableImageInline />
    )
  ) : (
    <div className="flex flex-1 items-center justify-center p-2 text-sm text-muted-foreground">
      {t("files.preview.empty")}
    </div>
  );

  return (
    <div ref={rootRef} data-testid="rail-files-panel" data-layout={layout} className="flex h-full min-h-0 flex-col">
      {toolbar}
      {/* 当前路径面包屑：根（项目名）+ 逐段可点回跳 */}
      <nav
        aria-label={t("files.list.heading")}
        data-testid="rail-files-breadcrumb"
        className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2 text-xs text-muted-foreground"
      >
        <button
          type="button"
          data-testid="rail-files-breadcrumb-root"
          onClick={() => setDir("")}
          className="rounded px-1 transition-colors hover:text-foreground"
        >
          {project ? baseName(project) : t("files.breadcrumb.root")}
        </button>
        {breadcrumbs.map((seg, i) => (
          <span key={`${i}-${seg}`} className="flex items-center">
            <ChevronRight className="size-3" aria-hidden />
            <button
              type="button"
              onClick={() => setDir(breadcrumbs.slice(0, i + 1).join("/"))}
              className="rounded px-1 transition-colors hover:text-foreground"
            >
              {seg}
            </button>
          </span>
        ))}
      </nav>
      {uploadPanel}
      {project ? (
        layout === "stacked" ? (
          <>
            {/* 窄档（容器 ≤600）：树约 1/3 高度，可滚动；写操作后 key 重挂载自取最新 */}
            <div data-testid="rail-files-tree-pane" className="max-h-64 min-h-32 shrink-0 overflow-y-auto border-b p-1">
              {treeContent}
            </div>
            {/* 文件列表：名称 + 大小 + 行内操作钮（下载/重命名/移动/删除） */}
            <div data-testid="rail-files-list-pane" className="min-h-0 shrink overflow-y-auto px-2 py-1">
              {listContent}
            </div>
            {/* 预览/编辑：编辑态替换预览（与 files.tsx 同判据），空态文案复用 */}
            <div data-testid="rail-files-preview-pane" className="min-h-0 flex-1 overflow-y-auto border-t p-2">
              {previewContent}
            </div>
          </>
        ) : (
          /* 宽档（>600）：树列宽可拖拽记忆（rail-files-resize，默认 14rem）+ 右侧内容区；
             split（601-899）内容区上下分（仅树手柄），columns（≥900）列表列宽可拖拽
             记忆（默认 20rem），预览列恒为剩余宽自适应 */
          <div data-testid="rail-files-columns" className="flex min-h-0 flex-1">
            <div
              data-testid="rail-files-tree-pane"
              style={{ width: treeWidth }}
              className="shrink-0 overflow-y-auto p-1"
            >
              {treeContent}
            </div>
            {resizeHandle(
              "rail-files-resize-handle-tree",
              t("files.resize.railTreeAriaLabel"),
              treeWidth,
              RAIL_FILES_TREE_MIN,
              RAIL_FILES_TREE_MAX,
              {
                onPointerDown: onTreePointerDown,
                onPointerMove: onTreePointerMove,
                onPointerUp: onTreePointerUp,
                onPointerCancel: onTreePointerCancel,
                onKeyDown: onTreeKeyDown,
                onDoubleClick: onTreeDoubleClick,
              },
            )}
            <div className={`flex min-h-0 min-w-0 flex-1 ${layout === "columns" ? "flex-row" : "flex-col"}`}>
              <div
                data-testid="rail-files-list-pane"
                style={layout === "columns" ? { width: listWidth } : undefined}
                className={`min-h-0 min-w-0 overflow-y-auto px-2 py-1 ${
                  layout === "columns" ? "shrink-0 border-r" : "flex-1"
                }`}
              >
                {listContent}
              </div>
              {layout === "columns"
                ? resizeHandle(
                    "rail-files-resize-handle-list",
                    t("files.resize.railListAriaLabel"),
                    listWidth,
                    RAIL_FILES_LIST_MIN,
                    RAIL_FILES_LIST_MAX,
                    {
                      onPointerDown: onListPointerDown,
                      onPointerMove: onListPointerMove,
                      onPointerUp: onListPointerUp,
                      onPointerCancel: onListPointerCancel,
                      onKeyDown: onListKeyDown,
                      onDoubleClick: onListDoubleClick,
                    },
                  )
                : null}
              <div
                data-testid="rail-files-preview-pane"
                className={`min-h-0 flex-1 overflow-y-auto p-2 ${layout === "columns" ? "" : "border-t"}`}
              >
                {previewContent}
              </div>
            </div>
          </div>
        )
      ) : (
        <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
          {t("files.project.empty")}
        </div>
      )}
      {/* 隐藏文件选择器（多选；目标目录由 openUploadPicker 预置） */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="rail-files-upload-input"
        className="hidden"
        onChange={(e) => void onFilesPicked(e.target.files)}
      />
      {dialogNode}
      {deleteConfirm ? (
        <DeleteConfirmDialog
          path={deleteConfirm.path}
          isDir={deleteConfirm.isDir}
          childCount={deleteChildCount}
          busy={deleteBusy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteConfirm(null)}
        />
      ) : null}
      {conflict ? (
        <FsConflictDialog
          desc={
            conflict.kind === "move"
              ? t("files.conflict.moveDesc", { path: conflict.target })
              : t("files.conflict.uploadDesc", { name: conflict.file?.name ?? "", dir: conflict.target })
          }
          existing={
            conflict.existing
              ? t("files.conflict.existingInfo", {
                  kind: conflict.existing.kind ?? "",
                  size: conflict.existing.size != null ? formatSize(conflict.existing.size) : "",
                })
              : undefined
          }
          busy={conflictBusy}
          keepBothReason={conflict.kind === "upload" ? t("files.conflict.keepBothDisabled") : undefined}
          onOverwrite={() =>
            conflict.kind === "move" ? void resolveMoveConflict("overwrite") : resolveUploadConflict("overwrite")
          }
          onKeepBoth={() => {
            if (conflict.kind === "move") void resolveMoveConflict("rename");
            else resolveUploadConflict("cancel");
          }}
          onCancel={() => {
            if (conflict.kind === "move") setConflict(null);
            else resolveUploadConflict("cancel");
          }}
        />
      ) : null}
    </div>
  );
}
