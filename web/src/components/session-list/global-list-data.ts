// 全局平铺列表纯逻辑（todo 10）：分组排序、最近会话选取、折叠记忆、跨项目点击判定、侧栏定位事件。
// 抽成纯函数便于单测（web/tests/global-list.test.ts）；localStorage 薄封装带环境守卫，
// 存储实例可注入（bun 测试无 DOM，组件路径缺省用浏览器 localStorage）。
import type { SessionListItem } from "@/lib/api";

/** 最近会话条数（计划决策 7：跨项目按 modified 取最新 8 条） */
export const RECENT_LIMIT = 8;

/** 项目组默认可见顶层会话条数（r9 wave1：分组默认只渲染前 10 条，超出出「加载更多」） */
export const GROUP_VISIBLE_LIMIT = 10;
/** 「加载更多」每次追加的可见条数 */
export const GROUP_VISIBLE_STEP = 20;

/** 折叠记忆 localStorage key 前缀（完整 key = 前缀 + 项目绝对路径） */
export const COLLAPSE_PREFIX = "ul-omo-webui:collapse:";

/** 侧栏定位事件（topbar 项目切换器 → session-list 展开该组并滚动置顶） */
export const LOCATE_EVENT = "ul-omo-webui:locate-project";

/** 项目偏好最小形状（ui.projects 的子集，便于单测构造） */
export interface ProjectPreference {
  projectPath: string;
  preferredModel: string | null;
}

/** 侧栏项目排序档位（C16 docs08-r3 todo 9）：
 * activity=现状（各组最新会话 modified 降序）；added=注册时间 createdAt 升序
 * （存量行 createdAt 同为迁移时刻，退化为 lastOpenedAt 稳定序）；manual=手动顺序。
 * 档位与手动顺序存 meta_kv（sidebar.projectSort / sidebar.projectOrder），跨设备一致。 */
export type ProjectSortMode = "activity" | "added" | "manual";

/** meta_kv 键名（走 GET/PUT /api/settings） */
export const PROJECT_SORT_KV = "sidebar.projectSort";
export const PROJECT_ORDER_KV = "sidebar.projectOrder";

/** kv 值解析：缺失/未知值一律回退 activity（对抗 malformed input 不崩） */
export function parseProjectSort(raw: string | null | undefined): ProjectSortMode {
  return raw === "added" || raw === "manual" ? raw : "activity";
}

/** 手动顺序 kv 值解析（JSON 路径数组）：非法 JSON/非数组/非字符串项返回 null（回退当前
 * 档规则），重复项去重；未知路径在 groupOrder 消费时忽略，此处不做注册集校验 */
export function parseManualProjectOrder(raw: string | null | undefined): string[] | null {
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string" || out.includes(item)) continue;
      out.push(item);
    }
    return out;
  } catch {
    return null;
  }
}

type CollapseStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): CollapseStorage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

/** 组内最新 modified（空组为空串，排序恒排尾部） */
export function latestModified(list: SessionListItem[]): string {
  let latest = "";
  for (const s of list) {
    if (s.modified > latest) latest = s.modified;
  }
  return latest;
}

/** 分组排序（C16 docs08-r3 todo 9 参数化）：当前项目组置顶规则三档通用、不变。
 * activity（缺省）=其余按各组最新 modified 降序；added=按项目注册时间 createdAt 升序，
 * createdAt 相同（存量迁移行同值）退化为 lastOpenedAt 升序稳定序；manual=手动顺序
 * （kv 数组序），未列项目与已注销路径按 activity 规则追加/忽略。 */
