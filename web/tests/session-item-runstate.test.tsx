/**
 * 状态点权威链测试（docs08-r6 任务 11）：SSE runStates > 服务端行 runState（GET /api/sessions
 * 下发，水合探询/列表刷新携带——提问回合刷新页面即显 waiting 不闪 idle）> 引擎探询 active。
 * 场景走真实组件（happy-dom + react-dom/client，session-item-compact.test.tsx 同款基建）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

// vitest 单文件独立 worker，双注册防御与 bun 单进程先例同形（session-item-compact 同款）
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { SessionItem } = await import("@/components/session-list/session-item");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");

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

let mountedRoot: { unmount(): void } | null = null;

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

/** 行内状态点（size-1.5 圆点 span）的类列表 */
function dotClasses(container: HTMLElement): string[] {
  const dot = [...container.querySelectorAll("span")].find((s) => s.className.includes("size-1.5"));
  expect(dot).toBeDefined();
  return dot!.className.split(/\s+/).filter(Boolean);
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
  document.body.innerHTML = "";
});

describe("状态点权威链（SSE runStates > 行级 runState > active）", () => {
  test("水合窗口兜底：刷新后未见 SSE 帧时，行级 waiting 直接琥珀显示（不闪 idle）", async () => {
    const container = await mount(
      createElement(SessionItem, {
        session: makeSession("s-wait", { runState: "waiting", active: true }),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    // store runStates 空（页面刚刷新，SSE 未回放）——行级 runState（水合探询携带）直接生效
    expect(useSessionsStore.getState().runStates).toEqual({});
    expect(dotClasses(container)).toContain("bg-amber-500");
  });

  test("SSE 权威压过行级：runStates 有值时行级 runState 不参与", async () => {
    useSessionsStore.setState({ runStates: { "s-run": "running" } });
    const container = await mount(
      createElement(SessionItem, {
        session: makeSession("s-run", { runState: "waiting", active: true }),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    expect(dotClasses(container)).toContain("bg-sky-500");
  });

  test("行级缺席回退 active=true → running（旧兜底保留）；idle 行保持灰", async () => {
    const container = await mount(
      createElement(SessionItem, {
        session: makeSession("s-legacy", { active: true }),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    expect(dotClasses(container)).toContain("bg-sky-500");

    const idleContainer = await mount(
      createElement(SessionItem, {
        session: makeSession("s-idle", { runState: "idle", active: false }),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    const idle = dotClasses(idleContainer);
    expect(idle).toContain("bg-muted-foreground/30");
    expect(idle).not.toContain("bg-sky-500");
    expect(idle).not.toContain("bg-amber-500");
  });
});
