// 排队条双操作单测（docs08-r7 任务 15）：
// - restructureQueue 共用协议：整队清空 → 窗口期快照合并 → 按序重入队 → 快照对账
// - 立即发送：目标条转 steer 排首位（引擎注入下一循环边界，jsonl queue_enqueue
//   mode:steer 证据由真实引擎 QA 承担），余项按原序原档保持排队
// - 单条撤销：仅保留项按原序重入队
// - 竞态守卫：清空→重入队窗口期用户新排队条目合并不丢不重；落定瞬间 409 重试
// - QueueBar 渲染契约：queue-item-send-now / queue-item-remove 双 testid
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");
const { QueueBar } = await import("@/components/chat/queue-bar");
const { restructureQueue } = await import("@/components/chat/queue-actions");
const { useQueueStore } = await import("@/stores/queue");
const { useMessagesStore } = await import("@/stores/messages");
import type { QueueItem, QueueSnapshot } from "@/lib/api";

const ORIGINAL_FETCH = globalThis.fetch;

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

interface StubQueue {
  steering: string[];
  followUp: string[];
}

/** fetch 桩：记录 DELETE/GET/POST /queue 与 /prompt 调用；windowQueue 提供清空后
 *  快照（窗口期新增条目），finalQueue 提供重入队完成后快照；promptFailures 按
 *  文本注入 409 一次。 */