export function groupOrder(
  projectPaths: string[],
  byProject: Record<string, SessionListItem[]>,
  currentProject: string | null,
  opts?: {
    mode?: ProjectSortMode;
    /** 注册元数据（createdAt/lastOpenedAt），added 档用；缺省视为空值走稳定退化序 */
    meta?: Record<string, { createdAt: string | null; lastOpenedAt: string | null }>;
    /** 手动顺序（kv 解析结果），manual 档用 */
    manualOrder?: string[];
  },
): string[] {
  const mode = opts?.mode ?? "activity";
  const rest = projectPaths.filter((p) => p !== currentProject);

  if (mode === "manual" && opts?.manualOrder) {
    const known = new Set(rest);
    const seen = new Set<string>();
    const listed = opts.manualOrder.filter((p) => known.has(p) && !seen.has(p) && (seen.add(p), true));
    const unlisted = rest.filter((p) => !seen.has(p));
    unlisted.sort((a, b) => latestModified(byProject[b] ?? []).localeCompare(latestModified(byProject[a] ?? [])));
    const ordered = [...listed, ...unlisted];
    return currentProject && projectPaths.includes(currentProject) ? [currentProject, ...ordered] : ordered;
  }

  if (mode === "added") {
    const meta = opts?.meta ?? {};
    rest.sort((a, b) => {
      const ca = meta[a]?.createdAt ?? "";
      const cb = meta[b]?.createdAt ?? "";
      if (ca !== cb) return ca < cb ? -1 : 1;
      // 存量行 createdAt 同为迁移时刻 → 退化 lastOpenedAt 稳定排序（设置区文案注明）
      const la = meta[a]?.lastOpenedAt ?? "";
      const lb = meta[b]?.lastOpenedAt ?? "";
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    return currentProject && projectPaths.includes(currentProject) ? [currentProject, ...rest] : rest;
  }

  rest.sort((a, b) => latestModified(byProject[b] ?? []).localeCompare(latestModified(byProject[a] ?? [])));
  if (currentProject && projectPaths.includes(currentProject)) return [currentProject, ...rest];
  return rest;
}

export function flattenSessions(byProject: Record<string, SessionListItem[]>): SessionListItem[] {
  const out: SessionListItem[] = [];
  for (const list of Object.values(byProject)) out.push(...list);
  return out;
}

/** 最近会话：跨项目按 modified 降序取前 limit 条（置顶会话自然参与，不做特殊排序） */
export function recentTop(all: SessionListItem[], limit: number = RECENT_LIMIT): SessionListItem[] {
  return [...all].sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit);
}

/** 读折叠记忆：未写入 null；写入值 "1"=折叠 "0"=展开 */
export function readCollapsed(projectPath: string, storage?: CollapseStorage | null): boolean | null {
  const ls = storage ?? defaultStorage();
  if (!ls) return null;
  const raw = ls.getItem(COLLAPSE_PREFIX + projectPath);
  if (raw === null) return null;
  return raw === "1";
}

export function writeCollapsed(projectPath: string, collapsed: boolean, storage?: CollapseStorage | null): void {
  const ls = storage ?? defaultStorage();
  if (!ls) return;
  ls.setItem(COLLAPSE_PREFIX + projectPath, collapsed ? "1" : "0");
}

/** 组展开态：显式覆盖（本次会话内的点按）优先，其次 localStorage 记忆，
 * 都缺省时当前项目展开、其余折叠（计划 todo 10 默认规则） */
export function isGroupExpanded(
  projectPath: string,
  currentProject: string | null,
  override: boolean | undefined,
  storage?: CollapseStorage | null,
): boolean {
  if (override !== undefined) return override;
  const remembered = readCollapsed(projectPath, storage);
  if (remembered !== null) return !remembered;
  return projectPath === currentProject;
}

/** 跨项目点击判定（计划 todo 10 统一 handler 的决策核）：
 * 同项目仅选中；跨项目轻量切换并携带目标项目偏好模型（跳过 lastOpenedAt PATCH） */
export function crossProjectDecision(
  sessionProject: string,
  currentProject: string | null,
  projects: ProjectPreference[],
): { switchProject: boolean; preferredModel: string | null } {
  if (sessionProject === currentProject) return { switchProject: false, preferredModel: null };
  const preferred = projects.find((p) => p.projectPath === sessionProject)?.preferredModel ?? null;
  return { switchProject: true, preferredModel: preferred };
}

/** 触发侧栏定位（topbar 调用）：session-list 监听后展开该组并滚动置顶 */
export function locateProjectInSidebar(project: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(LOCATE_EVENT, { detail: project }));
}
