// 项目偏好防抖持久化（todo 22 模型、W2 todo 8 思考级别）：连续切换只落最后一次
// （latest-wins）；触发时再读 store 当前值——项目从 sessions store 的当前选中会话
// 派生（projectOfSession(byProject, selectedId)，会话根架构 W1 任务 4：项目不再
// 读 ui 顶栏字段），防抖期间切换会话时写入的是新选中会话所属项目自己的当前
// 选择（与项目切换路径应用的偏好一致，幂等无害）；派生为 null（无选中会话或未
// 命中）时静默跳过。原 topbar 模块内实现迁移至此，供顶栏与输入区 chip 两个选择
// 面共用同一条持久化路径；delayMs 形参仅供单测加速。
import { api, ApiError } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { projectOfSession, useSessionsStore } from "@/stores/sessions";
import { t } from "@/i18n/i18n";

export const PREFERENCE_DEBOUNCE_MS = 600;

let modelTimer: ReturnType<typeof setTimeout> | null = null;
let thinkingTimer: ReturnType<typeof setTimeout> | null = null;

/** 模型偏好 latest-wins PATCH preferredModel；成功后同步本地 projects（切走再切回时
 * 会话 select 直接读到最新值，不等服务端 refetch）。 */
export function scheduleModelPreferencePersist(delayMs = PREFERENCE_DEBOUNCE_MS): void {
  if (modelTimer) clearTimeout(modelTimer);
  modelTimer = setTimeout(() => {
    modelTimer = null;
    const ui = useUiStore.getState();
    // 触发时派生目标项目：跟随当前选中会话（防抖期间切走会话则落新会话的项目）
    const sessions = useSessionsStore.getState();
    const project = projectOfSession(sessions.byProject, sessions.selectedId);
    const model = ui.selectedModel;
    if (!project || !model) return;
    api
      .patchProjectMeta({ path: project, preferredModel: model })
      .then(() => {
        const cur = useUiStore.getState();
        cur.setProjects(cur.projects.map((p) => (p.projectPath === project ? { ...p, preferredModel: model } : p)));
      })
      .catch((err: unknown) => {
        if (!(err instanceof ApiError && err.status === 401)) {
          useUiStore.getState().pushGlobalError(t("common.lib.saveModelPrefFailed"));
        }
      });
  }, delayMs);
}

/** 思考级别偏好 latest-wins PATCH preferredThinkingLevel（W2 todo 8，服务端 todo 7 起
 * 接受该字段；仅 chip 主动选择触发——引擎 thinking_level_changed 回显是显示层同步，
 * 不走此处，不落偏好）。 */
export function scheduleThinkingPreferencePersist(delayMs = PREFERENCE_DEBOUNCE_MS): void {
  if (thinkingTimer) clearTimeout(thinkingTimer);
  thinkingTimer = setTimeout(() => {
    thinkingTimer = null;
    const ui = useUiStore.getState();
    // 触发时派生目标项目：跟随当前选中会话（防抖期间切走会话则落新会话的项目）
    const sessions = useSessionsStore.getState();
    const project = projectOfSession(sessions.byProject, sessions.selectedId);
    const level = ui.selectedThinkingLevel;
    if (!project || !level) return;
    api
      .patchProjectMeta({ path: project, preferredThinkingLevel: level })
      .then(() => {
        const cur = useUiStore.getState();
        cur.setProjects(
          cur.projects.map((p) => (p.projectPath === project ? { ...p, preferredThinkingLevel: level } : p)),
        );
      })
      .catch((err: unknown) => {
        if (!(err instanceof ApiError && err.status === 401)) {
          useUiStore.getState().pushGlobalError(t("common.lib.saveThinkingPrefFailed"));
        }
      });
  }, delayMs);
}

/** 取消未落定的防抖写入（单测隔离用，防跨用例 / 跨文件泄漏 PATCH） */
export function cancelPendingPreferencePersist(): void {
  if (modelTimer) clearTimeout(modelTimer);
  modelTimer = null;
  if (thinkingTimer) clearTimeout(thinkingTimer);
  thinkingTimer = null;
}
