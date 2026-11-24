// 罗列收敛批（2026-11-21）：引擎连续落库的纯错误 assistant 消息（限流/额度失败，
// 实测 429 连发 content 为空或全空 text，中间夹不入列的 custom 条目）在 items 层
// 折叠为单个 errorRun 卡（×N）——对齐 CLI 不罗列的观感。锁定：
// - 相邻同文折叠：count 累加、lastTs 取末条、category 取首条；
// - 不可见条目（custom/toolResult）不阻断折叠；可见条目（用户消息）打断；
// - 不同文本不合并；带可见 content / 含 error part 的失败消息不折叠（保守口径）。
import { describe, expect, test } from "vitest";
import { buildMessageItems } from "@/components/chat/message-items";

const ERR = '429: {"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}';

function errEntry(id: string, ts: number, content: Array<{ type: string; text?: string }> = [], extra: Record<string, unknown> = {}) {
  return {
    type: "message",
    id,
    timestamp: new Date(ts).toISOString(),
    message: { role: "assistant", stopReason: "error", errorMessage: ERR, timestamp: ts, content, ...extra },
  };
}

function userEntry(id: string) {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text: "再试一次" }] } };
}

function customEntry(id: string) {
  return { type: "custom", id, customType: "session-lifecycle" };
}

function build(entries: Array<ReturnType<typeof errEntry> | ReturnType<typeof userEntry> | ReturnType<typeof customEntry>>) {
  return buildMessageItems(entries as never, { hasStreamingMessage: false, interrupted: false });
}

describe("errorRun 折叠（罗列收敛批）", () => {
  test("相邻同文纯错误折叠为单卡：count/lastTs/category", () => {
    const items = build([
      errEntry("e1", 1000, [], { providerDiagnostic: { httpStatus: 429 } }),
      customEntry("c1"),
      errEntry("e2", 2000, [{ type: "text", text: "" }]),
      customEntry("c2"),
      errEntry("e3", 3000),
    ]);
    expect(items).toHaveLength(1);
    const run = items[0];
    expect(run.kind).toBe("errorRun");
    if (run.kind !== "errorRun") return;
    expect(run.text).toBe(ERR);
    expect(run.count).toBe(3);
    expect(run.lastTs).toBe(3000);
    expect(run.category).toBe("rateLimit");
    expect(run.key).toBe("error-run-e1");
  });

  test("不同文本不合并，各自成卡", () => {
    const items = build([
      errEntry("e1", 1000),
      errEntry("e2", 2000, [], { errorMessage: "402: billing" } as never),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe("errorRun");
    expect(items[1].kind).toBe("errorRun");
  });

  test("用户消息打断折叠：非相邻不合并", () => {
    const items = build([errEntry("e1", 1000), userEntry("u1"), errEntry("e2", 2000)]);
    expect(items).toHaveLength(3);
    expect(items[0].kind).toBe("errorRun");
    expect(items[1].kind).toBe("entry");
    expect(items[2].kind).toBe("errorRun");
  });

  test("带可见 content 的失败消息不折叠，维持逐条气泡", () => {
    const items = build([
      errEntry("e1", 1000, [{ type: "text", text: "部分输出" }]),
      errEntry("e2", 2000),
    ]);
    expect(items[0].kind).toBe("entry");
    expect(items[1].kind).toBe("errorRun");
  });

  test("含 error part 的失败消息不折叠（保守口径：归类去重发生在渲染层）", () => {
    const items = build([
      errEntry("e1", 1000, [{ type: "error", message: ERR } as never]),
      errEntry("e2", 2000),
    ]);
    expect(items[0].kind).toBe("entry");
    expect(items[1].kind).toBe("errorRun");
  });

  test("非错误消息照常 entry：无 errorMessage / 非 assistant / toolResult", () => {
    const items = build([
      errEntry("e1", 1000, [], { stopReason: "length", errorMessage: undefined } as never),
      { type: "message", id: "u0", message: { role: "user", stopReason: "error", errorMessage: ERR } },
      { type: "message", id: "t0", message: { role: "toolResult", stopReason: "error", errorMessage: ERR, content: [] } },
    ] as never);
    expect(items).toHaveLength(2);
    expect(items.every((it) => it.kind === "entry")).toBe(true);
  });

  test("折叠卡携首条记录 id（翻页后排序归位用）", () => {
    const items = build([errEntry("e1", 1000), errEntry("e2", 2000)]);
    expect(items[0]).toMatchObject({ kind: "errorRun", entryId: "e1", count: 2 });
  });

  test("有记忆标记触发 mergeMemoryItems 重排时，折叠卡留在历史位置不被甩到末尾（2026-11-24 回归）", async () => {
    const { mergeMemoryItems } = await import("@/components/chat/message-items");
    const { memoryMarkerOf } = await import("@/lib/memory-entries");
    // 记忆标记条目（omo-memory:accepted-turns）：buildMessageItems 不入列，由 mergeMemoryItems 生成标记
    const markerEntry = { type: "custom", id: "m1", customType: "omo-memory:accepted-turns", data: {} } as never;
    expect(memoryMarkerOf(markerEntry)).not.toBeNull();
    const entries = [
      userEntry("u1"),
      errEntry("e1", 1000),
      markerEntry,
      userEntry("u2"),
    ];
    const items = build(entries as never);
    expect(items.map((it) => it.kind)).toEqual(["entry", "errorRun", "entry"]);
    const merged = mergeMemoryItems(items, entries as never);
    // 修复前：errorRun 无锚被赋 LAST，重排后沉到末尾 [entry, entry, memoryMarker, errorRun]
    expect(merged.map((it) => it.kind)).toEqual(["entry", "errorRun", "memoryMarker", "entry"]);
  });
});
