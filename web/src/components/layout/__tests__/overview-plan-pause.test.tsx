// 计划控制面按钮三态（2026-10-31 方案 b）：绑定 active → 暂停钮（点击走 plan-pause）；
// user_paused → 恢复钮（点击走 plan-resume）；未绑定 → 整块不渲染。
// 环境说明同 tests/abort-settle-reset.test.tsx：happy-dom 全局注册 + 动态 import
// （保证 mock 晚于 preload 生效）+ fetch 桩记录调用。
import { afterEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { useMessagesStore } = await import("@/stores/messages");

const SID = "qa-plan-pause";

// api 模块整替：记录调用，快照按用例覆写
const apiState = {
  snapshot: { bound: false } as Record<string, unknown>,
  calls: [] as { method: string; args: unknown[] }[],
};

vi.mock("@/lib/api", () => ({
  api: {
    getPlanProgress: (sessionId: string) => {
      apiState.calls.push({ method: "getPlanProgress", args: [sessionId] });
      return Promise.resolve(apiState.snapshot);
    },
    pausePlan: (sessionId: string) => {
      apiState.calls.push({ method: "pausePlan", args: [sessionId] });
      // 真实端点改盘后快照翻成 user_paused（这里直接翻快照模拟回读）
      apiState.snapshot = { ...apiState.snapshot, status: "user_paused" };
      return Promise.resolve({ ok: true, workId: "w", status: "user_paused" });
    },
    resumePlan: (sessionId: string) => {
      apiState.calls.push({ method: "resumePlan", args: [sessionId] });
      apiState.snapshot = { ...apiState.snapshot, status: "active" };
      return Promise.resolve({ ok: true, workId: "w", status: "active" });
    },
  },
}));

const { OverviewPlan } = await import("@/components/layout/overview-plan");

async function renderInto(sessionId: string | null): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(OverviewPlan, { sessionId }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

let mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
  useMessagesStore.getState().clearSession(SID);
  apiState.snapshot = { bound: false };
  apiState.calls = [];
});

function boundSnap(status: string | null): Record<string, unknown> {
  return { bound: true, planName: "p", workId: "w", status, done: 1, total: 9, currentTitle: "1. a" };
}

describe("OverviewPlan 控制面按钮三态", () => {
  test("active 绑定：渲染暂停钮（resume testid 不存在）", async () => {
    apiState.snapshot = boundSnap("active");
    const el = await renderInto(SID);
    mounted.push(el);
    expect(el.querySelector('[data-testid="overview-plan-pause"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="overview-plan-resume"]')).toBeNull();
  });

  test("user_paused：渲染恢复钮", async () => {
    apiState.snapshot = boundSnap("user_paused");
    const el = await renderInto(SID);
    mounted.push(el);
    expect(el.querySelector('[data-testid="overview-plan-resume"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="overview-plan-pause"]')).toBeNull();
  });

  test("status 缺失（旧服务端）→ 按暂停渲染（可暂停是保守态）", async () => {
    apiState.snapshot = boundSnap(null);
    const el = await renderInto(SID);
    mounted.push(el);
    expect(el.querySelector('[data-testid="overview-plan-pause"]')).not.toBeNull();
  });

  test("未绑定 → 整块不渲染", async () => {
    apiState.snapshot = { bound: false };
    const el = await renderInto(SID);
    mounted.push(el);
    expect(el.querySelector('[data-testid="overview-plan"]')).toBeNull();
  });

  test("点击暂停：走 pausePlan，操作后回读快照翻成恢复钮", async () => {
    apiState.snapshot = boundSnap("active");
    const el = await renderInto(SID);
    mounted.push(el);
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="overview-plan-pause"]');
    expect(btn?.textContent).toBe("暂停执行");
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiState.calls.some((c) => c.method === "pausePlan")).toBe(true);
    expect(el.querySelector('[data-testid="overview-plan-resume"]')).not.toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="overview-plan-resume"]')?.textContent).toBe("恢复执行");
  });

  test("点击恢复：走 resumePlan，翻回暂停钮", async () => {
    apiState.snapshot = boundSnap("user_paused");
    const el = await renderInto(SID);
    mounted.push(el);
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="overview-plan-resume"]');
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiState.calls.some((c) => c.method === "resumePlan")).toBe(true);
    expect(el.querySelector('[data-testid="overview-plan-pause"]')).not.toBeNull();
  });
});
