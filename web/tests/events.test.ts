// EventsClient 单测（mock EventSource）：重连退避序列、连接状态、事件分发、
// gap/游标回退触发的全量 refetch、未知事件容错、单例约束、前台唤醒。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
    es0.emit("message_start", { projectPath: "/p", event: { type: "message_start", sessionId: "s1", id: "e1", message: { role: "user", content: [] } } }, 1);
    es0.emitError(); // 收到过帧的正常断开：走 EventSource 退避重建（不触发降级）
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(scheduler.pendingCount()).toBe(1);

    client.wake();
    expect(scheduler.entries[0].cancelled).toBe(true); // 挂起退避被取消
    expect(MockEventSource.instances).toHaveLength(2); // 立即重建

    // 退避已复位：新连接再断仍是 1s
    MockEventSource.instances[1].emitOpen();
    MockEventSource.instances[1].emit("message_update", { projectPath: "/p", event: { type: "message_update", sessionId: "s1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } } }, 2);
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

  test("信封 durableSessionId 优先作 store 路由键；缺席帧回退 wire sessionId", () => {
    const scheduler = new MockScheduler();
    const client = freshClient(scheduler);
    client.start();
    const es = MockEventSource.instances[0];
    es.emitOpen();

    // 带 durableSessionId：路由键 = durable id（非 holder 别名 rpc-1）
    es.emit(
      "message_start",
      { projectPath: "/p", event: { type: "message_start", sessionId: "rpc-1", id: "e1", message: { role: "user", content: [] } }, durableSessionId: "dur-1" },
      1,
    );
    // 缺席 durableSessionId：回退 wire sessionId
    es.emit(
      "message_start",
      { projectPath: "/p", event: { type: "message_start", sessionId: "rpc-2", id: "e2", message: { role: "user", content: [] } } },
      2,
    );

    const keys = Object.keys(useMessagesStore.getState().bySession);
    expect(keys).toContain("dur-1");
    expect(keys).toContain("rpc-2");
    expect(keys).not.toContain("rpc-1");

    // 会话级状态同样落在 durable 键下（todo 15 的 SessionListItem.id 即 durable id）
    useSessionsStore.setState({ byProject: { "/p": [makeSession("dur-1")] } });
    es.emit(
      "agent_start",
      { projectPath: "/p", event: { type: "agent_start", sessionId: "rpc-1" }, durableSessionId: "dur-1" },
      3,
    );
    expect(useSessionsStore.getState().byProject["/p"][0].active).toBe(true);
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

  test("synthetic agent_settled（事件断流兜底）触发该会话补拉；真实 settle 不触发", async () => {
    // 形态复现：引擎事件断流（assistant 流式事件未送达），server watchdog 合成
    // agent_settled{synthetic:true}——前端须补拉 GET messages 兜底显示已落盘回复
    useSessionsStore.setState({ byProject: { "/p": [makeSession("s1")] } });
    useMessagesStore.setState({
      bySession: { s1: loadedMessages([{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "你好" }] } } as unknown as WireEntry]) },
    });
    const page = {
      sessionId: "s1",
      entries: [
        { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "你好" }] } },
        { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "你好！我是编排代理。" }] } },
      ],
      leafId: "a1",
      cursor: "a1",
    };
    const fetchLog = stubFetch((url) =>
      url.includes("/api/sessions/s1/messages") ? { status: 200, body: page } : { status: 404, body: { error: "unknown" } },
    );
    try {
      const scheduler = new MockScheduler();
      const client = freshClient(scheduler);
      client.start();
      const es = MockEventSource.instances[0];
      es.emitOpen();

      // 对照：真实 agent_settled（引擎事件，无 synthetic 标记）不补拉
      es.emit("agent_settled", { projectPath: "/p", event: { type: "agent_settled", sessionId: "rpc-1" }, durableSessionId: "s1" }, 1);
      await tick();
      expect(fetchLog.calls).toHaveLength(0);

      // synthetic settle（settle_watchdog / engine_crash 合成）→ 补拉该会话
      es.emit(
        "agent_settled",
        { projectPath: "/p", event: { type: "agent_settled", synthetic: true, sessionId: "s1", reason: "settle_watchdog" }, durableSessionId: "s1" },
        2,
      );
      await tick();

      expect(fetchLog.calls.some((c) => c.includes("/api/sessions/s1/messages"))).toBe(true);
      const session = useMessagesStore.getState().bySession["s1"]!;
      expect(session.entries).toHaveLength(2); // user + 补拉回来的 assistant 回复
      expect((session.entries[1].message as { role?: string }).role).toBe("assistant");
      expect(session.cursor).toBe("a1");
      client.stop();
    } finally {
      fetchLog.restore();
    }
  });

  test("synthetic settle 到达时 store 外会话不触发补拉", async () => {
    const fetchLog = stubFetch(() => ({ status: 200, body: { sessionId: "s-x", entries: [], leafId: null, cursor: null } }));
    try {
      dispatchSseEvent(
        "agent_settled",
        JSON.stringify({ projectPath: "/p", event: { type: "agent_settled", synthetic: true, sessionId: "s-other", reason: "engine_crash" } }),
        1,
      );
      await tick();
      await tick();
      expect(fetchLog.calls).toHaveLength(0); // 未加载会话不在补拉范围
    } finally {
      fetchLog.restore();
    }
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
      // 活动会话被校准（docs08-r4 任务 11 起 gap 另发一次 GET /queue 排队对账，不计入本断言），
      // 失败不抛、不清空 store
      expect(fetchLog.calls.filter((c) => c.includes("/api/sessions/s1/messages"))).toHaveLength(1);
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

// ---------- fetch 流降级（Chrome 153 EventSource 停摆兜底） ----------

/** 可控 ReadableStream：测试按需 push chunk / close 断流 */
class MockSseStream {
  readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  constructor() {
    this.stream = new ReadableStream({
      start: (c) => {
        this.controller = c;
      },
    });
  }
  push(text: string): void {
    this.controller.enqueue(new TextEncoder().encode(text));
  }
  close(): void {
    this.controller.close();
  }
}

interface MockFetchRecord {
  url: string;
  lastEventId: string | null;
}

/** transport 级 fetch mock：返回可控 SSE 流并记录请求（与 refetch 的 globalThis.fetch 独立） */
function makeFetchMock(stream: MockSseStream, calls: MockFetchRecord[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), lastEventId: headers["Last-Event-ID"] ?? null });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: stream.stream,
    } as unknown as Response;
  }) as typeof fetch;
}

