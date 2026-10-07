// 应用引导与项目打开：初始加载落到 last_opened_at 最新的项目（docs/01「最近打开/默认项目」），
// 顶栏切换项目与初始引导共用 openProject。
import { api, ApiError } from "@/lib/api";
import type { ProjectMeta } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";

/** 取 last_opened_at 最新的项目（服务端已按 DESC 排序，这里再兜底一次 NULL 排序差异） */
export function pickLatestProject(projects: ProjectMeta[]): ProjectMeta | null {
  let latest: ProjectMeta | null = null;
  for (const p of projects) {
    if (!latest || (p.lastOpenedAt ?? "") > (latest.lastOpenedAt ?? "")) latest = p;
  }
  return latest;
}

/** 拉取当前项目的会话列表（view/q/archived 取 store 当前值；todo 15 接搜索与视图切换） */
export async function refreshSessions(): Promise<void> {
  const { currentProject } = useUiStore.getState();
  if (!currentProject) return;
  const { view, archived, q, setLoading } = useSessionsStore.getState();
  setLoading(true);
  try {
    const res = await api.listSessions({ project: currentProject, view, archived, q: q || undefined });
    useSessionsStore.getState().setSessions(currentProject, res.sessions);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      useUiStore.getState().showToast("会话列表加载失败", "error");
    }
  } finally {
    useSessionsStore.getState().setLoading(false);
  }
}

/** 打开项目：设当前项目 → 更新 last_opened_at → 应用该项目模型偏好 → 刷新会话列表 → 拉模型列表 */
export async function openProject(path: string): Promise<void> {
  const ui = useUiStore.getState();
  ui.setCurrentProject(path);
  ui.setDrawerOpen(false);
  // 偏好先行（todo 22）：项目切换即应用该项目 preferred_model；无偏好项目先置空，
  // 模型列表到达后回落列表首项仅作展示默认（不回写 meta，避免把默认值冒充用户选择）
  const preferred = ui.projects.find((p) => p.projectPath === path)?.preferredModel ?? null;
  ui.setSelectedModel(preferred);

  try {
    await api.patchProjectMeta({ path, lastOpenedAt: new Date().toISOString() });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      ui.showToast("更新最近打开时间失败", "error");
    }
  }

  await refreshSessions();

  try {
    const { models } = await api.listModels(path);
    const cur = useUiStore.getState();
    cur.setModels(models);
    if (!cur.selectedModel && models.length > 0) {
      cur.setSelectedModel(`${models[0].provider}/${models[0].id}`);
    }
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      // 加载失败是"未知"而非"确认为空"：resetModels 不标记 modelsLoaded，发送防呆不误伤
      useUiStore.getState().resetModels();
    }
  }
}

/** 登录后主布局初始引导：agent 降级能力 + 项目列表 + 落最近项目 */
export async function bootstrap(): Promise<void> {
  const ui = useUiStore.getState();
  const projectsRes = await api.listProjects();
  ui.setProjects(projectsRes.projects);

  try {
    const agentsRes = await api.listAgents();
    ui.setAgentsDegraded(agentsRes.capabilities.agentsList === false);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      // agent 枚举本就降级，拉取失败不阻塞主流程
      ui.setAgentsDegraded(true);
    }
  }

  // 外链入口配置（todo 26）：kv 键 external-git-url / external-files-url，空值视为未配置（入口隐藏）。
  // 拉取失败不阻塞主流程（入口缺失无害，设置弹层保存后会更新 store）。
  try {
    const { settings } = await api.getSettings();
    ui.setExternalLinks({
      gitUrl: settings["external-git-url"]?.trim() || null,
      filesUrl: settings["external-files-url"]?.trim() || null,
    });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      // 静默：无外链配置时入口不渲染，属预期形态
    }
  }

  const latest = pickLatestProject(projectsRes.projects);
  if (latest) await openProject(latest.projectPath);
}
