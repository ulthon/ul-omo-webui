// queue_update 事件接线单测（docs08-r4 任务 11）：SSE 帧按 wire type 原样透传进
// queue store（spike (b)-2：载荷 {steering[], followUp[], ordered:[{text,mode,enqueueOrder}]}，
// 入队与出队宣布都发）；gap 帧触发排队快照对账（resyncQueues，fetch stub 记录调用）；
// EventsClient 真实路径：queue_update 必须在 HANDLED_EVENT_TYPES（EventSource 具名
// 事件模型下列表外的类型浏览器不派发——QA 实测漏列即排队条永不清空）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import { EventsClient, disconnectEvents } from "@/lib/events";
import { useMessagesStore } from "@/stores/messages";
import { useQueueStore } from "@/stores/queue";
import { MockEventSource, MockScheduler } from "./helpers/mock-sse";

function frame(wire: Record<string, unknown>, cursor: number, durable?: string): void {
  dispatchSseEvent(
    String(wire.type),
    JSON.stringify(durable ? { projectPath: "/p", event: wire, durableSessionId: durable } : { projectPath: "/p", event: wire }),
    cursor,
  );
}

function stubFetchGetQueue(calls: string[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ sessionId: "x", steering: [], followUp: [], ordered: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("queue_update 接线（排队列表增量）", () => {
  let restoreFetch: () => void = () => {};
  beforeEach(() => {
    resetDispatchState();
    useMessagesStore.setState({ bySession: {} });
    useQueueStore.setState({ bySession: {} });
  });
  afterEach(() => {
    restoreFetch();
    resetDispatchState();
  });

  test("queue_update 帧按信封 durableSessionId 路由进 queue store（入队）", () => {
    frame(
      {
        type: "queue_update",
        steering: [],
        followUp: ["回复：Q-1"],
        ordered: [{ text: "回复：Q-1", mode: "followUp", enqueueOrder: 1 }],
        sessionId: "rpc-1",
      },
      1,
      "d-1",
    );
    const items = useQueueStore.getState().bySession["d-1"].items;
    expect(items).toEqual([{ text: "回复：Q-1", mode: "followUp", enqueueOrder: 1, enqueuedAt: expect.any(Number) }]);
  });

  test("出队宣布（ordered:[]）清空；payload 缺 ordered 容错为空", () => {
    frame(
      { type: "queue_update", steering: [], followUp: ["x"], ordered: [{ text: "x", mode: "followUp", enqueueOrder: 2 }] },
      2,
      "d-1",
    );
    frame({ type: "queue_update", steering: [], followUp: [], ordered: [] }, 3, "d-1");
    expect(useQueueStore.getState().bySession["d-1"].items.length).toBe(0);
    frame({ type: "queue_update", steering: [], followUp: [] }, 4, "d-1");
    expect(useQueueStore.getState().bySession["d-1"].items.length).toBe(0);
  });

  test("gap 帧触发已加载会话排队快照对账（GET /queue 逐会话一次）", async () => {
    const calls: string[] = [];
    restoreFetch = stubFetchGetQueue(calls);
    useMessagesStore.setState({
      bySession: {
        "d-1": {
          entries: [],
          cursor: "c1",
          leafId: null,
          loaded: true,
          streaming: false,
          streamingMessage: null,
          streamingEntryId: null,
          toolRuns: {},
        },
      },
    });
    dispatchSseEvent("gap", JSON.stringify({ from: 9, to: 3 }), null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.some((url) => url.endsWith("/api/sessions/d-1/queue"))).toBe(true);
  });

  test("EventsClient 真实路径：queue_update 具名帧派发进 queue store（HANDLED_EVENT_TYPES 接线）", () => {
    MockEventSource.reset();
    const scheduler = new MockScheduler();
    const client = new EventsClient({
      createEventSource: ((url: string) => new MockEventSource(url)) as unknown as (url: string) => EventSource,
      schedule: scheduler.schedule,
    });
    client.start();
    const es = MockEventSource.live[0];
    es.emitOpen();
    es.emit(
      "queue_update",
      {
        projectPath: "/p",
        event: {
          type: "queue_update",
          steering: [],
          followUp: ["跟答项"],
          ordered: [{ text: "跟答项", mode: "followUp", enqueueOrder: 9 }],
          sessionId: "rpc-1",
        },
        durableSessionId: "d-2",
      },
      5,
    );
    expect(useQueueStore.getState().bySession["d-2"].items).toEqual([
      { text: "跟答项", mode: "followUp", enqueueOrder: 9, enqueuedAt: expect.any(Number) },
    ]);
    client.stop();
    disconnectEvents();
  });
});
