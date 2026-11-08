// 右栏"文件"页签横向列宽拖拽记忆逻辑（rail-files-resize）：仿 pages/files-resize
// 纯逻辑测试形态（node 环境 + 手写 window/localStorage shim）。覆盖：默认回退（无
// 记录/非整数/越界）、clamp 边界、记忆键名与读写往返、写入失败静默降级。
import { describe, expect, test, beforeEach } from "vitest";
import {
  RAIL_FILES_LIST_DEFAULT,
  RAIL_FILES_LIST_KEY,
  RAIL_FILES_LIST_MAX,
  RAIL_FILES_LIST_MIN,
  RAIL_FILES_TREE_DEFAULT,
  RAIL_FILES_TREE_KEY,
  RAIL_FILES_TREE_MAX,
  RAIL_FILES_TREE_MIN,
  clampRailFilesListWidth,
  clampRailFilesTreeWidth,
  readRailFilesListWidthPreference,
  readRailFilesTreeWidthPreference,
  writeRailFilesListWidthPreference,
  writeRailFilesTreeWidthPreference,
} from "../rail-files-resize";

/** 极简 localStorage shim：node 环境无 window；throwing=true 模拟 storage 不可用 */
function installStorage(throwing = false) {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => {
      if (throwing) throw new Error("storage unavailable");
      return store.has(k) ? store.get(k)! : null;
    },
    setItem: (k: string, v: string) => {
      if (throwing) throw new Error("storage unavailable");
      store.set(k, v);
    },
  };
  (globalThis as { window?: unknown }).window = { localStorage: ls };
  return store;
}

beforeEach(() => {
  installStorage();
});

describe("rail-files-resize 列宽拖拽记忆", () => {
  test("边界常量符合计划：树 10-22rem 默认 14rem，列表 14-40rem 默认 20rem", () => {
    expect(RAIL_FILES_TREE_MIN).toBe(160);
    expect(RAIL_FILES_TREE_MAX).toBe(352);
    expect(RAIL_FILES_TREE_DEFAULT).toBe(224);
    expect(RAIL_FILES_LIST_MIN).toBe(224);
    expect(RAIL_FILES_LIST_MAX).toBe(640);
    expect(RAIL_FILES_LIST_DEFAULT).toBe(320);
    expect(RAIL_FILES_TREE_KEY).toBe("ul-omo-webui:rail-files-tree-w");
    expect(RAIL_FILES_LIST_KEY).toBe("ul-omo-webui:rail-files-list-w");
  });

  test("无记录时读默认", () => {
    expect(readRailFilesTreeWidthPreference()).toBe(RAIL_FILES_TREE_DEFAULT);
    expect(readRailFilesListWidthPreference()).toBe(RAIL_FILES_LIST_DEFAULT);
  });

  test("读写往返", () => {
    writeRailFilesTreeWidthPreference(300);
    writeRailFilesListWidthPreference(500);
    expect(readRailFilesTreeWidthPreference()).toBe(300);
    expect(readRailFilesListWidthPreference()).toBe(500);
  });

  test("非整数/越界/非数值一律落默认", () => {
    installStorage();
    window.localStorage.setItem(RAIL_FILES_TREE_KEY, "300.5");
    window.localStorage.setItem(RAIL_FILES_LIST_KEY, "9999");
    expect(readRailFilesTreeWidthPreference()).toBe(RAIL_FILES_TREE_DEFAULT);
    expect(readRailFilesListWidthPreference()).toBe(RAIL_FILES_LIST_DEFAULT);
    window.localStorage.setItem(RAIL_FILES_TREE_KEY, "abc");
    window.localStorage.setItem(RAIL_FILES_LIST_KEY, "0");
    expect(readRailFilesTreeWidthPreference()).toBe(RAIL_FILES_TREE_DEFAULT);
    expect(readRailFilesListWidthPreference()).toBe(RAIL_FILES_LIST_DEFAULT);
  });

  test("clamp 钳制在下界、上界并取整", () => {
    expect(clampRailFilesTreeWidth(100)).toBe(RAIL_FILES_TREE_MIN);
    expect(clampRailFilesTreeWidth(9999)).toBe(RAIL_FILES_TREE_MAX);
    expect(clampRailFilesTreeWidth(224.6)).toBe(225);
    expect(clampRailFilesListWidth(100)).toBe(RAIL_FILES_LIST_MIN);
    expect(clampRailFilesListWidth(9999)).toBe(RAIL_FILES_LIST_MAX);
    expect(clampRailFilesListWidth(400.4)).toBe(400);
  });

  test("storage 不可用时读写静默降级（读默认/写不抛）", () => {
    installStorage(true);
    expect(readRailFilesTreeWidthPreference()).toBe(RAIL_FILES_TREE_DEFAULT);
    expect(readRailFilesListWidthPreference()).toBe(RAIL_FILES_LIST_DEFAULT);
    expect(() => writeRailFilesTreeWidthPreference(300)).not.toThrow();
    expect(() => writeRailFilesListWidthPreference(500)).not.toThrow();
  });
});
