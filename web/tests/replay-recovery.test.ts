// docs08-r5 任务 5：流式末段重播修复验收（store 级，任务 3 诊断同口径）。
//
// 根因（.omo/evidence/docs08-r5/task-3-diagnosis.md 定案，confirmed）：引擎 wire 消息帧
// 全程无 id，真实条目 id 仅在 entry_appended（=JSONL id=REST id，三方一致实证）且被前端
// 白名单丢弃——刷新/切页后 SSE 整缓冲重放把已落库 assistant 段的 start/deltas/end 重播
// 一遍：start 重建 streamingMessage（从头逐字重播）、end 按 syntheticId 落合成孪生
// （与 REST 真实 id 条目永不收敛，双份留存）。
//
// 修复（诊断 5(d) 杠杆 1+2）：
//   杠杆 1 身份归一——entry_appended 对 user/assistant 消息条目消费真实 id：移除同载荷
//          合成孪生（djb2 合成 id 与引擎真实 id 两空间不相交，只删孪生）+ 真实 id upsert；
//   杠杆 2 重放消费抑制——服务端重放路径以 replay_begin/replay_done 桥级帧界定单次恢复
//          窗口（event-dispatch 转译为 store.replayRecovering）；窗口内无 id assistant
//          start 若载荷已是槽内定格 assistant 条目的内容前缀（且含非空文本/思考的正向
//          身份证据），不重建 streamingMessage（no-op 吸收，message_end 由杠杆 1 收敛）。
//
// 反铁律（任务 5 前置约束）：两杠杆均以真实 id/恢复窗口为判据，永不按内容指纹跨回合
// 去重——两个不同回合的完全相同 assistant 回复必须双双保留（反例测试钉死）。
//
// 浏览器级复现不可行（诊断同款约束：隔离实例无前端构建）；store 的 entries +
// streamingMessage 与 buildMessageItems 产物即渲染层双列/重播的直接输入，store 级 +
// items 级断言为充分证据（浏览器级取证留待 F3 隔离实例手动 QA）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WireEntry, WireMessage } from "@/lib/api";
import { buildMessageItems } from "@/components/chat/message-items";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import { useMessagesStore, type WireEvent } from "@/stores/messages";

function resetStores() {
  useMessagesStore.setState({ bySession: {}, replayRecovering: false });
}

const SID = "01a14f75-5cbb-7d44-8cef-b69e11975271";

const REPLY_TEXT = "1\n2\n3";

/** REST 真相形态的 assistant 定格条目（真实 id，引擎 JSONL 同构） */
function assistantRestEntry(id: string, message: WireMessage): WireEntry {
  return { type: "message", id, message } as WireEntry;
}

/** 已落库 assistant 段的重放帧（probe3 帧 9204-9302 语义还原：start 半截 pending 载荷、
 * deltas、end 全量 stop 载荷，全程无 id） */
function replayedAssistantFrames(text = REPLY_TEXT): WireEvent[] {
  const start = {
    role: "assistant",
    content: [{ type: "text", text: text.slice(0, 1) }],
    stopReason: "pending",
  };
  const end = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
  return [
    { type: "message_start", message: start },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(1) } },
    { type: "message_end", message: end },
  ];
}

function appendedFrame(id: string, message: WireMessage): WireEvent {
  return { type: "entry_appended", entry: { type: "message", id, message } };
}

function entryIds(sessionId: string): string[] {
  const slot = useMessagesStore.getState().bySession[sessionId];
  return slot ? slot.entries.map((e) => e.id) : [];
}

function slotOf(sessionId: string) {
  return useMessagesStore.getState().bySession[sessionId];
}

function isSyntheticId(id: unknown): boolean {
  return typeof id === "string" && /^h[0-9a-z]+-\d+$/.test(id);
}

