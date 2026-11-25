// 渲染性能诊断打点单测（2026-11-25 记忆卡闪烁排查批）：
// merge_slow 节流聚合 / longtask 安装幂等与快照合并。契约：低于阈值零输出；
// 超阈值记 warn 且节流窗内聚合计数；无 window 或 PerformanceObserver 缺失时安装
// 静默不炸；快照 provider 抛错不吞 longtask 本身的记录。只断言 ring 缓冲里的
// 机器消费字段，console 镜像由 spy 静默。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  diag,
  installDiagLongtaskCapture,
  logSlowMergeTiming,
  resetDiagForTest,
  setDiagRenderSnapshotProvider,
  type DiagEntry,
} from "../diag";

interface FakeTaskEntry {
  duration: number;
  startTime: number;
}

/** node 环境合成 window + PerformanceObserver（记录回调供测试手动触发） */
function installFakeLongtaskEnv(): { fire: (entries: FakeTaskEntry[]) => void } {
  let cb: ((list: { getEntries(): FakeTaskEntry[] }) => void) | null = null;
  class FakePerformanceObserver {
    constructor(callback: (list: { getEntries(): FakeTaskEntry[] }) => void) {
      cb = callback;
    }
    observe(): void {}
  }
  (globalThis as Record<string, unknown>).window = {};
  (globalThis as Record<string, unknown>).PerformanceObserver = FakePerformanceObserver;
  return { fire: (entries) => cb?.({ getEntries: () => entries }) };
}

function lastEv(ev: string): DiagEntry | undefined {
  const hit = diag.entries().filter((e) => e.ev === ev);
  return hit[hit.length - 1];
}

let consoleWarn: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  resetDiagForTest();
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetDiagForTest();
  consoleWarn?.mockRestore();
  consoleWarn = null;
  setDiagRenderSnapshotProvider(null);
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).PerformanceObserver;
});

describe("logSlowMergeTiming 节流聚合", () => {
  test("低于阈值不记录", () => {
    logSlowMergeTiming(19.9, 100, 50, 10_000);
    expect(diag.entries().filter((e) => e.ev === "merge_slow")).toHaveLength(0);
  });

  test("超阈值首记：字段齐、n=1", () => {
    logSlowMergeTiming(25.4, 216, 180, 10_000);
    const e = lastEv("merge_slow");
    expect(e?.mod).toBe("perf");
    expect(e?.lvl).toBe("warn");
    expect(e?.f).toMatchObject({ ms: 25, entries: 216, items: 180, n: 1 });
  });

  test("节流窗内不重复记录、聚合计数带进下一次", () => {
    logSlowMergeTiming(25, 216, 180, 10_000); // 首记 n=1
    logSlowMergeTiming(30, 216, 181, 10_100); // 窗内：不记，count=2
    logSlowMergeTiming(40, 216, 182, 10_400); // 窗内：不记，count=3
    expect(diag.entries().filter((e) => e.ev === "merge_slow")).toHaveLength(1);
    logSlowMergeTiming(50, 216, 183, 10_600); // 窗过后：n 聚合
    const e = lastEv("merge_slow");
    expect(e?.f).toMatchObject({ ms: 50, items: 183, n: 3 });
  });

  test("resetDiagForTest 后节流状态归零", () => {
    logSlowMergeTiming(25, 216, 180, 10_000);
    resetDiagForTest();
    logSlowMergeTiming(25, 216, 180, 10_100); // 复位后窗内即记
    const e = lastEv("merge_slow");
    expect(e?.f).toMatchObject({ n: 1 });
  });
});

describe("installDiagLongtaskCapture", () => {
  test("无 window 环境安全返回（幂等可重复调用）", () => {
    expect(() => {
      installDiagLongtaskCapture();
      installDiagLongtaskCapture();
    }).not.toThrow();
    expect(diag.entries().filter((e) => e.ev === "longtask")).toHaveLength(0);
  });

  test("longtask 超阈值：记录时长与快照合并字段", () => {
    const env = installFakeLongtaskEnv();
    installDiagLongtaskCapture(120);
    setDiagRenderSnapshotProvider(() => ({ session: "01a1f139", entries: 216, items: 180, rows: 13, cards: 4, follow: 1, streaming: 1 }));
    env.fire([{ duration: 2340.6, startTime: 12_345 }]);
    const e = lastEv("longtask");
    expect(e?.mod).toBe("perf");
    expect(e?.lvl).toBe("warn");
    expect(e?.f).toMatchObject({
      ms: 2341,
      start: 12_345,
      session: "01a1f139",
      entries: 216,
      items: 180,
      rows: 13,
      cards: 4,
      follow: 1,
      streaming: 1,
    });
  });

  test("低于阈值的卡顿不记录；快照 provider 抛错不吞记录", () => {
    const env = installFakeLongtaskEnv();
    installDiagLongtaskCapture(120);
    env.fire([{ duration: 100, startTime: 100 }]); // 低于阈值
    expect(diag.entries().filter((e) => e.ev === "longtask")).toHaveLength(0);
    setDiagRenderSnapshotProvider(() => {
      throw new Error("snapshot boom");
    });
    env.fire([{ duration: 300, startTime: 200 }]);
    const e = lastEv("longtask");
    expect(e?.f).toMatchObject({ ms: 300, start: 200 });
  });

  test("PerformanceObserver 构造抛错时静默不装", () => {
    (globalThis as Record<string, unknown>).window = {};
    class BoomObserver {
      constructor() {
        throw new Error("no support");
      }
    }
    (globalThis as Record<string, unknown>).PerformanceObserver = BoomObserver;
    expect(() => installDiagLongtaskCapture()).not.toThrow();
  });
});
