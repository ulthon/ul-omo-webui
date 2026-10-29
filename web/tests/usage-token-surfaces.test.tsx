// 水位三面附已用/上限 token（docs08 r7 任务 5）组件层用例：
// - 桌面状态栏 detail 追加「 · {n}% · used/limit」（testid status-detail）；
// - failure 面：contextUsage.contextWindow<=0 → toUsageStats context=null →
//   状态栏不出现 token 段。
// 渲染走真实组件（happy-dom + createRoot，model-pending-badge 同款 Popover 透传化）；
// api.getUsage 打桩喂 usage 快照，无网络无时间依赖。
import { afterEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// radix Popover 透传化（model-pending-badge.test.tsx 同款）：Content 恒渲染
vi.mock("@/components/ui/popover", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const PopoverContent = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...(rest as object)} data-testid="popover-content">
      {children}
    </div>
  );
  return { Popover: Passthrough, PopoverTrigger: Passthrough, PopoverClose: Passthrough, PopoverContent };
});

// api.getUsage 打桩（短模型名走真实实现）
const getUsageMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, getUsage: (...args: unknown[]) => getUsageMock(...args) } };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { StatusBar } = await import("@/components/chat/status-bar");
const { useMessagesStore } = await import("@/stores/messages");
const { usePermissionsStore } = await import("@/stores/permissions");
const { useSessionsStore } = await import("@/stores/sessions");
const { useLocaleStore } = await import("@/i18n/i18n");

const S = "s-usage";

/** 与契约同构的 usage 快照：57K/1M → 5.7% */
const USAGE = {
  tokens: { input: 40000, output: 7000, cacheRead: 9000, cacheWrite: 1000, total: 57000 },
  cost: 0.01,
  contextUsage: { tokens: 57000, contextWindow: 1_000_000, percent: 5.7 },
};

const roots: Array<() => Promise<void>> = [];

async function render(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  roots.push(() => act(async () => root.unmount()));
  return container;
}

function seedStores(): void {
  useLocaleStore.setState({ locale: "zh-CN" });
  useMessagesStore.setState({ bySession: {} });
  usePermissionsStore.setState({ bySession: {} });
  useSessionsStore.setState({ runStates: {}, appliedModels: {} });
}

afterEach(async () => {
  for (const unmount of roots) await unmount();
  roots.length = 0;
  getUsageMock.mockReset();
  document.body.innerHTML = "";
});

describe("水位三面附 token（docs08 r7 任务 5）", () => {
  test("状态栏：detail 追加「 · 6% · 57.0k/1.00M」", async () => {
    seedStores();
    getUsageMock.mockResolvedValue({ usage: USAGE });
    const c = await render(createElement(StatusBar, { sessionId: S }));
    const detail = c.querySelector('[data-testid="status-detail"]');
    expect(detail?.textContent).toContain("上下文 6% · 57.0k/1.00M");
  });

  test("failure 面：contextWindow<=0 → context null → 状态栏 detail 无 token 段", async () => {
    seedStores();
    getUsageMock.mockResolvedValue({
      usage: { ...USAGE, contextUsage: { tokens: 57000, contextWindow: 0, percent: 5.7 } },
    });
    const c = await render(createElement(StatusBar, { sessionId: S }));
    const detail = c.querySelector('[data-testid="status-detail"]');
    expect(detail?.textContent).not.toContain("57.0k");
    expect(detail?.textContent).not.toContain("上下文");
  });

  test("failure 面（环）：context null → toUsageStats context=null，组件数据源整环隐藏等价", async () => {
    seedStores();
    const { toUsageStats } = await import("@/components/chat/status-bar-data");
    const stats = toUsageStats({ ...USAGE, contextUsage: { tokens: 57000, contextWindow: 0, percent: 5.7 } });
    expect(stats.context).toBeNull();
  });
});
