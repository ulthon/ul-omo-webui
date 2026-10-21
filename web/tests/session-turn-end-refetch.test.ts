// task 19h（docs08-r6 IS-5）回归：回合自然结束（agent_end/settled/idle）补拉会话列表，
// 用服务端真相对齐侧栏（durable=true 创建占位行由 pendingIds 保护至列表带回）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionListItem } from "@/lib/api";
import { api } from "@/lib/api";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

function makeSession(id: string, messageCount = 0): SessionListItem {
  return {
    id,
    path: `/p/${id}.jsonl`,
    project: "/p",
    title: id,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount,
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

const listSessions = vi.spyOn(api, "listSessions");

beforeEach(() => {
  resetDispatchState();
  listSessions.mockReset();
  useUiStore.getState().setCurrentProject("/p");
});

afterEach(() => {
  resetDispatchState();
  useSessionsStore.setState({ byProject: {}, runStates: {}, runStateAt: {}, appliedModels: {}, selectedId: null, aliasIds: {}, pendingIds: {}, allMode: false });
  useUiStore.getState().setCurrentProject(null);
});

describe("回合结束补拉会话列表（task 19h）", () => {
  test("agent_end → refreshSessions 发射，服务端列表整替写入 byProject", async () => {
    useSessionsStore.getState().setSessions("/p", [makeSession("dur-new")]);
    listSessions.mockResolvedValue({ sessions: [makeSession("dur-new", 5), makeSession("other", 1)] });
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-1" }, "dur-new"), 1);
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    // 列表带回调用的参数：单项目模式按当前项目拉取
    expect(listSessions.mock.calls[0][0]).toMatchObject({ project: "/p" });
    await vi.waitFor(() => {
      const rows = useSessionsStore.getState().byProject["/p"];
      expect(rows.find((s) => s.id === "dur-new")?.messageCount).toBe(5);
      expect(rows.some((s) => s.id === "other")).toBe(true);
    });
    // 回合结束同时落 idle（既有语义不回退）
    expect(useSessionsStore.getState().runStates["dur-new"]).toBe("idle");
  });

  test("失败静默：listSessions 拒绝不冒泡、不清空列表", async () => {
    useSessionsStore.getState().setSessions("/p", [makeSession("dur-new")]);
    listSessions.mockRejectedValue(new Error("network"));
    expect(() => dispatchSseEvent("agent_settled", frame({ type: "agent_settled", sessionId: "rpc-1" }, "dur-new"), 1)).not.toThrow();
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(useSessionsStore.getState().byProject["/p"].map((s) => s.id)).toEqual(["dur-new"]);
  });
});
