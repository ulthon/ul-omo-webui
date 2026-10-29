// 僵尸复位前对账（docs08-r6 任务 6 ②）：zombieReconcileAndReset 决策路径——
// 仍有未决（提问/排队）维持锁定；无未决或对账失败（宁缺勿错）复位解锁。
// 直接驱动导出的决策函数 + 真实 store 落库断言（permissions.test 同款 fetch mock 口径；
// 无定时器、无渲染，按构造无抖动；10s 定时器本身是既有行为不在本测范围）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const { zombieReconcileAndReset } = await import("@/components/chat/zombie-reset");
const { useMessagesStore } = await import("@/stores/messages");
const { useQuestionsStore } = await import("@/stores/questions");
const { useQueueStore } = await import("@/stores/queue");

const SID = "qa-zombie-1";
const ORIGINAL_FETCH = globalThis.fetch;

/** q1 wire 帧（GET /questions 响应载荷，与 SSE question 帧同构） */
function questionFrame(id: string): Record<string, unknown> {
  return {
    type: "extension_ui_request",
    method: "question",
    id,
    requestId: `call_${id}`,
    toolCallId: "",
    waitForAnswer: true,
    questions: [
      {
        id: "q1",
        header: "Deploy",
        question: "Which environment should we deploy to?",
        options: [{ label: "staging" }, { label: "production" }],
        multiSelect: false,
      },
    ],
    timeout: 30 * 60_000,
    askedAtMs: Date.now(),
    deadlineAtMs: Date.now() + 30 * 60_000,
    remainingMs: 30 * 60_000,
  };
}

/** 路由级 fetch mock：questions/queue 两端点各配响应体与状态码 */
function stubFetch(routes: { questions?: { status?: number; body: unknown }; queue?: { status?: number; body: unknown } }): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes(`/api/sessions/${SID}/questions`)) {
      const route = routes.questions ?? { body: { sessionId: SID, questions: [] } };
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes(`/api/sessions/${SID}/queue`)) {
      const route = routes.queue ?? { body: { sessionId: SID, steering: [], followUp: [], ordered: [] } };
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function markZombieStreaming(): void {
  useMessagesStore.getState().setStreaming(SID, true);
  // 僵尸形态：流式位 true 但无流式消息（chat-view 定时器判定条件同款）
  const st = useMessagesStore.getState().bySession[SID];
  expect(st?.streaming).toBe(true);
  expect(st?.streamingMessage ?? null).toBe(null);
}

function streamingNow(): boolean {
  return useMessagesStore.getState().bySession[SID]?.streaming ?? false;
}

beforeEach(() => {
  useQuestionsStore.setState({ bySession: {} });
  useQueueStore.setState({ bySession: {} });
  useMessagesStore.getState().clearSession(SID);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  useMessagesStore.getState().clearSession(SID);
});

describe("僵尸复位前对账——维持锁定路径", () => {
  test("服务端仍有未决提问 → 不复位，问题卡经对账入队（中断逃逸口数据源）", async () => {
    stubFetch({ questions: { body: { sessionId: SID, questions: [questionFrame("q-a")] } } });
    markZombieStreaming();
    const reset = await zombieReconcileAndReset(SID, () => false);
    expect(reset).toBe(false);
    expect(streamingNow()).toBe(true);
    const pending = useQuestionsStore.getState().bySession[SID] ?? [];
    expect(pending.map((r) => r.id)).toEqual(["q-a"]);
    expect(pending[0].waitForAnswer).toBe(true);
  });

  test("提问 + 排队皆未决 → 不复位且两 store 都落库（对账同款代码复用）", async () => {
    stubFetch({
      questions: { body: { sessionId: SID, questions: [questionFrame("q-b")] } },
      queue: { body: { sessionId: SID, steering: ["先并入当前工作"], followUp: ["做完后继续"], ordered: [] } },
    });
    markZombieStreaming();
    const reset = await zombieReconcileAndReset(SID, () => false);
    expect(reset).toBe(false);
    expect(streamingNow()).toBe(true);
    expect((useQueueStore.getState().bySession[SID]?.items ?? []).map((i) => i.text)).toEqual([
      "先并入当前工作",
      "做完后继续",
    ]);
    expect((useQuestionsStore.getState().bySession[SID] ?? []).map((r) => r.id)).toEqual(["q-b"]);
  });

  test("仅排队非空（无提问）→ 不复位（引擎仍有待执行工作）", async () => {
    stubFetch({
      queue: { body: { sessionId: SID, steering: ["跟答一条"], followUp: [], ordered: [{ text: "跟答一条", mode: "followUp", enqueueOrder: 1 }] } },
    });
    markZombieStreaming();
    const reset = await zombieReconcileAndReset(SID, () => false);
    expect(reset).toBe(false);
    expect(streamingNow()).toBe(true);
  });

  test("同 id 提问帧重投不重复入队（对账与 SSE 重放同源去重不变量）", async () => {
    useQuestionsStore.getState().pushRequest(SID, {
      id: "q-a",
      waitForAnswer: true,
      questions: [],
      deadlineAtMs: Date.now() + 1000,
      timeout: 1000,
      askedAtMs: Date.now(),
      anchorEntryId: null,
    });
    stubFetch({ questions: { body: { sessionId: SID, questions: [questionFrame("q-a")] } } });
    markZombieStreaming();
    await zombieReconcileAndReset(SID, () => false);
    expect(useQuestionsStore.getState().bySession[SID]?.length).toBe(1);
  });
});

describe("僵尸复位前对账——解锁路径（宁缺勿错）", () => {
  test("两端点皆空 → 复位解锁（真僵尸）", async () => {
    stubFetch({});
    markZombieStreaming();
    const reset = await zombieReconcileAndReset(SID, () => false);
    expect(reset).toBe(true);
    expect(streamingNow()).toBe(false);
  });

  test("两端点皆失败（网络/5xx）→ 复位解锁，不抛（对账失败不得永久锁死）", async () => {
    stubFetch({
      questions: { status: 500, body: { error: "boom" } },
      queue: { status: 503, body: { error: "unavailable" } },
    });
    markZombieStreaming();
    const reset = await zombieReconcileAndReset(SID, () => false);
    expect(reset).toBe(true);
    expect(streamingNow()).toBe(false);
  });

  test("提问端失败 + 排队空 → 复位解锁（缺失证据按无未决处理）", async () => {
    stubFetch({ questions: { status: 500, body: { error: "boom" } } });
    markZombieStreaming();
    const reset = await zombieReconcileAndReset(SID, () => false);
    expect(reset).toBe(true);
    expect(streamingNow()).toBe(false);
  });

  test("cancelled（组件卸载/会话切换）→ 不复位不落库", async () => {
    stubFetch({
      questions: { body: { sessionId: SID, questions: [questionFrame("q-c")] } },
      queue: { body: { sessionId: SID, steering: ["排一条"], followUp: [], ordered: [] } },
    });
    markZombieStreaming();
    const reset = await zombieReconcileAndReset(SID, () => true);
    expect(reset).toBe(false);
    expect(streamingNow()).toBe(true);
    expect(useQuestionsStore.getState().bySession[SID]).toBeUndefined();
    expect(useQueueStore.getState().bySession[SID]).toBeUndefined();
  });
});
