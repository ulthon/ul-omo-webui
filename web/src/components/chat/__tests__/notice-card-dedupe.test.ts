// 同类警示卡聚合（2026-10-31，与 CLI 对齐）：引擎在会话重载/引擎重启时重复写
// reflection-parked 条目（生产实测同 parkedAt 成簇 6 条），CLI 仅事件到达时画一次；
// buildMessageItems 同类 noticeCard 只保留最末一条（最新状态）。
import { describe, expect, test } from "vitest";
import { buildMessageItems } from "@/components/chat/message-items";
import type { WireEntry } from "@/lib/api";

function parked(id: string, streak: number): WireEntry & { id: string } {
  return {
    type: "custom",
    customType: "senpi-memory.reflection-parked",
    data: {
      schemaVersion: 1, identity: "a", streak, parkedAt: "2026-10-30T23:31:02.743Z",
      nextProbeAt: "2026-10-31T05:31:02.743Z", retryable: true,
      lastReason: "failed", recommendation: "inspect child-stderr.log",
    },
    id, parentId: null, timestamp: "2026-10-31T00:00:00.000Z",
  } as WireEntry & { id: string };
}

function msg(id: string): WireEntry & { id: string } {
  return {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
    id, parentId: null, timestamp: "2026-10-31T00:00:01.000Z",
  } as WireEntry & { id: string };
}

describe("noticeCard 同类聚合", () => {
  test("多条 parked 只渲染最末一条，取其最新 streak", () => {
    const items = buildMessageItems(
      [parked("e1", 6), msg("m1"), parked("e2", 6), parked("e3", 7)],
      { hasStreamingMessage: false, interrupted: false },
    );
    const cards = items.filter((i) => i.kind === "noticeCard");
    expect(cards).toHaveLength(1);
    if (cards[0].kind === "noticeCard") {
      expect(cards[0].notice.streak).toBe(7);
      expect(cards[0].key).toContain("e3");
    }
  });

  test("单条不受影响；卡片保持在原时序位置（不跳到末尾）", () => {
    const items = buildMessageItems(
      [parked("e1", 6), msg("m1")],
      { hasStreamingMessage: false, interrupted: false },
    );
    const cards = items.filter((i) => i.kind === "noticeCard");
    expect(cards).toHaveLength(1);
    expect(items[0].kind).toBe("noticeCard");
    expect(items[1].kind).toBe("entry");
  });
});