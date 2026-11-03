// CLI 恢复摘要收敛（2026-11-02，与 CLI 对齐）：引擎终端扩展每次 CLI 重启/接管写
// senpi-terminal:restore-digest custom_message；buildMessageItems 专用静音信息行入列，
// 且同型只保留最末一条（旧摘要描述彼次重启后的状态，天然过期）。数据不动纯展示收敛。
import { describe, expect, test } from "vitest";
import { buildMessageItems } from "@/components/chat/message-items";
import type { WireEntry } from "@/lib/api";

function digest(id: string, content: string, display = true): WireEntry & { id: string } {
  return {
    type: "custom_message",
    customType: "senpi-terminal:restore-digest",
    display,
    content,
    id,
    parentId: null,
    timestamp: "2026-11-02T00:00:00.000Z",
  } as WireEntry & { id: string };
}

function msg(id: string): WireEntry & { id: string } {
  return {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
    id,
    parentId: null,
    timestamp: "2026-11-02T00:00:01.000Z",
  } as WireEntry & { id: string };
}

describe("restoreDigest 同类收敛", () => {
  test("多条只渲染最末一条，位置保持在最末条目处（不跳到末尾）", () => {
    const items = buildMessageItems(
      [digest("d1", "state A"), msg("m1"), digest("d2", "state B"), msg("m2"), digest("d3", "state C"), msg("m3")],
      { hasStreamingMessage: false, interrupted: false },
    );
    const ds = items.filter((it) => it.kind === "restoreDigest");
    expect(ds).toHaveLength(1);
    if (ds[0].kind !== "restoreDigest") throw new Error("unreachable");
    expect(ds[0].digest.content).toBe("state C");
    // 位置在 d3 原时序处（m2 之后），且不被挪到列表末尾
    expect(items[items.length - 1].kind).toBe("entry");
    expect(items.indexOf(ds[0])).toBeGreaterThan(items.findIndex((it) => it.kind === "entry" && "entryId" in it && it.entryId === "m2"));
  });

  test("display=false 不入列；其它未知 customType 兜底占位行照旧", () => {
    const unknown = {
      type: "custom_message",
      customType: "some-unknown-type",
      display: true,
      id: "u1",
      parentId: null,
      timestamp: "2026-11-02T00:00:00.000Z",
    } as WireEntry & { id: string };
    const items = buildMessageItems([digest("d1", "hidden", false), unknown], {
      hasStreamingMessage: false,
      interrupted: false,
    });
    expect(items.filter((it) => it.kind === "restoreDigest")).toHaveLength(0);
    expect(items.filter((it) => it.kind === "customMessage")).toHaveLength(1);
  });

  test("content 非字符串回落空串不阻断渲染", () => {
    const weird = {
      type: "custom_message",
      customType: "senpi-terminal:restore-digest",
      display: true,
      content: 123,
      id: "d1",
      parentId: null,
      timestamp: "2026-11-02T00:00:00.000Z",
    } as unknown as WireEntry & { id: string };
    const items = buildMessageItems([weird], { hasStreamingMessage: false, interrupted: false });
    const ds = items.filter((it) => it.kind === "restoreDigest");
    expect(ds).toHaveLength(1);
    if (ds[0].kind !== "restoreDigest") throw new Error("unreachable");
    expect(ds[0].digest.content).toBe("");
  });

  test("例行摘要（nothing to restore / 全恢复）不入列；关注句（lost/orphan/仍在跑）才显示", () => {
    const routine = buildMessageItems(
      [digest("r1", "Terminal state after restart: nothing to restore."), digest("r2", "Terminal state after restart: restored 2 - a, b; muted 1 - c.")],
      { hasStreamingMessage: false, interrupted: false },
    );
    expect(routine.filter((it) => it.kind === "restoreDigest")).toHaveLength(0);

    const actionable = buildMessageItems(
      [digest("a1", "Terminal state after restart (offline up to 3m): lost 1 - watch x; background: job y still running (pid 9, output not captured).")],
      { hasStreamingMessage: false, interrupted: false },
    );
    expect(actionable.filter((it) => it.kind === "restoreDigest")).toHaveLength(1);
  });

  test("认不出的句式一律显示（fail-open，引擎改词不吞信息）", () => {
    const items = buildMessageItems(
      [digest("u1", "全新措辞的摘要：监视器可能出问题了")],
      { hasStreamingMessage: false, interrupted: false },
    );
    expect(items.filter((it) => it.kind === "restoreDigest")).toHaveLength(1);
  });
});
