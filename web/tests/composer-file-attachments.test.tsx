// 通用附件前端（docs08 2026-10-23/24 批次任务 18）：任意格式非图片文件粘贴/选择
// → 三态 chip（上传中/就绪/失败）→ 发送拼路径行。组件级集成（happy-dom，
// composer-mobile-layout 惯例）：api 层 vi.spyOn 桩，无真实网络，上传 promise 受控。
// 铁律（B10）：附件内容绝不进 prompt 正文，只带绝对路径行。
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
const apiMod = await import("@/lib/api");

const SID = "qa-task18";

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

async function inputText(container: HTMLElement, value: string): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickSend(container: HTMLElement): Promise<void> {
  const btn = container.querySelector<HTMLButtonElement>('button[data-testid="send-btn"]')!;
  await act(async () => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function chipEl(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="file-attachment-chip"]')!;
}

beforeEach(() => {
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  useUiStore.setState({ toast: null });
  vi.restoreAllMocks();
});

describe("通用文件附件（任务 18）：粘贴 → 三态 chip → 路径行", () => {
  test("(a) 粘贴 zip（非图片）→ 上传中 chip →（POST 成功）就绪并带回路径", async () => {
    let resolveUpload: (v: { path: string; name: string; bytes: number }) => void = () => {};
    const uploadSpy = vi.spyOn(apiMod.api, "postBinaryAttachment").mockImplementation(
      () =>
        new Promise((res) => {
          resolveUpload = res;
        }),
    );
    const view = await renderLive();
    try {
      const zip = new File([new Uint8Array([1, 2, 3, 4])], "demo.zip", { type: "application/zip" });
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
      await act(async () => {
        firePaste(textarea, [zip]);
      });
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(uploadSpy.mock.calls[0][0]).toBe(SID);
      expect(uploadSpy.mock.calls[0][1]).toBe(zip);
      expect(uploadSpy.mock.calls[0][2]).toBe("demo.zip");
      expect(chipEl(view.container).dataset.stage).toBe("uploading");
      await act(async () => {
        resolveUpload({ path: "/data/attachments/abc/demo.zip", name: "demo.zip", bytes: 4 });
      });
      const chip = chipEl(view.container);
      expect(chip.dataset.stage).toBe("ready");
      expect(chip.textContent).toContain("demo.zip");
    } finally {
      await view.unmount();
    }
  });

  test("(b) 发送 → prompt 含路径行、不含文件内容；成功后 chip 清空", async () => {
    vi.spyOn(apiMod.api, "postBinaryAttachment").mockResolvedValue({
      path: "/data/attachments/abc/demo.zip",
      name: "demo.zip",
      bytes: 4,
    });
    const promptSpy = vi.spyOn(apiMod.api, "prompt").mockResolvedValue({
      disposition: "sent",
    } as unknown as Awaited<ReturnType<typeof apiMod.api.prompt>>);
    const view = await renderLive();
    try {
      const zip = new File([new TextEncoder().encode("SECRET-FILE-CONTENT")], "demo.zip", { type: "application/zip" });
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
      await act(async () => {
        firePaste(textarea, [zip]);
      });
      await inputText(view.container, "看一下这个压缩包");
      await clickSend(view.container);
      expect(promptSpy).toHaveBeenCalledTimes(1);
      const outgoing = promptSpy.mock.calls[0][1] as { text: string };
      expect(outgoing.text).toContain("[已附加文件：/data/attachments/abc/demo.zip（按需读取）]");
      expect(outgoing.text).toContain("看一下这个压缩包");
      // B10 铁律：文件内容绝不进 prompt
      expect(outgoing.text).not.toContain("SECRET-FILE-CONTENT");
      // 发送成功后 chip 条清空（文件留存，48h 兜底）
      expect(view.container.querySelector('[data-testid="file-attachment-chip"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("(c) 上传失败（413）→ 失败 chip + 重试/移除；重试重新 POST 后就绪", async () => {
    vi.spyOn(apiMod.api, "postBinaryAttachment")
      .mockRejectedValueOnce(
        new apiMod.ApiError(413, "attachment_too_large", "附件超过 10MB 上限"),
      )
      .mockResolvedValueOnce({ path: "/data/attachments/abc/big.zip", name: "big.zip", bytes: 100 });
    const view = await renderLive();
    try {
      const zip = new File([new Uint8Array(100)], "big.zip", { type: "application/zip" });
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
      await act(async () => {
        firePaste(textarea, [zip]);
      });
      const chip = chipEl(view.container);
      expect(chip.dataset.stage).toBe("failed");
      expect(chip.querySelector('[data-testid="file-attachment-retry"]')).not.toBeNull();
      // 失败 chip 单独不使能发送
      expect(view.container.querySelector<HTMLButtonElement>('button[data-testid="send-btn"]')!.disabled).toBe(true);
      const uploadCalls = vi.mocked(apiMod.api.postBinaryAttachment);
      await act(async () => {
        chip.querySelector<HTMLButtonElement>('[data-testid="file-attachment-retry"]')!.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });
      // 重试重新 POST（复用原始 File）并落就绪态
      expect(uploadCalls).toHaveBeenCalledTimes(2);
      expect(uploadCalls.mock.calls[1]![1]).toBe(zip);
      expect(chipEl(view.container).dataset.stage).toBe("ready");
    } finally {
      await view.unmount();
    }
  });

  test("(c2) 失败 chip 移除：本地出列且不再拦截输入", async () => {
    vi.spyOn(apiMod.api, "postBinaryAttachment").mockRejectedValue(
      new apiMod.ApiError(413, "attachment_too_large", "附件超过 10MB 上限"),
    );
    const view = await renderLive();
    try {
      const zip = new File([new Uint8Array(10)], "x.zip", { type: "application/zip" });
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
      await act(async () => {
        firePaste(textarea, [zip]);
      });
      await act(async () => {});
      const chip = chipEl(view.container);
      expect(chip.dataset.stage).toBe("failed");
      await act(async () => {
        chip.querySelector<HTMLButtonElement>('[data-testid="file-attachment-remove"]')!.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });
      expect(view.container.querySelector('[data-testid="file-attachment-chip"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("(d) 图片粘贴回归：仍走内联链路（image-strip），不产生文件 chip、不调二进制通道", async () => {
    const uploadSpy = vi.spyOn(apiMod.api, "postBinaryAttachment");
    const view = await renderLive();
    try {
      const png = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
      await act(async () => {
        firePaste(textarea, [png]);
      });
      // FileReader 异步读图：等定时器拍后再断言
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(view.container.querySelector('[data-testid="image-thumb"]')).not.toBeNull();
      expect(view.container.querySelector('[data-testid="file-attachment-chip"]')).toBeNull();
      expect(uploadSpy).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  test("(d2) 混合剪贴板（图片+zip）：图片进内联、zip 进文件 chip，两路并行", async () => {
    vi.spyOn(apiMod.api, "postBinaryAttachment").mockResolvedValue({
      path: "/data/attachments/abc/mix.zip",
      name: "mix.zip",
      bytes: 5,
    });
    const view = await renderLive();
    try {
      const png = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
      const zip = new File([new Uint8Array(5)], "mix.zip", { type: "application/zip" });
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
      await act(async () => {
        firePaste(textarea, [png, zip]);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(view.container.querySelector('[data-testid="image-thumb"]')).not.toBeNull();
      // zip 并行走文件通道：冲刷后已落就绪
      expect(chipEl(view.container).dataset.stage).toBe("ready");
      await act(async () => {});
      expect(chipEl(view.container).dataset.stage).toBe("ready");
    } finally {
      await view.unmount();
    }
  });

  test("(e) 文件选择器 accept 开放：无 accept 限制属性；选择 zip 同样走文件 chip", async () => {
    vi.spyOn(apiMod.api, "postBinaryAttachment").mockResolvedValue({
      path: "/data/attachments/abc/pick.zip",
      name: "pick.zip",
      bytes: 3,
    });
    const view = await renderLive();
    try {
      const input = view.container.querySelector<HTMLInputElement>('input[data-testid="composer-file-input"]')!;
      expect(input.getAttribute("accept")).toBeNull();
      expect(input.multiple).toBe(true);
      // 直接驱动 onChange 分流（happy-dom 的 files 只读，用原型 setter 模拟选择）
      const zip = new File([new Uint8Array(3)], "pick.zip", { type: "application/zip" });
      Object.defineProperty(input, "files", { value: [zip] });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {});
      expect(chipEl(view.container).dataset.stage).toBe("ready");
    } finally {
      await view.unmount();
    }
  });

  test("stale_state：上传在途时发送被拦截（不排队、不吞 chip），落定后可发", async () => {
    let resolveUpload: (v: { path: string; name: string; bytes: number }) => void = () => {};
    vi.spyOn(apiMod.api, "postBinaryAttachment").mockImplementation(
      () =>
        new Promise((res) => {
          resolveUpload = res;
        }),
    );
    const promptSpy = vi.spyOn(apiMod.api, "prompt");
    const view = await renderLive();
    try {
      const zip = new File([new Uint8Array(6)], "slow.zip", { type: "application/zip" });
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
      await act(async () => {
        firePaste(textarea, [zip]);
      });
      await inputText(view.container, "go");
      await clickSend(view.container);
      expect(promptSpy).not.toHaveBeenCalled();
      expect(chipEl(view.container).dataset.stage).toBe("uploading");
      expect(view.container.querySelector('[data-testid="composer-error"]')?.textContent).toContain("附件上传中");
      await act(async () => {
        resolveUpload({ path: "/data/attachments/abc/slow.zip", name: "slow.zip", bytes: 6 });
      });
      await clickSend(view.container);
      expect(promptSpy).toHaveBeenCalledTimes(1);
    } finally {
      await view.unmount();
    }
  });

  test("malformed-input：空文件跳过（无 chip + toast）；超 10MB 拒绝（无 chip）", async () => {
    const uploadSpy = vi.spyOn(apiMod.api, "postBinaryAttachment");
    const view = await renderLive();
    try {
      const empty = new File([], "empty.zip", { type: "application/zip" });
      const huge = new File([new Uint8Array(0)], "huge.zip", { type: "application/zip" });
      Object.defineProperty(huge, "size", { value: 10 * 1024 * 1024 + 1 });
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]')!;
      await act(async () => {
        firePaste(textarea, [empty, huge]);
      });
      expect(view.container.querySelector('[data-testid="file-attachment-chip"]')).toBeNull();
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(useUiStore.getState().toasts.at(-1)?.text ?? "").toContain("10MB");
    } finally {
      await view.unmount();
    }
  });
});
