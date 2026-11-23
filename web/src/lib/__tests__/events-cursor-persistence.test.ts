// webui-refetch-storm 任务 4（GAP-6）：SSE 事件游标会话级持久化 + 整页重载增量对账。
// 覆盖面：
// - happy：重载带有效游标（sessionStorage 种子）→ 重连携游标（fetch Last-Event-ID /
//   ES ?afterId=），服务端小缺口 gap 帧落地 ?before= 增量对账路径，零 full=1 请求；
// - failure①：游标越窗（gap 宽度 > GAP_INCREMENTAL_WINDOW）→ full=1 兜底仍触发；
//   存储畸形值（NaN/abc/-3/12.5/空串）→ 按无游标处理，首连行为不变（无头）；
// - failure②（敌对）：断线 >200 帧但服务端环缓冲完整 → 带游标重连纯回放恢复
//   （无 gap 帧、零 REST 对账调用、分发游标推到末帧）——客户端半场；
//   服务端半场（isFreshConnect 必须视 query 游标为非首连）在 server/test/
//   sse-after-id-query.test.ts 钉死；
// - failure③：ES 与 fetch 两传输行为一致（?afterId= URL 与 Last-Event-ID 头同值同源，
//   内存游标优先于持久值，无游标时双双缺席）；
// - 落盘节流：帧推进只记内存态不写存储；visibilitychange→hidden / pagehide 真事件
//   才落盘（先例 diag.ts flush-on-hidden）。
// 环境（scroll-follow-anchor 惯例）：@happy-dom 全局注册 + 被测模块动态 import。
// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
// happy-dom 寄存器不覆盖 sessionStorage 的兜底 shim（Map 后备，语义一致）
if (!(globalThis as { sessionStorage?: unknown }).sessionStorage) {
  const store = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

const { EventsClient } = await import("@/lib/events");
const {
  dispatchSseEvent,
  resetDispatchState,
  getDispatchCursor,
  EVENT_CURSOR_STORAGE_KEY,
  readPersistedEventCursor,
  persistEventCursor,
} = await import("@/lib/event-dispatch");
const { api } = await import("@/lib/api");
const { useMessagesStore } = await import("@/stores/messages");

// ---- 测试基建 ----

/** 尾窗已加载形态的会话槽（与 event-dispatch-gap-tiering 惯例一致） */
function tailLoaded(entries) {
  return {
    entries,
    cursor: entries.at(-1)?.id ?? null,
    leafId: entries.at(-1)?.id ?? null,
    loaded: true,
    hasMore: true,
    oldestId: entries[0]?.id ?? null,
    streaming: false,
    streamingMessage: null,
    streamingEntryId: null,
    toolRuns: {},
    compacting: false,
  };
}

function entry(id: string) {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}

/** hb 心跳帧信封（无会话身份：游标记账后短路，零 store 写入——批量回放用） */
function hbData(t: number): string {
  return JSON.stringify({ projectPath: "", event: { type: "hb", t } });
}

/** 直接向分发层注入一帧 hb（推进内存游标） */
function emitHb(cursor: number): void {
  dispatchSseEvent("hb", hbData(cursor), cursor);
}

/** SSE 帧文本 */
function sseFrame(event: string, data: string, id?: number): string {
  return `event: ${event}\ndata: ${data}\n${id !== undefined ? `id: ${id}\n` : ""}\n`;
}

/** fetch 流响应桩：一次性写完全部 chunk 后关流（流结束=断线路径，重连经 no-op schedule 吞掉） */
function sseResponse(chunks: string[]): Promise<Response> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: stream,
  } as unknown as Response);
}

/** EventSource 桩：记录构造 URL，帧经 emit 注入 */
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(ev: { type: string; data: string; lastEventId: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: { type: string; data: string; lastEventId: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string, data: string, lastEventId: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, data, lastEventId });
  }
  close(): void {
    this.readyState = 2;
  }
}

/** 重连调度桩：永不触发（防真实退避定时器污染调用计数） */
const noopSchedule = (): (() => void) => () => {};

const clients: EventsClient[] = [];
const ORIGINAL_LIST = api.listMessages;
let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
let apiCalls: Array<{ sessionId: string; opts: Record<string, unknown> }> = [];

