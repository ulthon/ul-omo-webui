// schedule-data 纯函数单测（docs08-2026-10-22 批次任务 22）：到期相对档/循环人读格式/
// 摘要截断/状态映射/明天 9 点预设。全部确定性（now 显式注入），无时间/随机因素。
import { describe, expect, test } from "vitest";
import {
  formatDue,
  formatDurationParts,
  formatEvery,
  promptExcerpt,
  scheduleStateClass,
  scheduleStateKey,
  tomorrowAt9,
} from "../schedule-data";

describe("formatDurationParts / formatDue", () => {
  const NOW = 1_800_000_000_000;

  test("未来到期按紧凑档位取整", () => {
    expect(formatDurationParts(30_000)).toBe("30s");
    expect(formatDurationParts(5 * 60_000)).toBe("5m");
    expect(formatDurationParts(3 * 3_600_000)).toBe("3h");
    expect(formatDurationParts(2 * 86_400_000)).toBe("2d");
  });

  test("formatDue：未来 → past:false + 紧凑时长", () => {
    expect(formatDue(NOW + 5 * 60_000, NOW)).toEqual({ text: "5m", past: false });
    expect(formatDue(NOW + 3_600_000, NOW)).toEqual({ text: "1h", past: false });
  });

  test("formatDue：已到期（含恰好等于 now）→ past:true，绝不显示负倒计时", () => {
    expect(formatDue(NOW - 60_000, NOW)).toEqual({ text: "", past: true });
    expect(formatDue(NOW, NOW)).toEqual({ text: "", past: true });
  });

  test("formatDue：非法值兜底 past:true", () => {
    expect(formatDue(Number.NaN, NOW)).toEqual({ text: "", past: true });
  });

  test("formatDue：固定基点 1m 档位（原 formatDueNow 墙钟用例，固定 now 消除 flake）", () => {
    expect(formatDue(NOW + 60_000, NOW)).toEqual({ text: "1m", past: false });
  });
});

describe("formatEvery", () => {
  test("整小时/整分钟归档，非整归秒", () => {
    expect(formatEvery(3_600_000)).toBe("1h");
    expect(formatEvery(7_200_000)).toBe("2h");
    expect(formatEvery(300_000)).toBe("5m");
    expect(formatEvery(5_400_000)).toBe("90m");
    expect(formatEvery(90_000)).toBe("90s");
  });

  test("非法值返回空串", () => {
    expect(formatEvery(0)).toBe("");
    expect(formatEvery(Number.NaN)).toBe("");
    expect(formatEvery(-1)).toBe("");
  });
});

describe("promptExcerpt", () => {
  test("压缩空白取单行", () => {
    expect(promptExcerpt("第一行\n  第二行\t制表")).toBe("第一行 第二行 制表");
  });

  test("超长截断加省略号", () => {
    const long = "字".repeat(100);
    const out = promptExcerpt(long, 80);
    expect(out).toHaveLength(81);
    expect(out.endsWith("…")).toBe(true);
  });

  test("恰在阈值不截断", () => {
    const exact = "字".repeat(80);
    expect(promptExcerpt(exact, 80)).toBe(exact);
  });
});

describe("状态映射与明天 9 点", () => {
  test("state → 词典键与配色三态", () => {
    expect(scheduleStateKey("pending")).toBe("schedule.statePending");
    expect(scheduleStateKey("firing")).toBe("schedule.stateFiring");
    expect(scheduleStateKey("failed")).toBe("schedule.stateFailed");
    expect(scheduleStateClass("pending")).toContain("bg-muted");
    expect(scheduleStateClass("firing")).toContain("sky");
    expect(scheduleStateClass("failed")).toContain("destructive");
  });

  test("tomorrowAt9：本地明天 09:00:00.000", () => {
    const now = new Date(2026, 9, 22, 23, 30, 0).getTime(); // 2026-10-22 23:30 本地
    const d = new Date(tomorrowAt9(now));
    expect(d.getDate()).toBe(23);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });
});
