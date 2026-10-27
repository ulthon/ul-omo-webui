// 项目跟随式文件管理页（builtin-file-management 任务 2）：fixed 全屏覆盖层形态同
// SettingsPage（shell 依据 ui store filesPageOpen 条件渲染，SSE 不中断）。
// 三栏：左=项目目录树（复用 file-tree.tsx，新增可选 onDirectoryOpen 同步中栏）；
// 中=当前目录文件列表（名称/大小/mtime/类型列，列头点击排序，目录恒优先；
// 单击目录进入、单击文件右栏预览）；右=FilePreview 复用（复用组件自带只读约束）。
// 页头：项目下拉（ui store projects，bootstrap 已从 GET /api/projects 填充；
// 空时兜底自拉一次）+ 当前路径面包屑。默认项目 = ui store currentProject
// （bootstrap openProject 写入，即最近活跃会话项目），无会话时取列表首个。
// 操作面（任务 6）：列表上方工具栏（新建文件/新建目录/上传/刷新）+ 列表与树右键
// 菜单（下载/重命名/移动/删除，目录加“在此上传”）；上传 = 文件选择器多选 +
// 逐个排队（进度条 + 结果态）；重命名/移动 = 对话框输入目标相对路径（移动支持
// 跨目录路径）；操作成功后重取当前目录与树（不做乐观更新）；失败 toast
// （apiErrorMessage 错误码词典文案）。无拖拽、无批量勾选（后续任务也不做，计划 Must NOT）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { ChevronRight, RefreshCw, Upload, X } from "lucide-react";
import { api, FsUploadConflictError } from "@/lib/api";
import type { FsTreeEntry } from "@/lib/api";
import { useIsMobile } from "@/lib/use-is-mobile";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { useUiStore } from "@/stores/ui";
import { FileTree } from "@/components/file-tree/file-tree";
import { FilePreview } from "@/components/file-tree/file-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type SortKey = "name" | "size" | "mtime" | "type";
type SortDir = "asc" | "desc";
type MobilePane = "tree" | "list" | "preview";
type OpDialogKind = "newFile" | "newDir" | "rename" | "move";

/** 右键菜单目标（列表行/树行统一形状；scope 供菜单项差异：目录才有“在此上传”） */
interface ContextMenuTarget {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

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
  status: "uploading" | "done" | "failed";
}

/** fs/tree 条目 + 服务端增补的 size/mtime（类型在 lib/api 未同步前本地扩展） */
interface ListEntry extends FsTreeEntry {
  size: number | null;
  mtime: number | null;
}

const MOBILE_FILES_QUERY = "(max-width: 768px)";

/** 末段路径（面包屑/回退展示） */
function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** 项目内相对路径拼接（"" 根特判） */
function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function sortLabelKey(key: SortKey): "files.list.sortByName" | "files.list.sortBySize" | "files.list.sortByMtime" | "files.list.sortByType" {
  switch (key) {
    case "name":
      return "files.list.sortByName";
    case "size":
      return "files.list.sortBySize";
    case "mtime":
      return "files.list.sortByMtime";
    case "type":
      return "files.list.sortByType";
  }
}

const LIST_KEY: Record<SortKey, "files.list.name" | "files.list.size" | "files.list.mtime" | "files.list.type"> = {
  name: "files.list.name",
  size: "files.list.size",
  mtime: "files.list.mtime",
  type: "files.list.type",
};

const TYPE_KEY: Record<FsTreeEntry["type"], "files.type.directory" | "files.type.file" | "files.type.symlink" | "files.type.other"> = {
  directory: "files.type.directory",
  file: "files.type.file",
  symlink: "files.type.symlink",
  other: "files.type.other",
};

const MOBILE_PANE_KEY: Record<MobilePane, "files.mobile.tree" | "files.mobile.list" | "files.mobile.preview"> = {
  tree: "files.mobile.tree",
  list: "files.mobile.list",
  preview: "files.mobile.preview",
};

interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** 字节人性化展示（B/KB/MB/GB，一位小数；超大档位直接 GB） */
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

/** 本地时区 YYYY-MM-DD HH:mm */
function formatMtime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 目录恒优先；size/mtime 按真实值排序（null 恒排在有值之后），同值回退名称序 */
function compareEntries(a: ListEntry, b: ListEntry, sort: SortState): number {
  const dirDelta = Number(b.type === "directory") - Number(a.type === "directory");
  if (dirDelta !== 0) return dirDelta;
  const sign = sort.dir === "asc" ? 1 : -1;
  const nameDelta = a.name.localeCompare(b.name);
  const fallback = () => (nameDelta !== 0 ? sign * nameDelta : 0);
  if (sort.key === "type") {
    const typeDelta = a.type.localeCompare(b.type);
    return typeDelta !== 0 ? sign * typeDelta : nameDelta;
  }
  if (sort.key === "size") {
    if (a.size == null || b.size == null) {
      if (a.size == null && b.size == null) return fallback();
      return a.size == null ? 1 : -1;
    }
    return a.size !== b.size ? sign * (a.size - b.size) : fallback();
  }
  if (sort.key === "mtime") {
    if (a.mtime == null || b.mtime == null) {
      if (a.mtime == null && b.mtime == null) return fallback();
      return a.mtime == null ? 1 : -1;
    }
    return a.mtime !== b.mtime ? sign * (a.mtime - b.mtime) : fallback();
  }
  return sign * nameDelta;
}

