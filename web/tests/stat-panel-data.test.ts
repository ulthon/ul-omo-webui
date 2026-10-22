// 成本全景聚合纯函数单测（docs08 2026-10-22 批次任务 9，GAP-11 4⑪）：
// - aggregateCostBreakdown：今日/累计拆分、跨日界与未来时间戳不计今日、按模型分组降序、
//   零 usage → 零值非 NaN、单条目、缺模型条目只进合计不进拆分、大额累计保值；
// - aggregateTimeAttribution：toolCall→toolResult 配对求和、无配对 → null（行省略）、
//   收尾 assistant 无生成窗不计、负跨度（时钟偏移）丢弃；
// - cacheHitRate：total≤0 → null、零读 → 0%、真实样本比例核对。
// 时间戳形态沿 step-duration 实测口径：entry.timestamp=ISO 字符串、message.timestamp=ms 数字。
import { describe, expect, test } from "vitest";
import type { WireEntry } from "@/lib/api";
import {
  aggregateCostBreakdown,
  aggregateTimeAttribution,
  cacheHitRate,
  startOfTodayMs,
} from "@/components/chat/stat-panel-data";

const NOW = startOfTodayMs(new Date().getTime()) + 12 * 3_600_000; // 当天本地 12:00 附近，避开日界抖动
const TODAY = startOfTodayMs(NOW) + 3_600_000; // 当天 01:00
const YESTERDAY = TODAY - 24 * 3_600_000;

/** assistant 落库条目（message_end 形态：entry.timestamp ISO + message.usage.cost.total + message.model） */
function assistantEntry(opts: { id: string; tsMs: number; cost?: number; model?: string; toolCallIds?: string[] }): WireEntry {
  const message: Record<string, unknown> = {
    role: "assistant",
    timestamp: opts.tsMs,
    content: (opts.toolCallIds ?? []).map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })),
  };
  if (opts.cost !== undefined) {
    message.usage = {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: { input: 0.9, output: 0.1, cacheRead: 0, cacheWrite: 0, total: opts.cost },
    };
  }
  if (opts.model !== undefined) message.model = opts.model;
  return { type: "message", id: opts.id, timestamp: new Date(opts.tsMs).toISOString(), message } as WireEntry;
}

function toolResultEntry(opts: { tsMs: number; toolCallId: string; details?: Record<string, unknown> }): WireEntry {
  return {
    type: "message",
    id: `r-${opts.toolCallId}`,
    timestamp: new Date(opts.tsMs).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: opts.toolCallId,
      timestamp: opts.tsMs,
      content: [{ type: "text", text: "done" }],
      ...(opts.details ? { details: opts.details } : {}),
    },
  } as WireEntry;
}

