// 成本全景卡组件层用例（docs08 2026-10-22 批次任务 9，GAP-11 4⑪）：
// - 新块渲染：成本区「累计/今日」双数字 + 按模型拆分降序；命中率行；末回合 tok/s；
//   耗时估算区（模型/工具）；子代理逐个花费 + 合计行；
// - regression：既有行不漂移（tokens 分项、stat-cost-value 仍为累计快照值）；
// - fallback：usage 数据缺失（空 usage + 无条目）→ 累计/今日 零值非 NaN，
//   耗时/子代理/末回合区块整体隐藏（缺数据行省略口径）。
// 渲染走真实组件（happy-dom + createRoot，usage-token-surfaces 同款）；
// api.getUsage 打桩喂快照、messages store 直注 entries（无网络无新拉取）。
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const getUsageMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, getUsage: (...args: unknown[]) => getUsageMock(...args) } };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { StatPanel } = await import("@/components/chat/stat-panel");
const { useMessagesStore } = await import("@/stores/messages");
import { useSessionsStore } from "@/stores/sessions";
import { useLocaleStore } from "@/i18n/i18n";
import { startOfTodayMs } from "@/components/chat/stat-panel-data";
import type { WireEntry } from "@/lib/api";

const S = "s-panorama";
// 确定性时钟：只 fake Date（计时器保持真实），组件内 usageAt=Date.now() 与 fixture 同源
const FIXED_NOW = startOfTodayMs(new Date().getTime()) + 12 * 3_600_000; // 当天本地 12:00
const TODAY_MS = FIXED_NOW - 10 * 3_600_000; // 当天本地 02:00
vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
afterAll(() => {
  vi.useRealTimers();
});
const iso = (ms: number): string => new Date(ms).toISOString();

const USAGE = {
  tokens: { input: 40000, output: 7000, cacheRead: 9000, cacheWrite: 1000, total: 57000 },
  cost: 1.5,
  contextUsage: { tokens: 57000, contextWindow: 1_000_000, percent: 5.7 },
  turnSpeed: { turns: [{ tokPerSec: 45.6, endedAt: iso(TODAY_MS) }], averageTokPerSec: 45.6 },
};

function assistantEntry(opts: { id: string; tsMs: number; cost: number; model: string; toolCallIds?: string[] }): WireEntry {
  return {
    type: "message",
    id: opts.id,
    timestamp: iso(opts.tsMs),
    message: {
      role: "assistant",
      model: opts.model,
      timestamp: opts.tsMs,
      content: [
        { type: "text", text: "ok" },
        ...(opts.toolCallIds ?? []).map((id) => ({ type: "toolCall", id, name: "task", arguments: { task_summary: "扫描目录" } })),
      ],
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0.9, output: 0.1, cacheRead: 0, cacheWrite: 0, total: opts.cost } },
    },
  } as WireEntry;
}

function toolResultEntry(opts: { tsMs: number; toolCallId: string }): WireEntry {
  return {
    type: "message",
    id: `r-${opts.toolCallId}`,
    timestamp: iso(opts.tsMs),
    message: {
      role: "toolResult",
      toolCallId: opts.toolCallId,
      timestamp: opts.tsMs,
      content: [{ type: "text", text: "done" }],
      details: { task_id: "st_x1", status: "completed", task_summary: "扫描目录", run_stats: { cost_usd: 0.1486, runtime_ms: 65000 } },
    },
  } as WireEntry;
}

/** 双模型今日花费 + task 子代理（toolCall→toolResult 相差 60s → 工具 1m 0s） */
function panoramaEntries(): WireEntry[] {
  return [
    assistantEntry({ id: "a1", tsMs: TODAY_MS - 120_000, cost: 0.25, model: "glm-5.3-4k" }),
    assistantEntry({ id: "a2", tsMs: TODAY_MS - 60_000, cost: 0.1, model: "glm-4.6v", toolCallIds: ["tc1"] }),
    toolResultEntry({ tsMs: TODAY_MS, toolCallId: "tc1" }),
  ];
}

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

function seedMessages(entries: WireEntry[]): void {
  useLocaleStore.setState({ locale: "zh-CN" });
  useSessionsStore.setState({ runStates: {}, appliedModels: {} });
  useMessagesStore.setState({
    bySession: {
      [S]: {
        entries,
        cursor: null,
        leafId: null,
        loaded: true,
        streaming: false,
        streamingMessage: null,
        streamingEntryId: null,
        toolRuns: {},
        compacting: false,
      },
    },
  });
}

