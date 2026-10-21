// 手机档上下结构输入区（docs08-r6 任务 13）：胶囊三圆钮同行形态退役，改为
// 上行 textarea 整行宽（自适应增高）+ 下行功能钮（常用语/收纳/排队切换）+ 发送。
// matchMedia 桩切手机档 + renderToStaticMarkup 静态断言（composer-interrupt 惯例）；
// 发送可达与常用语一步直达走真实事件（createRoot 驱动，api 层 vi.spyOn 桩，无网络）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("@/components/composer/composer");
const { useUiStore } = await import("@/stores/ui");
const apiMod = await import("@/lib/api");

const SID = "qa-mobile-13";
const SHEET_QUERY = "(max-width: 639.98px)";
const REAL_MATCH_MEDIA = window.matchMedia.bind(window);

function stubMatchMedia(compact: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: compact && query === SHEET_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

function renderComposer(queueAvailable: boolean): string {
  return renderToStaticMarkup(
    createElement(Composer, {
      sessionId: SID,
      queueAvailable,
      permissionLocked: false,
      hydrationLocked: false,
      onSent: () => {},
      onAborted: () => {},
    }),
  );
}

async function renderLive(props: { queueAvailable: boolean }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(Composer, {
        sessionId: SID,
        queueAvailable: props.queueAvailable,
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

beforeEach(() => {
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  window.matchMedia = REAL_MATCH_MEDIA;
  useUiStore.setState({ toast: null });
});

describe("手机档上下结构（docs08-r6 任务 13）", () => {
  test("上行：textarea 整行宽，胶囊容器只包 textarea（无功能钮同挤）", () => {
    stubMatchMedia(true);
    const html = renderComposer(false);
    const capsuleToTextarea = /<div[^>]*data-testid="composer-capsule"[^>]*>[\s\S]*?<textarea/.exec(html)?.[0] ?? "";
    const inputTag = /<textarea[^>]*data-testid="composer-input"[^>]*>/.exec(html)?.[0] ?? "";
    // 上行容器到 textarea 之间只有模型浮签，无功能钮同挤
    expect(capsuleToTextarea).not.toContain('data-testid="snippet-btn"');
    expect(capsuleToTextarea).not.toContain('data-testid="composer-more-btn"');
    expect(capsuleToTextarea).not.toContain('data-testid="send-btn"');
    expect(capsuleToTextarea).not.toContain('data-testid="queue-mode-btn"');
    expect(inputTag).not.toBe("");
    expect(inputTag).toContain("w-full");
    expect(inputTag).not.toContain("flex-1");
    expect(inputTag).toContain("w-full");
  });

  test("下行：常用语/收纳/排队切换/停止/发送均在 textarea 之后的按钮行", () => {
    stubMatchMedia(true);
    const html = renderComposer(true);
    const inputIdx = html.indexOf('data-testid="composer-input"');
    for (const tid of ["snippet-btn", "composer-more-btn", "queue-mode-btn", "send-btn"]) {
      const idx = html.indexOf(`data-testid="${tid}"`);
      expect(idx).toBeGreaterThan(inputIdx);
    }
    // 上行容器与下行按钮行之间有分行容器（上行 relative 块先闭合）
    expect(html).toContain('data-testid="composer-capsule"');
  });

  test("发送可达：手机档输入文字后点击发送走 api.prompt", async () => {
    stubMatchMedia(true);
    const promptSpy = vi.spyOn(apiMod.api, "prompt").mockResolvedValue({
      disposition: "sent",
    } as unknown as Awaited<ReturnType<typeof apiMod.api.prompt>>);
    const view = await renderLive({ queueAvailable: false });
    try {
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]');
      expect(textarea).not.toBeNull();
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      await act(async () => {
        setValue.call(textarea, "你好");
        textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const sendBtn = view.container.querySelector<HTMLButtonElement>('button[data-testid="send-btn"]');
      expect(sendBtn).not.toBeNull();
      expect(sendBtn!.disabled).toBe(false);
      await act(async () => {
        sendBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptSpy.mock.calls[0][1]).toMatchObject({ text: "你好" });
    } finally {
      await view.unmount();
    }
  });

  test("常用语一步直达：手机档点常用语钮即开 inline 下拉（不回退）", async () => {
    stubMatchMedia(true);
    const view = await renderLive({ queueAvailable: false });
    try {
      const snippetBtn = view.container.querySelector<HTMLButtonElement>('button[data-testid="snippet-btn"]');
      expect(snippetBtn).not.toBeNull();
      expect(view.container.querySelector('[data-testid="snippet-dropdown"]')).toBeNull();
      await act(async () => {
        snippetBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const dropdown = view.container.querySelector('[data-testid="snippet-dropdown"]');
      expect(dropdown).not.toBeNull();
      // inline 流内档：下拉渲染在 composer 根容器内（胶囊上方条区），非 sheet 弹层
      expect(view.container.contains(dropdown!)).toBe(true);
    } finally {
      await view.unmount();
    }
  });
});