describe("aggregateCostBreakdown（今日/累计/按模型）", () => {
  test("今日合计只取今日条目；累计取快照；按模型降序拆分", () => {
    const entries = [
      assistantEntry({ id: "a1", tsMs: YESTERDAY, cost: 9.99, model: "glm-5.3" }),
      assistantEntry({ id: "a2", tsMs: TODAY, cost: 0.25, model: "glm-5.3" }),
      assistantEntry({ id: "a3", tsMs: TODAY + 60_000, cost: 0.75, model: "glm-4.6v" }),
      { type: "message", id: "u1", message: { role: "user" } } as WireEntry, // 非 assistant 不计
    ];
    const r = aggregateCostBreakdown(1.5, entries, NOW);
    expect(r.cumulative).toBe(1.5);
    expect(r.todayTotal).toBeCloseTo(1.0, 10);
    expect(r.entriesCounted).toBe(2);
    expect(r.byModel).toEqual([
      { model: "glm-5.3", cost: 0.25 },
      { model: "glm-4.6v", cost: 0.75 },
    ].sort((a, b) => b.cost - a.cost));
  });

  test("日界边界：恰好日界的条目计入；日界前 1ms 与未来时间戳不计", () => {
    const dayStart = startOfTodayMs(NOW);
    const entries = [
      assistantEntry({ id: "pre", tsMs: dayStart - 1, cost: 5, model: "m" }),
      assistantEntry({ id: "at", tsMs: dayStart, cost: 1, model: "m" }),
      assistantEntry({ id: "future", tsMs: NOW + 3_600_000, cost: 7, model: "m" }),
    ];
    const r = aggregateCostBreakdown(0, entries, NOW);
    expect(r.todayTotal).toBe(1);
    expect(r.entriesCounted).toBe(1);
  });

  test("零 usage → 零值非 NaN；非法快照费用归 0", () => {
    const r = aggregateCostBreakdown(Number.NaN, [], NOW);
    expect(r.cumulative).toBe(0);
    expect(r.todayTotal).toBe(0);
    expect(r.byModel).toEqual([]);
    expect(Number.isFinite(r.todayTotal)).toBe(true);
  });

  test("单条目缺模型：计入今日合计，不进按模型拆分", () => {
    const entries = [assistantEntry({ id: "solo", tsMs: TODAY, cost: 0.5 })];
    const r = aggregateCostBreakdown(0, entries, NOW);
    expect(r.todayTotal).toBeCloseTo(0.5, 10);
    expect(r.byModel).toEqual([]);
    expect(r.entriesCounted).toBe(1);
  });

  test("缺 cost.total 的 assistant 条目不计；大额累计保值", () => {
    const noCost = { ...assistantEntry({ id: "x", tsMs: TODAY, model: "m" }) };
    const r = aggregateCostBreakdown(12345.6789, [noCost as WireEntry], NOW);
    expect(r.cumulative).toBe(12345.6789);
    expect(r.todayTotal).toBe(0);
    expect(r.entriesCounted).toBe(0);
  });
});

describe("aggregateTimeAttribution（模型/工具耗时估算）", () => {
  test("toolCall→toolResult 配对求和；有调用条目生成窗=首结果到达", () => {
    const t0 = TODAY;
    const entries = [
      assistantEntry({ id: "a1", tsMs: t0, cost: 0.1, toolCallIds: ["t1", "t2"] }),
      toolResultEntry({ tsMs: t0 + 5_000, toolCallId: "t2" }),
      toolResultEntry({ tsMs: t0 + 9_000, toolCallId: "t1" }),
      assistantEntry({ id: "a2", tsMs: t0 + 20_000, cost: 0.1 }), // 收尾 assistant：下一条目缺失不计数
    ];
    const r = aggregateTimeAttribution(entries);
    expect(r.toolMs).toBe(14_000); // 5000 + 9000
    expect(r.modelMs).toBe(5_000); // a1 窗口到首结果 t2；a2 无后继活动省略
  });

  test("全部无配对 → toolMs=null（行省略）；负跨度丢弃", () => {
    const t0 = TODAY;
    const unpaired = [assistantEntry({ id: "a1", tsMs: t0, toolCallIds: ["t1"] })];
    expect(aggregateTimeAttribution(unpaired)).toEqual({ modelMs: null, toolMs: null });
    const skewed = [
      assistantEntry({ id: "a1", tsMs: t0, toolCallIds: ["t1"] }),
      toolResultEntry({ tsMs: t0 - 100, toolCallId: "t1" }), // 时钟偏移：结果早于调用
    ];
    expect(aggregateTimeAttribution(skewed)).toEqual({ modelMs: null, toolMs: null });
  });

  test("空条目 → 双 null", () => {
    expect(aggregateTimeAttribution([])).toEqual({ modelMs: null, toolMs: null });
  });
});

describe("cacheHitRate（缓存命中率）", () => {
  test("真实样本比例核对（glm-4.6v：cacheRead/total）", () => {
    expect(cacheHitRate({ cacheRead: 30325, total: 45371 })).toBeCloseTo(0.6685, 3);
  });
  test("total≤0 → null（行省略）；零读 → 0%", () => {
    expect(cacheHitRate({ cacheRead: 0, total: 0 })).toBeNull();
    expect(cacheHitRate({ cacheRead: 0, total: 100 })).toBe(0);
  });
});
