/**
 * 项目组会话默认 10 条 + 加载更多（r9 2026-10-26 批次 wave1 任务 5）：
 * - 15 条组默认只渲染前 10 条，组尾「加载更多（还有 5 个）」按钮
 * - 点击后可见容量 10+20=30 ≥ 15 全显，按钮消失
 * - 批量管理模式全量不截断；搜索模式结果列表全量（分组本就不渲染，锁回归）
 * - stale state 对抗：重挂载（刷新）后回落默认 10；各组可见数按项目键控互不串台
 * 场景走真实组件（happy-dom + react-dom/client，sidebar-single-list.test.tsx 同款基建），
 * api 层 mock fetch。最近区 RECENT_LIMIT 与置顶/排序逻辑不在本文件断言范围。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { SessionList } = await import("@/components/session-list/session-list");
const { GROUP_VISIBLE_LIMIT, GROUP_VISIBLE_STEP } = await import("@/components/session-list/global-list-data");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;

const P1 = "/p1";
const P2 = "/p2";
/** /p1 组 15 条（任务给定基准），/p2 组 12 条（跨组串台检查用） */
const P1_IDS = Array.from({ length: 15 }, (_, i) => `s-${String(i + 1).padStart(2, "0")}`);
const P2_IDS = Array.from({ length: 12 }, (_, i) => `t-${String(i + 1).padStart(2, "0")}`);

function makeSession(id: string, project: string, modified: string): SessionListItem {
  return {
    id,
    path: `${project}/${id}.jsonl`,
    project,
    title: id,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified,
    messageCount: 1,
    firstMessage: id,
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
  };
}

function seedSessions(): SessionListItem[] {
  return [
    ...P1_IDS.map((id, i) => makeSession(id, P1, `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`)),
    ...P2_IDS.map((id, i) => makeSession(id, P2, `2026-02-01T00:${String(i).padStart(2, "0")}:00.000Z`)),
  ];
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

let mountedRoot: { unmount(): void } | null = null;

async function mountSessionList(): Promise<HTMLElement> {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/sessions")) {
      return okJson({ project: null, archived: "false", sessions: seedSessions() });
    }
    if (url.startsWith("/api/tags")) return okJson({ global: [], project: [] });
    return okJson({ ok: true });
  }) as typeof fetch;
  useUiStore.setState({
    currentProject: P1,
    projects: [
      { projectPath: P1, preferredModel: null, lastOpenedAt: "2026-01-01T00:00:00.000Z" },
      { projectPath: P2, preferredModel: null, lastOpenedAt: "2026-01-01T00:00:00.000Z" },
    ],
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SessionList));
  });
  mountedRoot = root;
  return container;
}

/** 静态微任务排空（fetch 已 mock 同步 resolve） */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** 组容器内已渲染的会话标题（id 即标题；最近区在组容器外，不参与统计） */
function shownInGroup(container: HTMLElement, project: string): string[] {
  const text = container.querySelector(`[data-project-group="${project}"]`)?.textContent ?? "";
  const ids = project === P1 ? P1_IDS : P2_IDS;
  return ids.filter((id) => text.includes(id));
}

