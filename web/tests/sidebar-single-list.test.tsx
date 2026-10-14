/**
 * 侧栏单列表回归测试（W3 todo 10）：
 * - buildForkIndexes：fork 编号 = 同父兄弟按 sessionPath 升序的 1..N 位次，
 *   输入顺序打乱 / 重复调用结果稳定（列表加载时一次算好缓存的契约）
 * - SessionItem：fork 行徽标 GitFork + "fork"、标题后缀「(fork #N)」；人工行不显来源徽标
 *   （docs08-r3 C14 删「人工」分支）
 * - 子会话行内展开/收起（knownChildren 免请求；缺省走懒加载 archived=all 按血缘过滤），
 *   展开/收起均为瞬态（无持久化副作用）
 * - SessionList：human/all 分段控件删除（唯一列表口径），工具条 批量/归档/标签
 *   whitespace-nowrap + shrink-0（390px 单行锚点的类级断言）
 * 场景走真实组件（happy-dom + react-dom/client，session-dialogs.test.tsx 同款基建），
 * api 层 mock fetch。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

// bun test 单进程跑多文件：session-dialogs.test.tsx 可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { buildForkIndexes, SessionItem } = await import("@/components/session-list/session-item");
const { SessionList } = await import("@/components/session-list/session-list");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;

const PARENT_PATH = "/store/p1.jsonl";

function makeSession(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    path: `/store/${id}.jsonl`,
    project: "/p1",
    title: id,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
    ...overrides,
  };
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch;
}

let mountedRoot: { unmount(): void } | null = null;

/** 挂载组件并落 DOM，返回容器（根句柄登记到模块级，afterEach 统一卸载） */
async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  mountedRoot = root;
  return container;
}

function buttonsOf(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll("button")];
}

function findButton(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return buttonsOf(root).find((b) => b.textContent?.trim() === label);
}

/** 静态微任务排空（懒加载 fetch 已 mock、同步 resolve 场景足够） */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

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

describe("buildForkIndexes fork 编号稳定性", () => {
  test("同父兄弟按 sessionPath 升序编号 1..N，输入顺序打乱结果不变", () => {
    const f1 = makeSession("f1", { path: "/store/b-fork.jsonl", parentSessionPath: PARENT_PATH });
    const f2 = makeSession("f2", { path: "/store/a-fork.jsonl", parentSessionPath: PARENT_PATH });
    const f3 = makeSession("f3", { path: "/store/c-fork.jsonl", parentSessionPath: PARENT_PATH });
    const forward = buildForkIndexes([f1, f2, f3]);
    const shuffled = buildForkIndexes([f3, f1, f2]);
    expect(forward.get("/store/a-fork.jsonl")).toBe(1);
    expect(forward.get("/store/b-fork.jsonl")).toBe(2);
    expect(forward.get("/store/c-fork.jsonl")).toBe(3);
    expect([...shuffled.entries()].sort()).toEqual([...forward.entries()].sort());
  });

  test("不同父各自独立编号；非 fork 会话不进表；重复调用结果一致（跨渲染确定性）", () => {
    const otherParent = "/store/p2.jsonl";
    const sessions = [
      makeSession("top"),
      makeSession("fa", { path: "/store/x-fork.jsonl", parentSessionPath: PARENT_PATH }),
      makeSession("fb", { path: "/store/y-fork.jsonl", parentSessionPath: otherParent }),
    ];
    const map1 = buildForkIndexes(sessions);
    const map2 = buildForkIndexes(sessions);
    expect(map1.get("/store/x-fork.jsonl")).toBe(1);
    expect(map1.get("/store/y-fork.jsonl")).toBe(1);
    expect(map1.has("/store/top.jsonl")).toBe(false);
    expect([...map1.entries()]).toEqual([...map2.entries()]);
  });

  test("无 fork 会话 → 空表", () => {
    expect(buildForkIndexes([makeSession("a"), makeSession("b")]).size).toBe(0);
  });
});

describe("SessionItem 来源徽标与 fork 后缀", () => {
  test("fork 行：GitFork 图标 + fork 文本徽标，标题带 (fork #N) 后缀", async () => {
    const fork = makeSession("fork-row", { parentSessionPath: PARENT_PATH, title: "演示父会话" });
    const forkIndexes = new Map([[fork.path, 2]]);
    const container = await mount(
      createElement(SessionItem, { session: fork, forkIndexes, expandable: false, onDialog: () => {}, onChanged: () => {} }),
    );
    const badge = [...container.querySelectorAll("span")].find((s) => s.textContent?.trim() === "fork");
    expect(badge).toBeDefined();
    expect(badge?.querySelector("svg.lucide-git-fork")).toBeDefined();
    expect(container.textContent).toContain("演示父会话 (fork #2)");
  });

  test("人工行：无来源徽标（docs08-r3 C14），无后缀", async () => {
    const container = await mount(
      createElement(SessionItem, { session: makeSession("human-row", { title: "人工会话" }), expandable: false, onDialog: () => {}, onChanged: () => {} }),
    );
    const badge = [...container.querySelectorAll("span")].find((s) => s.textContent?.trim() === "人工");
    expect(badge).toBeUndefined();
    expect(container.querySelector("svg.lucide-user")).toBeNull();
    expect(container.textContent).not.toContain("(fork #");
  });

  test("编号表缺省：fork 行仍显示 fork 徽标但不显示后缀", async () => {
    const fork = makeSession("orphan-fork", { parentSessionPath: PARENT_PATH, title: "无编号 fork" });
    const container = await mount(
      createElement(SessionItem, { session: fork, expandable: false, onDialog: () => {}, onChanged: () => {} }),
    );
    expect([...container.querySelectorAll("span")].some((s) => s.textContent?.trim() === "fork")).toBe(true);
    expect(container.textContent).not.toContain("(fork #");
  });
});

