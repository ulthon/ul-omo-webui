// 状态条纯助手单测（todo 24）：usage 形态容错、消息级增量累加、显示格式化。
// A5 追加：turnSpeed 速度环快照容错解析（parseTurnSpeed）。
import { describe, expect, test } from "bun:test";
import {
  addMessageUsage,
  formatCost,
  formatTokens,
  parseTurnSpeed,
  toUsageStats,
  type UsageStats,
} from "@/components/chat/status-bar-data";

const base: UsageStats = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
  context: null,
};

describe("toUsageStats（GET /api/usage 快照形态）", () => {
  test("完整形态", () => {
    const stats = toUsageStats({
      tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 20, total: 200 },
      cost: 0.0123,
      contextUsage: { tokens: 1500, contextWindow: 100000, percent: 1.5 },
    });
    expect(stats.tokens).toEqual({ input: 100, output: 50, cacheRead: 30, cacheWrite: 20, total: 200 });
    expect(stats.cost).toBe(0.0123);
    expect(stats.context).toEqual({ tokens: 1500, contextWindow: 100000, percent: 1.5 });
  });

  test("缺字段容错归零；cost 非数字归零", () => {
    const stats = toUsageStats({ tokens: { input: 10 }, cost: "n/a" });
    expect(stats.tokens.input).toBe(10);
    expect(stats.tokens.output).toBe(0);
    expect(stats.cost).toBe(0);
    expect(stats.context).toBeNull();
  });

  test("contextUsage 缺失或窗口为 0 时 context 为 null", () => {
    expect(toUsageStats({ contextUsage: { tokens: 1, contextWindow: 0, percent: 0 } }).context).toBeNull();
    expect(toUsageStats({}).context).toBeNull();
  });
});

describe("addMessageUsage（message_end 条目的 message.usage 增量）", () => {
  const messageUsage = {
    input: 120,
    output: 40,
    cacheRead: 8,
    cacheWrite: 2,
    reasoning: 10,
    totalTokens: 170,
    cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 },
  };

  test("按分项累加，total 取 totalTokens，cost 取 cost.total", () => {
    const snapshot = toUsageStats({
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0.01,
    });
    const next = addMessageUsage(snapshot, { role: "assistant", usage: messageUsage });
    expect(next).not.toBeNull();
    expect(next!.tokens.input).toBe(220);
    expect(next!.tokens.output).toBe(90);
    expect(next!.tokens.total).toBe(320);
    expect(next!.cost).toBeCloseTo(0.0112);
  });

  test("totalTokens 缺失时回退分项和；无 usage 返回 null", () => {
    const next = addMessageUsage(base, {
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } },
    });
    expect(next!.tokens.total).toBe(15);
    expect(addMessageUsage(base, { role: "assistant" })).toBeNull();
    expect(addMessageUsage(base, null)).toBeNull();
  });

  test("context 不可增量，保持快照值", () => {
    const snapshot = toUsageStats({
      tokens: {},
      cost: 0,
      contextUsage: { tokens: 900, contextWindow: 100000, percent: 0.9 },
    });
    expect(addMessageUsage(snapshot, { usage: messageUsage })!.context).toEqual(snapshot.context);
  });
});

describe("parseTurnSpeed（A5：usage.turnSpeed 容错解析）", () => {
  const sample = (tokPerSec: number, endedAt = "2026-10-13T01:00:00.000Z") => ({ tokPerSec, endedAt });

  test("正常快照：样本原样保留，均值取服务端值", () => {
    const r = parseTurnSpeed({
      turnSpeed: { turns: [sample(20), sample(30, "2026-10-13T01:01:00.000Z")], averageTokPerSec: 25 },
    });
    expect(r.turns.length).toBe(2);
    expect(r.turns[0]).toEqual(sample(20));
    expect(r.averageTokPerSec).toBe(25);
  });

  test("无回合：turns 缺失/空数组 → 空列表 + average null（前端显示暂无数据）", () => {
    expect(parseTurnSpeed({}).turns).toEqual([]);
    expect(parseTurnSpeed({ turnSpeed: { turns: [], averageTokPerSec: 0 } })).toEqual({
      turns: [],
      averageTokPerSec: null,
    });
    expect(parseTurnSpeed(null).averageTokPerSec).toBeNull();
  });

  test("脏样本丢弃：tok/s 非有限/≤0、endedAt 非字符串；均值异常回退本地均值", () => {
    const r = parseTurnSpeed({
      turnSpeed: {
        turns: [sample(20), sample(NaN), sample(0), sample(-5), { tokPerSec: 30 }, sample(40)],
        averageTokPerSec: -1, // 服务端均值异常 → 回退本地均值 (20+40)/2
      },
    });
    expect(r.turns.map((t) => t.tokPerSec)).toEqual([20, 40]);
    expect(r.averageTokPerSec).toBeCloseTo(30);
  });
});

describe("格式化", () => {
  test("formatTokens", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(1234567)).toBe("1.23M");
  });

  test("formatCost 固定 4 位小数", () => {
    expect(formatCost(0)).toBe("$0.0000");
    expect(formatCost(0.01234)).toBe("$0.0123");
  });
});