export function FilesPage() {
  const t = useT();
  const showToast = useUiStore((s) => s.showToast);
  const storeProjects = useUiStore((s) => s.projects);
  const setStoreProjects = useUiStore((s) => s.setProjects);
  const currentProject = useUiStore((s) => s.currentProject);
  const setFilesPageOpen = useUiStore((s) => s.setFilesPageOpen);
  const isMobile = useIsMobile(MOBILE_FILES_QUERY);

  // 项目表：直接读 bootstrap 填充的 ui store；空（未引导完/直接挂载）时自拉一次兜底（写回 store，派生即可见）
  const projects = storeProjects;
  const [projectsError, setProjectsError] = useState(false);
  useEffect(() => {
    if (projects.length > 0) return;
    let cancelled = false;
    api
      .listProjects()
      .then((res) => {
        if (cancelled) return;
        setStoreProjects(res.projects);
      })
      .catch(() => {
        if (!cancelled) setProjectsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projects.length, setStoreProjects]);

  // 当前项目：本地 state 只存用户显式选择；渲染期派生生效值——显式选择在表内优先，
  // 否则最近活跃会话项目（currentProject 在表内），否则列表首个。无 effect 级联。
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const project = useMemo(() => {
    if (pickedProject && projects.some((p) => p.projectPath === pickedProject)) return pickedProject;
    if (currentProject && projects.some((p) => p.projectPath === currentProject)) return currentProject;
    return projects[0]?.projectPath ?? null;
  }, [pickedProject, projects, currentProject]);

  const [dir, setDir] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // 切项目清路径与选中（事件处理器内做，不走 effect）
  const changeProject = (next: string) => {
    setPickedProject(next);
    setDir("");
    setSelected(null);
  };

  // 中栏目录列表：项目或路径变化即重取。响应带键名缓存比对：键不匹配（切项目/切路径窗口）
  // 渲染期派生为未加载，不 effect 内同步清态
  const [{ key: loadedKey, entries, listError }, setList] = useState<{ key: string; entries: FsTreeEntry[] | null; listError: boolean }>({
    key: "",
    entries: null,
    listError: false,
  });
  const loadDir = useCallback((proj: string, path: string) => {
    const key = `${proj}|${path}`;
    api
      .fsTree(proj, path || undefined)
      .then((res) => {
        setList({ key, entries: res.entries, listError: false });
      })
      .catch((err: unknown) => {
        setList({ key, entries: null, listError: true });
        showToast(apiErrorMessage(err, "files.list.loadFailed"), "error");
      });
  }, [showToast]);
  useEffect(() => {
    if (!project) return;
    loadDir(project, dir);
  }, [project, dir, loadDir]);
  const currentKey = project ? `${project}|${dir}` : "";
  const loaded = loadedKey === currentKey && !listError ? entries : null;

  const [sort, setSort] = useState<SortState>({ key: "name", dir: "asc" });
  const sorted = useMemo(
    () => (loaded ? ([...loaded] as ListEntry[]).sort((a, b) => compareEntries(a, b, sort)) : null),
    [loaded, sort],
  );
  const toggleSort = (key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  };

  const [mobilePane, setMobilePane] = useState<MobilePane>("list");

  // ---- 操作面（任务 6）：工具栏 + 右键菜单 + 对话框 + 上传队列 ----
  // 树刷新版本：任意写操作成功后 +1，FileTree 以 key 重挂载自取（无命令式刷新口，简单一致）
  const [treeVersion, setTreeVersion] = useState(0);
  const [menu, setMenu] = useState<ContextMenuTarget | null>(null);
  const [dialog, setDialog] = useState<OpDialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // 待上传目标目录：工具栏上传 = 当前目录；目录“在此上传”= 该目录
  const uploadDirRef = useRef<string>("");
  const uploadSeqRef = useRef(0);

  /** 写操作成功后统一收口：重取当前目录 + 树（不做乐观更新，计划口径） */
  const refetchAfterOp = useCallback(() => {
    if (project) loadDir(project, dir);
    setTreeVersion((v) => v + 1);
  }, [project, dir, loadDir]);

  const openMenu = (e: ReactMouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, path, isDir });
  };

  /** 树行右键：目标从行 DOM 解析（data-testid 路径 + aria-expanded 判目录），FileTree 零波及 */
  const onTreeContextMenu = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement;
    const row = typeof target.closest === "function" ? target.closest("[data-testid^='tree-row-']") : null;
    if (!(row instanceof HTMLElement)) return;
    const testid = row.getAttribute("data-testid");
    if (!testid) return;
    openMenu(e, testid.slice("tree-row-".length), row.getAttribute("aria-expanded") !== null);
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

  const removeEntry = async (path: string) => {
    if (!project) return;
    try {
      await api.fsDelete(project, path);
      if (selected === path) setSelected(null);
      refetchAfterOp();
    } catch (err) {
      showToast(apiErrorMessage(err, "files.op.deleteFailed"), "error");
    }
  };

  const openUploadPicker = (targetDir: string) => {
    uploadDirRef.current = targetDir;
    fileInputRef.current?.click();
  };

  /** 多选逐个排队上传：每文件进度回写队列态；409 冲突（FsUploadConflictError 携带
   * existing）本任务仅 toast（确认弹窗/三选属任务 7）；全部结束后重取列表与树 */
  const onFilesPicked = async (fileList: FileList | null) => {
    // 先快照 FileList 再清空 input.value：e.target.files 与 input 是同一活对象，
    // 先清空会让快照变空（真实浏览器实测）
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
          onProgress: (loaded, total) =>
            setUploadQueue((q) => q.map((it) => (it.id === id ? { ...it, loaded, total } : it))),
        });
        setUploadQueue((q) => q.map((it) => (it.id === id ? { ...it, status: "done" } : it)));
      } catch (err) {
        setUploadQueue((q) => q.map((it) => (it.id === id ? { ...it, status: "failed" } : it)));
        if (err instanceof FsUploadConflictError) {
          showToast(t("files.upload.conflict"), "error");
        } else {
          showToast(apiErrorMessage(err, "files.op.uploadFailed"), "error");
        }
      }
    }
    refetchAfterOp();
  };

  /** 对话框提交：新建走当前目录拼接；重命名/移动交 fsMove（to 为目标相对路径，跨目录合法） */
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
      const fallbackKey =
        kind === "newFile"
          ? "files.op.createFileFailed"
          : kind === "newDir"
            ? "files.op.createDirFailed"
            : kind === "rename"
              ? "files.op.renameFailed"
              : "files.op.moveFailed";
      showToast(apiErrorMessage(err, fallbackKey), "error");
    } finally {
      setDialogBusy(false);
    }
  };

  const DIALOG_TITLE_KEY: Record<OpDialogKind, "files.dialog.newFileTitle" | "files.dialog.newDirTitle" | "files.dialog.renameTitle" | "files.dialog.moveTitle"> = {
    newFile: "files.dialog.newFileTitle",
    newDir: "files.dialog.newDirTitle",
    rename: "files.dialog.renameTitle",
    move: "files.dialog.moveTitle",
  };

  const dialogNode = dialog ? (
    <Dialog open onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <DialogContent data-testid="files-dialog">
        <DialogHeader>
          <DialogTitle>{t(DIALOG_TITLE_KEY[dialog.kind])}</DialogTitle>
          <DialogDescription>
            {dialog.kind === "newFile" || dialog.kind === "newDir" ? t("files.dialog.nameLabel") : t("files.dialog.targetLabel")}
          </DialogDescription>
        </DialogHeader>
        <input
          data-testid="files-dialog-input"
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
          <Button variant="outline" data-testid="files-dialog-cancel" onClick={() => setDialog(null)}>
            {t("files.dialog.cancel")}
          </Button>
          <Button data-testid="files-dialog-confirm" disabled={dialogBusy} onClick={() => void runDialog()}>
            {t("files.dialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null;

  const menuNode = menu ? (
    <>
      {/* 全屏透明层：点外关闭（右键再次打开由下层行处理） */}
      <div
        data-testid="files-menu-overlay"
        className="fixed inset-0 z-50"
        onClick={() => setMenu(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(null);
        }}
      />
      <div
        role="menu"
        data-testid="files-context-menu"
        style={{ left: menu.x, top: menu.y }}
        className="fixed z-50 min-w-36 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md"
      >
        {menu.isDir ? (
          <button
            type="button"
            role="menuitem"
            data-testid="files-menu-upload-here"
            onClick={() => {
              const path = menu.path;
              setMenu(null);
              openUploadPicker(path);
            }}
            className="w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-muted"
          >
            {t("files.menu.uploadHere")}
          </button>
        ) : (
          <button
            type="button"
            role="menuitem"
            data-testid="files-menu-download"
            onClick={() => {
              const path = menu.path;
              setMenu(null);
              downloadEntry(path);
            }}
            className="w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-muted"
          >
            {t("files.menu.download")}
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          data-testid="files-menu-rename"
          onClick={() => {
            const path = menu.path;
            setMenu(null);
            setDialog({ kind: "rename", from: path, value: baseName(path) });
          }}
          className="w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-muted"
        >
          {t("files.menu.rename")}
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="files-menu-move"
          onClick={() => {
            const path = menu.path;
            setMenu(null);
            setDialog({ kind: "move", from: path, value: path });
          }}
          className="w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-muted"
        >
          {t("files.menu.move")}
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="files-menu-delete"
          onClick={() => {
            const path = menu.path;
            setMenu(null);
            void removeEntry(path);
          }}
          className="w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-muted"
        >
          {t("files.menu.remove")}
        </button>
      </div>
    </>
  ) : null;

  const onTreeDirectoryOpen = (path: string) => {
    setDir(path);
    if (isMobile) setMobilePane("list");
  };
  const onListRowClick = (entry: FsTreeEntry) => {
    const path = joinRel(dir, entry.name);
    if (entry.type === "directory") {
      setDir(path);
      return;
    }
    setSelected(path);
    if (isMobile) setMobilePane("preview");
  };

  const breadcrumbs = useMemo(() => dir.split("/").filter(Boolean), [dir]);

  const projectSelect = (
    <select
      data-testid="files-project-select"
      aria-label={t("files.project.selectAria")}
      value={project ?? ""}
      onChange={(e) => changeProject(e.target.value)}
      className="h-8 max-w-48 rounded-lg border border-input bg-transparent px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {projects.length === 0 && <option value="">{t("files.project.empty")}</option>}
      {projects.map((p) => (
        <option key={p.projectPath} value={p.projectPath}>
          {baseName(p.projectPath)}
        </option>
      ))}
    </select>
  );

  const treePane = (
    <div data-testid="files-tree-pane" className="flex min-h-0 flex-col overflow-y-auto" onContextMenu={onTreeContextMenu}>
      {project ? (
        <FileTree key={treeVersion} project={project} selectedPath={selected} onSelect={setSelected} onDirectoryOpen={onTreeDirectoryOpen} />
      ) : null}
    </div>
  );

  const toolbar = (
    <div data-testid="files-toolbar" className="mb-2 flex shrink-0 items-center gap-1.5">
      <Button variant="outline" size="sm" data-testid="files-toolbar-new-file" onClick={() => setDialog({ kind: "newFile", from: null, value: "" })}>
        {t("files.toolbar.newFile")}
      </Button>
      <Button variant="outline" size="sm" data-testid="files-toolbar-new-dir" onClick={() => setDialog({ kind: "newDir", from: null, value: "" })}>
        {t("files.toolbar.newDir")}
      </Button>
      <Button variant="outline" size="sm" data-testid="files-toolbar-upload" onClick={() => openUploadPicker(dir)}>
        <Upload className="size-4" aria-hidden />
        {t("files.toolbar.upload")}
      </Button>
      <Button variant="ghost" size="sm" data-testid="files-toolbar-refresh" aria-label={t("files.toolbar.refresh")} onClick={refetchAfterOp}>
        <RefreshCw className="size-4" aria-hidden />
      </Button>
    </div>
  );

  const uploadPanel =
    uploadQueue.length > 0 ? (
      <div data-testid="files-upload-queue" className="mb-2 rounded-lg border p-2 text-xs">
        <div className="mb-1 font-medium text-muted-foreground">{t("files.upload.queueTitle")}</div>
        {uploadQueue.map((it) => {
          const percent = it.total > 0 ? Math.min(100, Math.round((it.loaded / it.total) * 100)) : 0;
          return (
            <div key={it.id} data-testid={`files-upload-item-${it.name}`} data-status={it.status} className="py-1">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate" title={it.name}>
                  {it.name}
                </span>
                <span className={it.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                  {it.status === "uploading"
                    ? t("files.upload.uploading")
                    : it.status === "done"
                      ? t("files.upload.done")
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


  const listPane = (
    <div data-testid="files-list-pane" className="flex min-h-0 flex-col">
      {toolbar}
      {uploadPanel}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            {(["name", "size", "mtime", "type"] as const).map((key) => (
              <th key={key} scope="col" className="py-1.5 pr-2 font-normal">
                <button
                  type="button"
                  data-testid={`files-sort-${key}`}
                  aria-label={t(sortLabelKey(key))}
                  onClick={() => toggleSort(key)}
                  className="flex items-center gap-0.5 rounded px-1 transition-colors hover:text-foreground"
                >
                  {t(LIST_KEY[key])}
                  {sort.key === key ? <span aria-hidden>{sort.dir === "asc" ? "↑" : "↓"}</span> : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!sorted && !listError && project ? (
            <tr>
              <td colSpan={4} className="py-6 text-center text-muted-foreground">
                …
              </td>
            </tr>
          ) : null}
          {listError && project ? (
            <tr>
              <td data-testid="files-list-error" colSpan={4} className="py-6 text-center text-destructive">
                {t("files.list.loadFailed")}
              </td>
            </tr>
          ) : null}
          {sorted?.length === 0 ? (
            <tr>
              <td data-testid="files-list-empty" colSpan={4} className="py-6 text-center text-muted-foreground">
                {t("files.list.empty")}
              </td>
            </tr>
          ) : null}
          {sorted?.map((entry) => {
            return (
              <tr key={entry.name} className="border-b border-border/40">
                <td className="py-1.5 pr-2">
                  <button
                    type="button"
                    data-testid={`files-row-${entry.name}`}
                    onClick={() => onListRowClick(entry)}
                    onContextMenu={(e) => openMenu(e, joinRel(dir, entry.name), entry.type === "directory")}
                    className="w-full truncate rounded text-left transition-colors hover:text-primary"
                    title={entry.name}
                  >
                    {entry.type === "directory" ? <span className="mr-1" aria-hidden>▸</span> : null}
                    {entry.name}
                  </button>
                </td>
                <td className="py-1.5 pr-2 text-muted-foreground">
                  {entry.size == null ? t("files.list.notAvailable") : formatSize(entry.size)}
                </td>
                <td className="py-1.5 pr-2 text-muted-foreground">
                  {entry.mtime == null ? t("files.list.notAvailable") : formatMtime(entry.mtime)}
                </td>
                <td className="py-1.5 pr-2 text-muted-foreground">{t(TYPE_KEY[entry.type])}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const previewPane = (
    <div data-testid="files-preview-pane" className="flex min-h-0 flex-col overflow-y-auto">
      {selected && project ? (
        <FilePreview key={selected} project={project} path={selected} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
          {t("files.preview.empty")}
        </div>
      )}
    </div>
  );

  return (
    <div data-testid="files-page" className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t("files.page.closeAria")}
          data-testid="files-page-close"
          onClick={() => setFilesPageOpen(false)}
        >
          <X className="size-5" />
        </Button>
        <h1 className="text-base font-medium">{t("files.page.title")}</h1>
        <div className="ml-2 flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{t("files.project.label")}</span>
          {projectSelect}
        </div>
      </header>
      {/* 当前路径面包屑：根（项目名）+ 逐段可点回跳 */}
      <nav aria-label={t("files.list.heading")} data-testid="files-breadcrumb" className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-3 text-xs text-muted-foreground">
        <button
          type="button"
          data-testid="files-breadcrumb-root"
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
      {projectsError && projects.length === 0 ? (
        <div data-testid="files-projects-error" className="flex flex-1 items-center justify-center p-4 text-sm text-destructive">
          {t("files.error.projectsLoadFailed")}
        </div>
      ) : isMobile ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div role="tablist" aria-label={t("files.mobile.switcherAria")} data-testid="files-mobile-tabs" className="flex shrink-0 border-b">
            {(["tree", "list", "preview"] as const).map((pane) => (
              <button
                key={pane}
                type="button"
                role="tab"
                aria-selected={mobilePane === pane}
                data-testid={`files-mobile-tab-${pane}`}
                onClick={() => setMobilePane(pane)}
                className={`flex-1 py-2 text-sm transition-colors ${
                  mobilePane === pane ? "border-b-2 border-primary font-medium text-foreground" : "text-muted-foreground"
                }`}
              >
                {t(MOBILE_PANE_KEY[pane])}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {mobilePane === "tree" ? treePane : mobilePane === "list" ? listPane : previewPane}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[16rem_1fr_22rem]">
          <div className="min-h-0 border-r p-2">{treePane}</div>
          <div className="min-h-0 overflow-y-auto p-3">{listPane}</div>
          <div className="min-h-0 border-l p-3">{previewPane}</div>
        </div>
      )}
      {/* 隐藏文件选择器（多选；目标目录由 openUploadPicker 预置） */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="files-upload-input"
        className="hidden"
        onChange={(e) => void onFilesPicked(e.target.files)}
      />
      {menuNode}
      {dialogNode}
    </div>
  );
}
