// 右栏"文件"页签横向列宽拖拽记忆（rail-files-resize）：仿 pages/files-resize.ts
// 抽出逻辑与组件解耦。持久化 localStorage 两键（树列/列表列），仅宽档（>600）消费；
// 纵向堆叠档（≤600）不受影响。读取缺失/非整数/越界一律落回默认；写入失败（storage
// 不可用）静默降级。默认与边界以 rem 设计（树 10-22rem 默认 14rem，列表 14-40rem
// 默认 20rem），存取统一换算为整数 px（1rem=16px）。预览列恒为剩余宽自适应。

/** localStorage 键与拖宽边界（px），命名风格对齐 files-resize.ts */
export const RAIL_FILES_TREE_KEY = "ul-omo-webui:rail-files-tree-w";
export const RAIL_FILES_LIST_KEY = "ul-omo-webui:rail-files-list-w";
export const RAIL_FILES_TREE_MIN = 10 * 16;
export const RAIL_FILES_TREE_MAX = 22 * 16;
export const RAIL_FILES_TREE_DEFAULT = 14 * 16;
export const RAIL_FILES_LIST_MIN = 14 * 16;
export const RAIL_FILES_LIST_MAX = 40 * 16;
export const RAIL_FILES_LIST_DEFAULT = 20 * 16;

/** 宽度记忆读取：无记录/手写异常值（9999/0/非数值等）落回对应默认 */
export function readRailFilesTreeWidthPreference(): number {
  return readWidth(RAIL_FILES_TREE_KEY, RAIL_FILES_TREE_DEFAULT, RAIL_FILES_TREE_MIN, RAIL_FILES_TREE_MAX);
}

export function readRailFilesListWidthPreference(): number {
  return readWidth(RAIL_FILES_LIST_KEY, RAIL_FILES_LIST_DEFAULT, RAIL_FILES_LIST_MIN, RAIL_FILES_LIST_MAX);
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

/** 宽度记忆写入：仅在拖拽结束（pointerup）/方向键/双击重置路径调用 */
export function writeRailFilesTreeWidthPreference(width: number): void {
  writeWidth(RAIL_FILES_TREE_KEY, width);
}

export function writeRailFilesListWidthPreference(width: number): void {
  writeWidth(RAIL_FILES_LIST_KEY, width);
}

function writeWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(width));
  } catch {
    // storage 不可用：忽略（页面生命周期内 state 仍生效）
  }
}

export function clampRailFilesTreeWidth(width: number): number {
  return Math.min(RAIL_FILES_TREE_MAX, Math.max(RAIL_FILES_TREE_MIN, Math.round(width)));
}

export function clampRailFilesListWidth(width: number): number {
  return Math.min(RAIL_FILES_LIST_MAX, Math.max(RAIL_FILES_LIST_MIN, Math.round(width)));
}
