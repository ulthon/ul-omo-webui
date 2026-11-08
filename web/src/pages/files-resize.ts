// 独立文件页三栏拖宽记忆（files-panel-oc 任务 2）：仿 components/layout/sidebar-resize.ts
// 抽出逻辑与组件解耦。持久化 localStorage 两键（左栏/右栏），仅桌面三栏形态消费；
// 移动端三态切换不受影响。读取缺失/非整数/越界一律落回默认；写入失败（storage
// 不可用）静默降级。默认与边界以 rem 设计（左 12-28rem 默认 16rem，右 14-36rem
// 默认 22rem），存取统一换算为整数 px（1rem=16px）。

/** localStorage 键与拖宽边界（px），命名风格对齐 sidebar-resize.ts */
export const FILES_LEFT_KEY = "ul-omo-webui:files-left-width";
export const FILES_RIGHT_KEY = "ul-omo-webui:files-right-width";
export const FILES_LEFT_MIN = 12 * 16;
export const FILES_LEFT_MAX = 28 * 16;
export const FILES_LEFT_DEFAULT = 16 * 16;
export const FILES_RIGHT_MIN = 14 * 16;
export const FILES_RIGHT_MAX = 36 * 16;
export const FILES_RIGHT_DEFAULT = 22 * 16;

/** 宽度记忆读取：无记录/手写异常值（9999/0/非数值等）落回对应默认 */
export function readFilesLeftWidthPreference(): number {
  return readWidth(FILES_LEFT_KEY, FILES_LEFT_DEFAULT, FILES_LEFT_MIN, FILES_LEFT_MAX);
}

export function readFilesRightWidthPreference(): number {
  return readWidth(FILES_RIGHT_KEY, FILES_RIGHT_DEFAULT, FILES_RIGHT_MIN, FILES_RIGHT_MAX);
}

function readWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return fallback;
    return value;
  } catch {
    return fallback;
  }
}

/** 宽度记忆写入：仅在拖拽结束（pointerup）与双击重置路径调用 */
export function writeFilesLeftWidthPreference(width: number): void {
  writeWidth(FILES_LEFT_KEY, width);
}

export function writeFilesRightWidthPreference(width: number): void {
  writeWidth(FILES_RIGHT_KEY, width);
}

function writeWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(width));
  } catch {
    // storage 不可用：忽略（页面生命周期内 state 仍生效）
  }
}

export function clampFilesLeftWidth(width: number): number {
  return Math.min(FILES_LEFT_MAX, Math.max(FILES_LEFT_MIN, Math.round(width)));
}

export function clampFilesRightWidth(width: number): number {
  return Math.min(FILES_RIGHT_MAX, Math.max(FILES_RIGHT_MIN, Math.round(width)));
}
