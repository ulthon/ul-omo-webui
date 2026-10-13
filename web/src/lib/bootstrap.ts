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

/** 拉取会话列表（q/archived 取 store 当前值；列表固定含 fork，服务端已无 view 参数）：
 * 全局视图（allMode，todo 10 侧栏默认）委托 store 聚合分支——项目切换后侧栏保持全局平铺；
 * 否则保持单项目现状路径。 */
export async function refreshSessions(): Promise<void> {
  if (useSessionsStore.getState().allMode) {
    return useSessionsStore.getState().refreshSessions();
  }
  const { currentProject } = useUiStore.getState();
  if (!currentProject) return;
  const { archived, q, setLoading } = useSessionsStore.getState();
  setLoading(true);
  try {
    const res = await api.listSessions({ project: currentProject, archived, q: q || undefined });
    useSessionsStore.getState().setSessions(currentProject, res.sessions);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      useUiStore.getState().showToast("会话列表加载失败", "error");
    }
  } finally {
    useSessionsStore.getState().setLoading(false);
  }
}

/** 拉取项目模型列表并应用展示回退（openProject 与轻量跨项目切换共用）：
 * 无选中模型时回落列表首项仅作展示默认（不回写 meta，避免把默认值冒充用户选择） */
export async function loadProjectModels(path: string): Promise<void> {
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
  await loadProjectModels(path);
}

/** 登录后主布局初始引导：项目列表 + 落最近项目 */
export async function bootstrap(): Promise<void> {
  const ui = useUiStore.getState();
  const projectsRes = await api.listProjects();
  ui.setProjects(projectsRes.projects);

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
  if (!latest) return;
  // 死项目守卫（W1 缺陷 #2）：上次项目目录已不存在时静默跳过——不 PATCH lastOpenedAt、
  // 不 openProject、不弹 toast，避免启动即报错；下次打开其他项目自然刷新 last_opened_at。
  if (latest.missing) {
    console.info("[senpi-webui] 上次项目路径已不存在，跳过自动打开:", latest.projectPath);
    return;
  }
  await openProject(latest.projectPath);
}
