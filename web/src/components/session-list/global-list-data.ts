// 全局平铺列表纯逻辑（todo 10）：分组排序、最近会话选取、折叠记忆、跨项目点击判定、侧栏定位事件。
// 抽成纯函数便于单测（web/tests/global-list.test.ts）；localStorage 薄封装带环境守卫，
// 存储实例可注入（bun 测试无 DOM，组件路径缺省用浏览器 localStorage）。
import type { SessionListItem } from "@/lib/api";

/** 最近会话条数（计划决策 7：跨项目按 modified 取最新 8 条） */
export const RECENT_LIMIT = 8;

/** 折叠记忆 localStorage key 前缀（完整 key = 前缀 + 项目绝对路径） */
export const COLLAPSE_PREFIX = "senpi-webui:collapse:";

/** 侧栏定位事件（topbar 项目切换器 → session-list 展开该组并滚动置顶） */
export const LOCATE_EVENT = "senpi-webui:locate-project";

/** 项目偏好最小形状（ui.projects 的子集，便于单测构造） */
export interface ProjectPreference {
  projectPath: string;
  preferredModel: string | null;
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

/** 分组排序：当前项目组最前，其余按各组最新 modified 降序（计划 todo 10） */
export function groupOrder(
  projectPaths: string[],
  byProject: Record<string, SessionListItem[]>,
  currentProject: string | null,
): string[] {
  const rest = projectPaths.filter((p) => p !== currentProject);
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