function loadMoreButton(container: ParentNode, project: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-project-group="${project}"] button[data-testid="group-load-more"]`);
}

/** React 受控输入：原生 setter 写值 + input 事件（直赋 value 不触发 onChange） */
function fillInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    allMode: false,
    selectedId: null,
    loading: false,
    view: "all",
    q: "",
    archived: "false",
    tagFilter: [],
  });
  useUiStore.setState({ currentProject: null, projects: [], models: [] });
});

afterEach(async () => {
  const root = mountedRoot;
  mountedRoot = null;
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  globalThis.fetch = ORIGINAL_FETCH;
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("项目组加载更多（r9 wave1）", () => {
  test("断言 1：15 条组默认渲染 10 条 + 按钮显示还有 5 个", async () => {
    expect(GROUP_VISIBLE_LIMIT).toBe(10);
    const container = await mountSessionList();
    await act(async () => {
      await flush();
    });
    expect(shownInGroup(container, P1)).toHaveLength(10);
    const btn = loadMoreButton(container, P1);
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain("还有 5 个");
  });

  test("断言 2：点击加载更多后容量 30 全显 15 条，按钮消失", async () => {
    expect(GROUP_VISIBLE_LIMIT + GROUP_VISIBLE_STEP).toBe(30);
    const container = await mountSessionList();
    await act(async () => {
      await flush();
    });
    const btn = loadMoreButton(container, P1);
    expect(btn).not.toBeNull();
    await act(async () => {
      btn?.click();
      await flush();
    });
    expect(shownInGroup(container, P1)).toHaveLength(15);
    expect(loadMoreButton(container, P1)).toBeNull();
  });

  test("断言 3a：批量管理模式全量不截断，无加载更多按钮", async () => {
    const container = await mountSessionList();
    await act(async () => {
      await flush();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-testid="batch-toggle"]')?.click();
      await flush();
    });
    // 批量条已出现确认模式生效
    expect(container.querySelector('[data-testid="batch-bar"]')).not.toBeNull();
    expect(shownInGroup(container, P1)).toHaveLength(15);
    expect(loadMoreButton(container, P1)).toBeNull();
  });

  test("断言 3b：搜索激活后结果全量（15 条全出，无分组截断）", async () => {
    const container = await mountSessionList();
    await act(async () => {
      await flush();
    });
    const input = container.querySelector<HTMLInputElement>("input");
    expect(input).not.toBeNull();
    // 搜索入口为既有 250ms 防抖（时间即被测行为）：单次等待覆盖防抖窗口，
    // 随后断言结构确定性（搜索模式接管列表主体，平铺全量结果）
    await act(async () => {
      fillInput(input!, "s-");
      await new Promise((r) => setTimeout(r, 400));
      await flush();
    });
    expect(container.querySelector('[data-testid="recent-section"]')).toBeNull();
    // 搜索模式为平铺结果列表：不再有分组容器与加载更多按钮
    expect(container.querySelector("[data-project-group]")).toBeNull();
    const text = container.textContent ?? "";
    for (const id of P1_IDS) expect(text).toContain(id);
    expect(container.querySelector('button[data-testid="group-load-more"]')).toBeNull();
  });

  test("stale state：重挂载（刷新）后可见数回落默认 10，不残留全展", async () => {
    const container = await mountSessionList();
    await act(async () => {
      await flush();
    });
    await act(async () => {
      loadMoreButton(container, P1)?.click();
      await flush();
    });
    expect(shownInGroup(container, P1)).toHaveLength(15);
    // 重挂载 = 刷新语义：组件内 state 不持久化，回落 GROUP_VISIBLE_LIMIT
    await act(async () => {
      mountedRoot?.unmount();
    });
    document.body.innerHTML = "";
    const container2 = await mountSessionList();
    await act(async () => {
      await flush();
    });
    expect(shownInGroup(container2, P1)).toHaveLength(10);
    expect(loadMoreButton(container2, P1)?.textContent).toContain("还有 5 个");
  });

  test("各组可见数按项目键控互不串台；切项目后键控值保留（会话内覆盖语义）", async () => {
    const container = await mountSessionList();
    await act(async () => {
      await flush();
    });
    // 展开 /p2（非当前组默认折叠）：12 条组默认 10 条 + 还有 2 个
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-project-group="${P2}"] button[data-testid="group-toggle"]`)?.click();
      await flush();
    });
    expect(shownInGroup(container, P2)).toHaveLength(10);
    expect(loadMoreButton(container, P2)?.textContent).toContain("还有 2 个");
    // /p1 加载更多到全显，/p2 不受影响（键控独立，无跨组泄漏）
    await act(async () => {
      loadMoreButton(container, P1)?.click();
      await flush();
    });
    expect(shownInGroup(container, P1)).toHaveLength(15);
    expect(shownInGroup(container, P2)).toHaveLength(10);
    expect(loadMoreButton(container, P2)).not.toBeNull();
    // 切当前项目：P2 成为当前组自动展开（既有分组规则），P1 非当前组自动折叠——
    // 但 P1 的键控可见值保留：重新展开后仍全显 15（而非回落 10），证明未被切换重置，
    // 且 P2 不继承 P1 的加载更多（仍 10 + 还有 2 个）
    await act(async () => {
      useUiStore.setState({ currentProject: P2 });
      await flush();
    });
    expect(shownInGroup(container, P2)).toHaveLength(10);
    expect(loadMoreButton(container, P2)?.textContent).toContain("还有 2 个");
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-project-group="${P1}"] button[data-testid="group-toggle"]`)?.click();
      await flush();
    });
    expect(shownInGroup(container, P1)).toHaveLength(15);
  });
});