describe("SessionItem 行内展开/收起（瞬态）", () => {
  test("knownChildren：初始不渲染子行，点 chevron 展开、再点收起，全程零请求", async () => {
    let fetchCalls = 0;
    mockFetch(async () => {
      fetchCalls += 1;
      return okJson({ project: "/p1", archived: "all", sessions: [] });
    });
    const child1 = makeSession("c1", { parentSessionPath: "/store/parent.jsonl", title: "子会话一" });
    const child2 = makeSession("c2", { path: "/store/a-c2.jsonl", parentSessionPath: "/store/parent.jsonl", title: "子会话二" });
    const parent = makeSession("parent", { path: "/store/parent.jsonl", title: "父会话" });
    const forkIndexes = new Map([
      [child1.path, 2],
      [child2.path, 1],
    ]);
    const container = await mount(
      createElement(SessionItem, {
        session: parent,
        forkIndexes,
        knownChildren: [child1, child2],
        expandable: true,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    expect(container.textContent).not.toContain("子会话一");
    const chevron = container.querySelector<HTMLButtonElement>('button[aria-label="展开子会话"]');
    expect(chevron).toBeDefined();
    await act(async () => {
      chevron?.click();
      await flush();
    });
    expect(container.textContent).toContain("子会话二 (fork #1)");
    expect(container.textContent).toContain("子会话一 (fork #2)");
    expect(fetchCalls).toBe(0);
    const collapse = container.querySelector<HTMLButtonElement>('button[aria-label="收起子会话"]');
    await act(async () => {
      collapse?.click();
      await flush();
    });
    expect(container.textContent).not.toContain("子会话一");
  });

  test("无 knownChildren：首次展开走懒加载（archived=all），按 parentSessionPath 过滤渲染", async () => {
    const parent = makeSession("lazy-parent", { path: "/store/lazy-parent.jsonl", title: "懒加载父会话" });
    const requested: string[] = [];
    mockFetch(async (input) => {
      const url = String(input);
      requested.push(url);
      const mine = [
        makeSession("lc1", { path: "/store/lc1.jsonl", parentSessionPath: parent.path, title: "懒子会话" }),
        makeSession("lc2", { path: "/store/lc2.jsonl", parentSessionPath: "/store/别的父.jsonl", title: "别家子会话" }),
      ];
      return okJson({ project: "/p1", archived: "all", sessions: mine });
    });
    const container = await mount(
      createElement(SessionItem, { session: parent, expandable: true, onDialog: () => {}, onChanged: () => {} }),
    );
    const chevron = container.querySelector<HTMLButtonElement>('button[aria-label="展开子会话"]');
    await act(async () => {
      chevron?.click();
      await flush();
    });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("project=%2Fp1");
    expect(requested[0]).toContain("archived=all");
    expect(container.textContent).toContain("懒子会话");
    expect(container.textContent).not.toContain("别家子会话");
  });
});

describe("SessionList 工具条单列表（分段控件删除 + no-wrap）", () => {
  function seedAggregateResponse(): SessionListItem[] {
    return [
      makeSession("p1", { path: PARENT_PATH, title: "父会话", modified: "2026-01-05T00:00:00.000Z" }),
      makeSession("fa", { path: "/store/a-fork.jsonl", parentSessionPath: PARENT_PATH, title: "父会话" }),
      makeSession("fb", { path: "/store/b-fork.jsonl", parentSessionPath: PARENT_PATH, title: "父会话" }),
    ];
  }

  async function mountSessionList(): Promise<HTMLElement> {
    mockFetch(async (input) => {
      const url = String(input);
      if (url.includes("/api/sessions")) {
        return okJson({ project: null, archived: "false", sessions: seedAggregateResponse() });
      }
      if (url.includes("/api/tags")) return okJson({ global: [], project: [] });
      return okJson({ ok: true });
    });
    useUiStore.setState({
      currentProject: "/p1",
      projects: [{ projectPath: "/p1", preferredModel: null, lastOpenedAt: "2026-01-05T00:00:00.000Z" }],
    });
    return mount(createElement(SessionList));
  }

  test("human/all 分段控件不再渲染；批量/归档/标签按钮 whitespace-nowrap + shrink-0", async () => {
    const container = await mountSessionList();
    await act(async () => {
      await flush();
    });
    expect(findButton(container, "人工")).toBeUndefined();
    expect(findButton(container, "全部活动")).toBeUndefined();
    for (const label of ["批量", "未归档", "标签"]) {
      const btn = findButton(container, label);
      expect(btn).toBeDefined();
      expect(btn?.className).toContain("whitespace-nowrap");
      expect(btn?.className).toContain("shrink-0");
    }
  });

  test("fork 编号集成：最近区 fork 行带 (fork #N) 后缀与 fork 徽标", async () => {
    const container = await mountSessionList();
    await act(async () => {
      await flush();
    });
    expect(container.textContent).toContain("(fork #1)");
    expect(container.textContent).toContain("(fork #2)");
    expect(container.querySelectorAll("svg.lucide-git-fork").length).toBeGreaterThanOrEqual(2);
  });
});
