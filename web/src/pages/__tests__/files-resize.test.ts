// 独立文件页三栏拖宽记忆逻辑（files-panel-oc 任务 2）：仿 sidebar-resize 纯逻辑
// 测试形态（node 环境 + 手写 window/localStorage shim）。覆盖：默认回退（无记录/
// 非整数/越界）、clamp 边界、记忆键名与读写往返、写入失败静默降级。
import { describe, expect, test, beforeEach } from "vitest";
import {
  FILES_LEFT_DEFAULT,
  FILES_LEFT_KEY,
  FILES_LEFT_MAX,
  FILES_LEFT_MIN,
  FILES_RIGHT_DEFAULT,
  FILES_RIGHT_KEY,
  FILES_RIGHT_MAX,
  FILES_RIGHT_MIN,
  clampFilesLeftWidth,
  clampFilesRightWidth,
  readFilesLeftWidthPreference,
  readFilesRightWidthPreference,
  writeFilesLeftWidthPreference,
  writeFilesRightWidthPreference,
} from "../files-resize";

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

describe("files-resize 拖宽记忆（任务 2）", () => {
  test("边界常量符合计划：左 12-28rem 默认 16rem，右 14-36rem 默认 22rem", () => {
    expect(FILES_LEFT_MIN).toBe(192);
    expect(FILES_LEFT_MAX).toBe(448);
    expect(FILES_LEFT_DEFAULT).toBe(256);
    expect(FILES_RIGHT_MIN).toBe(224);
    expect(FILES_RIGHT_MAX).toBe(576);
    expect(FILES_RIGHT_DEFAULT).toBe(352);
  });

  test("记忆键名固定（刷新后读取依据）", () => {
    expect(FILES_LEFT_KEY).toBe("ul-omo-webui:files-left-width");
    expect(FILES_RIGHT_KEY).toBe("ul-omo-webui:files-right-width");
  });

  test("无记录落回默认", () => {
    expect(readFilesLeftWidthPreference()).toBe(FILES_LEFT_DEFAULT);
    expect(readFilesRightWidthPreference()).toBe(FILES_RIGHT_DEFAULT);
  });

  test("手写异常值（非整数/非数值/越界）一律落回默认", () => {
    const store = installStorage();
    for (const bad of ["abc", "1.5", "0", "9999", "-100"]) {
      store.set(FILES_LEFT_KEY, bad);
      store.set(FILES_RIGHT_KEY, bad);
      expect(readFilesLeftWidthPreference()).toBe(FILES_LEFT_DEFAULT);
      expect(readFilesRightWidthPreference()).toBe(FILES_RIGHT_DEFAULT);
    }
  });

  test("合法值读写往返一致", () => {
    writeFilesLeftWidthPreference(300);
    writeFilesRightWidthPreference(400);
    expect(readFilesLeftWidthPreference()).toBe(300);
    expect(readFilesRightWidthPreference()).toBe(400);
  });

  test("clamp 钳制在下界、上界并取整", () => {
    expect(clampFilesLeftWidth(100)).toBe(FILES_LEFT_MIN);
    expect(clampFilesLeftWidth(9999)).toBe(FILES_LEFT_MAX);
    expect(clampFilesLeftWidth(300.6)).toBe(301);
    expect(clampFilesRightWidth(100)).toBe(FILES_RIGHT_MIN);
    expect(clampFilesRightWidth(9999)).toBe(FILES_RIGHT_MAX);
    expect(clampFilesRightWidth(400.4)).toBe(400);
  });

  test("storage 不可用时读写静默降级（读默认/写不抛）", () => {
    installStorage(true);
    expect(readFilesLeftWidthPreference()).toBe(FILES_LEFT_DEFAULT);
    expect(readFilesRightWidthPreference()).toBe(FILES_RIGHT_DEFAULT);
    expect(() => writeFilesLeftWidthPreference(300)).not.toThrow();
    expect(() => writeFilesRightWidthPreference(400)).not.toThrow();
  });
});
