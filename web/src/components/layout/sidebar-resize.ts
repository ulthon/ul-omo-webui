// 左侧栏宽度记忆（r9 2026-10-26 批次 w2-t7）：逻辑抽出与组件解耦（right-rail 的
// 助手与组件同文件是历史形态，此处独立成 ts 免去 react/only-export-components 豁免）。
// 持久化与右栏同源同风格：localStorage 键 ul-omo-webui:sidebar-width，仅桌面
// （lg+）展开档消费；手机抽屉 w-full 不受影响（宽度经 CSS 变量只在 lg 断点生效）。
// 读取缺失/非整数/越界一律落回默认 288；写入失败（storage 不可用）静默降级。

/** localStorage 键与拖宽边界（px），命名风格对齐 right-rail.tsx */
export const SIDEBAR_WIDTH_KEY = "ul-omo-webui:sidebar-width";
export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 288;

/** 宽度记忆读取：无记录/手写异常值（9999/0/非数值等）落回默认 288 */
export function readSidebarWidthPreference(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < SIDEBAR_WIDTH_MIN || value > SIDEBAR_WIDTH_MAX) {
      return SIDEBAR_WIDTH_DEFAULT;
    }
    return value;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

/** 宽度记忆写入：仅在拖拽结束（pointerup）、键盘微调与双击重置路径调用 */
export function writeSidebarWidthPreference(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // storage 不可用：忽略（页面生命周期内 state 仍生效）
  }
}

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}
