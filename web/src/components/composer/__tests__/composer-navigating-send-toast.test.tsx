// @ts-nocheck
// task-10 attempt-7 侧发现 1 回归：叶导航在途（navigating 布防）点发送——
// api.prompt 抛 409 navigating（todo 6 ⑦ 互斥守卫，客户端出网前拦截零网络）时，
// Composer 不得静默吞点击也不得进常驻错误卡（QA 实录走了 pushError 常驻卡，瞬态
// 在途态反馈过重且被驱动漏看）：按 switchBusy 轻提示纪律出 toast、草稿保留可重发。
// 环境（composer-waiting-hint 同惯例）：@happy-dom + api 整模块 mock（ApiError 按
// 真实 (status, code, message) 形状镜像），createRoot 挂载真实点击链。
import { describe, expect, test, vi, beforeEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
window.matchMedia = ((query: string) =>
  ({
    matches: false, // 桌面档
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

const NAV_MSG = "叶切换进行中，请稍候再发送";
/** 真实 ApiError 形状镜像（status/code/message）：composer 分流按 instanceof + 双字段 */
class MockApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
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
  ApiError: MockApiError,
}));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("../composer");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");
const { useMessagesStore } = await import("@/stores/messages");

const SID = "d-nav";

/** 微任务链 flush（发送链 fire-and-forget promise；固定 sleep 禁用纪律） */
async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function mountComposer(): () => void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(Composer, {
        sessionId: SID,
        queueAvailable: false,
        permissionLocked: false,
        hydrationLocked: false,
        onSent: () => {},
        onAborted: () => {},
      }),
    );
  });
  return () => act(() => root.unmount());
}

beforeEach(() => {
  apiFns.clear();
  apiFns.set("getDraft", vi.fn(async () => ({ sessionId: SID, draft: { content: "待发草稿", updatedAt: "2026-11-15T00:00:00Z" } })));
  useSessionsStore.setState({ byProject: {}, runStates: {}, runStateAt: {}, selectedId: SID });
  useMessagesStore.setState({ bySession: {} });
  useUiStore.setState({ toasts: [], modelsLoaded: false });
  localStorage.clear();
});

describe("侧发现 1：导航在途发送拒绝出轻提示（toast）不进常驻卡、草稿保留", () => {
  test("prompt 拒 409 navigating → toast 一枚（文案=navigatingSendBlocked）、零错误卡、草稿保留可重发", async () => {
    // 导航在途：api.prompt 出网前被 todo 6 ⑦ 守卫拒（此处按契约边界模拟该拒绝形状）
    apiFns.set("prompt", vi.fn(async () => { throw new MockApiError(409, "navigating", NAV_MSG); }));
    const unmount = mountComposer();
    await act(async () => {
      await flushMicrotasks();
    });
    const input = document.querySelector('[data-testid="composer-input"]');
    expect(input?.value).toBe("待发草稿"); // 草稿已回填（canSend 成立）

    const btn = document.querySelector('[data-testid="send-btn"]');
    expect(btn?.disabled).toBe(false);
    await act(async () => {
      btn.click();
      await flushMicrotasks();
    });

    expect(apiFns.get("prompt")).toHaveBeenCalledTimes(1); // 出网尝试发生（守卫拒绝非静默吞）
    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(1); // 轻提示（switchBusy 同纪律：瞬态忙碌门不进常驻卡）
    expect(toasts[0].text).toBe(NAV_MSG); // zh 锁定文案（common.lib.navigatingSendBlocked）
    expect(useMessagesStore.getState().bySession[SID]?.errors ?? []).toHaveLength(0); // 零常驻错误卡
    expect(document.querySelector('[data-testid="composer-input"]').value).toBe("待发草稿"); // 草稿保留（失败不清空，可重发）
    unmount();
  });

  test("对照：already_processing 撞车仍走常驻错误卡（既有 IS-4 语义不回归）", async () => {
    apiFns.set("prompt", vi.fn(async () => { throw new MockApiError(409, "already_processing", "occupied"); }));
    const unmount = mountComposer();
    await act(async () => {
      await flushMicrotasks();
    });
    await act(async () => {
      document.querySelector('[data-testid="send-btn"]').click();
      await flushMicrotasks();
    });
    // 直发 409 already_processing 先走排队重试（spike F2），重试再拒才收卡——两次 prompt
    expect(apiFns.get("prompt")).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().toasts).toHaveLength(0); // 不走 toast
    expect(useMessagesStore.getState().bySession[SID]?.errors ?? []).toHaveLength(1); // 常驻卡在场
    unmount();
  });
});
