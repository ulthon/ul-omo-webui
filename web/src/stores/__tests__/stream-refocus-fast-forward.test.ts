// r10 todo 14：切页回来流式滞后——复现与修复回归。
// 根因（复现钉定，见 evidence/task-14）：页面后台/断线期间引擎继续产出，回前台 SSE
// 重连后服务端以 replay_begin/replay_done 包夹补发积压帧（t8 重放窗口）。窗口内每帧
// message_update 都走 applyWireEvent → appendDelta，一次 set 一次渲染——UI 从旧位置
// 逐帧回放积压文本（滞后）。修复：窗口内 delta 按 (contentIndex,kind) 保序合并缓冲，
// replay_done 一次性快进 flush（最终内容与逐帧一致，渲染只落最新一拍）；窗口外
// 前台流式逐帧 set 语义原样保留（逐字效果回归断言）。
// 注：真实移动端 webview 的后台帧调度行为超出桌面仿真验证边界（桌面 Playwright/
// store 级仿真为准），已在 evidence 注明。
import { describe, expect, test, beforeEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");

const SID = "s-replay";

/** 建立在途流式形态：agent_start 建槽 + assistant message_start 建流式消息 */
function startStreamingSession(baseText: string): void {
  useMessagesStore.setState({ bySession: {}, replayRecovering: false });
  const s = useMessagesStore.getState();
  s.applyWireEvent(SID, { type: "agent_start" });
  s.applyWireEvent(SID, {
    type: "message_start",
    id: "m1",
    message: { role: "assistant", content: [{ type: "text", text: baseText }] },
  });
}

function textDelta(chunk: string) {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk },
  };
}

function streamingText(): string {
  const st = useMessagesStore.getState().bySession[SID];
  const part = st?.streamingMessage?.content?.[0];
  return part && part.type === "text" ? String(part.text) : "";
}

/** store 订阅计数（每次 set 一次通知 = 一拍渲染的代理量） */
function countStoreWrites(): { count: () => number; stop: () => void } {
  let n = 0;
  const unsub: () => void = useMessagesStore.subscribe(() => {
    n += 1;
  }) as () => void;
  return { count: () => n, stop: unsub };
}

beforeEach(() => {
  useMessagesStore.setState({ bySession: {}, replayRecovering: false });
});

describe("r10 todo 14：重放窗口积压快进（切页回来滞后修复）", () => {
  test("复现：回放窗口内 60 帧积压 delta 在当前代码逐帧写入（应失败）", () => {
    startStreamingSession("base|");
    const counter = countStoreWrites();
    useMessagesStore.getState().beginReplayRecovery();
    for (let i = 0; i < 60; i++) {
      useMessagesStore.getState().applyWireEvent(SID, textDelta(String.fromCharCode(97 + (i % 26))));
    }
    useMessagesStore.getState().endReplayRecovery();
    // 最终内容正确（现代码也满足）……
    expect(streamingText()).toBe("base|" + "abcdefghijklmnopqrstuvwxyz".repeat(3).slice(0, 60));
    // ……但当前逐帧写：60 次 set，UI 从旧位置逐帧回放（滞后根因）。修复后快进
    // 只应有个位数次写入（flush 合并 1 次 + 窗口标记 1 次）。
    expect(counter.count()).toBeLessThanOrEqual(4);
  });

  test("修复后：最终渲染 = 最新状态，且最终文本与逐帧应用结果完全一致", () => {
    // 对照组：同样 60 帧逐帧应用（前台语义）得到的最终文本
    startStreamingSession("base|");
    for (let i = 0; i < 60; i++) {
      useMessagesStore.getState().applyWireEvent(SID, textDelta(String.fromCharCode(97 + (i % 26))));
    }
    const expected = streamingText();

    // 快进组：回放窗口内同样序列
    startStreamingSession("base|");
    useMessagesStore.getState().beginReplayRecovery();
    for (let i = 0; i < 60; i++) {
      useMessagesStore.getState().applyWireEvent(SID, textDelta(String.fromCharCode(97 + (i % 26))));
    }
    useMessagesStore.getState().endReplayRecovery();
    expect(useMessagesStore.getState().replayRecovering).toBe(false);
    expect(streamingText()).toBe(expected);
  });

  test("多 part（thinking+text）与多会话积压同窗快进，保序合并不串组", () => {
    useMessagesStore.setState({ bySession: {}, replayRecovering: false });
    const s = useMessagesStore.getState();
    s.applyWireEvent(SID, { type: "agent_start" });
    s.applyWireEvent(SID, {
      type: "message_start",
      id: "m1",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "th|" }, { type: "text", text: "tx|" }] },
    });
    s.applyWireEvent("s2", { type: "agent_start" });
    s.applyWireEvent("s2", {
      type: "message_start",
      id: "m2",
      message: { role: "assistant", content: [{ type: "text", text: "o|" }] },
    });
    s.beginReplayRecovery();
    const seq = [
      [SID, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "A" } }],
      [SID, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "B" } }],
      [SID, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "C" } }],
      ["s2", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "D" } }],
    ] as const;
    for (const [sid, ev] of seq) s.applyWireEvent(sid, ev as never);
    s.endReplayRecovery();
    const msg = useMessagesStore.getState().bySession[SID].streamingMessage!;
    expect(msg.content![0]).toEqual({ type: "thinking", thinking: "th|AC" });
    expect(msg.content![1]).toEqual({ type: "text", text: "tx|B" });
    const msg2 = useMessagesStore.getState().bySession["s2"].streamingMessage!;
    expect(msg2.content![0]).toEqual({ type: "text", text: "o|D" });
  });

  test("前台逐字回归：窗口外逐帧流式写入次数等于帧数（逐字效果不牺牲）", () => {
    startStreamingSession("");
    const counter = countStoreWrites();
    for (let i = 0; i < 20; i++) {
      useMessagesStore.getState().applyWireEvent(SID, textDelta("x"));
    }
    // 前台流式保持逐帧渲染语义（每 delta 一拍）——typewriter 回归断言
    expect(counter.count()).toBe(20);
    expect(streamingText()).toBe("x".repeat(20));
  });

  test("回放窗口内 message_start / 非流式路径行为不变（t5 抑制语义零回归）", () => {
    // 定格条目 + 窗口内无 id start 前缀重播：仍被抑制（不重建 streamingMessage）
    startStreamingSession("已落库内容");
    useMessagesStore.getState().settleStreaming(SID);
    const entries = useMessagesStore.getState().bySession[SID].entries;
    expect(entries).toHaveLength(1);
    useMessagesStore.getState().beginReplayRecovery();
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "已落库内容" }] },
    });
    expect(useMessagesStore.getState().bySession[SID].streamingMessage).toBeNull();
    // 抑制后窗口内 delta 缓冲 flush 对无流式消息 no-op，不崩不增条目
    useMessagesStore.getState().applyWireEvent(SID, textDelta("x"));
    useMessagesStore.getState().endReplayRecovery();
    expect(useMessagesStore.getState().bySession[SID].streamingMessage).toBeNull();
    expect(useMessagesStore.getState().bySession[SID].entries).toHaveLength(1);
  });
});
