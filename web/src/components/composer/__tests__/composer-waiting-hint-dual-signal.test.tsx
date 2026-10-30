// @ts-nocheck
// engine-upgrade 2026-10-30 缺陷 C：等待提示双信号（确定性渲染单测，计划验收 ③④⑤）。
// ③ waiting + 帧静默超 120s + 无待答卡 → 经真实 60s 清扫节拍（fake timers 推进一拍）
//    置抑制标志，提示条隐去（走真实节拍路径断言，非直接改状态）；
// ④ waiting + 有待答提问卡 → 静默超 120s 仍保持显示（卡信号压过静默）；
// ⑤ waiting + 10s 前有帧 → 显示（帧新鲜信号独立承重，无需卡与节拍）。
// 环境（session-list-new-session-icon 惯例）：@happy-dom 全局注册 + renderToStaticMarkup
// 静态断言（misleading_success_output 防护：断言 DOM 可见性，非「不抛错」）。
// 状态全部经 dispatchSseEvent 真实帧路径写入（stale_state 防护：不走改状态捷径，
// 清扫走 event-dispatch 真实 interval 回调，非直接调 store 动作）。
// 确定性手段：vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })——
// Date 随 setSystemTime / advanceTimersByTime 精确推进，清扫 interval 可推进一拍；
// setTimeout 保持真实（微任务冲刷用），零真实等待、零时序运气。
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
window.matchMedia = ((query: string) =>
  ({
    matches: false, // 桌面档（非 isCompact 分支）
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

// api 整模块代理 mock（同 session-list-new-session-icon 先例；具名键按 composer 依赖树补齐）
const apiFns = new Map();
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (!apiFns.has(key)) apiFns.set(key, vi.fn(() => Promise.resolve({})));
        return apiFns.get(key);
      },
    },
  ),
  ApiError: class ApiError extends Error {},
  shortModelName: (m: string) => m,
}));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Composer } = await import("../composer");
const {
  dispatchSseEvent,
  resetDispatchState,
  SWEEP_INTERVAL_MS,
  WAITING_HINT_SILENCE_MS,
} = await import("@/lib/event-dispatch");
const { useSessionsStore } = await import("@/stores/sessions");
const { useQuestionsStore } = await import("@/stores/questions");
const { usePermissionsStore } = await import("@/stores/permissions");
const { useMessagesStore } = await import("@/stores/messages");

const T0 = 1_000_000;

function frame(wire: Record<string, unknown>, durable?: string): string {
  return JSON.stringify(
    durable ? { projectPath: "/p", event: wire, durableSessionId: durable } : { projectPath: "/p", event: wire },
  );
}

/** 未知 method 的阻塞帧：落 waiting、不渲染任何卡（静默隐去路径的纯态构造） */
function mysteryBlock(): Record<string, unknown> {
  return { type: "extension_ui_request", method: "mystery_block", sessionId: "rpc-1" };
}

function renderComposer(): string {
  return renderToStaticMarkup(
    createElement(Composer, {
      sessionId: "d-1",
      queueAvailable: false,
      permissionLocked: false,
      hydrationLocked: false,
      onSent: () => {},
      onAborted: () => {},
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(T0);
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    runStateAt: {},
    runStateSeq: {},
    lastFrameAt: {},
    waitingHintHidden: {},
    selectedId: "d-1",
    allMode: false,
  });
  useQuestionsStore.setState({ bySession: {} });
  usePermissionsStore.setState({ bySession: {} });
  useMessagesStore.setState({ bySession: {} });
  resetDispatchState();
});

afterEach(() => {
  resetDispatchState();
  vi.useRealTimers(); // 恢复真实时钟，防跨文件泄漏
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    runStateAt: {},
    runStateSeq: {},
    lastFrameAt: {},
    waitingHintHidden: {},
  });
  useQuestionsStore.setState({ bySession: {} });
  usePermissionsStore.setState({ bySession: {} });
  useMessagesStore.setState({ bySession: {} });
});

describe("engine-upgrade 2026-10-30 缺陷 C：等待提示双信号", () => {
  test("③ waiting + 帧静默超 120s + 无待答卡：经真实清扫节拍隐去，runState 不动（分层边界）", () => {
    dispatchSseEvent("extension_ui_request", frame(mysteryBlock(), "d-1"), 1);
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("waiting");

    const before = renderComposer();
    expect(before).toContain('data-testid="composer-waiting-hint"'); // 帧刚到达（新鲜）：显示

    vi.setSystemTime(T0 + WAITING_HINT_SILENCE_MS + 10_000);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS); // 真实节拍一拍：sweepStaleRunStates + 提示抑制

    // 分层边界：抑制只动 UI 派生标志，runState waiting 原样（WAITING_STALE_MS 30min 档不动）
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("waiting");
    expect(useSessionsStore.getState().waitingHintHidden["d-1"]).toBe(true);

    const after = renderComposer();
    expect(after).not.toContain('data-testid="composer-waiting-hint"'); // DOM 可见性断言
  });

  test("④ waiting + 有待答提问卡：静默超 120s 仍保持显示（卡信号压过静默）", () => {
    dispatchSseEvent(
      "extension_ui_request",
      frame(
        {
          type: "extension_ui_request",
          method: "question",
          id: "q1",
          waitForAnswer: true,
          sessionId: "rpc-1",
          questions: [{ id: "q1", question: "继续吗？", options: [{ label: "是" }] }],
        },
        "d-1",
      ),
      1,
    );
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("waiting");
    expect(useQuestionsStore.getState().bySession["d-1"]?.length).toBe(1);

    vi.setSystemTime(T0 + WAITING_HINT_SILENCE_MS + 10_000);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(useSessionsStore.getState().waitingHintHidden["d-1"]).toBeUndefined(); // 卡压过静默：不置抑制
    expect(renderComposer()).toContain('data-testid="composer-waiting-hint"');
  });

  test("⑤ waiting + 10s 前有帧：显示（帧新鲜信号独立承重，无需卡与节拍）", () => {
    dispatchSseEvent("extension_ui_request", frame(mysteryBlock(), "d-1"), 1);
    vi.setSystemTime(T0 + 10_000); // 静默 10s（< 120s），不推进清扫节拍
    expect(useSessionsStore.getState().waitingHintHidden["d-1"]).toBeUndefined();
    expect(renderComposer()).toContain('data-testid="composer-waiting-hint"');
  });
});
