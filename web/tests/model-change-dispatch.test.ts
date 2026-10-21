/**
 * 模型切换 SSE 事件接线（docs08-r6 任务 8 ③④⑤）：
 * - model_changed（引擎每次成功切换必发）：归一 "provider/model" 写 sessions store
 *   appliedModels（徽标/水位环数据源）；绝不回写 ui.selectedModel（不回写偏好语义）。
 * - model_change_rejected（引擎守卫拒绝，reason=context-budget/auth）：error toast
 *   明示切换未生效；runState 必须不变——toast 不得污染运行态（对抗类断言）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import { useMessagesStore } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

function frame(wire: Record<string, unknown>, cursor: number, durable?: string): void {
  dispatchSseEvent(
    String(wire.type),
    JSON.stringify(
      durable ? { projectPath: "/p", event: wire, durableSessionId: durable } : { projectPath: "/p", event: wire },
    ),
    cursor,
  );
}

beforeEach(() => {
  resetDispatchState();
  useMessagesStore.setState({ bySession: {} });
  useSessionsStore.setState({ appliedModels: {}, runStates: {}, byProject: {}, selectedId: null });
  useUiStore.setState({ toast: null, selectedModel: "zai-coding-cn/glm-5.3-flash" });
});

afterEach(() => {
  resetDispatchState();
});

describe("model_changed（引擎落定回显，任务 8 ④⑤数据源）", () => {
  test("归一 provider/model 写 appliedModels（信封 durableSessionId 路由），不回写 selectedModel", () => {
    frame(
      { type: "model_changed", model: { provider: "zai-coding-cn", id: "glm-4.7" }, thinkingLevel: "low", sessionId: "rpc-1" },
      1,
      "d-1",
    );
    expect(useSessionsStore.getState().appliedModels["d-1"]).toBe("zai-coding-cn/glm-4.7");
    // 不回写偏好语义：顶栏/chip 的选择不受引擎回显篡改
    expect(useUiStore.getState().selectedModel).toBe("zai-coding-cn/glm-5.3-flash");
  });

  test("载荷异形（model 缺 provider/id）静默容错，不写入", () => {
    frame({ type: "model_changed", model: { id: "glm-4.7" }, sessionId: "rpc-1" }, 2, "d-1");
    frame({ type: "model_changed", sessionId: "rpc-1" }, 3, "d-1");
    expect(Object.keys(useSessionsStore.getState().appliedModels)).toEqual([]);
  });
});

describe("model_change_rejected（任务 8 ③：error toast，不动 runState）", () => {
  test("拒绝帧弹 error toast 含模型与 detail，runState/active 保持不变", () => {
    useSessionsStore.getState().setRunState("d-1", "running");
    const before = useSessionsStore.getState().runStates["d-1"];

    frame(
      {
        type: "model_change_rejected",
        model: { provider: "zai-coding-cn", id: "glm-4.6v" },
        reason: "context-budget",
        detail: "Compact the session before switching",
        sessionId: "rpc-1",
      },
      4,
      "d-1",
    );

    const toast = useUiStore.getState().toast;
    expect(toast).not.toBeNull();
    expect(toast?.kind).toBe("error");
    expect(toast?.text).toContain("glm-4.6v");
    expect(toast?.text).toContain("Compact the session before switching");

    // 对抗类 toast_pollutes_runstate：拒绝不改变回合进行状态
    expect(useSessionsStore.getState().runStates["d-1"]).toBe(before);
    // appliedModels 也不得被拒绝帧污染（切换未生效）
    expect(useSessionsStore.getState().appliedModels["d-1"]).toBeUndefined();
  });

  test("载荷缺 detail/model 容错为空串，仍弹 toast 不抛错", () => {
    useSessionsStore.getState().setRunState("d-9", "waiting");
    frame({ type: "model_change_rejected", reason: "auth", sessionId: "rpc-2" }, 5, "d-9");
    expect(useUiStore.getState().toast?.kind).toBe("error");
    expect(useSessionsStore.getState().runStates["d-9"]).toBe("waiting");
  });
});