describe("fetch 流降级", () => {
  test("SSE 解析：多行 data 合并 / 跨 chunk 分帧 / id 记录 / 心跳注释跳过", async () => {
    resetDispatchState();
    useMessagesStore.setState({ bySession: {} });
    const scheduler = new MockScheduler();
    const stream = new MockSseStream();
    const calls: MockFetchRecord[] = [];
    const client = new EventsClient({
      forceFetchTransport: true,
      schedule: scheduler.schedule,
      fetchImpl: makeFetchMock(stream, calls),
    });
    client.start();
    await tick(); // fetch 发起并连上

    // 单 chunk 完整帧（user message 入列）
    stream.push(
      'event: message_start\ndata: {"event":{"type":"message_start","sessionId":"s1","id":"e1","message":{"role":"user","content":[]}}}\nid: 10\n\n',
    );
    // 跨 chunk 分帧：事件行被切断
    stream.push('event: message_start\ndata: {"event":{"type":"message_start","sess');
    stream.push('ionId":"s1","id":"e2","message":{"role":"user","content":[]}}}\nid: 11\n\n');
    // 多行 data 合并（换行在 JSON token 之间，parse 合法）
    stream.push('event: message_start\ndata: {"event":\ndata: {"type":"message_start","sessionId":"s1","id":"e3","message":{"role":"user","content":[]}}}\nid: 12\n\n');
    // 心跳注释行：不产生派发
    stream.push(": ping\n\n");
    await tick();

    const session = useMessagesStore.getState().bySession["s1"];
    expect(session?.entries).toHaveLength(3);
    expect(session?.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(getDispatchCursor()).toBe(12);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/events");
    client.stop();
  });

  test("fetch 模式收到 gap 帧走既有 refetch 兜底", async () => {
    resetDispatchState();
    useMessagesStore.setState({ bySession: { s1: loadedMessages([]) } });
    const page = { sessionId: "s1", entries: [{ type: "message", id: "m1" }], leafId: "m1", cursor: "m1" };
    const refetchCalls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      refetchCalls.push(String(input));
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const scheduler = new MockScheduler();
      const stream = new MockSseStream();
      const client = new EventsClient({
        forceFetchTransport: true,
        schedule: scheduler.schedule,
        fetchImpl: makeFetchMock(stream, []),
      });
      client.start();
      await tick();
      stream.push('event: gap\ndata: {"from":1,"to":0}\nid: 5\n\n');
      await tick();
      await tick();
      expect(refetchCalls.some((c) => c.includes("/api/sessions/s1/messages"))).toBe(true);
      expect(useMessagesStore.getState().bySession["s1"]!.entries).toEqual([{ type: "message", id: "m1" }]);
      client.stop();
    } finally {
      globalThis.fetch = original;
    }
  });

  test("重连请求自带 Last-Event-ID 头（游标取自分发层记账）", async () => {
    resetDispatchState();
    dispatchSseEvent("agent_start", JSON.stringify({ projectPath: "/p", event: { type: "agent_start", sessionId: "s1" } }), 42);
    const scheduler = new MockScheduler();
    const stream = new MockSseStream();
    const calls: MockFetchRecord[] = [];
    const client = new EventsClient({
      forceFetchTransport: true,
      schedule: scheduler.schedule,
      fetchImpl: makeFetchMock(stream, calls),
    });
    client.start();
    await tick();
    expect(calls[0].lastEventId).toBe("42");
    client.stop();
  });

  test("EventSource OPEN 后看门狗窗口内零消息切 fetch；模式粘滞（断流重连不再回 EventSource）", async () => {
    const scheduler = new MockScheduler();
    const stream = new MockSseStream();
    const calls: MockFetchRecord[] = [];
    const client = new EventsClient({
      stallTimeoutMs: 5000,
      heartbeatMs: 8000,
      createEventSource: ((url: string) => new MockEventSource(url)) as unknown as (url: string) => EventSource,
      schedule: scheduler.schedule,
      fetchImpl: makeFetchMock(stream, calls),
    });
    client.start();
    MockEventSource.instances[0].emitOpen(); // 布防滚动看门狗第一拍
    expect(scheduler.delays().at(-1)).toBe(16000); // 窗口 = max(5000, 2×8000)

    scheduler.flush(); // 窗口内零帧 → 停摆判定，挂重连退避
    scheduler.flush(); // 退避到期 → fetch 接管
    expect(calls).toHaveLength(1);
    await tick();

    // fetch 流正常派发（同一条 dispatch 入口）
    stream.push('event: message_start\ndata: {"event":{"type":"message_start","sessionId":"s1","id":"e1","message":{"role":"user","content":[]}}}\nid: 20\n\n');
    await tick();
    expect(useMessagesStore.getState().bySession["s1"]).toBeDefined();

    // 断流 → 退避重连仍走 fetch（EventSource 不再新建：模式粘滞）
    stream.close();
    await tick();
    scheduler.flush();
    expect(calls).toHaveLength(2);
    expect(MockEventSource.instances).toHaveLength(1);
    client.stop();
  });

  test("任何帧（含 hb 心跳）续期看门狗：活跃/健康空闲收流期绝不误切，停帧满窗才切", () => {
    const scheduler = new MockScheduler();
    const stream = new MockSseStream();
    const calls: MockFetchRecord[] = [];
    const client = new EventsClient({
      stallTimeoutMs: 5000,
      heartbeatMs: 8000,
      createEventSource: ((url: string) => new MockEventSource(url)) as unknown as (url: string) => EventSource,
      schedule: scheduler.schedule,
      fetchImpl: makeFetchMock(stream, calls),
    });
    client.start();
    const es = MockEventSource.instances[0];
    es.emitOpen();
    expect(scheduler.pendingCount()).toBe(1);

    // 事件帧续期：旧一轮计时被取消，新一轮重新计时（滚动制，而非解除）
    es.emit("message_start", { projectPath: "/p", event: { type: "message_start", sessionId: "s1", id: "e1", message: { role: "user", content: [] } } }, 1);
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.entries.filter((e) => e.cancelled)).toHaveLength(1);

    // hb 心跳帧同样续期（生产 8s 节拍：健康空闲连接每次心跳都重置 16s 窗口）
    es.emit("hb", { projectPath: "", event: { type: "hb", t: 1 } }, 2);
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.delays().at(-1)).toBe(16000);
    expect(scheduler.entries.filter((e) => !e.cancelled)).toHaveLength(1);

    // 最后一次续期后模拟窗口流逝（无新帧）→ 才判定停摆
    scheduler.flush();
    expect(scheduler.pendingCount()).toBe(1); // 重连退避挂起
    scheduler.flush();
    expect(calls).toHaveLength(1); // 切 fetch 接管
    client.stop();
  });

  test("停摆超窗切 fetch 时强制 refetchLoadedSessions 全量对账（自愈兜底）", async () => {
    useMessagesStore.setState({ bySession: { s1: loadedMessages([]) } });
    const page = { sessionId: "s1", entries: [{ type: "message", id: "m1" }], leafId: "m1", cursor: "m1" };
    const fetchLog = stubFetch((url) =>
      url.includes("/api/sessions/s1/messages") ? { status: 200, body: page } : { status: 404, body: { error: "unknown" } },
    );
    try {
      const scheduler = new MockScheduler();
      const stream = new MockSseStream();
      const client = new EventsClient({
        stallTimeoutMs: 5000,
        heartbeatMs: 8000,
        createEventSource: ((url: string) => new MockEventSource(url)) as unknown as (url: string) => EventSource,
        schedule: scheduler.schedule,
        fetchImpl: makeFetchMock(stream, []),
      });
      client.start();
      MockEventSource.instances[0].emitOpen();
      scheduler.flush(); // 超窗 → 停摆判定 → 对账
      await tick();
      await tick();
      expect(fetchLog.calls.some((c) => c.includes("/api/sessions/s1/messages"))).toBe(true);
      expect(useMessagesStore.getState().bySession["s1"]!.entries).toEqual([{ type: "message", id: "m1" }]);
      client.stop();
    } finally {
      fetchLog.restore();
    }
  });

  test("EventSource OPEN 后零帧即断同样判定停摆切 fetch，并触发对账", async () => {
    useMessagesStore.setState({ bySession: { s1: loadedMessages([]) } });
    const page = { sessionId: "s1", entries: [{ type: "message", id: "m1" }], leafId: "m1", cursor: "m1" };
    const fetchLog = stubFetch((url) =>
      url.includes("/api/sessions/s1/messages") ? { status: 200, body: page } : { status: 404, body: { error: "unknown" } },
    );
    try {
      const scheduler = new MockScheduler();
      const stream = new MockSseStream();
      const calls: MockFetchRecord[] = [];
      const instancesBefore = MockEventSource.instances.length;
      const client = new EventsClient({
        stallTimeoutMs: 5000,
        heartbeatMs: 8000,
        createEventSource: ((url: string) => new MockEventSource(url)) as unknown as (url: string) => EventSource,
        schedule: scheduler.schedule,
        fetchImpl: makeFetchMock(stream, calls),
      });
      client.start();
      MockEventSource.instances.at(-1)!.emitOpen();
      MockEventSource.instances.at(-1)!.emitError(); // OPEN 后零帧即断
      await tick();
      await tick();
      expect(calls).toHaveLength(0); // error 路径先退避，未立即 fetch
      expect(fetchLog.calls.some((c) => c.includes("/api/sessions/s1/messages"))).toBe(true); // 对账已发射
      expect(useMessagesStore.getState().bySession["s1"]!.entries).toEqual([{ type: "message", id: "m1" }]);
      scheduler.flush();
      expect(calls).toHaveLength(1); // 退避到期切 fetch
      expect(MockEventSource.instances.length).toBe(instancesBefore + 1); // 不再回 EventSource（粘滞）
      client.stop();
    } finally {
      fetchLog.restore();
    }
  });

  test("hb 心跳帧经分发：游标推进、不进任何 store（follow-only 语义）", () => {
    const scheduler = new MockScheduler();
    const client = freshClient(scheduler);
    client.start();
    const es = MockEventSource.instances[0];
    es.emitOpen();
    es.emit("hb", { projectPath: "", event: { type: "hb", t: 123 } }, 7);
    expect(getDispatchCursor()).toBe(7);
    expect(useMessagesStore.getState().bySession).toEqual({});
    // 后续真实帧游标正常衔接（hb 参与 id 序列不断链）
    es.emit("agent_start", { projectPath: "/p", event: { type: "agent_start", sessionId: "s1" } }, 8);
    expect(getDispatchCursor()).toBe(8);
    client.stop();
  });

  test("stop 中止 fetch 连接（AbortController），断流不触发重连", async () => {
    const scheduler = new MockScheduler();
    const stream = new MockSseStream();
    const calls: MockFetchRecord[] = [];
    const client = new EventsClient({
      forceFetchTransport: true,
      schedule: scheduler.schedule,
      fetchImpl: makeFetchMock(stream, calls),
    });
    client.start();
    await tick();
    client.stop();
    stream.close(); // abort 后的流结束不应引发重连
    await tick();
    scheduler.flush();
    expect(calls).toHaveLength(1);
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