describe("docs08-r5 任务 5：流式末段重播修复（身份归一 + 恢复窗口抑制）", () => {
  beforeEach(resetStores);
  afterEach(() => {
    resetDispatchState();
    resetStores();
  });

  test("恢复窗口内已落库段 start 不重建 streamingMessage（重播抑制），end 孪生由 entry_appended 收敛", () => {
    const end = { role: "assistant", content: [{ type: "text", text: REPLY_TEXT }], stopReason: "stop" };
    useMessagesStore.getState().setEntries(SID, [assistantRestEntry("4a6479d9", end)], "4a6479d9", "4a6479d9");
    useMessagesStore.getState().beginReplayRecovery();
    const frames = replayedAssistantFrames();
    useMessagesStore.getState().applyWireEvent(SID, frames[0]);
    // 抑制验收：不重建流式（用户看不到从头逐字重播）
    expect(slotOf(SID).streamingMessage).toBeNull();
    expect(slotOf(SID).streaming).toBe(false);
    // delta 无流式消息可作用，自然 no-op；end 定格孪生随后被身份归一收敛
    useMessagesStore.getState().applyWireEvent(SID, frames[1]);
    useMessagesStore.getState().applyWireEvent(SID, frames[2]);
    expect(entryIds(SID).length).toBe(2); // REST 真相 + 刚定格的合成孪生（相邻帧窗口）
    useMessagesStore.getState().applyWireEvent(SID, appendedFrame("4a6479d9", end));
    useMessagesStore.getState().endReplayRecovery();
    expect(entryIds(SID)).toEqual(["4a6479d9"]); // 恒单条真实 id
    expect(slotOf(SID).streamingMessage).toBeNull();
    expect(slotOf(SID).streaming).toBe(false);
  });

  test("恢复窗口内在途新段（前缀不匹配）照常流式重建，落定后单条真实 id 不丢失", () => {
    // REST 旧快照：只有历史段，不含在途新段 M（REST 旧快照 vs 新 SSE 帧竞态形态）
    const oldEntry = { role: "assistant", content: [{ type: "text", text: "历史回复" }], stopReason: "stop" };
    useMessagesStore.getState().setEntries(SID, [assistantRestEntry("aaa00001", oldEntry)], "aaa00001", "aaa00001");
    useMessagesStore.getState().beginReplayRecovery();
    const frames = replayedAssistantFrames();
    useMessagesStore.getState().applyWireEvent(SID, frames[0]);
    // 在途段照常重建（新内容不是任何定格条目的前缀——live 续播语义保持）
    expect(slotOf(SID).streamingMessage).not.toBeNull();
    expect(slotOf(SID).streaming).toBe(true);
    for (const ev of frames.slice(1)) useMessagesStore.getState().applyWireEvent(SID, ev);
    useMessagesStore.getState().applyWireEvent(SID, appendedFrame("bbb00002", frames[frames.length - 1].message));
    useMessagesStore.getState().endReplayRecovery();
    // 竞态不丢消息：新段单条真实 id 在列，历史段原样保留
    expect(entryIds(SID)).toEqual(["aaa00001", "bbb00002"]);
    expect(slotOf(SID).streamingMessage).toBeNull();
  });

  test("恢复窗口内空载荷 start 无身份证据，不抑制（照常重建）", () => {
    const end = { role: "assistant", content: [{ type: "text", text: REPLY_TEXT }], stopReason: "stop" };
    useMessagesStore.getState().setEntries(SID, [assistantRestEntry("4a6479d9", end)], "4a6479d9", "4a6479d9");
    useMessagesStore.getState().beginReplayRecovery();
    // 空 content 的 start：与任何条目都"前缀匹配"但不含非空文本——不构成身份证据，
    // 照常重建（宁可短暂重播也不冒进吞掉在途段的流式呈现）
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "message_start",
      message: { role: "assistant", content: [], stopReason: "pending" },
    });
    expect(slotOf(SID).streamingMessage).not.toBeNull();
    useMessagesStore.getState().endReplayRecovery();
  });

  test("窗口外（未开窗口）同前缀 start 照常重建——live 流式零改动", () => {
    const end = { role: "assistant", content: [{ type: "text", text: REPLY_TEXT }], stopReason: "stop" };
    useMessagesStore.getState().setEntries(SID, [assistantRestEntry("4a6479d9", end)], "4a6479d9", "4a6479d9");
    // 不开恢复窗口：新回合恰好以同文开头（同前缀）也必须照常流式
    const frames = replayedAssistantFrames();
    useMessagesStore.getState().applyWireEvent(SID, frames[0]);
    expect(slotOf(SID).streamingMessage).not.toBeNull();
    expect(slotOf(SID).streaming).toBe(true);
    for (const ev of frames.slice(1)) useMessagesStore.getState().applyWireEvent(SID, ev);
    useMessagesStore.getState().applyWireEvent(SID, appendedFrame("ccc00003", frames[frames.length - 1].message));
    // 两回合各自真实 id 并存（同文不同回合，反铁律）
    expect(entryIds(SID)).toEqual(["4a6479d9", "ccc00003"]);
  });

  test("entry_appended 身份归一：合成孪生被真实 id 替换；无孪生时真实条目补入", () => {
    // live 路径：end 定格落合成 id，entry_appended 到达即归一为真实 id（此后与 REST 同空间）
    const msg = { role: "assistant", content: [{ type: "text", text: "实时回复" }], stopReason: "stop" };
    useMessagesStore.getState().applyWireEvent(SID, { type: "message_start", message: { ...msg, stopReason: "pending", content: [{ type: "text", text: "实" }] } });
    useMessagesStore.getState().applyWireEvent(SID, { type: "message_end", message: msg });
    expect(entryIds(SID).length).toBe(1);
    expect(isSyntheticId(entryIds(SID)[0])).toBe(true);
    useMessagesStore.getState().applyWireEvent(SID, appendedFrame("ddd00004", msg));
    expect(entryIds(SID)).toEqual(["ddd00004"]);
    // 重复 entry_appended 幂等（重放同帧不复制条目）
    useMessagesStore.getState().applyWireEvent(SID, appendedFrame("ddd00004", msg));
    expect(entryIds(SID)).toEqual(["ddd00004"]);

    // 补入分支：帧缺失场景下仅 entry_appended 到达，真实条目直接入列
    const msg2 = { role: "assistant", content: [{ type: "text", text: "补入回复" }], stopReason: "stop" };
    useMessagesStore.getState().applyWireEvent(SID, appendedFrame("eee00005", msg2));
    expect(entryIds(SID)).toEqual(["ddd00004", "eee00005"]);
  });

  test("entry_appended 身份归一覆盖 user 旧格式帧（无 timestamp）：任务 4 守卫不启用时仍收敛", () => {
    // 老数据（无 timestamp）：任务 4 载荷守卫不启用，回显重播落合成孪生；
    // entry_appended 真实身份归一仍然收敛——双杠杆互补
    const restMsg = { role: "user", content: [{ type: "text", text: "旧格式消息" }] };
    useMessagesStore
      .getState()
      .setEntries(SID, [{ type: "message", id: "fff00006", message: restMsg } as WireEntry], "fff00006", "fff00006");
    useMessagesStore.getState().applyWireEvent(SID, { type: "message_start", message: restMsg });
    useMessagesStore.getState().applyWireEvent(SID, { type: "message_end", message: restMsg });
    expect(entryIds(SID).length).toBe(2); // 旧行为：守卫不启用，合成孪生暂存
    useMessagesStore.getState().applyWireEvent(SID, appendedFrame("fff00006", restMsg));
    expect(entryIds(SID)).toEqual(["fff00006"]); // 归一收敛为单条真实 id
  });

  test("反铁律：两个不同回合的完全相同 assistant 回复（各自真实 id）双双保留", () => {
    // 回合 1 已落库（REST 真相 R1）；回合 2 live 到达同文回复，entry_appended 携 R2。
    // 任何环节都不得因"内容相同"坍缩：R1 与 R2 必须并存。
    const reply = { role: "assistant", content: [{ type: "text", text: "完全相同的回复" }], stopReason: "stop" };
    useMessagesStore.getState().setEntries(SID, [assistantRestEntry("aaa00001", reply)], "aaa00001", "aaa00001");
    // 回合 2 live 全生命周期（窗口外，正常流式）
    const frames = replayedAssistantFrames("完全相同的回复");
    for (const ev of frames) useMessagesStore.getState().applyWireEvent(SID, ev);
    useMessagesStore.getState().applyWireEvent(SID, appendedFrame("bbb00002", frames[frames.length - 1].message));
    const ids = entryIds(SID);
    expect(ids).toEqual(["aaa00001", "bbb00002"]);
    expect(slotOf(SID).entries.length).toBe(2);
  });

  test("恢复窗口内 turn_end/agent_end 定格路径零回归：抑制段不残留流式标志，live 段正常定格", () => {
    const settled = { role: "assistant", content: [{ type: "text", text: REPLY_TEXT }], stopReason: "stop" };
    useMessagesStore.getState().setEntries(SID, [assistantRestEntry("4a6479d9", settled)], "4a6479d9", "4a6479d9");
    useMessagesStore.getState().beginReplayRecovery();
    // 重播的 turn_end/agent_end（无在途流式）：不定格、不残留
    useMessagesStore.getState().applyWireEvent(SID, { type: "turn_end", message: settled });
    useMessagesStore.getState().applyWireEvent(SID, { type: "agent_end" });
    expect(slotOf(SID).streaming).toBe(false);
    expect(slotOf(SID).streamingMessage).toBeNull();
    expect(entryIds(SID)).toEqual(["4a6479d9"]);
    useMessagesStore.getState().endReplayRecovery();

    // live turn_end：在途流式照常定格（既有语义）
    useMessagesStore.getState().applyWireEvent(SID, { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "实" }], stopReason: "pending" } });
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "实时定格" }], stopReason: "stop" },
    });
    expect(slotOf(SID).streamingMessage).toBeNull();
    expect(entryIds(SID).length).toBe(2);
  });

  test("dispatch 转译：replay_begin/replay_done 桥级帧翻转 store 恢复窗口", () => {
    expect(useMessagesStore.getState().replayRecovering).toBe(false);
    dispatchSseEvent("replay_begin", JSON.stringify({ after: 0, buffered: 1000 }), 1000);
    expect(useMessagesStore.getState().replayRecovering).toBe(true);
    // 窗口内消息帧照常分发（同一入口路由不回归）
    dispatchSseEvent(
      "message_start",
      JSON.stringify({ projectPath: "/p", event: { type: "message_start", sessionId: SID, message: { role: "assistant", content: [] } } }),
      1001,
    );
    expect(slotOf(SID).streaming).toBe(true);
    dispatchSseEvent("replay_done", JSON.stringify({ count: 1000 }), 1001);
    expect(useMessagesStore.getState().replayRecovering).toBe(false);
  });

  test("渲染直接输入：重放收敛后 buildMessageItems 单 assistant 项、无流式项（DOM 无孪生气泡的直接输入）", () => {
    const end = { role: "assistant", content: [{ type: "text", text: REPLY_TEXT }], stopReason: "stop" };
    useMessagesStore.getState().setEntries(SID, [assistantRestEntry("4a6479d9", end)], "4a6479d9", "4a6479d9");
    useMessagesStore.getState().beginReplayRecovery();
    for (const ev of replayedAssistantFrames()) useMessagesStore.getState().applyWireEvent(SID, ev);
    useMessagesStore.getState().applyWireEvent(SID, appendedFrame("4a6479d9", end));
    useMessagesStore.getState().endReplayRecovery();
    const slot = slotOf(SID);
    const items = buildMessageItems(
      slot.entries.filter((e) => typeof e.id === "string") as Array<WireEntry & { id: string; message: WireMessage }>,
      { hasStreamingMessage: slot.streamingMessage !== null, interrupted: false },
    );
    const entryItems = items.filter((i) => i.kind === "entry");
    expect(entryItems.length).toBe(1);
    expect(items.some((i) => i.kind === "streaming")).toBe(false);
    expect(entryItems[0].key).toBe("4a6479d9");
  });
});
