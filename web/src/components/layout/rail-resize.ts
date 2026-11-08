// 右栏拖宽边界（#36）：上限自固定 560 放宽为视口相对——min(视口 70%, 1400)，
// 同时保证中间会话区最小可用宽 360px（上限再受 视口-360 钳制）。
// 仿 pages/files-resize.ts 抽出逻辑与组件解耦，纯函数便于单测；
// localStorage 记忆键与读写契约（pointerup / 键盘微调落盘）不变。
// lg 档视口 ≥1024：视口-360 = 664 ≥ 下限 320，max() 兜底仅防手算异常视口。

/** localStorage 键（沿用既有契约）与拖宽边界（px） */
export const RAIL_WIDTH_KEY = "ul-omo-webui:right-rail-width";
export const RAIL_WIDTH_MIN = 320;
/** 绝对上限与中间会话区最小可用宽 */
export const RAIL_WIDTH_ABS_MAX = 1400;
export const RAIL_SESSION_MIN = 360;
export const RAIL_WIDTH_DEFAULT = 384;

/** 纯函数：给定视口宽算右栏拖宽上限（下限 RAIL_WIDTH_MIN 兜底） */
export function railWidthMax(viewportWidth: number): number {
  const relative = Math.min(
    Math.round(viewportWidth * 0.7),
    RAIL_WIDTH_ABS_MAX,
    Math.max(viewportWidth - RAIL_SESSION_MIN, RAIL_WIDTH_MIN),
  );
  return Math.max(RAIL_WIDTH_MIN, relative);
}

/** 纯函数：拖宽实时钳制（下限 MIN、上限随视口），四舍五入取整 */
export function clampRailWidth(width: number, viewportWidth: number): number {
  return Math.min(railWidthMax(viewportWidth), Math.max(RAIL_WIDTH_MIN, Math.round(width)));
}

/** 宽度记忆读取：无记录返回默认；手写异常值（9999/0/非数值/超新上限）落回默认 384 */
export function readRailWidthPreference(viewportWidth: number): number {
  try {
    const raw = window.localStorage.getItem(RAIL_WIDTH_KEY);
    if (raw === null) return RAIL_WIDTH_DEFAULT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < RAIL_WIDTH_MIN || value > railWidthMax(viewportWidth)) {
      return RAIL_WIDTH_DEFAULT;
    }
    return value;
  } catch {
    return RAIL_WIDTH_DEFAULT;
  }
}

/** 宽度记忆写入：仅在拖拽结束（pointerup）与键盘微调路径调用；storage 不可用静默降级 */
export function writeRailWidthPreference(width: number): void {
  try {
    window.localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  } catch {
    // storage 不可用：忽略（页面生命周期内 state 仍生效）
  }
}
