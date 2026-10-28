// r10 todo 15：输出重复复发修复验收（store 级，docs08-r5 任务 3/4/5 同口径）。
//
// 根因（对照 b6d3df4 定案）：b6d3df4 的收敛不变量是"每条消息定格产生的合成孪生
// 由 entry_appended 真实 id 身份归一收敛"（诊断杠杆 1）。该不变量只在 SSE 通道成立：
// dad6d24 引入的 gap 小缺口 REST 增量补齐（?before= → appendEntries 追加路径）按 id
// upsert，不做载荷身份归一——当某条消息的 entry_appended 帧落在 gap 内丢失（切页/
// 隐藏页停摆丢帧，恰是用户复发场景），message_end 定格的合成孪生永无人收敛，REST
// 真实 id 条目追加后双列。6875933 的 200 帧尾窗+越窗截断发 gap 使对账补齐成为常态，
// 复发概率大增。
//
// 修复：追加路径（appendEntries）入列前标识对账——按待入列消息载荷指纹移除槽内
// 同载荷合成孪生（synthetic id 形态甄别，绝不触真实 id 条目），已追加消息的重放/
// 回填帧按 id upsert 幂等 no-op。
//
// 反铁律（docs/08:83）：身份对账绝不按内容跨回合去重——同会话两回合相同 assistant
// 文本各有真实 id，双双保留（反例钉死）。
import { beforeEach, describe, expect, test } from "vitest";
import type { WireEntry, WireMessage } from "@/lib/api";
import { useMessagesStore, type WireEvent } from "@/stores/messages";

function resetStores() {
  useMessagesStore.setState({ bySession: {}, replayRecovering: false });
}

const SID = "01a14f75-5cbb-7d44-8cef-b69e11975271";
const REPLY = "1\n2\n3";

function assistantMsg(text: string): WireMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

function realEntry(id: string, msg: WireMessage): WireEntry {
  return { type: "message", id, message: msg } as WireEntry;
}

function assistantEntriesOf(sessionId: string): WireEntry[] {
  const slot = useMessagesStore.getState().bySession[sessionId];
  if (!slot) return [];
  return slot.entries.filter((e) => (e.message as WireMessage | undefined)?.role === "assistant");
}

function isSyntheticId(id: unknown): boolean {
  return typeof id === "string" && /^h[0-9a-z]+-\d+$/.test(id);
}

/** 直发路径还原一段完整回合的 assistant 帧（无恢复窗口，live 语义） */
function liveAssistantFrames(text: string): WireEvent[] {
  return [
    { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: text.slice(0, 1) }], stopReason: "pending" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(1) } },
    { type: "message_end", message: assistantMsg(text) },
  ];
}

describe("r10 todo 15：追加路径标识对账（输出重复复发修复）", () => {
  beforeEach(resetStores);

  test("复现：entry_appended 落在 gap 内丢失后，REST 增量补齐追加真实 id 条目不残留合成孪生", () => {
    // live 回合完整流式 + message_end 定格 → 合成孪生入列
    for (const ev of liveAssistantFrames(REPLY)) useMessagesStore.getState().applyWireEvent(SID, ev);
    const slot = useMessagesStore.getState().bySession[SID];
    expect(assistantEntriesOf(SID).length).toBe(1);
    expect(isSyntheticId(assistantEntriesOf(SID)[0].id)).toBe(true);
    // 该消息的 entry_appended 帧落在 gap 内丢失（停摆丢帧）；
    // gap 小缺口对账经 ?before= REST 拿到真实 id 条目走 appendEntries 追加
    useMessagesStore.getState().appendEntries(SID, [realEntry("bbb00002", assistantMsg(REPLY))]);
    // 修复验收：孪生被收敛，恒单条真实 id（当前代码双列——失败复现）
    const entries = assistantEntriesOf(SID);
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe("bbb00002");
    expect(slot.streamingMessage).toBeNull();
  });

  test("已追加消息的重放/回填帧（同真实 id）幂等 no-op：不复制条目", () => {
    useMessagesStore.getState().setEntries(SID, [realEntry("aaa00001", assistantMsg(REPLY))], "aaa00001", "aaa00001");
    useMessagesStore.getState().appendEntries(SID, [realEntry("aaa00001", assistantMsg(REPLY))]);
    expect(assistantEntriesOf(SID).length).toBe(1);
    expect(assistantEntriesOf(SID)[0].id).toBe("aaa00001");
  });

  test("反铁律：同会话两回合完全相同 assistant 文本（各自真实 id）双双保留", () => {
    useMessagesStore.getState().setEntries(SID, [realEntry("aaa00001", assistantMsg("完全相同的回复"))], "aaa00001", "aaa00001");
    // 回合 2 同文回复经增量补齐追加（真实 id 异）
    useMessagesStore.getState().appendEntries(SID, [realEntry("bbb00002", assistantMsg("完全相同的回复"))]);
    const entries = assistantEntriesOf(SID);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.id)).toEqual(["aaa00001", "bbb00002"]);
  });

  test("对账只触合成孪生：槽内同文真实 id 条目不受追加移除影响", () => {
    // 两回合同文均已真实 id 落库；再补拉一条同文条目也不得误删既有真实条目
    useMessagesStore
      .getState()
      .setEntries(
        SID,
        [realEntry("aaa00001", assistantMsg("同文")), realEntry("bbb00002", assistantMsg("同文"))],
        "bbb00002",
        "bbb00002",
      );
    useMessagesStore.getState().appendEntries(SID, [realEntry("ccc00003", assistantMsg("同文"))]);
    const entries = assistantEntriesOf(SID);
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.id)).toEqual(["aaa00001", "bbb00002", "ccc00003"]);
  });

  test("user 消息追加同防线路径收敛：孪生被真实 id 条目整替", () => {
    const msg = { role: "user", content: [{ type: "text", text: "用户消息" }], timestamp: 1760000000000 };
    useMessagesStore.getState().applyWireEvent(SID, { type: "message_start", message: msg });
    useMessagesStore.getState().applyWireEvent(SID, { type: "message_end", message: msg });
    expect(assistantEntriesOf(SID).length).toBe(0);
    const slot = useMessagesStore.getState().bySession[SID];
    const users = slot.entries.filter((e) => (e.message as WireMessage | undefined)?.role === "user");
    expect(users.length).toBe(1);
    expect(isSyntheticId(users[0].id)).toBe(true);
    // entry_appended 丢失，REST 补齐真实 id 条目
    useMessagesStore.getState().appendEntries(SID, [realEntry("ddd00004", msg as WireMessage)]);
    const users2 = useMessagesStore.getState().bySession[SID].entries.filter(
      (e) => (e.message as WireMessage | undefined)?.role === "user",
    );
    expect(users2.length).toBe(1);
    expect(users2[0].id).toBe("ddd00004");
  });
});
