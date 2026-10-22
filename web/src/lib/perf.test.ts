// docs08-2026-10-22-batch 任务 1 单测：web 埋点门控（ulomo_perf localStorage 调试开关）
// 与 mark/measure 助手。契约：默认关零输出零计时；开启时返回真实时长，异常不外抛。
import { afterEach, describe, expect, test } from "vitest";
import { PERF_FLAG_KEY, perfMark, perfMeasure, webPerfEnabled } from "./perf";

function storeOf(value: string | null): { getItem(key: string): string | null } {
  return { getItem: (key) => (key === PERF_FLAG_KEY ? value : null) };
}

describe("webPerfEnabled 门控", () => {
  test("缺省（无键）关闭", () => {
    expect(webPerfEnabled(storeOf(null))).toBe(false);
  });
  test("ulomo_perf=1 开启；其他值关闭", () => {
    expect(webPerfEnabled(storeOf("1"))).toBe(true);
    expect(webPerfEnabled(storeOf("0"))).toBe(false);
    expect(webPerfEnabled(storeOf("true"))).toBe(false);
  });
  test("存储抛错（不可用环境）一律关闭", () => {
    expect(webPerfEnabled({ getItem: () => { throw new Error("unavailable"); } })).toBe(false);
  });
});

describe("perfMark / perfMeasure", () => {
  const original = globalThis.localStorage;
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", { value: original, writable: true, configurable: true });
  });

  function enable() {
    Object.defineProperty(globalThis, "localStorage", {
      value: storeOf("1"),
      writable: true,
      configurable: true,
    });
  }

  test("关闭时：mark 零副作用、measure 返回 undefined", () => {
    perfMark("ulomo:test-off-start");
    expect(perfMeasure("ulomo:test-off", "ulomo:missing", "ulomo:test-off-end")).toBeUndefined();
  });

  test("开启时：mark/measure 返回非负时长", () => {
    enable();
    perfMark("ulomo:test-on-start");
    const ms = perfMeasure("ulomo:test-on", "ulomo:test-on-start", "ulomo:test-on-end");
    expect(typeof ms).toBe("number");
    expect(ms as number).toBeGreaterThanOrEqual(0);
  });

  test("开启但起点 mark 缺失：不外抛返回 undefined", () => {
    enable();
    expect(perfMeasure("ulomo:test-missing", "ulomo:no-such-start-mark", "ulomo:test-missing-end")).toBeUndefined();
  });
});
