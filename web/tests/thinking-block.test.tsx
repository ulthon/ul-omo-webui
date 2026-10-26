// 思考块默认展开设置 + 展开态滚动跟随（docs08-r5 任务 13）：
// - parseThinkingExpanded kv 解析（仅精确 "true" 开，其余回退 false）
// - bootstrap 读 GET /api/settings 填充 ui store 快照（缺省折叠）
// - ThinkingBlock 初始开合读挂载时刻快照；挂载后改设置不影响已挂载块（瞬态语义）
// - 展开态滚底跟随 / wheel、touchmove 手滑停跟随 / 手动重新展开复位（happy-dom 模拟滚动）
// - 设置面板"对话"分区：勾选即 PUT chat.thinkingDefaultExpanded（"true"/"false" 字符串载荷）
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// bun/vitest 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");

import { THINKING_EXPANDED_KV, parseThinkingExpanded, useUiStore } from "@/stores/ui";
import { bootstrap } from "@/lib/bootstrap";
import { ThinkingBlock } from "@/components/chat/thinking-block";
import { ConversationSection } from "@/pages/settings";

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------- 挂载辅助

const CLEANUPS: Array<() => void> = [];

function makeContainer(): HTMLElement {
  const c = document.createElement("div");
  document.body.appendChild(c);
  return c;
}

/** 挂载 ThinkingBlock 并返回可重渲染句柄（thinking 变化模拟流式增量） */
function mountThinking(initialThinking: string) {
  const container = makeContainer();
  const root = createRoot(container);
  const render = (thinking: string) =>
    act(() => {
      root.render(createElement(ThinkingBlock, { thinking, live: true }));
    });
  render(initialThinking);
  CLEANUPS.push(() => act(() => root.unmount()));
  return {
    render,
    button: () => container.querySelector("button") as HTMLButtonElement,
    body: () => container.querySelector("[data-testid='thinking-body']") as HTMLElement | null,
  };
}

beforeEach(() => {
  useUiStore.setState({ thinkingDefaultExpanded: false, toast: null });
});

afterEach(() => {
  while (CLEANUPS.length) CLEANUPS.pop()!();
});

// ---------------------------------------------------------------- kv 解析

describe("parseThinkingExpanded kv 解析", () => {
  test('仅精确 "true" 为开；缺失/空串/其他值回退 false（缺省折叠）', () => {
    expect(parseThinkingExpanded("true")).toBe(true);
    expect(parseThinkingExpanded(undefined)).toBe(false);
    expect(parseThinkingExpanded(null)).toBe(false);
    expect(parseThinkingExpanded("")).toBe(false);
    expect(parseThinkingExpanded("false")).toBe(false);
    expect(parseThinkingExpanded("TRUE")).toBe(false);
    expect(parseThinkingExpanded("1")).toBe(false);
  });
});

// ---------------------------------------------------------------- bootstrap 读取

