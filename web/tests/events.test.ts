// EventsClient 单测（mock EventSource）：重连退避序列、连接状态、事件分发、
// gap/游标回退触发的全量 refetch、未知事件容错、单例约束、前台唤醒。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionListItem, WireEntry } from "@/lib/api";
import { dispatchSseEvent, getDispatchCursor, resetDispatchState } from "@/lib/event-dispatch";
import { connectEvents, disconnectEvents, EventsClient } from "@/lib/events";
import { useMessagesStore, type SessionMessages } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { MockEventSource, MockScheduler } from "./helpers/mock-sse";

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

function loadedMessages(entries: WireEntry[]): SessionMessages {
  return {
    entries,
    cursor: "old-cursor",
    leafId: null,
    loaded: true,
    streaming: false,
    streamingMessage: null,
    streamingEntryId: null,
    toolRuns: {},
  };
}

function freshClient(scheduler: MockScheduler): EventsClient {
  return new EventsClient({
    createEventSource: ((url: string) => new MockEventSource(url)) as unknown as (url: string) => EventSource,
    schedule: scheduler.schedule,
  });
}

/** 让微任务链（fetch promise → setEntries）走完 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface FetchLog {
  calls: string[];
  restore: () => void;
}

/** 替换全局 fetch 记录调用并返回固定 JSON */
function stubFetch(respond: (url: string) => { status: number; body: unknown }): FetchLog {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const res = respond(url);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

beforeEach(() => {
  MockEventSource.reset();
  resetDispatchState();
  useMessagesStore.setState({ bySession: {} });
  useSessionsStore.setState({ byProject: {}, selectedId: null, loading: false });
  useUiStore.setState({ connection: "online" });
});

afterEach(() => {
  disconnectEvents();
});

describe("重连退避", () => {
  test("断线后按 1s/2s/4s…30s 指数退避重建，open 成功复位", () => {
    const scheduler = new MockScheduler();
    const client = freshClient(scheduler);
    client.start();
    expect(MockEventSource.instances).toHaveLength(1);
    expect(useUiStore.getState().connection).toBe("online");

    for (const expected of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      MockEventSource.instances.at(-1)!.emitError();
      expect(useUiStore.getState().connection).toBe("reconnecting");
      scheduler.flush();
      expect(scheduler.delays().at(-1)).toBe(expected);
      // 旧连接已被关闭（close-on-error，不用浏览器固定节奏的原生重连）
      expect(MockEventSource.live).toHaveLength(1);
    }

    // 恢复在线 → 复位，再断从 1s 起步
    const es = MockEventSource.instances.at(-1)!;
    es.emitOpen();
    expect(useUiStore.getState().connection).toBe("online");
    es.emitError();
    scheduler.flush();
    expect(scheduler.delays().at(-1)).toBe(1000);
    client.stop();
  });

  test("stop 关闭连接、取消挂起重连；重启可用", () => {
    const scheduler = new MockScheduler();
    const client = freshClient(scheduler);
    client.start();
    MockEventSource.instances[0].emitError();
    expect(scheduler.pendingCount()).toBe(1);

    client.stop();
    expect(MockEventSource.instances[0].closed).toBe(true);
    scheduler.flush();
    expect(MockEventSource.instances).toHaveLength(1); // 无新连接

    client.start();
    expect(MockEventSource.instances).toHaveLength(2);
    client.stop();
  });

  test("回前台唤醒：连接死亡/退避等待时立即重建并复位退避", () => {
    const scheduler = new MockScheduler();
    const client = freshClient(scheduler);
    client.start();
    const es0 = MockEventSource.instances[0];
    es0.emitOpen();
    es0.emitError(); // 进入退避等待（1s 挂起）
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(scheduler.pendingCount()).toBe(1);

    client.wake();
    expect(scheduler.entries[0].cancelled).toBe(true); // 挂起退避被取消
    expect(MockEventSource.instances).toHaveLength(2); // 立即重建

    // 退避已复位：新连接再断仍是 1s
    MockEventSource.instances[1].emitError();
    scheduler.flush();
    expect(scheduler.delays().at(-1)).toBe(1000);
    client.stop();
  });
});

describe("事件分发", () => {
  test("message_update 增量进 messages store；agent_start/idle 同步 sessions 活跃态", () => {
    useSessionsStore.setState({ byProject: { "/p": [makeSession("s1")] } });
    const scheduler = new MockScheduler();
    const client = freshClient(scheduler);
    client.start();
    const es = MockEventSource.instances[0];
    es.emitOpen();

    es.emit(
      "message_start",
      { projectPath: "/p", event: { type: "message_start", sessionId: "s1", id: "e1", message: { role: "assistant", content: [] } } },
      10,
    );
    es.emit(
      "message_update",
      { projectPath: "/p", event: { type: "message_update", sessionId: "s1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" } } },
      11,
    );
    es.emit(
      "message_update",
      { projectPath: "/p", event: { type: "message_update", sessionId: "s1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "，世界" } } },
      12,
    );

    const session = useMessagesStore.getState().bySession["s1"];
    expect(session?.streaming).toBe(true);
    const part = session?.streamingMessage?.content?.[0] as { text?: string } | undefined;
    expect(part?.text).toBe("你好，世界");
    expect(getDispatchCursor()).toBe(12);

    es.emit("agent_start", { projectPath: "/p", event: { type: "agent_start", sessionId: "s1" } }, 13);
    expect(useSessionsStore.getState().byProject["/p"][0].active).toBe(true);
    es.emit("agent_idle", { projectPath: "/p", event: { type: "agent_idle", sessionId: "s1" } }, 14);
    expect(useSessionsStore.getState().byProject["/p"][0].active).toBe(false);

    es.emit(
      "agent_end",
      { projectPath: "/p", event: { type: "agent_end", sessionId: "s1", message: { role: "assistant", content: [{ type: "text", text: "你好，世界" }] } } },
      15,
    );
    const settled = useMessagesStore.getState().bySession["s1"];
    expect(settled.streaming).toBe(false);
    expect(settled.entries).toHaveLength(1);
    client.stop();
  });

  test("未知事件类型 / 无 sessionId / 非法 JSON 帧全部容错忽略", () => {
    const scheduler = new MockScheduler();
    const client = freshClient(scheduler);
    client.start();
    const es = MockEventSource.instances[0];
    es.emitOpen();

    // 噪音类型不在监听集合内，浏览器层就不派发；同型帧直接打分发层验证容错
    dispatchSseEvent("tool_hook_status", JSON.stringify({ projectPath: "/p", event: { type: "tool_hook_status", sessionId: "s1" } }), 1);
    dispatchSseEvent("message_update", "not-json{{", 2);
    dispatchSseEvent("message_update", JSON.stringify({ projectPath: "/p" }), 3); // 无 event
    dispatchSseEvent("message_update", JSON.stringify({ projectPath: "/p", event: { type: "extension_ui_request" } }), 4); // 无 sessionId
    es.emit(
      "message_update",
      { projectPath: "/p", event: { type: "message_update", sessionId: "s1", assistantMessageEvent: { type: "who_knows", contentIndex: 9 } } },
      5,
    );

    expect(useMessagesStore.getState().bySession["s1"]).toBeUndefined();
    expect(getDispatchCursor()).toBe(5);
    client.stop();
  });

  test("重放幂等：同一回合事件流整体重喂一遍（重连缓冲重放路径），entries 不重复", () => {
    const scheduler = new MockScheduler();
    const client = freshClient(scheduler);
    client.start();
    const es = MockEventSource.instances[0];
    es.emitOpen();

    const turn = [
      { name: "agent_start", cursor: 1, event: { type: "agent_start", sessionId: "s1" } },
      { name: "message_start", cursor: 2, event: { type: "message_start", sessionId: "s1", id: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }] } } },
      { name: "message_start", cursor: 3, event: { type: "message_start", sessionId: "s1", id: "a1", message: { role: "assistant", content: [] } } },
      { name: "message_update", cursor: 4, event: { type: "message_update", sessionId: "s1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" } } },
      { name: "message_end", cursor: 5, event: { type: "message_end", sessionId: "s1", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "你好" }] } } },
      { name: "agent_end", cursor: 6, event: { type: "agent_end", sessionId: "s1" } },
    ];
    const feed = () => {
      for (const f of turn) es.emit(f.name, { projectPath: "/p", event: f.event }, f.cursor);
    };
    feed();
    const afterFirst = useMessagesStore.getState().bySession["s1"]!;
    expect(afterFirst.entries).toHaveLength(2); // user + assistant
    expect(afterFirst.streaming).toBe(false);

    // 重连后服务端缓冲全量重放：同一批帧重喂，状态收敛一致
    feed();
    const afterReplay = useMessagesStore.getState().bySession["s1"]!;
    expect(afterReplay.entries).toHaveLength(2);
    expect(afterReplay.streaming).toBe(false);
    expect(afterReplay.streamingMessage).toBeNull();
    expect(getDispatchCursor()).toBe(6);
    client.stop();
  });
});

