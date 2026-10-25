/**
 * 会话第四态「后台运行中」web 侧测试（docs08-2026-10-23-24-batch 任务 12）：
 * - store：服务端行 background_running 同步入 runStates（SSE running/waiting/error 优先）、
 *   终局回落清除；清扫器后台态专属阈值（60min）超时回落、未超不扫（f，注入时钟确定性）；
 * - stopIntent（composer-logic 纯函数）：后台态+非流式 → 提示语义，不中断；
 * - SessionItem 状态点：第四态紫点呼吸 + 「后台运行中」title（d）；
 * - ContextWaterRing 水位环：第四态紫环 + 明细「后台运行中」（d）；
 * - Composer 中断钮交互：后台态点击出「有后台任务」提示、不打 abort 接口（e）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { stopIntent } = await import("@/components/composer/composer-logic");
const { SessionItem } = await import("@/components/session-list/session-item");
const { ContextWaterRing } = await import("@/components/layout/context-ring");
const { Composer } = await import("@/components/composer/composer");
const { useSessionsStore, BACKGROUND_STALE_MS } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");
import type { SessionListItem } from "@/lib/api";

const SID = "bg-1";

function makeSession(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: SID,
    path: "/store/bg-1.jsonl",
    project: "/p1",
    title: "后台会话",
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
    ...overrides,
  };
}

const ORIGINAL_FETCH = globalThis.fetch;
const fetchedUrls: string[] = [];

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function mockFetch(handler: (input: RequestInfo | URL) => Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchedUrls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
}

let mountedRoot: { unmount(): void } | null = null;

async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  mountedRoot = root;
  return container;
}

function resetStore(): void {
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    runStateAt: {},
    appliedModels: {},
    selectedId: null,
    aliasIds: {},
    pendingIds: {},
  });
}

beforeEach(() => {
  fetchedUrls.length = 0;
  resetStore();
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  mountedRoot?.unmount();
  mountedRoot = null;
  globalThis.fetch = ORIGINAL_FETCH;
  resetStore();
});

// ---------------------------------------------------------------- store 同步与清扫（f）

describe("store：服务端行第四态同步与清扫器", () => {
  test("行 runState=background_running → runStates 写入；SSE running/waiting/error 在位时不覆盖", () => {
    const store = useSessionsStore.getState();
    store.setSessions("/p1", [makeSession({ runState: "background_running" })]);
    expect(useSessionsStore.getState().runStates[SID]).toBe("background_running");

    useSessionsStore.setState({ runStates: { [SID]: "running" } });
    store.setSessions("/p1", [makeSession({ runState: "background_running" })]);
    expect(useSessionsStore.getState().runStates[SID]).toBe("running");

    useSessionsStore.setState({ runStates: { [SID]: "waiting" } });
    store.setSessions("/p1", [makeSession({ runState: "background_running" })]);
    expect(useSessionsStore.getState().runStates[SID]).toBe("waiting");
  });

  test("行回落非后台（jsonl 终态回执后刷新）→ store 后台态清除", () => {
    const store = useSessionsStore.getState();
    store.setSessions("/p1", [makeSession({ runState: "background_running" })]);
    expect(useSessionsStore.getState().runStates[SID]).toBe("background_running");
    store.setSessions("/p1", [makeSession({ runState: "idle" })]);
    expect(useSessionsStore.getState().runStates[SID]).toBeUndefined();
  });

  test("清扫器：后台态 60min 专属阈值——未超不扫、超时回落 idle（注入时钟，无真实等待）", () => {
    const t0 = 1_000_000;
    useSessionsStore.setState({
      runStates: { [SID]: "background_running", other: "running", wait: "waiting" },
      runStateAt: { [SID]: t0, other: t0, wait: t0 },
    });
    const store = useSessionsStore.getState();
    // 59min：后台不扫；running 10min / waiting 30min 阈值均过 → 两者已回落
    store.sweepStaleRunStates(t0 + 59 * 60_000);
    expect(useSessionsStore.getState().runStates[SID]).toBe("background_running");
    expect(useSessionsStore.getState().runStates.other).toBe("idle");
    expect(useSessionsStore.getState().runStates.wait).toBe("idle");
    // 60min 整（阈值边界：<= 不扫，严格大于才扫）仍未扫
    store.sweepStaleRunStates(t0 + BACKGROUND_STALE_MS);
    expect(useSessionsStore.getState().runStates[SID]).toBe("background_running");
    // 61min：后台态回落（完成通知丢失的兜底）
    store.sweepStaleRunStates(t0 + BACKGROUND_STALE_MS + 1);
    expect(useSessionsStore.getState().runStates[SID]).toBe("idle");
  });
});

// ---------------------------------------------------------------- 停止钮意图（e 纯函数层）

describe("stopIntent（后台态停止钮语义）", () => {
  test("后台态 + 无流式回合 → background-hint（不中断）", () => {
    expect(stopIntent("background_running", false)).toBe("background-hint");
  });
  test("后台态 + 流式回合（queueAvailable）→ abort（中断的是当前回合）", () => {
    expect(stopIntent("background_running", true)).toBe("abort");
  });
  test("三态既有语义不变：running/waiting/idle/未知 → abort", () => {
    for (const state of ["running", "waiting", "idle", "error", undefined, null]) {
      expect(stopIntent(state, false)).toBe("abort");
      expect(stopIntent(state, true)).toBe("abort");
    }
  });
});

// ---------------------------------------------------------------- 状态点（d）

describe("SessionItem 状态点第四态渲染", () => {
  test("runStates=background_running → 紫点呼吸 + title「后台运行中」", () => {
    useSessionsStore.setState({ runStates: { [SID]: "background_running" } });
    const html = renderToStaticMarkup(
      createElement(SessionItem, {
        session: makeSession(),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    expect(html).toContain("后台运行中");
    expect(html).toContain("bg-violet-500");
  });

  test("服务端行 runState=background_running（SSE 未见过事件）→ 同样渲染第四态", () => {
    const html = renderToStaticMarkup(
      createElement(SessionItem, {
        session: makeSession({ runState: "background_running" }),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    expect(html).toContain("后台运行中");
    expect(html).toContain("bg-violet-500");
  });
});

// ---------------------------------------------------------------- 水位环（d）

describe("ContextWaterRing 第四态渲染", () => {
  function usagePayload(): unknown {
    return {
      sessionId: SID,
      usage: {
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: 0.01,
        contextUsage: { tokens: 2048, contextWindow: 1_000_000, percent: 0.2 },
      },
    };
  }

  test("runStates=background_running → 紫环 + 脉冲点 + 明细「后台运行中」", async () => {
    mockFetch(async () => okJson(usagePayload()));
    useSessionsStore.setState({ runStates: { [SID]: "background_running" } });
    const container = await mount(createElement(ContextWaterRing, { sessionId: SID }));
    // 紫环 + 后台脉冲点（violet）；明细 Popover 默认收起不参与断言
    expect(container.querySelector("svg circle.stroke-violet-500")).not.toBeNull();
    expect(container.querySelector("[data-testid=context-ring-running-dot]")?.className).toContain("bg-violet-500");
  });

  test("无后台态 → 环不带 violet（三态渲染不变）", async () => {
    mockFetch(async () => okJson(usagePayload()));
    const container = await mount(createElement(ContextWaterRing, { sessionId: SID }));
    expect(container.querySelector("svg circle.stroke-violet-500")).toBeNull();
  });
});

// ---------------------------------------------------------------- 中断钮交互（e）

describe("Composer 后台态中断钮：提示语义，不裸中断", () => {
  test("后台态点击停止钮 → 「有后台任务」提示 + 不打 abort 接口", async () => {
    mockFetch(async () => okJson({ ok: true }));
    useSessionsStore.setState({ runStates: { [SID]: "background_running" } });
    const container = await mount(
      createElement(Composer, {
        sessionId: SID,
        queueAvailable: false,
        permissionLocked: false,
        hydrationLocked: false,
        onSent: () => {},
        onAborted: () => {},
      }),
    );
    const btn = container.querySelector("[data-testid=abort-btn]") as HTMLButtonElement;
    expect(btn).not.toBeNull(); // 后台态计入 interruptible 并集（可见才可提示）
    await act(async () => {
      btn.click();
    });
    expect(useUiStore.getState().toast?.text ?? "").toContain("有后台任务");
    expect(fetchedUrls.some((u) => u.includes("/abort"))).toBe(false);
  });

  test("running 态点击停止钮 → 仍走 abort（三态语义不变）", async () => {
    const abortCalls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      abortCalls.push(url);
      return Promise.resolve(okJson({ ok: true }));
    }) as unknown as typeof fetch;
    useSessionsStore.setState({ runStates: { [SID]: "running" } });
    const container = await mount(
      createElement(Composer, {
        sessionId: SID,
        queueAvailable: false,
        permissionLocked: false,
        hydrationLocked: false,
        onSent: () => {},
        onAborted: () => {},
      }),
    );
    const btn = container.querySelector("[data-testid=abort-btn]") as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    expect(abortCalls.some((u) => u.includes("/abort"))).toBe(true);
  });
});
