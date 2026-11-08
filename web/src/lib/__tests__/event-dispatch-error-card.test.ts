// 2026-11-08 直做批 #31：引擎 error 帧（429 限流等）文本进常驻错误卡——
// 此前分支只置状态点、文本被丢弃致 UI 展示为空。锁定三断言：
// 带文本 error 帧 → 状态点 error + 常驻错误卡出现文本；无文本帧 → 仅状态点；
// 同文重放不堆叠（pushError 同文去重兜底重连重放面）。
// @ts-nocheck
import { describe, expect, test, beforeEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");

function emit(sessionId, event, cursor = 100) {
  dispatchSseEvent("wire", JSON.stringify({ durableSessionId: sessionId, event }), cursor);
}

beforeEach(() => {
  useMessagesStore.setState({ bySession: {} });
  useSessionsStore.setState({ runStates: {} });
  resetDispatchState();
});

describe("引擎 error 帧文本进常驻错误卡（#31）", () => {
  test("带文本的 error 帧：状态点 error + 错误卡携带原文", () => {
    emit("s1", { type: "error", message: 'Error: 429: {"code":"1302","message":"您的账户已达到速率限制"}' });
    expect(useSessionsStore.getState().runStates["s1"]).toBe("error");
    const slot = useMessagesStore.getState().bySession["s1"];
    expect(slot?.errors ?? []).toHaveLength(1);
    expect(slot.errors[0].text).toContain("429");
    expect(slot.errors[0].text).toContain("1302");
  });

  test("error 尾缀类型帧同样入卡（开放集容错识别面不回退）", () => {
    emit("s2", { type: "prompt_error", message: "回合失败：连接中断" });
    expect(useSessionsStore.getState().runStates["s2"]).toBe("error");
    expect(useMessagesStore.getState().bySession["s2"]?.errors ?? []).toHaveLength(1);
  });

  test("无文本帧仅置状态点，不产生空错误卡", () => {
    emit("s3", { type: "error" });
    expect(useSessionsStore.getState().runStates["s3"]).toBe("error");
    expect(useMessagesStore.getState().bySession["s3"]?.errors ?? []).toHaveLength(0);
  });

  test("同文重放不堆叠（重连重放面由同文去重兜底）", () => {
    emit("s4", { type: "error", message: "Error: 429: limit" }, 100);
    emit("s4", { type: "error", message: "Error: 429: limit" }, 101);
    expect(useMessagesStore.getState().bySession["s4"]?.errors ?? []).toHaveLength(1);
  });
});
