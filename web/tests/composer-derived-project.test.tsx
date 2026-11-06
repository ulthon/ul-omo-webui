// 发送域项目源派生（会话根架构 W1 任务 2）：composer 的项目 = 选中会话派生
// （useActiveProject：selectedId + byProject 反查）。锁定三条行为：
// (a) 斜杠取数 getCommands(project) 用派生项目；
// (b) 输入历史 list/appendInputHistory 用派生项目（按项目共享的历史产品语义本身不变，仅来源切换）；
// (c) stale_state 防御：byProject 整替后选中会话落空 → 派生 null → @ 选择器防御门关闭、
//     斜杠不取数（发送钮 canSend 门本就不含 project，按契约原样保留）。
// 惯例：happy-dom 全局注册 + createRoot/act 真实交互（buoyant-send 同款），api 层
// vi.spyOn 桩，无网络、无定时器轮询（等待一律 vi.waitFor 有界轮询）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("@/components/composer/composer");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");
const { useMessagesStore } = await import("@/stores/messages");
const apiMod = await import("@/lib/api");

const PROJECT = "/proj-a";
const OTHER = "/proj-b";
const SID = "qa-derived-1";
const REAL_MATCH_MEDIA = window.matchMedia.bind(window);

function makeSession(id: string, project: string): SessionListItem {
  return {
    id,
    path: `${project}/${id}.jsonl`,
    project,
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
  };
}

/** 桌面档 matchMedia（happy-dom 环境确定性）：AnchoredPanel/移动档判定读取 */
window.matchMedia = ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

function commandsResponse(project: string): Awaited<ReturnType<typeof apiMod.api.getCommands>> {
  return {
    project,
    available: true,
    commands: {
      extension: [{ name: "review", source: "engine", description: "审查当前变更" }],
      skill: [],
      prompt: [],
    },
  } as Awaited<ReturnType<typeof apiMod.api.getCommands>>;
}

function resetStores(): void {
  useSessionsStore.setState({ byProject: {}, runStates: {}, runStateAt: {}, appliedModels: {}, selectedId: null });
  useMessagesStore.setState({ bySession: {} });
  useUiStore.setState({ toast: null });
  useSessionsStore.setState({ byProject: { [PROJECT]: [makeSession(SID, PROJECT)] }, selectedId: SID });
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.matchMedia = REAL_MATCH_MEDIA;
  document.body.innerHTML = "";
  resetStores();
});

async function mountComposer(): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(Composer, {
        sessionId: SID,
        queueAvailable: false,
        permissionLocked: false,
        hydrationLocked: false,
        onSent: () => {},
        onAborted: () => {},
      }),
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function typeInto(container: HTMLElement, text: string): Promise<void> {
  const input = container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]');
  expect(input).not.toBeNull();
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, text);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(container: HTMLElement, testid: string): Promise<void> {
  const el = container.querySelector<HTMLElement>(`[data-testid=${testid}]`);
  expect(el).not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("composer 发送域项目源 = 选中会话派生（会话根架构 W1 任务 2）", () => {
  test("(a) 斜杠取数跟随派生项目", async () => {
    const getCommands = vi.spyOn(apiMod.api, "getCommands").mockResolvedValue(commandsResponse(PROJECT));
    const { container, unmount } = await mountComposer();
    try {
      await typeInto(container, "/");
      await vi.waitFor(() => expect(getCommands).toHaveBeenCalledWith(PROJECT));
      expect(getCommands.mock.calls.every((c) => c[0] === PROJECT)).toBe(true);
      // 派生项目下发的命令渲染进面板（happy-dom 桌面档：面板入 container/document 树）
      await vi.waitFor(() => expect(document.querySelector('[data-testid="slash-hints"]')).not.toBeNull());
      expect(document.querySelector('[data-testid="slash-hints"]')!.textContent).toContain("review");
    } finally {
      await unmount();
    }
  });

  test("(b1) 历史取数跟随派生项目：openHistory 拉取并回填首条", async () => {
    const listInputHistory = vi.spyOn(apiMod.api, "listInputHistory").mockResolvedValue({
      project: PROJECT,
      items: [{ id: 1, projectPath: PROJECT, content: "派生项目的旧条目", createdAt: "" }],
    } as Awaited<ReturnType<typeof apiMod.api.listInputHistory>>);
    const { container, unmount } = await mountComposer();
    try {
      await click(container, "history-btn");
      await vi.waitFor(() => expect(listInputHistory).toHaveBeenCalledWith(PROJECT, 200));
      expect(listInputHistory.mock.calls.every((c) => c[0] === PROJECT)).toBe(true);
      await vi.waitFor(() => expect(document.querySelector('[data-testid="history-bar"]')).not.toBeNull());
      expect(document.querySelector('[data-testid="history-bar"]')!.textContent).toContain("派生项目的旧条目");
    } finally {
      await unmount();
    }
  });

  test("(b2) 发送后历史追加跟随派生项目", async () => {
    vi.spyOn(apiMod.api, "prompt").mockResolvedValue({
      disposition: "sent",
      streaming: false,
    } as unknown as Awaited<ReturnType<typeof apiMod.api.prompt>>);
    const appendInputHistory = vi.spyOn(apiMod.api, "appendInputHistory").mockResolvedValue({
      ok: true,
      items: [],
    } as Awaited<ReturnType<typeof apiMod.api.appendInputHistory>>);
    const { container, unmount } = await mountComposer();
    try {
      await typeInto(container, "派生项目消息");
      await click(container, "send-btn");
      await vi.waitFor(() => expect(appendInputHistory).toHaveBeenCalledWith(PROJECT, "派生项目消息"));
      expect(appendInputHistory.mock.calls.every((c) => c[0] === PROJECT)).toBe(true);
    } finally {
      await unmount();
    }
  });

  test("(c) stale_state：byProject 整替选中落空 → 派生 null → @ 门关闭、斜杠不取数", async () => {
    const getCommands = vi.spyOn(apiMod.api, "getCommands").mockResolvedValue(commandsResponse(PROJECT));
    const { container, unmount } = await mountComposer();
    try {
      const atBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="at-btn"]');
      expect(atBtn()).not.toBeNull();
      expect(atBtn()!.disabled).toBe(false);
      // 整替：选中会话所属分组消失（Selection 未清），派生瞬时落空
      await act(async () => {
        useSessionsStore.setState({ byProject: {} });
      });
      expect(atBtn()!.disabled).toBe(true);
      await typeInto(container, "/");
      await act(async () => {});
      expect(getCommands).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });
});
