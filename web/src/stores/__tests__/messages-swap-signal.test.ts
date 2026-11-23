// webui-refetch-storm 任务 3：setEntries 整替换代序号（swapSeq）store 级信号单测。
// 口径：setEntries 全量整替落在既有可见窗口（prev 有条目）上自增；首载水合、增量
// append、更早窗头插、游标/回执等旁路写入不计数。该序号是视图层换代检测的优先信号
// （message-list 落地滚动补偿），也是口径 A「稳态（无真对账）零整替」验收的计数器。
// 环境说明同 messages-admission.test.ts：node 环境、@ts-nocheck + 动态 import。
// @ts-nocheck
import { describe, expect, test, beforeEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");

const SID = "t-swap-seq";

function entry(id, parentId = null) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: id }] },
  };
}

const st = () => useMessagesStore.getState().bySession[SID];
const seq = () => st()?.swapSeq;

beforeEach(() => {
  useMessagesStore.setState({ bySession: {} });
});

describe("setEntries 整替换代序号（swapSeq）", () => {
  test("首载水合不计数：空槽 setEntries → swapSeq 0", () => {
    useMessagesStore.getState().setEntries(SID, [entry("a")], "a", "a");
    expect(seq()).toBe(0);
  });

  test("落在既有可见窗口上自增：二次 setEntries → 1，三次 → 2", () => {
    useMessagesStore.getState().setEntries(SID, [entry("a")], "a", "a");
    useMessagesStore.getState().setEntries(SID, [entry("a"), entry("b", "a")], "b", "b");
    expect(seq()).toBe(1);
    useMessagesStore.getState().setEntries(SID, [entry("a"), entry("b", "a")], "b", "b");
    expect(seq()).toBe(2);
  });

  test("增量 append 不计数：appendEntries 后 swapSeq 保持", () => {
    useMessagesStore.getState().setEntries(SID, [entry("a")], "a", "a");
    useMessagesStore.getState().appendEntries(SID, [entry("b", "a")]);
    expect(st().entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(seq()).toBe(0);
  });

  test("更早窗头插不计数：prependEntries 后 swapSeq 保持", () => {
    useMessagesStore.getState().setEntries(SID, [entry("a")], "a", "a");
    useMessagesStore.getState().prependEntries(SID, [entry("z0")], { hasMore: true, oldestId: "z0" });
    expect(st().entries.map((e) => e.id)).toEqual(["z0", "a"]);
    expect(seq()).toBe(0);
  });

  test("旁路写入不计数：setCursor / markReceiptModel 后 swapSeq 保持", () => {
    useMessagesStore.getState().setEntries(SID, [entry("a")], "a", "a");
    useMessagesStore.getState().setCursor(SID, "a2");
    useMessagesStore.getState().markReceiptModel(SID, "provider/model-x");
    expect(seq()).toBe(0);
  });

  test("槽先由 appendEntries 建出（可见内容在先）再 setEntries → 计一次", () => {
    useMessagesStore.getState().appendEntries(SID, [entry("a")]);
    expect(seq()).toBe(0);
    useMessagesStore.getState().setEntries(SID, [entry("a")], "a", "a");
    expect(seq()).toBe(1);
  });
});
