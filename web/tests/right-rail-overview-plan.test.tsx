// 右栏总览「计划」区块测试（r10 todo 12）：
// - 绑定 goal：计划名 + N/M 勾选态 + 当前步渲染（组件渲染面即手动 QA 证明）
// - 未绑定（bound:false）/ total=0 / 拉取失败 / 无会话 → 整块不渲染（不留空面板）
// - 更新策略：本会话消息活动（entries 引用变化）→ 1.5s 尾沿去抖重拉，进度推进；
//   无活动时推进时间无新请求（非轮询定时器）
// api 全 mock（无网络）；happy-dom + createRoot + act（tip-card 同款）；
// 去抖路径用 fake timers（无真实等待）。
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const getPlanProgressMock = vi.fn();
const getUsageMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getPlanProgress: (...args: unknown[]) => getPlanProgressMock(...args),
      getUsage: (...args: unknown[]) => getUsageMock(...args),
    },
  };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { OverviewPlan } = await import("@/components/layout/overview-plan");
const { OverviewPanel } = await import("@/components/layout/overview-panel");
const { useMessagesStore } = await import("@/stores/messages");

const SID = "01a17aca-809a-7984-a8fe-8c286eaf9caf";

function boundSnap(over = {}) {
  return {
    bound: true,
    planName: "r10-2026-10-27-batch",
    done: 1,
    total: 9,
    currentTitle: "10. 帧桥接 spike：引擎事件帧可达性探查",
    ...over,
  };
}

interface Handle {
  host: HTMLElement;
  q: (selector: string) => HTMLElement | null;
  unmount: () => Promise<void>;
}

async function mount(component: unknown): Promise<Handle> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(component as never);
  });
  await act(async () => {}); // flush 微任务（mock 的 then 回调）
  return {
    host,
    q: (selector: string) => host.querySelector<HTMLElement>(selector),
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function mountPlan(sessionId: string | null): Promise<Handle> {
  return mount(createElement(OverviewPlan, { sessionId }));
}

beforeEach(() => {
  getPlanProgressMock.mockReset();
  getUsageMock.mockReset();
  getUsageMock.mockRejectedValue(new Error("stats 不在本次测试面"));
  useMessagesStore.setState({ bySession: {} });
});

afterEach(() => {
  useMessagesStore.setState({ bySession: {} });
});

describe("总览计划区块（r10 todo 12）", () => {
  test("绑定 goal：计划名 + 勾选态 N/M + 当前步可见", async () => {
    getPlanProgressMock.mockResolvedValue(boundSnap());
    const h = await mountPlan(SID);
    try {
      expect(h.q('[data-testid="overview-plan"]')).not.toBeNull();
      expect(h.q('[data-testid="overview-plan"]').textContent).toContain("r10-2026-10-27-batch");
      expect(h.q('[data-testid="overview-plan-count"]').textContent).toBe("1/9");
      expect(h.q('[data-testid="overview-plan-current"]').textContent).toBe("10. 帧桥接 spike：引擎事件帧可达性探查");
      expect(getPlanProgressMock).toHaveBeenCalledTimes(1);
      expect(getPlanProgressMock).toHaveBeenCalledWith(SID);
    } finally {
      await h.unmount();
    }
  });

  test("全勾选：无当前步行，显示已全部完成", async () => {
    getPlanProgressMock.mockResolvedValue(boundSnap({ done: 9, currentTitle: null }));
    const h = await mountPlan(SID);
    try {
      expect(h.q('[data-testid="overview-plan-current"]')).toBeNull();
      expect(h.q('[data-testid="overview-plan-all-done"]')).not.toBeNull();
      expect(h.q('[data-testid="overview-plan-count"]').textContent).toBe("9/9");
    } finally {
      await h.unmount();
    }
  });

  test("未绑定（bound:false）→ 整块不渲染", async () => {
    getPlanProgressMock.mockResolvedValue({ bound: false });
    const h = await mountPlan(SID);
    try {
      expect(h.q('[data-testid="overview-plan"]')).toBeNull();
    } finally {
      await h.unmount();
    }
  });

  test("计划无 todo 行（total=0）与拉取失败 → 整块不渲染不崩", async () => {
    getPlanProgressMock.mockResolvedValueOnce(boundSnap({ done: 0, total: 0, currentTitle: null }));
    const h1 = await mountPlan(SID);
    expect(h1.q('[data-testid="overview-plan"]')).toBeNull();
    await h1.unmount();

    getPlanProgressMock.mockReset();
    getPlanProgressMock.mockRejectedValueOnce(new Error("network"));
    const h2 = await mountPlan(SID);
    try {
      expect(h2.q('[data-testid="overview-plan"]')).toBeNull();
    } finally {
      await h2.unmount();
    }
  });

  test("无会话（sessionId=null）不请求不渲染", async () => {
    const h = await mountPlan(null);
    try {
      expect(getPlanProgressMock).not.toHaveBeenCalled();
      expect(h.q('[data-testid="overview-plan"]')).toBeNull();
    } finally {
      await h.unmount();
    }
  });

  test("挂在总览面板首位（集成：OverviewPanel 含计划块）", async () => {
    getPlanProgressMock.mockResolvedValue(boundSnap());
    const h = await mount(createElement(OverviewPanel, { sessionId: SID }));
    try {
      const panel = h.q('[data-testid="overview-panel"]');
      expect(panel).not.toBeNull();
      const first = panel.firstElementChild;
      expect(first?.getAttribute("data-testid")).toBe("overview-plan");
    } finally {
      await h.unmount();
    }
  });
});

describe("计划区块更新策略（事件驱动，无轮询）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("消息活动 → 1.5s 尾沿去抖重拉，进度推进", async () => {
    getPlanProgressMock.mockResolvedValueOnce(boundSnap());
    const h = await mountPlan(SID);
    try {
      expect(h.q('[data-testid="overview-plan-count"]').textContent).toBe("1/9");
      expect(getPlanProgressMock).toHaveBeenCalledTimes(1);

      // 计划推进：引擎改写计划 → 工具帧到达 → entries 引用变化
      getPlanProgressMock.mockResolvedValueOnce(boundSnap({ done: 2, currentTitle: "11. 后台活动条+子代理进度" }));
      await act(async () => {
        useMessagesStore.setState({ bySession: { [SID]: { entries: [{ type: "message" }] } } });
      });
      // 去抖未到期：不重拉，旧数据仍在
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1400);
      });
      expect(getPlanProgressMock).toHaveBeenCalledTimes(1);
      expect(h.q('[data-testid="overview-plan-count"]').textContent).toBe("1/9");
      // 到期：重拉并渲染新进度
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(getPlanProgressMock).toHaveBeenCalledTimes(2);
      expect(h.q('[data-testid="overview-plan-count"]').textContent).toBe("2/9");
      expect(h.q('[data-testid="overview-plan-current"]').textContent).toBe("11. 后台活动条+子代理进度");
    } finally {
      await h.unmount();
    }
  });

  test("无消息活动时推进时间不产生新请求（非轮询定时器）", async () => {
    getPlanProgressMock.mockResolvedValue(boundSnap());
    const h = await mountPlan(SID);
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(getPlanProgressMock).toHaveBeenCalledTimes(1);
    } finally {
      await h.unmount();
    }
  });
});