function makeFetchClient(streamChunks: string[], opts: Record<string, unknown> = {}): EventsClient {
  const client = new EventsClient({
    forceFetchTransport: true,
    schedule: noopSchedule,
    fetchImpl: (input: string, init: { headers?: Record<string, string> }) => {
      fetchCalls.push({ url: String(input), headers: { ...(init.headers ?? {}) } });
      return sseResponse(streamChunks);
    },
    ...opts,
  });
  clients.push(client);
  return client;
}

function makeEsClient(opts: Record<string, unknown> = {}): EventsClient {
  const client = new EventsClient({
    schedule: noopSchedule,
    createEventSource: (url: string) => new FakeEventSource(url),
    ...opts,
  });
  clients.push(client);
  return client;
}

/** 有界轮询等待可观察条件（非固定睡眠） */
async function until(cond: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  expect(cond(), "有界轮询条件未满足").toBe(true);
}

/** 等 fetch 流泵结束（连接收尾，全部帧已分发） */
async function untilPumpDone(client: EventsClient): Promise<void> {
  await until(() => (client as unknown as { abortController: unknown }).abortController === null);
}

const visibilityDesc = Object.getOwnPropertyDescriptor(document, "visibilityState");
afterEach(() => {
  if (visibilityDesc) Object.defineProperty(document, "visibilityState", visibilityDesc);
  else delete (document as { visibilityState?: unknown }).visibilityState;
});

beforeEach(() => {
  sessionStorage.clear();
  fetchCalls = [];
  apiCalls = [];
  useMessagesStore.setState({ bySession: {}, replayRecovering: false });
  resetDispatchState();
  FakeEventSource.instances = [];
});

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
  api.listMessages = ORIGINAL_LIST;
  resetDispatchState();
});

// ---- 持久化节流与读取容错 ----

describe("任务 4：游标落盘节流（flush-on-hidden）", () => {
  test("帧推进只记内存态：连续分发帧后存储仍空，persistEventCursor 才写最新值", () => {
    emitHb(101);
    emitHb(102);
    emitHb(103);
    expect(sessionStorage.getItem(EVENT_CURSOR_STORAGE_KEY)).toBeNull(); // 不逐帧同步写
    expect(getDispatchCursor()).toBe(103); // 内存态照常推进
    persistEventCursor();
    expect(sessionStorage.getItem(EVENT_CURSOR_STORAGE_KEY)).toBe("103");
  });

  test("visibilitychange→hidden 真事件落盘（client 生命周期钩子安装）", () => {
    const client = makeEsClient();
    client.start();
    emitHb(201);
    emitHb(205);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sessionStorage.getItem(EVENT_CURSOR_STORAGE_KEY)).toBe("205");
    // 尚未见帧时落盘为 no-op（不清洗旧值、不写 null）
    resetDispatchState();
    sessionStorage.clear();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sessionStorage.getItem(EVENT_CURSOR_STORAGE_KEY)).toBeNull();
  });

  test("pagehide 真事件落盘", () => {
    const client = makeEsClient();
    client.start();
    emitHb(301);
    emitHb(302);
    window.dispatchEvent(new Event("pagehide"));
    expect(sessionStorage.getItem(EVENT_CURSOR_STORAGE_KEY)).toBe("302");
  });

  test("client.stop() 卸载落盘钩子：stop 后 hidden/pagehide 不再写", () => {
    const client = makeEsClient();
    client.start();
    emitHb(401);
    client.stop();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    expect(sessionStorage.getItem(EVENT_CURSOR_STORAGE_KEY)).toBeNull();
  });
});

describe("任务 4：readPersistedEventCursor 容错（malformed_input）", () => {
  test.each(["NaN", "abc", "-3", "12.5", "", " "])("存储值 %p → null（按无游标处理）", (raw) => {
    sessionStorage.setItem(EVENT_CURSOR_STORAGE_KEY, raw);
    expect(readPersistedEventCursor()).toBeNull();
  });

  test("合法值原样读回；键缺席为 null", () => {
    expect(readPersistedEventCursor()).toBeNull();
    sessionStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "777");
    expect(readPersistedEventCursor()).toBe(777);
  });
});

