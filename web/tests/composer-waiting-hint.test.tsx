// waiting 态输入明示（docs08-r6 任务 12；engine-upgrade 2026-10-30 缺陷 C 契约更新）：
// ① composer 头部等待提示条：runState=waiting 且双信号（最近 120s 内有 SSE 帧到达 或
//    有待答提问卡/权限卡）时显示「等待提问 / 权限应答中」，桌面（sm+）与手机胶囊（<sm）
//    双渲染支都出；非 waiting 态零渲染（回归护栏）。契约变化（缺陷 C）：waiting 单独
//    不再出条——直写 waiting（对账回写形态）无帧信号无卡时不显示，静默超 120s 且无卡
//    时经 60s 清扫节拍隐去（静默隐去路径见 composer-waiting-hint-dual-signal.test.tsx）。
// ② 排队入队可见反馈：回执 disposition=queued 时零 toast（双通道去重），仅排队条入列。
//    排队语义不回退：输入不禁用（waiting 态 textarea 仍可编辑）。
// 正例走真实 dispatchSseEvent 帧路径（帧信号新鲜，与生产写入链同源）；直写负例锁定
// 「waiting 单独不出条」的新契约。提示条为纯派生渲染：matchMedia 桩切档 +
// renderToStaticMarkup 静态断言（composer-interrupt 惯例）；入队反馈走真实 sendText
// 流程（api 层 vi.spyOn 桩，无网络），createRoot 驱动。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("@/components/composer/composer");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");
const { useQueueStore } = await import("@/stores/queue");
const { useMessagesStore } = await import("@/stores/messages");
const { usePermissionsStore } = await import("@/stores/permissions");
const { useQuestionsStore } = await import("@/stores/questions");
const apiMod = await import("@/lib/api");

const SID = "qa-waiting-1";
const SHEET_QUERY = "(max-width: 639.98px)";
const REAL_MATCH_MEDIA = window.matchMedia.bind(window);

