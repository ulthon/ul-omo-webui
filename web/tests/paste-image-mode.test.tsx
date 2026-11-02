// 粘贴图片发送方式（任务 20）：系统配置档 composer.pasteImageMode 三档路由 + 图片 chip
// 徽标文案。组件级集成（happy-dom，composer-file-attachments 同款 harness）：
// api 层 vi.spyOn 桩，无真实网络；档位直接置 ui store（bootstrap 读取面另测）。
// 断言口径（机器消费）：路由落点 = images 内联 chip / file-attachment-chip；徽标 =
// data-testid="image-chip-mode" 的实际判定文案。不锁散文措辞以外的结构。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("@/components/composer/composer");
const { useUiStore } = await import("@/stores/ui");
type PasteImageMode = ReturnType<(typeof useUiStore)["getState"]>["pasteImageMode"];
const apiMod = await import("@/lib/api");

const SID = "qa-task20";

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

/** 受控粘贴：绕开 DataTransfer 构造限制，直接给 Event 挂 clipboardData 形状 */
function firePaste(el: HTMLElement, files: File[]): void {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: { files, getData: () => "" },
  });
  el.dispatchEvent(ev);
}

/** 内联链路 readFileAsDataUrl（happy-dom FileReader）异步落定：有界轮询等 chip 出现，
 * 订阅的是真实状态变化而非固定延时（20×0ms 上限，超时即失败不掩不测） */
async function waitForThumb(container: HTMLElement): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      if (container.querySelector('[data-testid="image-thumb"]')) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function pngFile(): File {
  // 1x1 PNG 最小字节（签名足够，走 base64 内联链路不落盘）
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
}

function setMode(mode: PasteImageMode): void {
  useUiStore.setState({ pasteImageMode: mode });
}

beforeEach(() => {
  useUiStore.setState({ pasteImageMode: "auto", toast: null });
});

afterEach(() => {
  useUiStore.setState({ pasteImageMode: "auto", toast: null });
  vi.restoreAllMocks();
});

describe("粘贴图片发送方式（任务 20）：三档路由 + chip 徽标", () => {
  test("auto（缺省）：粘贴图片走内联链路，不出附件 chip，徽标显示内联说明", async () => {
    const uploadSpy = vi.spyOn(apiMod.api, "postBinaryAttachment");
    const view = await renderLive();
    try {
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
      await act(async () => {
        firePaste(textarea, [pngFile()]);
      });
      await waitForThumb(view.container);
      expect(view.container.querySelector('[data-testid="image-thumb"]')).toBeTruthy();
      expect(view.container.querySelector('[data-testid="file-attachment-chip"]')).toBeNull();
      expect(uploadSpy).not.toHaveBeenCalled();
      const badge = view.container.querySelector<HTMLElement>('[data-testid="image-chip-mode"]');
      expect(badge).toBeTruthy();
      expect(badge!.textContent).toBe("将内联发送，视觉模型可见");
    } finally {
      await view.unmount();
    }
  });

  test("inline：强制内联链路，徽标显示内联说明", async () => {
    const uploadSpy = vi.spyOn(apiMod.api, "postBinaryAttachment");
    setMode("inline");
    const view = await renderLive();
    try {
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
      await act(async () => {
        firePaste(textarea, [pngFile()]);
      });
      await waitForThumb(view.container);
      expect(view.container.querySelector('[data-testid="image-thumb"]')).toBeTruthy();
      expect(view.container.querySelector('[data-testid="file-attachment-chip"]')).toBeNull();
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(view.container.querySelector('[data-testid="image-chip-mode"]')!.textContent).toBe("将内联发送，视觉模型可见");
    } finally {
      await view.unmount();
    }
  });

  test("attach：粘贴图片改走附件 chip 通道（二进制附件 POST），无内联图片 chip", async () => {
    let resolveUpload: (v: { path: string; name: string; bytes: number }) => void = () => {};
    const uploadSpy = vi.spyOn(apiMod.api, "postBinaryAttachment").mockImplementation(
      () =>
        new Promise((res) => {
          resolveUpload = res;
        }),
    );
    setMode("attach");
    const view = await renderLive();
    try {
      const png = pngFile();
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
      await act(async () => {
        firePaste(textarea, [png]);
      });
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(uploadSpy.mock.calls[0][1]).toBe(png);
      expect(view.container.querySelector('[data-testid="image-thumb"]')).toBeNull();
      const chip = view.container.querySelector<HTMLElement>('[data-testid="file-attachment-chip"]');
      expect(chip).toBeTruthy();
      await act(async () => {
        resolveUpload({ path: "/data/attachments/abc/shot.png", name: "shot.png", bytes: 4 });
      });
      expect(view.container.querySelector('[data-testid="file-attachment-chip"]')!.textContent).toContain("shot.png");
    } finally {
      await view.unmount();
    }
  });
});
