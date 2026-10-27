// 项目跟随式文件管理页（builtin-file-management 任务 2）：fixed 全屏覆盖层形态同
// SettingsPage（shell 依据 ui store filesPageOpen 条件渲染，SSE 不中断）。
// 三栏：左=项目目录树（复用 file-tree.tsx，新增可选 onDirectoryOpen 同步中栏）；
// 中=当前目录文件列表（名称/大小/mtime/类型列，列头点击排序，目录恒优先；
// 单击目录进入、单击文件右栏预览）；右=FilePreview 复用（复用组件自带只读约束）。
// 页头：项目下拉（ui store projects，bootstrap 已从 GET /api/projects 填充；
// 空时兜底自拉一次）+ 当前路径面包屑。默认项目 = ui store currentProject
// （bootstrap openProject 写入，即最近活跃会话项目），无会话时取列表首个。
// 契约缺口（如实记录）：GET /api/fs/tree 仅回 name+type，无 size/mtime 字段——
// 服务端读面不在本任务允许改动范围，两列以 "—" 占位，size/mtime 排序退化为
// 名称序；服务端补字段后仅需删本文件 statGap 注释并接入真实值。
// 手机档（≤768px 显式断点）单栏层叠 + 段内切换钮；无写操作、无右键菜单（后续任务）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { api } from "@/lib/api";
import type { FsTreeEntry } from "@/lib/api";
import { useIsMobile } from "@/lib/use-is-mobile";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { useUiStore } from "@/stores/ui";
import { FileTree } from "@/components/file-tree/file-tree";
import { FilePreview } from "@/components/file-tree/file-preview";
import { Button } from "@/components/ui/button";

type SortKey = "name" | "size" | "mtime" | "type";
type SortDir = "asc" | "desc";
type MobilePane = "tree" | "list" | "preview";

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

/** 目录恒优先，再按排序键；size/mtime 无真实值（契约缺口见文件头），退化为名称序 */
function compareEntries(a: FsTreeEntry, b: FsTreeEntry, sort: SortState): number {
  const dirDelta = Number(b.type === "directory") - Number(a.type === "directory");
  if (dirDelta !== 0) return dirDelta;
  const sign = sort.dir === "asc" ? 1 : -1;
  const nameDelta = a.name.localeCompare(b.name);
  if (sort.key === "type") {
    const typeDelta = a.type.localeCompare(b.type);
    return typeDelta !== 0 ? sign * typeDelta : nameDelta;
  }
  // name / size / mtime：后两者暂无数据，统一名称序（升序翻转时仍反序展示，行为可预期）
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
    () => (loaded ? [...loaded].sort((a, b) => compareEntries(a, b, sort)) : null),
    [loaded, sort],
  );
  const toggleSort = (key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  };

  const [mobilePane, setMobilePane] = useState<MobilePane>("list");

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
    <div data-testid="files-tree-pane" className="flex min-h-0 flex-col overflow-y-auto">
      {project ? (
        <FileTree project={project} selectedPath={selected} onSelect={setSelected} onDirectoryOpen={onTreeDirectoryOpen} />
      ) : null}
    </div>
  );

  const listPane = (
    <div data-testid="files-list-pane" className="flex min-h-0 flex-col">
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
                    className="w-full truncate rounded text-left transition-colors hover:text-primary"
                    title={entry.name}
                  >
                    {entry.type === "directory" ? <span className="mr-1" aria-hidden>▸</span> : null}
                    {entry.name}
                  </button>
                </td>
                <td className="py-1.5 pr-2 text-muted-foreground">{t("files.list.notAvailable")}</td>
                <td className="py-1.5 pr-2 text-muted-foreground">{t("files.list.notAvailable")}</td>
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
    </div>
  );
}
