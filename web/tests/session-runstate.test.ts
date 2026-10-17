// todo 15 分发追加的单测：会话运行态（running/waiting/error）与未读计数递增。
// 覆盖 event-dispatch 的 SSE → sessions store 链路：
//   agent_start/end → running → 清除；extension_ui_request 四型 → waiting（setStatus/notify 噪音不算）；
//   error 尾缀类型 → error；message_end(assistant) 非查看态 → bumpUnread（选中且可见时不计）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SessionListItem } from "@/lib/api";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import { useSessionsStore } from "@/stores/sessions";

function makeSession(id: string): SessionListItem {
  return {
    id,
    path: `/store/sessions/${id}.jsonl`,
    project: "/p",
    title: id,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
  };
}

function frame(wire: Record<string, unknown>, durable?: string): string {
  return JSON.stringify(durable ? { projectPath: "/p", event: wire, durableSessionId: durable } : { projectPath: "/p", event: wire });
}

beforeEach(() => {
  resetDispatchState();
  const s = useSessionsStore.getState();
  s.setSessions("/p", [makeSession("durable-1"), makeSession("durable-2")]);
  s.select(null);
});

afterEach(() => {
  resetDispatchState();
  useSessionsStore.setState({ byProject: {}, runStates: {}, selectedId: null });
});

describe("运行态（状态点数据源）", () => {
  test("agent_start → running，agent_end 落 idle（权威空闲，压过不回落的 active 字段）", () => {
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-1" }, "durable-1"), 1);
    expect(useSessionsStore.getState().runStates["durable-1"]).toBe("running");
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-1" }, "durable-1"), 2);
    expect(useSessionsStore.getState().runStates["durable-1"]).toBe("idle");
  });

  test("四型 extension_ui_request → waiting；setStatus/notify 噪音不算", () => {
    for (const method of ["select", "confirm", "input", "editor"]) {
      dispatchSseEvent("extension_ui_request", frame({ type: "extension_ui_request", method, id: "r1", sessionId: "rpc-1" }, "durable-1"), 1);
      expect(useSessionsStore.getState().runStates["durable-1"]).toBe("waiting");
      useSessionsStore.getState().clearRunState("durable-1");
    }
    for (const method of ["setStatus", "notify", "setWidget"]) {
      dispatchSseEvent("extension_ui_request", frame({ type: "extension_ui_request", method, id: "r2", sessionId: "rpc-1" }, "durable-1"), 2);
      expect(useSessionsStore.getState().runStates["durable-1"]).toBeUndefined();
    }
  });

  test("error 尾缀 wire 类型 → error（容错识别）", () => {
    dispatchSseEvent("engine_event", frame({ type: "session_error", sessionId: "rpc-1" }, "durable-1"), 1);
    expect(useSessionsStore.getState().runStates["durable-1"]).toBe("error");
  });

  test("durableSessionId 缺席时按 wire sessionId 路由（兜底）", () => {
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "wire-alias" }), 1);
    expect(useSessionsStore.getState().runStates["wire-alias"]).toBe("running");
  });
});

describe("未读计数", () => {
  test("message_end(assistant) 非查看态 → unreadCount+1", () => {
    dispatchSseEvent("message_end", frame({ type: "message_end", sessionId: "rpc-1", message: { role: "assistant", content: [] } }, "durable-1"), 1);
    const list = useSessionsStore.getState().byProject["/p"]!;
    expect(list.find((s) => s.id === "durable-1")!.unreadCount).toBe(1);
  });

  test("选中且页面可见（bun 环境按可见兜底）→ 不计未读", () => {
    useSessionsStore.getState().select("durable-2");
    dispatchSseEvent("message_end", frame({ type: "message_end", sessionId: "rpc-2", message: { role: "assistant", content: [] } }, "durable-2"), 1);
    const list = useSessionsStore.getState().byProject["/p"]!;
    expect(list.find((s) => s.id === "durable-2")!.unreadCount).toBe(0);
  });

  test("message_end(user/toolResult) 与其他类型不计数", () => {
    dispatchSseEvent("message_end", frame({ type: "message_end", sessionId: "rpc-1", message: { role: "user", content: [] } }, "durable-1"), 1);
    dispatchSseEvent("message_end", frame({ type: "message_end", sessionId: "rpc-1", message: { role: "toolResult", content: [] } }, "durable-1"), 2);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-1" }, "durable-1"), 3);
    const list = useSessionsStore.getState().byProject["/p"]!;
    expect(list.find((s) => s.id === "durable-1")!.unreadCount).toBe(0);
  });
});
