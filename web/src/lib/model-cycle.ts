// 模型循环选择（r9 2026-10-26 批次，对齐 native 键位）：Ctrl+P / Shift+Ctrl+P 在
// CLI 收藏（favoriteModels，服务端已归一 "provider/model" 并剥 ":thinkingLevel" 后缀）
// 内 wrap 循环。nextFavoriteModel 是纯函数（无 store 依赖，单测直测）；selectModel 是
// chips.tsx 弹层选中内联逻辑油出的共用过程——chip 点击与键盘循环走同一条
// 「写 selectedModel + 防抖持久化」路径（同值不重复写、不触发持久化）。
import { scheduleModelPreferencePersist } from "@/lib/preferences";
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

/** 选中模型并防抖持久化偏好（chip 点击 / Ctrl+P 循环共用；chips.tsx 原内联逻辑油出） */
export function selectModel(value: string): void {
  const ui = useUiStore.getState();
  if (ui.selectedModel === value) return;
  ui.setSelectedModel(value);
  scheduleModelPreferencePersist();
}
