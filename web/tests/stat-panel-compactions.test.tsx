// 统计页签「上下文压缩」分区组件层用例（2026-11-25）：
// - 有压缩记录：分区渲染，首行压缩次数，逐次一行（时间 + 压缩前 → 压缩后），最新在前
// - tokensAfter 缺省（压缩后尚无回复）显示 "—"
// - 无压缩记录 / 接口失败：分区整体省略，面板其余分区不受影响
// - 回合落定（running→idle 边沿）与 usage 快照同节奏重拉
// 渲染走真实组件（happy-dom + createRoot，stat-panel-panorama 同款）；
// api.getUsage / api.getCompactions 打桩。
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const getUsageMock = vi.fn();
const getCompactionsMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getUsage: (...args: unknown[]) => getUsageMock(...args),
      getCompactions: (...args: unknown[]) => getCompactionsMock(...args),
    },
  };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { StatPanel } = await import("@/components/chat/stat-panel");
import type { ReactNode } from "react";
import { useSessionsStore } from "@/stores/sessions";
import { useLocaleStore } from "@/i18n/i18n";

const S = "s-compactions";
const USAGE = {
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  cost: 0,
};
const ITEMS = [
  { id: "cp-1", timestamp: "2026-11-18T05:52:37.449Z", tokensBefore: 293620, tokensAfter: 45010 },
  { id: "cp-2", timestamp: "2026-11-18T14:48:16.871Z", tokensBefore: 309392, tokensAfter: null },
];

const roots: Array<() => Promise<void>> = [];
async function render(ui: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  roots.push(() => act(async () => root.unmount()));
  return container;
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "zh-CN" });
  useSessionsStore.setState({ runStates: {}, appliedModels: {} });
  getUsageMock.mockResolvedValue({ sessionId: S, usage: USAGE });
});

afterEach(async () => {
  for (const unmount of roots) await unmount();
  roots.length = 0;
  getUsageMock.mockReset();
  getCompactionsMock.mockReset();
  document.body.innerHTML = "";
});

afterAll(() => {
  useSessionsStore.setState({ runStates: {}, appliedModels: {} });
});

describe("统计页签「上下文压缩」分区", () => {
  test("有压缩记录：首行次数，逐次一行（时间 + 压缩前 → 压缩后），最新在前", async () => {
    getCompactionsMock.mockResolvedValue({ sessionId: S, items: ITEMS });
    const c = await render(createElement(StatPanel, { sessionId: S }));
    const section = c.querySelector('[data-testid="stat-compactions"]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("上下文压缩");
    expect(c.querySelector('[data-testid="stat-compactions-count"]')?.textContent).toBe("2");
    const rows = c.querySelectorAll('[data-testid="stat-compaction-row"]');
    expect(rows.length).toBe(2);
    // 最新在前：cp-2（压缩后尚无回复 → "—"）在 cp-1 之前
    expect(rows[0]!.textContent).toContain("309.4k → —");
    expect(rows[1]!.textContent).toContain("293.6k → 45.0k");
    // 时间戳 "MM-DD HH:MM" 形态（钟点随宿主时区，只断言形态）
    expect(rows[1]!.textContent).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    // 其余分区不受影响
    expect(c.querySelector('[data-testid="stat-cost-value"]')).not.toBeNull();
  });

  test("无压缩记录 / 接口失败：分区省略，面板其余分区正常", async () => {
    getCompactionsMock.mockResolvedValue({ sessionId: S, items: [] });
    const c1 = await render(createElement(StatPanel, { sessionId: S }));
    expect(c1.querySelector('[data-testid="stat-compactions"]')).toBeNull();
    expect(c1.querySelector('[data-testid="stat-tokens-total"]')).not.toBeNull();

    getCompactionsMock.mockRejectedValue(new Error("boom"));
    const c2 = await render(createElement(StatPanel, { sessionId: S }));
    expect(c2.querySelector('[data-testid="stat-compactions"]')).toBeNull();
    expect(c2.querySelector('[data-testid="stat-tokens-total"]')).not.toBeNull();
    expect(c2.querySelector('[data-testid="stat-panel"]')!.textContent).not.toContain("用量不可用");
  });

  test("回合落定（running→idle）与快照同节奏重拉压缩记录", async () => {
    getCompactionsMock.mockResolvedValue({ sessionId: S, items: ITEMS });
    const c = await render(createElement(StatPanel, { sessionId: S }));
    expect(getCompactionsMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      useSessionsStore.setState({ runStates: { [S]: "running" } });
    });
    await act(async () => {
      useSessionsStore.setState({ runStates: { [S]: "idle" } });
    });
    expect(getCompactionsMock).toHaveBeenCalledTimes(2);
    expect(c.querySelector('[data-testid="stat-compaction-row"]')).not.toBeNull();
  });
});