describe("bootstrap 思考块默认展开读取", () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  function mockSettings(settings: Record<string, string>): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return okJson({ projects: [] });
      if (url === "/api/settings") return okJson({ settings });
      return new Response(JSON.stringify({ error: { code: "unmocked", message: url } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("键缺失回退 false（缺省折叠，行为与现状一致）", async () => {
    mockSettings({});
    await bootstrap();
    expect(useUiStore.getState().thinkingDefaultExpanded).toBe(false);
  });

  test('键值 "true" → store 开启；"false"/"1" 等非法值 → false', async () => {
    mockSettings({ [THINKING_EXPANDED_KV]: "true" });
    await bootstrap();
    expect(useUiStore.getState().thinkingDefaultExpanded).toBe(true);

    mockSettings({ [THINKING_EXPANDED_KV]: "false" });
    await bootstrap();
    expect(useUiStore.getState().thinkingDefaultExpanded).toBe(false);

    mockSettings({ [THINKING_EXPANDED_KV]: "1" });
    await bootstrap();
    expect(useUiStore.getState().thinkingDefaultExpanded).toBe(false);
  });
});

// ---------------------------------------------------------------- 初始开合

describe("ThinkingBlock 初始开合", () => {
  test('store 快照 true → 挂载即展开；false → 折叠且正文不渲染', () => {
    useUiStore.setState({ thinkingDefaultExpanded: true });
    const h1 = mountThinking("a");
    expect(h1.button().getAttribute("aria-expanded")).toBe("true");
    expect(h1.body()).not.toBeNull();

    useUiStore.setState({ thinkingDefaultExpanded: false });
    const h2 = mountThinking("a");
    expect(h2.button().getAttribute("aria-expanded")).toBe("false");
    expect(h2.body()).toBeNull();
  });

  test("挂载后改设置不影响已挂载块（手动开合是会话内瞬态）", () => {
    useUiStore.setState({ thinkingDefaultExpanded: true });
    const h = mountThinking("a");
    expect(h.button().getAttribute("aria-expanded")).toBe("true");
    act(() => {
      useUiStore.setState({ thinkingDefaultExpanded: false });
    });
    expect(h.button().getAttribute("aria-expanded")).toBe("true");
  });
});

// ---------------------------------------------------------------- 滚动跟随

describe("展开态滚动跟随", () => {
  test("thinking 变化时正文滚至底部（happy-dom 模拟滚动）", () => {
    useUiStore.setState({ thinkingDefaultExpanded: true });
    const h = mountThinking("a");
    const el = h.body()!;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 120 });
    h.render("a".repeat(40));
    expect(el.scrollTop).toBe(120);
  });

  test("wheel 手滑停跟随（之后 thinking 变化不再滚底）", () => {
    useUiStore.setState({ thinkingDefaultExpanded: true });
    const h = mountThinking("a");
    const el = h.body()!;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 120 });
    h.render("a".repeat(40));
    expect(el.scrollTop).toBe(120);

    el.dispatchEvent(new Event("wheel"));
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 300 });
    h.render("b".repeat(80));
    expect(el.scrollTop).toBe(120);
  });

  test("touchmove 手滑同样停跟随", () => {
    useUiStore.setState({ thinkingDefaultExpanded: true });
    const h = mountThinking("a");
    const el = h.body()!;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 120 });
    h.render("a".repeat(40));
    expect(el.scrollTop).toBe(120);

    el.dispatchEvent(new Event("touchmove"));
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 300 });
    h.render("b".repeat(80));
    expect(el.scrollTop).toBe(120);
  });

  test("手动折叠再展开复位跟随（新正文容器重新滚底）", () => {
    useUiStore.setState({ thinkingDefaultExpanded: true });
    const h = mountThinking("a");
    const el = h.body()!;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 120 });
    h.render("a".repeat(40));
    expect(el.scrollTop).toBe(120);

    el.dispatchEvent(new Event("wheel"));
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 200 });
    h.render("b".repeat(60));
    expect(el.scrollTop).toBe(120);

    // 手动折叠：正文卸载（零滚动开销）
    act(() => {
      h.button().click();
    });
    expect(h.body()).toBeNull();

    // 手动重新展开：新正文容器，跟随复位
    act(() => {
      h.button().click();
    });
    const el2 = h.body()!;
    Object.defineProperty(el2, "scrollHeight", { configurable: true, get: () => 400 });
    h.render("c".repeat(80));
    expect(el2.scrollTop).toBe(400);
  });
});

// ---------------------------------------------------------------- 设置面板 PUT 持久化

describe("设置面板对话分区（ConversationSection）", () => {
  test("勾选 PUT chat.thinkingDefaultExpanded 字符串载荷并更新 store；取消翻转回 false", async () => {
    useUiStore.setState({ thinkingDefaultExpanded: false });
    const ORIGINAL_FETCH = globalThis.fetch;
    const puts: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" && url === "/api/settings") {
        puts.push(JSON.parse(String(init.body)));
        return okJson({ ok: true, settings: {} });
      }
      return new Response(JSON.stringify({ error: { code: "unmocked", message: url } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const container = makeContainer();
      const root = createRoot(container);
      act(() => {
        root.render(createElement(ConversationSection));
      });
      CLEANUPS.push(() => act(() => root.unmount()));
      const checkbox = () => container.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(checkbox().checked).toBe(false);

      await act(async () => {
        checkbox().click();
      });
      expect(puts[0]).toEqual({ [THINKING_EXPANDED_KV]: "true" });
      expect(useUiStore.getState().thinkingDefaultExpanded).toBe(true);

      await act(async () => {
        checkbox().click();
      });
      expect(puts[1]).toEqual({ [THINKING_EXPANDED_KV]: "false" });
      expect(useUiStore.getState().thinkingDefaultExpanded).toBe(false);
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});