beforeEach(() => {
  vi.setSystemTime(FIXED_NOW);
});

afterEach(async () => {
  for (const unmount of roots) await unmount();
  roots.length = 0;
  getUsageMock.mockReset();
  document.body.innerHTML = "";
});

describe("成本全景卡（docs08 2026-10-22 任务 9）", () => {
  test("新块渲染：累计/今日双数字 + 模型拆分 + 命中率 + 末回合 + 耗时 + 子代理合计", async () => {
    seedMessages(panoramaEntries());
    getUsageMock.mockResolvedValue({ usage: USAGE });
    const c = await render(createElement(StatPanel, { sessionId: S }));
    // 累计/今日双数字（既有行值不漂移：stat-cost-value 仍为快照累计）
    expect(c.querySelector('[data-testid="stat-cost-value"]')?.textContent).toBe("$1.5000");
    expect(c.querySelector('[data-testid="stat-cost-today"]')?.textContent).toBe("$0.3500");
    // 按模型拆分：降序，两行
    const models = c.querySelectorAll('[data-testid="stat-cost-model"]');
    expect(models.length).toBe(2);
    expect(models[0]?.textContent).toContain("glm-5.3-4k");
    expect(models[0]?.textContent).toContain("$0.2500");
    expect(models[1]?.textContent).toContain("glm-4.6v");
    // 命中率 = 9000/57000 → 16%
    expect(c.querySelector('[data-testid="stat-cache-rate"]')?.textContent).toBe("16%");
    // 末回合 tok/s（45.6 <100 保留 1 位小数）
    expect(c.querySelector('[data-testid="stat-speed-last"]')?.textContent).toBe("45.6 tok/s");
    // 耗时估算：a1→a2 后继窗 60s + a2→首结果 60s = 2m 0s；工具 = 配对 60s
    expect(c.querySelector('[data-testid="stat-time-model"]')?.textContent).toContain("2m 0s");
    expect(c.querySelector('[data-testid="stat-time-tool"]')?.textContent).toContain("1m 0s");
    // 子代理逐个花费 + 合计（testid 在数值 span 上，标签经父行断言）
    const subRow = c.querySelector('[data-testid="stat-subagent-cost"]');
    expect(subRow?.textContent).toContain("$0.1486");
    expect(subRow?.parentElement?.textContent).toContain("扫描目录");
    expect(c.querySelector('[data-testid="stat-subagent-total"]')?.textContent).toBe("$0.1486");
    // regression：既有 tokens 行不变
    expect(c.querySelector('[data-testid="stat-tokens-input"]')?.textContent).toBe("40.0k");
    expect(c.querySelector('[data-testid="stat-context-percent"]')?.textContent).toBe("6%");
  });

  test("无子代理 → 子代理区块隐藏（成本区仍在）", async () => {
    seedMessages([assistantEntry({ id: "only", tsMs: TODAY_MS, cost: 0.2, model: "glm-5.3-4k" })]);
    getUsageMock.mockResolvedValue({ usage: USAGE });
    const c = await render(createElement(StatPanel, { sessionId: S }));
    expect(c.querySelector('[data-testid="stat-subagents"]')).toBeNull();
    expect(c.querySelector('[data-testid="stat-cost-today"]')?.textContent).toBe("$0.2000");
    expect(c.querySelectorAll('[data-testid="stat-cost-model"]').length).toBe(1);
  });

  test("fallback：usage 缺失 + 无条目 → 累计/今日零值非 NaN，估算区块隐藏", async () => {
    seedMessages([]);
    getUsageMock.mockResolvedValue({ usage: {} });
    const c = await render(createElement(StatPanel, { sessionId: S }));
    expect(c.querySelector('[data-testid="stat-cost-value"]')?.textContent).toBe("$0.0000");
    expect(c.querySelector('[data-testid="stat-cost-today"]')?.textContent).toBe("$0.0000");
    expect(c.querySelector('[data-testid="stat-cost-model"]')).toBeNull();
    expect(c.querySelector('[data-testid="stat-subagents"]')).toBeNull();
    expect(c.querySelector('[data-testid="stat-time"]')).toBeNull();
    expect(c.querySelector('[data-testid="stat-speed-last"]')).toBeNull();
    expect(c.querySelector('[data-testid="stat-speed-empty"]')).not.toBeNull();
    expect(c.textContent).not.toContain("NaN");
  });
});
