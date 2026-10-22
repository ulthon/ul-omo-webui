// docs08-2026-10-22-batch 任务 1 单测：性能埋点门控与 span 行格式。
// 契约：UL_OMO_WEBUI_DEBUG_PERF 默认关（零输出）；开启时 span 行按计划任务 1 格式逐段输出。
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  formatPerfLine,
  logPerfLine,
  logPerfSpan,
  perfEnabled,
  projHash8,
  sessionId8,
} from "../src/api/perf";

describe("UL_OMO_WEBUI_DEBUG_PERF 门控（perfEnabled）", () => {
  test("缺省（undefined）关闭", () => {
    expect(perfEnabled(undefined)).toBe(false);
  });
  test("空串与否定值关闭", () => {
    for (const v of ["", "0", "false", "FALSE", "off", "no", "on1"]) {
      expect(perfEnabled(v)).toBe(false);
    }
  });
  test("1/true/yes/on 开启且不分大小写", () => {
    for (const v of ["1", "true", "TRUE", "True", "yes", "on", "On"]) {
      expect(perfEnabled(v)).toBe(true);
    }
  });
});

describe("span 行格式（formatPerfLine 纯函数）", () => {
  test("messages 全段：op/proj/session/四段耗时/entries 按序", () => {
    expect(
      formatPerfLine({
        op: "messages",
        proj: "ab12cd34",
        session: "9f8e7d6c-1111-2222-3333-444455556666",
        ensureMs: 1.25,
        queueWaitMs: 0.04,
        switchToMs: 12.34,
        rpcMs: 100.0,
        entries: 210,
      }),
    ).toBe(
      "[perf] op=messages proj=ab12cd34 session=9f8e7d6c ensureMs=1.3 queueWaitMs=0 switchToMs=12.3 rpcMs=100 entries=210",
    );
  });
  test("可选段缺省即省略（usage 类：无 entries、session 缺席）", () => {
    expect(formatPerfLine({ op: "usage", proj: "ab12cd34", ensureMs: 0.5, switchToMs: 2, rpcMs: 3.25 })).toBe(
      "[perf] op=usage proj=ab12cd34 ensureMs=0.5 switchToMs=2 rpcMs=3.3",
    );
  });
  test("失败附 err 段（冷启动 503 归因）", () => {
    expect(formatPerfLine({ op: "messages", proj: "ab12cd34", session: "9f8e7d6c-x", ensureMs: 503.3, err: "engine_not_ready" })).toBe(
      "[perf] op=messages proj=ab12cd34 session=9f8e7d6c ensureMs=503.3 err=engine_not_ready",
    );
  });
  test("projHash8 稳定且 8 位十六进制；sessionId8 取前 8 位", () => {
    expect(projHash8("/tmp/a")).toBe(projHash8("/tmp/a"));
    expect(projHash8("/tmp/a")).not.toBe(projHash8("/tmp/b"));
    expect(projHash8("/tmp/a")).toMatch(/^[0-9a-f]{8}$/);
    expect(sessionId8("9f8e7d6c-1111")).toBe("9f8e7d6c");
  });
});

describe("logPerfLine / logPerfSpan 输出门控", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  test("开启时输出一行 span", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logPerfSpan({ op: "messages", proj: "ab12cd34", entries: 3 }, true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("[perf] op=messages proj=ab12cd34 entries=3");
  });
  test("关闭时零输出", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logPerfLine("[perf] op=messages proj=ab12cd34", false);
    logPerfSpan({ op: "usage", proj: "ab12cd34" }, false);
    expect(spy).not.toHaveBeenCalled();
  });
});
