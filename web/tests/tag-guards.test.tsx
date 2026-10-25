/**
 * 标签守卫三件套（docs08 2026-10-23/24 批次任务 10，GAP-4）：
 * - QA1 定义加载失败保 null：SessionList 挂载后 /api/tags 500 → tagDefs 维持 null，
 *   孤儿判定整体跳过（不渲染徽标、无 data-orphan），对照：定义加载成功时孤儿灰显在。
 *   （旧缺陷：失败写空定义集 → 全部挂载误判孤儿，为静默删库铺路）
 * - QA2 管理弹框孤儿清理：两段式确认（点「清理」仅出现确认钮、不发请求；点确认才
 *   整替删除，source 标识随请求下发），成功后行内挂载同步清空。
 * 场景走真实组件（happy-dom + react-dom/client，sidebar-single-list / tags-badge-grid 同款基建）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const setSessionTagsMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, setSessionTags: (...args: unknown[]) => setSessionTagsMock(...args) } };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { SessionList } = await import("@/components/session-list/session-list");
const { TagManageDialog } = await import("@/components/session-list/tag-manage-dialog");
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { useLocaleStore } from "@/i18n/i18n";
import type { SessionListItem } from "@/lib/api";

const ORIGINAL_FETCH = globalThis.fetch;

function makeSession(id: string, tags: Array<{ scope: string; name: string }>): SessionListItem {
  return {
    id,
    path: `/store/${id}.jsonl`,
    project: "/p1",
    title: `会话-${id}`,
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
    tags,
  };
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function failJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 500, headers: { "content-type": "application/json" } });
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

let mountedRoots: Array<{ unmount(): void }> = [];

async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  mountedRoots.push(root);
  return container;
}

beforeEach(() => {
  setSessionTagsMock.mockReset();
  useLocaleStore.setState({ locale: "zh-CN" });
  useUiStore.setState({
    currentProject: "/p1",
    projects: [{ projectPath: "/p1", preferredModel: null, lastOpenedAt: "2026-01-01T00:00:00.000Z" }],
    models: [],
    toast: null,
    tagDisplayMode: "text",
  });
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  globalThis.fetch = ORIGINAL_FETCH;
  localStorage.clear();
  document.body.innerHTML = "";
});

// ------------------------------------------------------- QA1 定义加载失败保 null

describe("SessionList 标签定义加载失败保 null（孤儿判定跳过）", () => {
  test("QA1：/api/tags 500 → 不渲染徽标、无孤儿误判（不写空集整替删除铺路）", async () => {
    const s = makeSession("s1", [{ scope: "global", name: "已删定义" }]);
    useSessionsStore.setState({
      byProject: { "/p1": [s] },
      runStates: {},
      allMode: false,
      selectedId: null,
      loading: false,
      view: "all",
      q: "",
      archived: "false",
      tagFilter: [],
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/tags")) return failJson({ error: { code: "internal", message: "boom" } });
      return okJson({ ok: true });
    }) as typeof fetch;

    const container = await mount(createElement(SessionList));
    await act(async () => {
      await flush();
    });

    // 定义未就绪（tagDefs null → definedKeys null）：徽标整体不渲染，孤儿判定跳过
    expect(container.querySelector('[data-testid="tag-badge"]')).toBeNull();
    expect(container.querySelector('[data-orphan="true"]')).toBeNull();
    expect(container.querySelector('[data-testid="tag-badges"]')).toBeNull();
  });

  test("QA1 对照：定义加载成功 → 孤儿挂载灰显在（判定仍在，只是不点按即删）", async () => {
    const s = makeSession("s1", [{ scope: "global", name: "已删定义" }]);
    useSessionsStore.setState({
      byProject: { "/p1": [s] },
      runStates: {},
      allMode: false,
      selectedId: null,
      loading: false,
      view: "all",
      q: "",
      archived: "false",
      tagFilter: [],
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/tags")) return okJson({ global: [], project: [] });
      return okJson({ ok: true });
    }) as typeof fetch;

    const container = await mount(createElement(SessionList));
    await act(async () => {
      await flush();
    });

    const orphan = container.querySelector('[data-testid="tag-badge"]');
    expect(orphan?.getAttribute("data-orphan")).toBe("true");
    // 点按孤儿徽标不再触发删除（守卫二：清理移入管理弹框）
    await act(async () => {
      orphan?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(setSessionTagsMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------- QA2 管理弹框孤儿清理（两段式确认 + 审计 source）

describe("TagManageDialog 孤儿清理两段式确认", () => {
  test("点「清理」仅进入确认态不发请求；点确认才整替删除并带审计 source", async () => {
    const s = makeSession("s1", [
      { scope: "global", name: "甲" },
      { scope: "global", name: "孤儿标签" },
    ]);
    useSessionsStore.setState({
      byProject: { "/p1": [s] },
      runStates: {},
      tagFilter: [],
    });
    setSessionTagsMock.mockResolvedValue({ tags: [{ scope: "global", name: "甲" }] });

    await mount(
      createElement(TagManageDialog, {
        scope: "global",
        defs: { global: [{ name: "甲", sort: 0 }], project: [] },
        orphanCleanups: [
          {
            sessionId: "s1",
            sessionTitle: "会话-s1",
            orphans: [{ scope: "global", name: "孤儿标签" }],
            keep: [{ scope: "global", name: "甲" }],
          },
        ],
        onChanged: () => {},
        onClose: () => {},
      }),
    );

    // Radix Dialog 传送到 document.body，查询走 body（container 仅挂载锾点）
    const root = document.body;
    // 清理区在，列出孤儿名
    expect(root.querySelector('[data-testid="tag-orphan-cleanup"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="tag-orphan-name"]')?.textContent).toBe("孤儿标签");

    // 第一段：点「清理」→ 出确认钮，不发请求
    const cleanBtn = root.querySelector<HTMLButtonElement>('[data-testid="tag-orphan-clean"]');
    expect(cleanBtn).not.toBeNull();
    await act(async () => {
      cleanBtn?.click();
    });
    expect(setSessionTagsMock).not.toHaveBeenCalled();
    const confirmBtn = root.querySelector<HTMLButtonElement>('[data-testid="tag-orphan-clean-confirm"]');
    expect(confirmBtn).not.toBeNull();

    // 第二段：确认 → 整替去孤儿，source 标识随请求（服务端写审计行用）
    await act(async () => {
      confirmBtn?.click();
    });
    expect(setSessionTagsMock).toHaveBeenCalledTimes(1);
    expect(setSessionTagsMock).toHaveBeenCalledWith(
      "s1",
      [{ scope: "global", name: "甲" }],
      "tag-manage-dialog:orphan-clean",
    );

    // 行内挂载同步清空孤儿
    await act(async () => {
      await flush();
    });
    const patched = useSessionsStore
      .getState()
      .byProject["/p1"]?.find((row) => row.id === "s1");
    expect(patched?.tags).toEqual([{ scope: "global", name: "甲" }]);
  });

  test("无孤儿清单时不渲染清理区", async () => {
    const container = await mount(
      createElement(TagManageDialog, {
        scope: "global",
        defs: { global: [], project: [] },
        onChanged: () => {},
        onClose: () => {},
      }),
    );
    expect(container.querySelector('[data-testid="tag-orphan-cleanup"]')).toBeNull();
  });
});