function stubApi(opts: {
  windowQueue?: StubQueue;
  finalQueue?: StubQueue;
  promptFail409OnceFor?: string[];
  postError?: Error;
} = {}): { calls: Call[] } {
  const calls: Call[] = [];
  const failedOnce = new Set<string>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = String(input);
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ method, url, body });
    const snapshot = (q: StubQueue): QueueSnapshot => ({
      sessionId: "s1",
      steering: q.steering,
      followUp: q.followUp,
    });
    if (url.endsWith("/queue") && method === "DELETE") {
      return new Response(JSON.stringify(snapshot({ steering: [], followUp: [] })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/queue")) {
      const q = calls.filter((c) => c.url.endsWith("/queue") && c.method === "GET").length === 1
        ? (opts.windowQueue ?? { steering: [], followUp: [] })
        : (opts.finalQueue ?? { steering: [], followUp: [] });
      return new Response(JSON.stringify(snapshot(q)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/prompt") && method === "POST") {
      if (opts.postError) throw opts.postError;
      const text = (body as { text?: string }).text ?? "";
      if (opts.promptFail409OnceFor?.includes(text) && !failedOnce.has(text)) {
        failedOnce.add(text);
        return new Response(JSON.stringify({ error: "conflict" }), { status: 409 });
      }
      return new Response(
        JSON.stringify({ disposition: "queued", streaming: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls };
}

function items(...specs: Array<[string, QueueItem["mode"]]>): QueueItem[] {
  return specs.map(([text, mode], i) => ({ text, mode, enqueueOrder: i + 1, enqueuedAt: 1 }));
}

function prompts(calls: Call[]): Array<{ text: string; streamingBehavior?: string }> {
  return calls.filter((c) => c.url.endsWith("/prompt")).map((c) => c.body as { text: string; streamingBehavior?: string });
}

describe("restructureQueue（排队条双操作协议）", () => {
  let stub: { calls: Call[] } = { calls: [] };
  beforeEach(() => {
    useQueueStore.setState({ bySession: {} });
    useMessagesStore.setState({ bySession: {} });
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("立即发送：目标条转 steer 排首位注入，余项按原序原档保持排队", async () => {
    const list = items(["甲", "steer"], ["乙", "followUp"], ["丙", "followUp"]);
    stub = stubApi();
    await restructureQueue("s1", list, list[0], true);
    expect(prompts(stub.calls)).toEqual([
      { text: "甲", streamingBehavior: "steer" },
      { text: "乙", streamingBehavior: "followUp" },
      { text: "丙", streamingBehavior: "followUp" },
    ]);
    // 协议面顺序：清空 → 窗口快照 → 重入队 → 终态快照
    const kinds = stub.calls.map((c) => `${c.method} ${c.url.endsWith("/prompt") ? "prompt" : "queue"}`);
    expect(kinds).toEqual(["DELETE queue", "GET queue", "POST prompt", "POST prompt", "POST prompt", "GET queue"]);
  });

  test("立即发送后余项仍在引擎队列（终态快照对账进 store，目标条不在）", async () => {
    const list = items(["甲", "steer"], ["乙", "followUp"]);
    stub = stubApi({ finalQueue: { steering: [], followUp: ["乙"] } });
    await restructureQueue("s1", list, list[0], true);
    const got = useQueueStore.getState().bySession["s1"].items.map((i) => [i.text, i.mode]);
    expect(got).toEqual([["乙", "followUp"]]);
  });

  test("单条撤销：仅保留项按原序重入队，目标条不再出现", async () => {
    const list = items(["甲", "steer"], ["乙", "followUp"], ["丙", "followUp"]);
    stub = stubApi({ finalQueue: { steering: [], followUp: ["甲", "丙"] } });
    await restructureQueue("s1", list, list[1], false);
    expect(prompts(stub.calls)).toEqual([
      { text: "甲", streamingBehavior: "steer" },
      { text: "丙", streamingBehavior: "followUp" },
    ]);
    const got = useQueueStore.getState().bySession["s1"].items.map((i) => i.text);
    expect(got).toEqual(["甲", "丙"]);
  });

  test("窗口期新排队条目合并在保留项之后，不丢失", async () => {
    const list = items(["甲", "steer"], ["乙", "followUp"]);
    // 清空后、重入队前用户又排了一条（快照可见）
    stub = stubApi({ windowQueue: { steering: [], followUp: ["窗口新条"] } });
    await restructureQueue("s1", list, list[0], true);
    expect(prompts(stub.calls)).toEqual([
      { text: "甲", streamingBehavior: "steer" },
      { text: "乙", streamingBehavior: "followUp" },
      { text: "窗口新条", streamingBehavior: "followUp" },
    ]);
  });

  test("窗口期快照与保留项同文同档不重复入队（SSE enqueue 抢先自纠场景）", async () => {
    const list = items(["甲", "steer"], ["乙", "followUp"]);
    stub = stubApi({ windowQueue: { steering: [], followUp: ["乙"] } });
    await restructureQueue("s1", list, list[0], true);
    const texts = prompts(stub.calls).map((p) => p.text);
    expect(texts.filter((t) => t === "乙").length).toBe(1);
  });

  test("agent_settled 竞态：窗口快照为空（已落定）重排队不丢，终态快照还原全部保留项", async () => {
    const list = items(["甲", "steer"], ["乙", "followUp"]);
    stub = stubApi({ windowQueue: { steering: [], followUp: [] }, finalQueue: { steering: [], followUp: ["甲", "乙"] } });
    await restructureQueue("s1", list, list[1], false);
    expect(prompts(stub.calls).map((p) => p.text)).toEqual(["甲"]);
    const got = useQueueStore.getState().bySession["s1"].items.map((i) => i.text);
    expect(got).toEqual(["甲", "乙"]);
  });

  test("落定瞬间 409 竞态：prompt 重试一次成功", async () => {
    const list = items(["甲", "followUp"]);
    stub = stubApi({ promptFail409OnceFor: ["甲"] });
    await restructureQueue("s1", list, list[0], true);
    const promptCalls = stub.calls.filter((c) => c.url.endsWith("/prompt"));
    expect(promptCalls.length).toBe(2);
    // 重试同载荷同档（409 后原样重发）
    expect(prompts(stub.calls)).toEqual([
      { text: "甲", streamingBehavior: "steer" },
      { text: "甲", streamingBehavior: "steer" },
    ]);
  });

  test("非 409 错误原样抛出（不静默吞）", async () => {
    const list = items(["甲", "followUp"]);
    stub = stubApi({ postError: new Error("boom") });
    await expect(restructureQueue("s1", list, list[0], true)).rejects.toThrow("boom");
  });
});

describe("QueueBar 渲染契约（双操作 testid）", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("每条含 queue-item-send-now 与 queue-item-remove；无条目不渲染", async () => {
    const { act } = await import("react");
    useQueueStore.setState({
      bySession: { s1: { items: items(["甲", "steer"], ["乙", "followUp"]) } },
    });
    useMessagesStore.setState({ bySession: { s1: { streaming: true } as never } });
    let html = "";
    await act(async () => {
      html = renderToStaticMarkup(createElement(QueueBar, { sessionId: "s1" }));
    });
    expect((html.match(/data-testid="queue-item-send-now"/g) ?? []).length).toBe(2);
    expect((html.match(/data-testid="queue-item-remove"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('data-testid="queue-item-cancel"');
    await act(async () => {
      useQueueStore.setState({ bySession: {} });
      html = renderToStaticMarkup(createElement(QueueBar, { sessionId: "s1" }));
    });
    expect(html).not.toContain('data-testid="queue-bar"');
  });
});
