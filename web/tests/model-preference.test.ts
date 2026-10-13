// 模型偏好单测（todo 22）：api.prompt 的空模型防呆（客户端拦截不发请求）、
// 顶栏当前偏好随下一条 prompt 注入、调用方显式 model 优先、加载未完成不误伤（fail-open）。
// W2 todo 8 追加：思考档随 prompt 注入（模型支持门控、显式传值优先、未选不注入）。
import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, api } from "@/lib/api";
import { useUiStore } from "@/stores/ui";

const ORIGINAL_FETCH = globalThis.fetch;

/** 替换全局 fetch 并记录请求体（request() 走 fetch，无需起端口） */
function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch;
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

const ONE_MODEL = [{ provider: "p", id: "m1", contextWindow: 1000, reasoning: false }];

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  useUiStore.setState({ models: [], modelsLoaded: false, selectedModel: null, selectedThinkingLevel: null });
});

describe("api.prompt 模型防呆与偏好注入", () => {
  test("modelsLoaded 且列表为空 → 客户端拦截，不发起请求", async () => {
    useUiStore.setState({ models: [], modelsLoaded: true, selectedModel: "p/m1" });
    let called = false;
    mockFetch(async () => {
      called = true;
      return okJson({ sessionId: "s1", disposition: "handled", streaming: false });
    });
    let err: unknown = null;
    try {
      await api.prompt("s1", { text: "hi" });
    } catch (e) {
      err = e;
    }
    expect(called).toBe(false);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("no_models_available");
  });

  test("modelsLoaded=false（加载中/失败）不防呆误伤（fail-open）", async () => {
    useUiStore.setState({ models: [], modelsLoaded: false, selectedModel: null });
    mockFetch(async () => okJson({ sessionId: "s1", disposition: "handled", streaming: false }));
    const receipt = await api.prompt("s1", { text: "hi" });
    expect(receipt.disposition).toBe("handled");
  });

  test("顶栏当前偏好注入下一条 prompt（body.model = selectedModel）", async () => {
    useUiStore.setState({ models: ONE_MODEL, modelsLoaded: true, selectedModel: "zai-coding-cn/glm-4.7" });
    let body: Record<string, unknown> = {};
    mockFetch(async (_input, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return okJson({ sessionId: "s1", disposition: "handled", streaming: false });
    });
    await api.prompt("s1", { text: "回复 OK" });
    expect(body.model).toBe("zai-coding-cn/glm-4.7");
  });

  test("调用方显式 model 优先于偏好注入", async () => {
    useUiStore.setState({ models: ONE_MODEL, modelsLoaded: true, selectedModel: "p/pref" });
    let body: Record<string, unknown> = {};
    mockFetch(async (_input, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return okJson({ sessionId: "s1", disposition: "handled", streaming: false });
    });
    await api.prompt("s1", { text: "hi", model: "p/explicit" });
    expect(body.model).toBe("p/explicit");
  });

  test("无偏好（selectedModel=null）时不注入 model 字段", async () => {
    useUiStore.setState({ models: ONE_MODEL, modelsLoaded: true, selectedModel: null });
    let body: Record<string, unknown> = {};
    mockFetch(async (_input, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return okJson({ sessionId: "s1", disposition: "handled", streaming: false });
    });
    await api.prompt("s1", { text: "hi" });
    expect("model" in body).toBe(false);
  });
});

describe("api.prompt 思考档注入（W2 todo 8）", () => {
  async function captureBody(): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    mockFetch(async (_input, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return okJson({ sessionId: "s1", disposition: "handled", streaming: false });
    });
    await api.prompt("s1", { text: "hi" });
    return body;
  }

  test("模型支持且有当前档 → body.thinkingLevel 注入", async () => {
    useUiStore.setState({
      models: [{ provider: "p", id: "m1", contextWindow: 1000, reasoning: true, supportedThinkingLevels: ["low", "high", "max"] }],
      modelsLoaded: true,
      selectedModel: "p/m1",
      selectedThinkingLevel: "max",
    });
    expect(await captureBody()).toMatchObject({ model: "p/m1", thinkingLevel: "max" });
  });

  test("模型未下发 supportedThinkingLevels → 即使有当前档也不注入（chip 同规则隐藏）", async () => {
    useUiStore.setState({
      models: ONE_MODEL,
      modelsLoaded: true,
      selectedModel: "p/m1",
      selectedThinkingLevel: "max",
    });
    const body = await captureBody();
    expect("thinkingLevel" in body).toBe(false);
  });

  test("模型支持但未选档 → 不注入", async () => {
    useUiStore.setState({
      models: [{ provider: "p", id: "m1", contextWindow: 1000, reasoning: true, supportedThinkingLevels: ["low", "high", "max"] }],
      modelsLoaded: true,
      selectedModel: "p/m1",
      selectedThinkingLevel: null,
    });
    const body = await captureBody();
    expect("thinkingLevel" in body).toBe(false);
  });

  test("调用方显式 thinkingLevel 优先于偏好注入", async () => {
    useUiStore.setState({
      models: [{ provider: "p", id: "m1", contextWindow: 1000, reasoning: true, supportedThinkingLevels: ["low", "high", "max"] }],
      modelsLoaded: true,
      selectedModel: "p/m1",
      selectedThinkingLevel: "low",
    });
    let body: Record<string, unknown> = {};
    mockFetch(async (_input, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return okJson({ sessionId: "s1", disposition: "handled", streaming: false });
    });
    await api.prompt("s1", { text: "hi", thinkingLevel: "high" });
    expect(body.thinkingLevel).toBe("high");
  });
});