// ---- happy / failure 场景（fetch 传输） ----

describe("任务 4 happy：重载带有效游标 → 小缺口增量对账，零 full=1", () => {
  test("fetch 重连携 Last-Event-ID=持久游标，gap 宽度 ≤ 窗口 → 恰一次 ?before=，无 full", async () => {
    sessionStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "100");
    useMessagesStore.setState({
      bySession: { s1: tailLoaded([entry("e180"), entry("e181"), entry("e182")]) },
    });
    api.listMessages = (sessionId: string, opts: Record<string, unknown>) => {
      apiCalls.push({ sessionId, opts });
      return Promise.resolve({
        sessionId,
        entries: [entry("e178"), entry("e179")],
        leafId: "e182",
        cursor: "e182",
        hasMore: false,
        oldestId: "e178",
      });
    };
    // 服务端形态：环缓冲淘汰了 1..100 → gap [101,150]（宽度 50 ≤ 200），之后续发
    const stream = [
      sseFrame("gap", JSON.stringify({ from: 101, to: 150 }), 150),
      sseFrame("hb", hbData(1), 151),
    ];
    const client = makeFetchClient(stream);
    client.start();
    await untilPumpDone(client);
    await until(() => apiCalls.length === 1);

    // 重连种子：Last-Event-ID 头 = 持久化游标（与 ES ?afterId= 同值）
    expect(fetchCalls[0]!.headers["Last-Event-ID"]).toBe("100");
    // 增量路径：恰一次 ?before=oldestId，零 full=1
    expect(apiCalls).toEqual([{ sessionId: "s1", opts: { before: "e180" } }]);
    expect(apiCalls.some((c) => (c.opts as { full?: boolean }).full === true)).toBe(false);
    // 合并落地（去重保序）
    expect(useMessagesStore.getState().bySession.s1!.entries.map((e) => e.id)).toEqual([
      "e178",
      "e179",
      "e180",
      "e181",
      "e182",
    ]);
  });
});

describe("任务 4 failure①：游标越窗 / 失效 → full=1 兜底仍触发", () => {
  test("gap 宽度 > GAP_INCREMENTAL_WINDOW → refetchLoadedSessions 全量（full: true）", async () => {
    sessionStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "100");
    useMessagesStore.setState({ bySession: { s1: tailLoaded([entry("e180")]) } });
    api.listMessages = (sessionId: string, opts: Record<string, unknown>) => {
      apiCalls.push({ sessionId, opts });
      return Promise.resolve({
        sessionId,
        entries: [entry("x1")],
        leafId: "x1",
        cursor: "x1",
        hasMore: false,
        oldestId: "x1",
      });
    };
    // 游标越窗：环缓冲淘汰 [1,500]（宽度 500 > 200），大缺口
    const stream = [
      sseFrame("gap", JSON.stringify({ from: 1, to: 500 }), 500),
      sseFrame("hb", hbData(1), 501),
    ];
    const client = makeFetchClient(stream);
    client.start();
    await untilPumpDone(client);
    await until(() => apiCalls.length === 1);

    expect(apiCalls).toEqual([{ sessionId: "s1", opts: { full: true } }]); // 大缺口 full 兜底未被削弱
  });

  test("服务重启游标归零形态：gap from > to（畸形区间）→ 同样落全量兜底", async () => {
    sessionStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "900");
    useMessagesStore.setState({ bySession: { s1: tailLoaded([entry("e1")]) } });
    api.listMessages = (sessionId: string, opts: Record<string, unknown>) => {
      apiCalls.push({ sessionId, opts });
      return Promise.resolve({
        sessionId,
        entries: [],
        leafId: null,
        cursor: null,
        hasMore: false,
        oldestId: null,
      });
    };
    // afterId=900 超前：gap {from:901, to:12}（from>to 畸形）无续发
    const stream = [sseFrame("gap", JSON.stringify({ from: 901, to: 12 }), 12)];
    const client = makeFetchClient(stream);
    client.start();
    await untilPumpDone(client);
    await until(() => apiCalls.length === 1);
    expect(apiCalls).toEqual([{ sessionId: "s1", opts: { full: true } }]);
  });

  test("存储畸形值 → 按无游标首连：fetch 请求不带 Last-Event-ID 头", async () => {
    sessionStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "NaN");
    const client = makeFetchClient([sseFrame("hb", hbData(1), 1)]);
    client.start();
    await untilPumpDone(client);
    expect(fetchCalls[0]!.headers["Last-Event-ID"]).toBeUndefined(); // 首连行为不变
  });
});

