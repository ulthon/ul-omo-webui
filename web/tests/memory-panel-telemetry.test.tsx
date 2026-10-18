// 记忆页签遥测卡组件测试（docs08-r5 任务 14）：
// - 库存在：头部状态卡渲染四项硬数据（今日条数/库总量/文件数/最近落条/system 文件体积）+ 库路径
// - 库缺失（telemetry=null）：不渲染卡片，既有诚实空态"该项目尚无记忆库"保留
// - 库存在但零条目：卡片渲染诚实零值，"该目录暂无记忆条目"空态保留
// api 层 mock fetch（session-dialogs.test.tsx 同款风格）；走真实组件（happy-dom + createRoot）。
import { afterEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { MemoryPanel } = await import("@/components/chat/memory-panel");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;
const PROJECT = "/tmp/task14-qa/proj";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** MemoryFactsResponse 构造（契约字段齐备，覆盖项按用例传） */
function memoryBody(overrides: Record<string, unknown>): unknown {
  return {
    project: PROJECT,
    libraryId: "proj-12345678",
    libraryPath: "/mem/agents/proj-12345678",
    exists: true,
    facts: [],
    system: [],
    telemetry: null,
    ...overrides,
  };
}

async function renderPanel(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(MemoryPanel, { sessionId: null }));
  });
  return container;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
  useUiStore.setState({ currentProject: null });
});

describe("记忆页签遥测卡（docs08-r5 任务 14）", () => {
  test("库存在：状态卡渲染四项硬数据 + 库路径", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/memory/facts?project=${encodeURIComponent(PROJECT)}`);
      return okJson(
        memoryBody({
          facts: [{ file: "2026-10.md", description: null, entries: ["一", "二", "三", "四", "五"] }],
          telemetry: {
            todayCount: 2,
            totalEntries: 5,
            fileCount: 3,
            lastEntryAt: new Date().toISOString(),
            systemBytes: 3276,
          },
        }),
      );
    }) as typeof fetch;
    useUiStore.setState({ currentProject: PROJECT });

    const container = await renderPanel();
    const card = container.querySelector('[data-testid="memory-telemetry"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector('[data-testid="memory-telemetry-today"]')?.textContent).toContain("今日 2 条");
    expect(card?.querySelector('[data-testid="memory-telemetry-total"]')?.textContent).toContain("库 5 条");
    expect(card?.querySelector('[data-testid="memory-telemetry-files"]')?.textContent).toContain("3 个文件");
    // lastEntryAt 为当前时间 → 刚刚；system 3276B → 3.2K（CLI 同风格一位小数）
    expect(card?.querySelector('[data-testid="memory-telemetry-last"]')?.textContent).toContain("最近落条 刚刚");
    expect(card?.querySelector('[data-testid="memory-telemetry-system"]')?.textContent).toContain(
      "system 文件体积 3.2K",
    );
    expect(card?.textContent).toContain("库路径：/mem/agents/proj-12345678");
    // 条目列表照常渲染
    expect(container.querySelectorAll('[data-testid="memory-fact-entry"]').length).toBe(5);
  });

  test("库缺失（telemetry=null）：不渲染卡片，诚实空态保留", async () => {
    globalThis.fetch = (async () =>
      okJson(memoryBody({ exists: false, libraryPath: "/mem/agents/proj-12345678" }))) as typeof fetch;
    useUiStore.setState({ currentProject: PROJECT });

    const container = await renderPanel();
    expect(container.querySelector('[data-testid="memory-telemetry"]')).toBeNull();
    expect(container.querySelector('[data-testid="memory-empty-library"]')).not.toBeNull();
    expect(container.textContent).toContain("该项目尚无记忆库");
  });

  test("库存在但零条目：卡片渲染诚实零值，零条目空态保留", async () => {
    globalThis.fetch = (async () =>
      okJson(
        memoryBody({
          telemetry: { todayCount: 0, totalEntries: 0, fileCount: 0, lastEntryAt: null, systemBytes: 0 },
        }),
      )) as typeof fetch;
    useUiStore.setState({ currentProject: PROJECT });

    const container = await renderPanel();
    const card = container.querySelector('[data-testid="memory-telemetry"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector('[data-testid="memory-telemetry-today"]')?.textContent).toContain("今日 0 条");
    expect(card?.querySelector('[data-testid="memory-telemetry-last"]')?.textContent).toContain("—");
    expect(container.querySelector('[data-testid="memory-empty-entries"]')).not.toBeNull();
    expect(container.textContent).toContain("该目录暂无记忆条目");
  });
});