describe("gap 与游标回退", () => {
  test("gap 帧触发已加载会话全量 refetch（先取后换，不清空界面）", async () => {
    const oldEntry: WireEntry = { type: "message", id: "old" };
    useMessagesStore.setState({ bySession: { s1: loadedMessages([oldEntry]) } });

    const page = { sessionId: "s1", entries: [{ type: "message", id: "m1" }], leafId: "m1", cursor: "m1" };
    const fetchLog = stubFetch((url) =>
      url.includes("/api/sessions/s1/messages") ? { status: 200, body: page } : { status: 404, body: { error: "unknown" } },
    );
    try {
      const scheduler = new MockScheduler();
      const client = freshClient(scheduler);
      client.start();
      const es = MockEventSource.instances[0];
      es.emitOpen();

      es.emit("gap", { from: 1, to: 5 }, 40);
      await tick();

      expect(fetchLog.calls.some((c) => c.includes("/api/sessions/s1/messages"))).toBe(true);
      const session = useMessagesStore.getState().bySession["s1"];
      expect(session.entries).toEqual([{ type: "message", id: "m1" }]);
      expect(session.cursor).toBe("m1");
      expect(session.loaded).toBe(true);
      client.stop();
    } finally {
      fetchLog.restore();
    }
  });

  test("游标回退（服务端重启归零）触发全量 refetch，且与 gap 连击不重复拉取", async () => {
    useMessagesStore.setState({ bySession: { s1: loadedMessages([]) } });
    const page = { sessionId: "s1", entries: [], leafId: null, cursor: null };
    const fetchLog = stubFetch(() => ({ status: 200, body: page }));
    try {
      // 旧纪元游标 100
      dispatchSseEvent("agent_start", JSON.stringify({ projectPath: "/p", event: { type: "agent_start", sessionId: "s1" } }), 100);
      expect(getDispatchCursor()).toBe(100);

      // 重连后新纪元：gap 帧 id=0（回退）→ refetch；随后新事件 id 1（仍回退）→ 去重不重复拉
      dispatchSseEvent("gap", JSON.stringify({ from: 1, to: 0 }), 0);
      dispatchSseEvent("agent_start", JSON.stringify({ projectPath: "/p", event: { type: "agent_start", sessionId: "s1" } }), 1);
      await tick();
      await tick();

      const messageCalls = fetchLog.calls.filter((c) => c.includes("/api/sessions/s1/messages"));
      expect(messageCalls.length).toBe(1); // in-flight 去重
      expect(getDispatchCursor()).toBe(1);
    } finally {
      fetchLog.restore();
    }
  });

  test("仅流式活动过（未 loaded）的会话同样触发 refetch；store 外会话自然不涉及", async () => {
    const fetchLog = stubFetch(() => ({ status: 500, body: { error: { code: "x", message: "x" } } }));
    try {
      dispatchSseEvent("gap", JSON.stringify({ from: 1, to: 5 }), 40);
      await tick();
      expect(fetchLog.calls).toHaveLength(0); // store 中无会话

      // applyWireEvent 在消息事件到达时为该会话建 store 条目（loaded=false 的活动会话）
      dispatchSseEvent(
        "message_start",
        JSON.stringify({ projectPath: "/p", event: { type: "message_start", sessionId: "s1", id: "e1", message: { role: "user", content: [] } } }),
        41,
      );
      dispatchSseEvent("gap", JSON.stringify({ from: 1, to: 5 }), 42);
      await tick();
      await tick();
      expect(fetchLog.calls).toHaveLength(1); // 活动会话被校准，失败不抛、不清空 store
      expect(useMessagesStore.getState().bySession["s1"]).toBeDefined();
    } finally {
      fetchLog.restore();
    }
  });
});

describe("单例约束", () => {
  test("connectEvents 重复调用至多 1 条存活连接；disconnectEvents 全关", () => {
    const scheduler = new MockScheduler();
    const factory = ((url: string) => new MockEventSource(url)) as unknown as (url: string) => EventSource;
    connectEvents({ createEventSource: factory, schedule: scheduler.schedule });
    connectEvents({ createEventSource: factory, schedule: scheduler.schedule });
    expect(MockEventSource.live).toHaveLength(1);
    disconnectEvents();
    expect(MockEventSource.live).toHaveLength(0);
    expect(MockEventSource.instances.every((es) => es.closed)).toBe(true);
  });

  test("重连周期内同一时刻也只有 1 条存活连接", () => {
    const scheduler = new MockScheduler();
    const client = freshClient(scheduler);
    client.start();
    MockEventSource.instances[0].emitError();
    scheduler.flush();
    expect(MockEventSource.live).toHaveLength(1);
    client.stop();
  });
});
