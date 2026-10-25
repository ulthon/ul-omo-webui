// 记忆停驻警示卡单测（docs08 2026-10-25 用户反馈：warning 级告警应内联消息列表，
// 与 omo native CLI 同构，不再依赖底部弹框）：
// - reflectionParkedOf 严格窄化（真实样本形态：streak/nextProbeAt/retryable/recommendation）
// - buildMessageItems：parked custom 条目入列 noticeCard；未知 custom 不入列（旧口径）
// - notify 帧 warning 级不弹 toast（event-dispatch 分流）
import { describe, expect, test, beforeEach, vi } from "vitest";
import { buildMessageItems, reflectionParkedOf } from "@/components/chat/message-items";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import { useUiStore } from "@/stores/ui";
import type { WireEntry } from "@/lib/api";

/** 真实样本形态（2026-10-24 生产 jsonl，2026-10-25 复核） */
function parkedEntry(over: Record<string, unknown> = {}): WireEntry & { id: string } {
  return {
    type: "custom",
    customType: "senpi-memory.reflection-parked",
    data: {
      schemaVersion: 1,
      identity: "senpi-webui-cd6e6588",
      streak: 6,
      parkedAt: "2026-10-24T00:07:10.696Z",
      nextProbeAt: "2026-10-24T06:07:10.696Z",
      retryable: true,
      lastReason: "failed",
      recommendation: "inspect runtime/reflection-sessions/<runId>/child-stderr.log",
      ...over,
    },
    id: "e-parked-1",
    parentId: null,
    timestamp: "2026-10-24T06:07:27.893Z",
  } as WireEntry & { id: string };
}

function frame(wire: Record<string, unknown>, cursor: number, durable = "d-notice"): void {
  dispatchSseEvent(
    String(wire.type),
    JSON.stringify({ projectPath: "/p", event: wire, durableSessionId: durable }),
    cursor,
  );
}

beforeEach(() => {
  useUiStore.setState({ toasts: [] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("reflectionParkedOf 窄化", () => {
  test("真实样本全字段命中", () => {
    const n = reflectionParkedOf(parkedEntry());
    expect(n).not.toBeNull();
    expect(n!.streak).toBe(6);
    expect(n!.retryable).toBe(true);
    expect(n!.nextProbeAtMs).toBe(Date.parse("2026-10-24T06:07:10.696Z"));
    expect(n!.recommendation).toContain("child-stderr.log");
  });

  test("时间缺失 → null 时间不阻断卡片", () => {
    const n = reflectionParkedOf(parkedEntry({ nextProbeAt: undefined }));
    expect(n).not.toBeNull();
    expect(n!.nextProbeAtMs).toBeNull();
  });

  test("streak 非正整数 → null（禁猜纪律）", () => {
    expect(reflectionParkedOf(parkedEntry({ streak: 0 }))).toBeNull();
    expect(reflectionParkedOf(parkedEntry({ streak: "6" }))).toBeNull();
    const e = parkedEntry();
    (e as unknown as { data: unknown }).data = null;
    expect(reflectionParkedOf(e)).toBeNull();
  });

  test("非本型 customType → null", () => {
    const e = parkedEntry();
    (e as unknown as { customType: unknown }).customType = "something.else";
    expect(reflectionParkedOf(e)).toBeNull();
  });
});

describe("buildMessageItems noticeCard 入列", () => {
  test("parked 条目 → noticeCard 行；未知 custom 条目不入列", () => {
    const unknownCustom: WireEntry & { id: string } = {
      type: "custom", customType: "other.extension", data: { x: 1 }, id: "e-other",
    } as WireEntry & { id: string };
    const items = buildMessageItems([parkedEntry(), unknownCustom], {
      hasStreamingMessage: false,
      interrupted: false,
    });
    expect(items.filter((i) => i.kind === "noticeCard")).toHaveLength(1);
    expect(items.some((i) => i.kind === "customMessage")).toBe(false);
  });
});

describe("notify 分流（warning 入列不弹）", () => {
  test("info notify → 底部轻提示；warning notify → 不弹（列表承载）", async () => {
    resetDispatchState();
    frame({ type: "extension_ui_request", method: "notify", message: "轻提示" }, 1);
    expect(useUiStore.getState().toasts.at(-1)?.text).toBe("轻提示");
    useUiStore.setState({ toasts: [] });
    frame({ type: "extension_ui_request", method: "notify", message: "Memory reflection paused", tone: "warning" }, 2);
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });
});
