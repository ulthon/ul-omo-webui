// 目录树（todo 16；W5 todo 14 放开到文件系统根）：不受 project 约束的独立组件，
// 消费 /api/fs/browse（仅目录；服务端为非根目录列表头部合成 ".." 父目录项，根目录不含），
// 与 fs/tree（项目内相对路径）不同源，故不复用 FileTree 本体。
// 懒加载与状态三件套（children/expanded/loading 同一对象整体替换）沿用 todo 20 FileTree 模式；
// 请求函数可注入（单测）。行点击 = 选中 + 未展开时下钻；chevron 单独承担展开/收起。
// ".." 行以 folder-up 图标区分（置顶由服务端合成顺序保证）。
// 已注册项目行置灰 + "已添加"徽标：禁止选中（onSelect 不触发）但保留下钻导航。
// DirectoryPickerDialog（docs08-r3 任务 20 重做，OpenChamber 式联动）：顶部路径输入框
// （停顿 300ms → fsBrowse 刷新列表；Enter 立即跳转；非法路径行内报错保留原列表）+
// 中部单层目录列表（服务端 ".." 行保留为列表首行）：单击=选中（确认钮启用）、
// 双击目录=下钻（列表与路径框同步）；已注册目录置灰 + "已添加"徽标禁选（仍可下钻）；
// Show hidden 开关默认隐藏 entry.hidden 项；确认回填 add-project-dialog 路径输入，
// 路径不存在（404）时确认钮变"新建并添加"→ addProject(path, true) 建目录并注册。
// 390 移动端全屏（h-dvh 覆盖类同 FilePickerDialog）；重开弹窗条件挂载即全新初始态。
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, Folder, FolderOpen, FolderUp, LoaderCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiError, type FsBrowseEntry, type FsBrowseResponse } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
// tSnap：异步续体（promise 回调）取词用快照态；渲染期文本走 useT 响应式
import { t as tSnap, useT } from "@/i18n/i18n";
import {
  initialDirTree,
  isAbsoluteInput,
  normalizeBrowsePath,
  PICKER_DEBOUNCE_MS,
  treeCollapse,
  treeExpand,
  treeLoaded,
  treeLoadFailed,
  type DirTreeData,
  type DirTreeKey,
} from "./directory-tree-logic";

export type DirTreeFetcher = (path?: string) => Promise<FsBrowseResponse>;

const NO_REGISTERED: ReadonlySet<string> = new Set<string>();

interface DirRowProps {
  path: DirTreeKey;
  entry: FsBrowseEntry;
  depth: number;
  data: DirTreeData;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  toggle: (path: DirTreeKey) => void;
  /** 已注册项目 realpath 集合：命中行置灰禁选（仍可展开下钻） */
  registeredPaths: ReadonlySet<string>;
}

