// 会话事件行锚点单测（事件行锚点化批 2026-11-18）：「模型已切换为 xxx」等事件行按
// 发生时刻的末条 entry 锚入消息流（CLI 同构：提示随消息流上移），不再恒钉列表底部；
// 锚解析失败回落流末（流式气泡之前，与提问卡同口径）；无 entries 序信息时维持存量
// 尾部并入。
import { describe, expect, test } from "vitest";
import { mergeSessionEventLines, type ChatListItem, type SessionEventLine } from "@/components/chat/message-items";

function entryItem(entryId: string): ChatListItem {
  return { key: `e-${entryId}`, kind: "entry", entryId, interrupted: false, model: null };
}

const STREAMING: ChatListItem = { key: "streaming", kind: "streaming" };

function line(id: string, anchorEntryId?: string | null): SessionEventLine {
  return {
    id,
    summary: { key: "chat.sessionEvents.modelSwitch", vars: { model: "p/m" } },
    ...(anchorEntryId !== undefined ? { anchorEntryId } : {}),
  };
}

const ENTRIES = [
  { type: "message", id: "e1" },
  { type: "message", id: "e2" },
];

describe("mergeSessionEventLines 锚点插入", () => {
  test("锚在 e1：事件行插在 e1 之后、e2 之前（切换发生在回答回来之前，随流上移）", () => {
    const out = mergeSessionEventLines([entryItem("e1"), entryItem("e2")], [line("ev-1", "e1")], ENTRIES);
    expect(out.map((i) => i.key)).toEqual(["e-e1", "session-event-ev-1", "e-e2"]);
  });

  test("流式气泡在场：锚点事件行插在气泡之前，气泡保持在最后", () => {
    const out = mergeSessionEventLines(
      [entryItem("e1"), entryItem("e2"), STREAMING],
      [line("ev-1", "e2")],
      ENTRIES,
    );
    expect(out.map((i) => i.key)).toEqual(["e-e1", "e-e2", "session-event-ev-1", "streaming"]);
  });

  test("同锚多行保持到达序", () => {
    const out = mergeSessionEventLines(
      [entryItem("e1"), entryItem("e2")],
      [line("ev-1", "e1"), line("ev-2", "e1")],
      ENTRIES,
    );
    expect(out.map((i) => i.key)).toEqual(["e-e1", "session-event-ev-1", "session-event-ev-2", "e-e2"]);
  });

  test("锚缺失（null/解析不出）回落流末：流式气泡之前，无流式则末尾", () => {
    const withStream = mergeSessionEventLines([entryItem("e1"), STREAMING], [line("ev-1", null)], ENTRIES);
    expect(withStream.map((i) => i.key)).toEqual(["e-e1", "session-event-ev-1", "streaming"]);
    const noStream = mergeSessionEventLines([entryItem("e1")], [line("ev-2", "ghost-anchor")], ENTRIES);
    expect(noStream.map((i) => i.key)).toEqual(["e-e1", "session-event-ev-2"]);
  });

  test("无 entries 序信息：维持尾部并入（存量口径）", () => {
    const out = mergeSessionEventLines([entryItem("e1"), STREAMING], [line("ev-1")], []);
    expect(out.map((i) => i.key)).toEqual(["e-e1", "streaming", "session-event-ev-1"]);
  });
});