function stubMatchMedia(compact: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: compact && query === SHEET_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

function setRunState(state: "running" | "waiting" | "idle" | "error" | undefined): void {
  useSessionsStore.setState((s) => {
    const runStates = { ...s.runStates };
    if (state === undefined) delete runStates[SID];
    else runStates[SID] = state;
    return { runStates };
  });
}

function renderComposer(queueAvailable: boolean): string {
  return renderToStaticMarkup(
    createElement(Composer, {
      sessionId: SID,
      queueAvailable,
      permissionLocked: false,
      hydrationLocked: false,
      onSent: () => {},
      onAborted: () => {},
    }),
  );
}

/** wire 帧信封（wire sessionId + durableSessionId=SID，与生产路由键同源） */
function envelope(wire: Record<string, unknown>, durable?: string): string {
  return JSON.stringify(
    durable ? { projectPath: "/p", event: wire, durableSessionId: durable } : { projectPath: "/p", event: wire },
  );
}

/** 阻塞型 confirm 帧（真实 waiting 写入链：帧信号新鲜 + 权限卡入队） */
function waitingFrame(): string {
  return envelope(
    { type: "extension_ui_request", method: "confirm", id: "r-hint", title: "确认执行？", sessionId: "rpc-hint" },
    SID,
  );
}

beforeEach(() => {
  resetDispatchState();
  useSessionsStore.setState({ lastFrameAt: {}, waitingHintHidden: {} });
  usePermissionsStore.setState({ bySession: {} });
  useQuestionsStore.setState({ bySession: {} });
  useMessagesStore.setState({ bySession: {} });
  setRunState(undefined);
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  resetDispatchState(); // 拆防 dispatch 布防的清扫 interval（本文件真实定时器）
  useSessionsStore.setState({ lastFrameAt: {}, waitingHintHidden: {} });
  usePermissionsStore.setState({ bySession: {} });
  useQuestionsStore.setState({ bySession: {} });
  useMessagesStore.setState({ bySession: {} });
  window.matchMedia = REAL_MATCH_MEDIA;
  setRunState(undefined);
  useUiStore.setState({ toast: null });
});

describe("waiting 提示条（桌面档）", () => {
  test("runState=waiting（真实帧写入，帧信号新鲜）→ 提示条可见（含等待文案）", () => {
    dispatchSseEvent("extension_ui_request", waitingFrame(), 1);
    expect(useSessionsStore.getState().runStates[SID]).toBe("waiting");
    const html = renderComposer(false);
    expect(html).toContain('data-testid="composer-waiting-hint"');
    expect(html).toContain("等待提问 / 权限应答中");
  });

  test("runState=waiting 直写（对账回写形态：无帧信号、无待答卡）→ 不显示（缺陷 C 双信号契约）", () => {
    setRunState("waiting");
    const html = renderComposer(false);
    expect(html).not.toContain('data-testid="composer-waiting-hint"');
  });

  test.each(["running", "idle", "error", undefined] as const)(
    "runState=%s → 零渲染（非 waiting 不出提示条）",
    (state) => {
      setRunState(state);
      const html = renderComposer(false);
      expect(html).not.toContain('data-testid="composer-waiting-hint"');
    },
  );

  test("waiting 态输入不被锁：textarea 无 disabled，中断钮在、排队模式钮随 queueAvailable", () => {
    dispatchSseEvent("extension_ui_request", waitingFrame(), 1);
    const html = renderComposer(false);
    // textarea 开标签内不存在 disabled 属性（disabled:opacity-50 是 class，需边界排除）
    const inputTag = /<textarea[^>]*>/.exec(html)?.[0] ?? "";
    expect(inputTag).toContain('data-testid="composer-input"');
    expect(inputTag).not.toMatch(/\sdisabled(?=[\s>])/);
    expect(html).toContain('data-testid="abort-btn"');
    expect(html).not.toContain('data-testid="queue-mode-btn"');
  });

  test("queueAvailable=true 且 waiting（帧信号新鲜）→ 排队模式钮仍在（排队语义不回退）", () => {
    dispatchSseEvent("extension_ui_request", waitingFrame(), 1);
    const html = renderComposer(true);
    expect(html).toContain('data-testid="composer-waiting-hint"');
    expect(html).toContain('data-testid="queue-mode-btn"');
  });
});

describe("waiting 提示条（手机胶囊档）", () => {
  test("runState=waiting（帧信号新鲜）→ 胶囊档渲染提示条（双档都出）", () => {
    stubMatchMedia(true);
    dispatchSseEvent("extension_ui_request", waitingFrame(), 1);
    const html = renderComposer(false);
    expect(html).toContain('data-testid="composer-capsule"');
    expect(html).toContain('data-testid="composer-waiting-hint"');
  });

  test("runState=idle → 胶囊档零渲染", () => {
    stubMatchMedia(true);
    setRunState("idle");
    const html = renderComposer(false);
    expect(html).toContain('data-testid="composer-capsule"');
    expect(html).not.toContain('data-testid="composer-waiting-hint"');
  });
});

describe("排队入队可见反馈", () => {
  async function sendAndGetToast(): Promise<string | null> {
    const promptSpy = vi.spyOn(apiMod.api, "prompt").mockResolvedValue({
      disposition: "queued",
    } as unknown as Awaited<ReturnType<typeof apiMod.api.prompt>>);
    const draftSpy = vi.spyOn(apiMod.api, "getDraft").mockRejectedValue(new Error("offline"));
    const putDraftSpy = vi.spyOn(apiMod.api, "putDraft").mockResolvedValue(undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(Composer, {
          sessionId: SID,
          queueAvailable: true,
          permissionLocked: false,
          hydrationLocked: false,
          onSent: () => {},
          onAborted: () => {},
        }),
      );
    });
    try {
      const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]');
      expect(textarea).not.toBeNull();
      // React 受控组件：直接赋值会被值追踪器去重吞掉，必须走原生 setter 触发 onChange
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      await act(async () => {
        setValue.call(textarea, "排队消息");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const sendBtn = container.querySelector<HTMLButtonElement>('button[data-testid="send-btn"]');
      expect(sendBtn).not.toBeNull();
      await act(async () => {
        sendBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(promptSpy).toHaveBeenCalledTimes(1);
      return useUiStore.getState().toasts.at(-1)?.text ?? null;
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      draftSpy.mockRestore();
      putDraftSpy.mockRestore();
    }
  }

  test("回执 queued → 零 toast（r10 todo 7 双通道去重：反馈走消息流事件行）+ 仅排队条入列（docs08-r7 任务 15）", async () => {
    const toast = await sendAndGetToast();
    expect(toast).toBeNull();
    const pending = useQueueStore.getState().bySession[SID]?.items ?? [];
    expect(pending.length).toBe(1);
    // 排队占位路径已退役：排队项只进 queue store，不进消息流
    expect(useMessagesStore.getState().bySession[SID]?.entries.length ?? 0).toBe(0);
  });
});
