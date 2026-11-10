// 未知斜杠命令按普通文本发送：斜杠下拉激活期间回车不再无条件吃掉——仅用户已用
// ↑/↓ 明确导航过高亮后回车才确认命令；未导航（默认高亮首项未动过）回车冒泡走
// 正常发送路径，原文经 api.prompt 发出。createRoot 真实交互（composer-mobile-layout
// 惯例），api 层 vi.spyOn 桩，无网络。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("@/components/composer/composer");
const { useSessionsStore } = await import("@/stores/sessions");
const { useMessagesStore } = await import("@/stores/messages");
const { useUiStore } = await import("@/stores/ui");
const apiMod = await import("@/lib/api");

const PROJECT = "/p";
const SID = "qa-slash-enter";

function seedProject(): void {
  useSessionsStore.setState({
    byProject: {
      [PROJECT]: [
        {
          id: SID,
          path: `/store/sessions/${SID}.jsonl`,
          project: PROJECT,
          title: SID,
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
        },
      ],
    },
    selectedId: SID,
    allMode: false,
  });
}

async function renderLive() {
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

async function typeText(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // 斜杠取数 effect 的 promise 落地后再继续（下拉数据就绪）
  await act(async () => {
    await Promise.resolve();
  });
}

async function pressEnter(textarea: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function promptText(spy: ReturnType<typeof vi.spyOn>): string {
  return (spy.mock.calls[0]?.[1] as { text: string } | undefined)?.text ?? "";
}

beforeEach(() => {
  useMessagesStore.setState({ bySession: {} });
  useUiStore.setState({ toast: null });
  seedProject();
  vi.spyOn(apiMod.api, "getCommands").mockResolvedValue({
    project: PROJECT,
    available: true,
    commands: { extension: [{ name: "init", source: "engine", description: "" }], skill: [], prompt: [] },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("未知斜杠命令回车按普通文本发送", () => {
  test("无匹配 token（/notacommand 测试）回车：原文走 api.prompt，不进命令分支", async () => {
    const promptSpy = vi.spyOn(apiMod.api, "prompt").mockResolvedValue({
      disposition: "sent",
    } as unknown as Awaited<ReturnType<typeof apiMod.api.prompt>>);
    const view = await renderLive();
    try {
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]');
      expect(textarea).not.toBeNull();
      await typeText(textarea!, "/notacommand 测试");
      await pressEnter(textarea!);
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptText(promptSpy)).toBe("/notacommand 测试");
    } finally {
      await view.unmount();
    }
  });

  test("下拉有候选但未导航（/in 默认高亮未动）回车：原文发送，不替换 token", async () => {
    const promptSpy = vi.spyOn(apiMod.api, "prompt").mockResolvedValue({
      disposition: "sent",
    } as unknown as Awaited<ReturnType<typeof apiMod.api.prompt>>);
    const view = await renderLive();
    try {
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]');
      expect(textarea).not.toBeNull();
      await typeText(textarea!, "/in");
      await pressEnter(textarea!);
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptText(promptSpy)).toBe("/in");
    } finally {
      await view.unmount();
    }
  });

  test("下拉有候选且已 ↓ 导航后回车：确认命令替换 token（/init ），不发送", async () => {
    const promptSpy = vi.spyOn(apiMod.api, "prompt").mockResolvedValue({
      disposition: "sent",
    } as unknown as Awaited<ReturnType<typeof apiMod.api.prompt>>);
    const view = await renderLive();
    try {
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]');
      expect(textarea).not.toBeNull();
      await typeText(textarea!, "/in");
      await act(async () => {
        textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      });
      await pressEnter(textarea!);
      expect(promptSpy).not.toHaveBeenCalled();
      expect((textarea as HTMLTextAreaElement).value).toBe("/init ");
    } finally {
      await view.unmount();
    }
  });
});
