// 模型循环选择（r9 2026-10-26 批次，对齐 native 键位）：Ctrl+P / Shift+Ctrl+P 在
// CLI 收藏（favoriteModels，服务端已归一 "provider/model" 并剥 ":thinkingLevel" 后缀）
// 内 wrap 循环。nextFavoriteModel 是纯函数（无 store 依赖，单测直测）；selectModel 是
// chips.tsx 弹层选中内联逻辑油出的共用过程——chip 点击与键盘循环走同一条
// 「写 selectedModel + 防抖持久化」路径（同值不重复写、不触发持久化）。
import { diag } from "@/lib/diag";
import { scheduleModelPreferencePersist, scheduleThinkingPreferencePersist } from "@/lib/preferences";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

export type CycleDirection = 1 | -1;

/** 归一比较键：前后空白与大小写差异不打断定位（收藏项与 selectedModel 两侧同归一） */
function normalizeModelValue(value: string): string {
  return value.trim().toLowerCase();
}

/** 收藏列表内的下一项：定位当前选中（归一比较），+1/-1 wrap。当前不在列表内时
 * 正向取首项（「从 0 起」）、反向取末项（方向对称的入列读法）；列表为空返回
 * null（调用方负责 toast + 打开弹层兜底）。 */
export function nextFavoriteModel(
  favoriteModels: readonly string[],
  selectedModel: string | null,
  direction: CycleDirection,
): string | null {
  if (favoriteModels.length === 0) return null;
  const idx =
    selectedModel === null
      ? -1
      : favoriteModels.findIndex((v) => normalizeModelValue(v) === normalizeModelValue(selectedModel));
  if (idx === -1) return direction === 1 ? favoriteModels[0] : favoriteModels[favoriteModels.length - 1];
  return favoriteModels[(idx + direction + favoriteModels.length) % favoriteModels.length];
}

/** 选中模型并防抖持久化偏好（chip 点击 / Ctrl+P 循环 / 顶栏下拉共用；chips.tsx 原内联逻辑油出） */
export function selectModel(value: string): void {
  const ui = useUiStore.getState();
  if (ui.selectedModel === value) return;
  // 选中即留痕（2026-11-18 用户反馈「切了但没换」排查）：与 thinking-level user_change
  // 同款来源分级日志。选中只是本地偏好，生效在下一条 prompt（api.ts 注入 + 回执比对
  // receipt_mismatch）；生效/拒绝帧另有 SSE model_changed / model_change_rejected 埋点。
  diag.info("model-select", "user_change", {
    from: ui.selectedModel ?? "unknown",
    to: value,
    session: useSessionsStore.getState().selectedId ?? "unknown",
  });
  // 手选粘性（模型粘性批 2026-11-18）：显式手选对该会话记粘性——切会话（applyProjectDecision）
  // 与消息水合不再把手选洗回已生效模型；选回已生效模型时解除（无粘性需求）；生效
  // （setAppliedModel 同值）自动解除
  const sess = useSessionsStore.getState().selectedId;
  if (sess !== null) {
    const applied = useSessionsStore.getState().appliedModels[sess] ?? null;
    if (value !== applied) useSessionsStore.getState().setModelSticky(sess, value);
    else useSessionsStore.getState().clearModelSticky(sess);
  }
  ui.setSelectedModel(value);
  scheduleModelPreferencePersist();
}

/** 收藏切换（思考档三链 C）：模型写入 + 收藏档位填思考档（pickThinkingLevel 显式
 * 手选路径置位，引擎回显不再覆盖）；档位随下次 prompt 生效，同 composer 手选一条
 * 持久化链。收藏无档位（旧服务端/无后缀条目）不动当前档位。 */
export function selectFavoriteModel(value: string): void {
  selectModel(value);
  const ui = useUiStore.getState();
  const level = ui.favoriteLevels[value];
  if (level) {
    ui.pickThinkingLevel(level);
    scheduleThinkingPreferencePersist();
  }
}
