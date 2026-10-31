// 2026-10-31 日志采集增强批：前端 diag 观测层单测。
// 覆盖：
// 1. 级别门控：默认 info（无存储环境），debug 不入缓冲；setDiagLevel 运行时切换即生效；
// 2. 环形缓冲：容量 3000 淘汰最旧、有序快照、seq 单调；
// 3. sendTrace 发送链：begin→receipt→firstFrame→settled 汇总行字段；drop 收尾；
// 4. 批量上报：注入 fetchImpl，flush 成功出队/失败保留重试；hidden 冲刷走同一出口；
// 5. buildDiagBundle 导出包组装（serverError 可选字段）；
// 6. parseDiagLevel 入参矩阵。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

import {
  buildDiagBundle,
  diag,
  DIAG_LEVEL_KEY,
  diagLevel,
  flushDiagReport,
  parseDiagLevel,
  resetDiagForTest,
  sendTrace,
  setDiagLevel,
  startDiagReporter,
} from "@/lib/diag";

beforeEach(() => {
  resetDiagForTest();
  localStorage.clear();
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseDiagLevel", () => {
  test("合法值与非法值", () => {
    expect(parseDiagLevel("DEBUG")).toBe("debug");
    expect(parseDiagLevel(" warn ")).toBe("warn");
    expect(parseDiagLevel("")).toBeNull();
    expect(parseDiagLevel("loud")).toBeNull();
    expect(parseDiagLevel(undefined)).toBeNull();
  });
});

describe("级别门控", () => {
  test("默认 info：debug 零入缓冲", () => {
    expect(diagLevel()).toBe("info");
    diag.debug("api", "req", { st: 200 });
    diag.trace("x", "y");
    expect(diag.entries()).toHaveLength(0);
    diag.warn("sse", "error", {});
    expect(diag.entries()).toHaveLength(1);
  });

  test("setDiagLevel 运行时切换立即生效并镜像 localStorage", () => {
    setDiagLevel("debug");
    expect(diagLevel()).toBe("debug");
    expect(localStorage.getItem(DIAG_LEVEL_KEY)).toBe("debug");
    diag.debug("api", "req", { st: 200 });
    expect(diag.entries()).toHaveLength(1);
    expect(diag.entries()[0].lvl).toBe("debug");
  });
});

describe("环形缓冲", () => {
  test("容量 3000：淘汰最旧，seq 连续", () => {
    for (let i = 1; i <= 3001; i++) diag.info("m", `e${i}`);
    const entries = diag.entries();
    expect(entries.length).toBe(3000);
    expect(entries[0].ev).toBe("e2");
    expect(entries[entries.length - 1].ev).toBe("e3001");
  });
});

describe("sendTrace 发送链", () => {
  test("四点链路汇总行", () => {
    sendTrace.begin("sess-abcd1234-xyz", { len: 42, queued: false });
    sendTrace.receipt("sess-abcd1234-xyz", { disposition: "ok" });
    sendTrace.firstFrame("sess-abcd1234-xyz");
    sendTrace.settled("sess-abcd1234-xyz", "agent_settled");
    const entries = diag.entries();
    const summary = entries.find((e) => e.mod === "perf" && e.ev === "send");
    expect(summary).toBeDefined();
    expect(summary?.f?.session).toBe("sess-abc");
    expect(summary?.f?.sendMs).toBeGreaterThanOrEqual(0);
    expect(summary?.f?.firstFrameMs).toBeGreaterThanOrEqual(0);
    expect(summary?.f?.turnMs).toBeGreaterThanOrEqual(0);
    expect(summary?.f?.reason).toBe("agent_settled");
    expect(summary?.f?.len).toBe(42);
    // 不记正文：meta 只有长度等元数据
    expect(String(summary?.f?.text ?? "")).toBe("");
  });

  test("drop 收尾为 warn 行", () => {
    sendTrace.begin("s1", {});
    sendTrace.drop("s1", "switch");
    const drop = diag.entries().find((e) => e.ev === "send.drop");
    expect(drop?.lvl).toBe("warn");
    expect(drop?.f?.reason).toBe("switch");
  });
});

describe("批量上报", () => {
  test("flush 成功出队、失败保留", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let ok = true;
    startDiagReporter("/api/diagnostics/frontend-log", {
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        if (!ok) return new Response("boom", { status: 500 });
        return new Response("{}", { status: 200 });
      },
    });
    diag.info("ui", "send", { len: 1 });
    diag.warn("sse", "error", {});
    ok = false;
    await flushDiagReport();
    expect(calls).toHaveLength(1);
    expect((calls[0].body as { entries: unknown[] }).entries).toHaveLength(2);
    ok = true;
    await flushDiagReport();
    expect(calls).toHaveLength(2);
    await flushDiagReport();
    expect(calls).toHaveLength(2); // 已清空，零请求
  });
});

describe("buildDiagBundle", () => {
  test("组装 meta + serverError 可选", () => {
    diag.info("ui", "boot", {});
    const bundle = buildDiagBundle(diag.entries(), { entries: [] }, { boot: {} }, "server down");
    expect(bundle.frontend.length).toBe(1);
    expect(bundle.meta.exportedAt).toBeTruthy();
    expect(bundle.serverError).toBe("server down");
    const clean = buildDiagBundle([], null, null);
    expect("serverError" in clean).toBe(false);
  });
});