function DirRow({ path, entry, depth, data, selectedPath, onSelect, toggle, registeredPaths }: DirRowProps) {
  const t = useT();
  const expanded = data.expanded.has(path);
  const loading = data.loading.has(path);
  const children = data.children.get(path);
  const selected = selectedPath === path;
  // ".." 行 = 纯上行导航：path 与父目录真实行共享键，若可展开会与父目录的展开态互相嵌套
  // （父展开 → 孙列表里的 ".." 同键已展开 → 又渲染父的 children → 无限递归），故禁展开、仅选中。
  const isParent = entry.name === "..";
  const rowExpanded = isParent ? false : expanded;
  const registered = registeredPaths.has(path);

  return (
    <div>
      <div
        data-testid={`dir-row-${path}`}
        role="treeitem"
        aria-selected={selected || undefined}
        aria-expanded={isParent ? undefined : rowExpanded}
        className={`flex h-11 items-center gap-0.5 rounded-lg pr-1.5 transition-colors hover:bg-muted ${
          selected ? "bg-muted text-foreground" : ""
        }`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {isParent ? (
          <span className="w-8 shrink-0 self-stretch" aria-hidden="true" />
        ) : (
          <button
            type="button"
            data-testid={`dir-toggle-${path}`}
            aria-label={`${expanded ? t("fileTree.tree.collapse") : t("fileTree.tree.expand")} ${entry.name}`}
            onClick={() => toggle(path)}
            className="flex w-8 shrink-0 items-center justify-center self-stretch text-muted-foreground transition-colors hover:bg-muted"
          >
            {loading ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <ChevronRight className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`} />
            )}
          </button>
        )}
        <button
          type="button"
          data-testid={`dir-name-${path}`}
          aria-disabled={registered || undefined}
          onClick={() => {
            if (!registered) onSelect(path);
            if (!isParent && !expanded) toggle(path);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded-md text-left text-sm transition-colors"
        >
          {isParent ? (
            <FolderUp className="size-4 shrink-0 text-muted-foreground" />
          ) : expanded ? (
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className={`min-w-0 truncate ${registered ? "text-muted-foreground/60" : ""}`}>
            {entry.name}
          </span>
          {registered && (
            <span
              data-testid={`dir-added-${path}`}
              className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
            >
              {t("fileTree.tree.addedBadge")}
            </span>
          )}
        </button>
      </div>
      {rowExpanded &&
        (children ?? []).map((child) => (
          <DirRow
            key={child.path}
            path={child.path}
            entry={child}
            depth={depth + 1}
            data={data}
            selectedPath={selectedPath}
            onSelect={onSelect}
            toggle={toggle}
            registeredPaths={registeredPaths}
          />
        ))}
    </div>
  );
}

export function DirectoryTree({
  selectedPath,
  onSelect,
  fetchDir = api.fsBrowse,
  registeredPaths = NO_REGISTERED,
}: {
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** 可注入（单测）；缺省走 /api/fs/browse */
  fetchDir?: DirTreeFetcher;
  /** 已注册项目 realpath 集合：命中行置灰 + "已添加"徽标 + 禁选可进入 */
  registeredPaths?: ReadonlySet<string>;
}) {
  // 三件套装同一对象整体替换（todo 20 模式）；根键 "" 初始即在加载中，挂载后由 effect 发起请求
  const [data, setData] = useState<DirTreeData>(initialDirTree);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    (path: DirTreeKey) => {
      fetchDir(path === "" ? undefined : path)
        .then((res) => {
          setData((prev) => treeLoaded(prev, path, res.entries));
          setLoadError(null);
        })
        .catch((err: unknown) => {
          setData((prev) => treeLoadFailed(prev, path));
          setLoadError(err instanceof Error ? err.message : tSnap("fileTree.tree.loadFailed"));
        });
    },
    [fetchDir],
  );

  useEffect(() => {
    load("");
  }, [load]);

  const toggle = useCallback(
    (path: DirTreeKey) => {
      setData((prev) => {
        if (prev.expanded.has(path)) return treeCollapse(prev, path);
        return treeExpand(prev, path);
      });
      // 懒加载：展开且无缓存时拉取该层（读取当前快照判断，避免在 setState 内发请求）
      if (!data.expanded.has(path) && data.children.get(path) == null && !data.loading.has(path)) {
        load(path);
      }
    },
    [data.expanded, data.children, data.loading, load],
  );

  const t = useT();
  const root = data.children.get("");
  const rootLoading = data.loading.has("");

  return (
    <div data-testid="directory-tree" role="tree" aria-label={t("fileTree.tree.serverTreeAria")} className="min-h-0">
      {loadError && (
        <p data-testid="dir-tree-error" className="px-2 py-1 text-xs text-destructive">
          {loadError}
        </p>
      )}
      {root === undefined || rootLoading ? (
        <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
        </div>
      ) : !root || root.length === 0 ? (
        <div className="p-3 text-sm text-muted-foreground">{t("fileTree.tree.empty")}</div>
      ) : (
        root.map((entry) => (
          <DirRow
            key={entry.path}
            path={entry.path}
            entry={entry}
            depth={0}
            data={data}
            selectedPath={selectedPath}
            onSelect={onSelect}
            toggle={toggle}
            registeredPaths={registeredPaths}
          />
        ))
      )}
    </div>
  );
}

/** 目录选择弹窗：确认回传所选目录路径；条件挂载 Body，重开即全新初始态 */
export function DirectoryPickerDialog({
  open,
  onOpenChange,
  onConfirm,
  fetchDir,
  registeredPaths,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (path: string) => void;
  fetchDir?: DirTreeFetcher;
  /** 已注册项目 realpath 集合：命中行置灰 + "已添加"徽标 + 禁选（仍可双击下钻） */
  registeredPaths?: ReadonlySet<string>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          data-testid="directory-picker"
          className="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-3 rounded-none p-3 sm:top-1/2 sm:left-1/2 sm:h-[85vh] sm:max-h-[85vh] sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
        >
          <PickerBody
            onConfirm={(path) => {
              onConfirm(path);
              onOpenChange(false);
            }}
            onClose={() => onOpenChange(false)}
            fetchDir={fetchDir}
            registeredPaths={registeredPaths}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

/** 确认钮状态：pick=选择此目录（回填）；create=路径不存在，新建并添加（建目录+注册） */
type ConfirmState = { kind: "pick"; target: string } | { kind: "create"; target: string } | null;

function PickerBody({
  onConfirm,
  onClose,
  fetchDir,
  registeredPaths = NO_REGISTERED,
}: {
  onConfirm: (path: string) => void;
  onClose: () => void;
  fetchDir?: DirTreeFetcher;
  registeredPaths?: ReadonlySet<string>;
}) {
  const t = useT();
  const fetchDirFn = fetchDir ?? api.fsBrowse;
  const [pathInput, setPathInput] = useState("/");
  const [entries, setEntries] = useState<FsBrowseEntry[]>([]);
  const [browsing, setBrowsing] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  /** 最后一次对 pathInput 的浏览 404：确认钮变"新建并添加" */
  const [notFound, setNotFound] = useState(false);
  /** 成功浏览过的判重键（normalizeBrowsePath 形态），用于跳过同形重复请求 */
  const [browsedKey, setBrowsedKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 竞态守卫：过期响应丢弃；在飞判重键避免"立即跳转 + 防抖到期"双发同键请求
  const seqRef = useRef(0);
  const inFlightRef = useRef<string | null>(null);
  const browse = useCallback(
    (target: string) => {
      const key = normalizeBrowsePath(target);
      if (target.length === 0) {
        seqRef.current += 1;
        inFlightRef.current = null;
        setBrowsing(false);
        setListError(null);
        setNotFound(false);
        return;
      }
      if (!isAbsoluteInput(target)) {
        seqRef.current += 1;
        inFlightRef.current = null;
        setBrowsing(false);
        setListError(t("fileTree.tree.notAbsolute"));
        setNotFound(false);
        return;
      }
      if (inFlightRef.current === key) return;
      if (key === browsedKey && !notFound && listError === null) return;
      const seq = ++seqRef.current;
      inFlightRef.current = key;
      setBrowsing(true);
      setListError(null);
      setSelected(null);
      fetchDirFn(target)
        .then((res) => {
          if (seq !== seqRef.current) return;
          inFlightRef.current = null;
          setEntries(res.entries);
          setBrowsedKey(key);
          setBrowsing(false);
          setNotFound(false);
          setListError(res.error === "eacces" ? t("fileTree.tree.notReadable") : null);
        })
        .catch((err: unknown) => {
          if (seq !== seqRef.current) return;
          inFlightRef.current = null;
          setBrowsing(false);
          if (err instanceof ApiError && err.status === 404) {
            setNotFound(true);
            setListError(t("fileTree.tree.notFound", { path: target }));
          } else {
            setNotFound(false);
            setListError(err instanceof Error ? err.message : t("fileTree.tree.loadFailed"));
          }
        });
    },
    [fetchDirFn, browsedKey, notFound, listError, t],
  );
  const browseRef = useRef(browse);
  useEffect(() => {
    browseRef.current = browse;
  });

  // 路径框停顿 300ms 联动列表（非法路径在 browse 内行内报错且保留原列表）；
  // ref 更新 effect 声明在前，本 effect 排定时器时读到的已是最新 browse
  useEffect(() => {
    const timer = setTimeout(() => browseRef.current(pathInput), PICKER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [pathInput]);

  /** 立即跳转（Enter / 双击下钻）：路径框与列表同步，防抖定时器到期后按判重键跳过 */
  const jump = useCallback((target: string) => {
    setPathInput(target);
    browseRef.current(target);
  }, []);

  // 确认目标：单击选中行 > 输入路径不存在（新建并添加）> 当前已浏览目录
  const confirmState: ConfirmState = selected
    ? { kind: "pick", target: selected }
    : notFound
      ? { kind: "create", target: pathInput }
      : browsedKey !== null && normalizeBrowsePath(pathInput) === browsedKey
        ? { kind: "pick", target: pathInput }
        : null;

  /** 新建并添加：服务端 mkdir -p（父级可写校验）后注册；成功刷新项目集合并回填 */
  const createAndAdd = async (target: string) => {
    const path = target.trim();
    setCreating(true);
    setCreateError(null);
    try {
      await api.addProject(path, true);
      const { projects } = await api.listProjects();
      useUiStore.getState().setProjects(projects);
      onConfirm(path);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t("fileTree.tree.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const visible = showHidden ? entries : entries.filter((e) => !e.hidden);

  const onPathKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      browseRef.current(pathInput);
    }
  };

  return (
    <>
      <DialogHeader className="shrink-0 gap-1.5">
        <DialogTitle>{t("fileTree.tree.dialogTitle")}</DialogTitle>
        <DialogDescription className="text-xs">
          {t("fileTree.tree.dialogHint")}
        </DialogDescription>
      </DialogHeader>

      <Input
        value={pathInput}
        onChange={(e) => {
          setPathInput(e.target.value);
          setCreateError(null);
        }}
        onKeyDown={onPathKeyDown}
        placeholder={t("fileTree.tree.pathPlaceholder")}
        className="shrink-0 font-mono text-sm"
        data-testid="dir-picker-path"
        aria-label={t("fileTree.tree.pathAria")}
        aria-invalid={listError !== null || undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {listError && (
        <p data-testid="dir-picker-error" className="shrink-0 text-xs text-destructive">
          {listError}
        </p>
      )}
      {createError && (
        <p data-testid="dir-picker-create-error" className="shrink-0 text-xs text-destructive">
          {createError}
        </p>
      )}

      <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={showHidden}
          onChange={(e) => setShowHidden(e.target.checked)}
          data-testid="dir-picker-show-hidden"
        />
        {t("fileTree.tree.showHidden")}
      </label>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border p-1" data-testid="dir-picker-list" role="listbox" aria-label={t("fileTree.tree.listAria")}>
        {browsing ? (
          <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
          </div>
        ) : visible.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">
            {listError === null && entries.length > 0 ? t("fileTree.tree.allHiddenNote") : t("fileTree.tree.empty")}
          </div>
        ) : (
          visible.map((entry) => {
            const registered = registeredPaths.has(entry.path);
            const isParent = entry.name === "..";
            return (
              <div
                key={entry.path}
                data-testid={`dir-row-${entry.path}`}
                role="option"
                aria-selected={selected === entry.path || undefined}
                aria-disabled={registered || undefined}
                title={registered ? t("fileTree.tree.addedTitle") : undefined}
                onClick={() => {
                  if (!registered) setSelected(entry.path);
                }}
                onDoubleClick={() => jump(entry.path)}
                className={`flex h-11 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-sm transition-colors ${
                  selected === entry.path ? "bg-muted" : "hover:bg-muted/60"
                }`}
              >
                {isParent ? (
                  <FolderUp className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className={`min-w-0 truncate font-mono ${registered ? "text-muted-foreground/60" : ""}`}>
                  {entry.name}
                </span>
                {registered && (
                  <span
                    data-testid={`dir-added-${entry.path}`}
                    className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
                  >
                    {t("fileTree.tree.addedBadge")}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2">
        <p data-testid="dir-picker-selected" className="truncate font-mono text-xs text-muted-foreground">
          {confirmState ? confirmState.target : t("fileTree.tree.noSelection")}
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="dir-picker-cancel"
            onClick={onClose}
            className="flex h-11 items-center rounded-lg border px-4 text-sm transition-colors hover:bg-muted"
          >
            {t("fileTree.tree.cancel")}
          </button>
          <button
            type="button"
            data-testid="dir-picker-confirm"
            disabled={confirmState === null || browsing || creating}
            onClick={() => {
              if (!confirmState) return;
              if (confirmState.kind === "create") void createAndAdd(confirmState.target);
              else onConfirm(confirmState.target);
            }}
            className="flex h-11 items-center rounded-lg bg-primary px-4 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            {confirmState?.kind === "create"
              ? creating
                ? t("fileTree.tree.creating")
                : t("fileTree.tree.createAndAdd")
              : t("fileTree.tree.pickThis")}
          </button>
        </div>
      </div>
    </>
  );
}