describe("任务 4 failure②（敌对）：断线 >200 帧但环缓冲完整 → 纯回放恢复，零 REST 对账", () => {
  test("带游标重连收 230 帧纯回放（无 gap 帧）：零 api 调用，游标推到末帧", async () => {
    sessionStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "100");
    api.listMessages = (sessionId: string, opts: Record<string, unknown>) => {
      apiCalls.push({ sessionId, opts });
      return Promise.resolve({ sessionId, entries: [], leafId: null, cursor: null, hasMore: false, oldestId: null });
    };
    // 服务端重放形态：replay_begin/done 包夹 230 帧（id 101..330），无 gap
    const frames: string[] = [sseFrame("replay_begin", JSON.stringify({ after: 100, buffered: 230 }), 101)];
    for (let i = 101; i <= 330; i++) frames.push(sseFrame("hb", hbData(i), i));
    frames.push(sseFrame("replay_done", JSON.stringify({ count: 230 }), 330));

    const client = makeFetchClient(frames);
    client.start();
    await untilPumpDone(client);
    await until(() => getDispatchCursor() === 330);

    expect(apiCalls).toHaveLength(0); // gap=0：零 REST 对账调用（纯回放恢复）
    expect(useMessagesStore.getState().replayRecovering).toBe(false); // begin/done 正常收口
  });
});

// ---- failure③：ES 与 fetch 双传输一致 ----

describe("任务 4 failure③：ES 与 fetch 两传输游标行为一致", () => {
  test("同一持久游标：ES 首连 URL ?afterId=100，fetch Last-Event-ID: 100（同值同源）", () => {
    sessionStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "100");
    const es = makeEsClient();
    es.start();
    const fetchClient = makeFetchClient([]);
    fetchClient.start();
    expect(FakeEventSource.instances[0]!.url).toBe("/api/events?afterId=100");
    expect(fetchCalls[0]!.headers["Last-Event-ID"]).toBe("100");
  });

  test("内存游标优先于持久值：帧推进后重连（同页新 client）两传输均携最新内存游标", () => {
    sessionStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "100");
    emitHb(105); // 页内已见帧：内存 105 > 持久 100
    const es = makeEsClient();
    es.start();
    const fetchClient = makeFetchClient([]);
    fetchClient.start();
    expect(FakeEventSource.instances.at(-1)!.url).toBe("/api/events?afterId=105");
    expect(fetchCalls[0]!.headers["Last-Event-ID"]).toBe("105");
  });

  test("无游标（存储空且内存空）：ES URL 不加参、fetch 不带头——首连行为不变", () => {
    const es = makeEsClient();
    es.start();
    const fetchClient = makeFetchClient([]);
    fetchClient.start();
    expect(FakeEventSource.instances[0]!.url).toBe("/api/events");
    expect(fetchCalls[0]!.headers["Last-Event-ID"]).toBeUndefined();
  });

  test("URL 已含查询串时以 & 拼接：/api/events?session=s9&afterId=100", () => {
    sessionStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "100");
    const es = makeEsClient({ url: "/api/events?session=s9" });
    es.start();
    expect(FakeEventSource.instances[0]!.url).toBe("/api/events?session=s9&afterId=100");
  });

  test("ES 帧通道端到端：持久游标种子连接后，帧经 onEventSourceFrame 推进内存游标", () => {
    sessionStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "500");
    const es = makeEsClient();
    es.start();
    const fake = FakeEventSource.instances[0]!;
    fake.onopen!();
    fake.emit("hb", hbData(1), 501); // 续发首帧 id 501
    expect(getDispatchCursor()).toBe(501);
    // 落盘后（hidden）持久值推进到 501
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sessionStorage.getItem(EVENT_CURSOR_STORAGE_KEY)).toBe("501");
  });
});
