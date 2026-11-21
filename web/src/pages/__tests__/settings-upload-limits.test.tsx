// @ts-nocheck
// 2026-11-20 设置页可调批：上传上限分区行为测试（组件级直挂 UploadLimitsSection）。
// 骨架同 login-site-name.test.tsx：@ts-nocheck + @happy-dom 全局注册 + api 定向 mock +
// 被测模块动态 import + createRoot/act。onChange/onBlur 是 React 合成事件，原生触发
// 用 input（冒泡）与 focusout（冒泡；React onBlur 委托 focusout 而非 blur）。
// 验收：(a) 三行渲染且缺省值 10/5/1；(b) 改文件上限为 20 并失焦 → PUT 对应 kv 且
//      store 更新；(c) 非法值（0）→ 行内提示且不 PUT；(d) 值未变失焦 → 不 PUT。
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const putSettings = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock("@/lib/api", () => ({
  api: {
    putSettings: (...args) => putSettings(...args),
  },
  ApiError: class ApiError extends Error {
    status: number;
  },
}));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { UploadLimitsSection } = await import("@/pages/settings");
const { useUiStore } = await import("@/stores/ui");

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(UploadLimitsSection));
  });
  await act(async () => {});
  return container;
}

/** 改输入值并失焦（触发提交）。受控 input 必须经原生 value setter 赋值：
 * 直接 input.value= 会被 React 的 value tracker 视为未变化，onChange 不触发。 */
const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
async function editAndBlur(input: HTMLInputElement, value: string) {
  await act(async () => {
    nativeValueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new Event("focusout", { bubbles: true }));
  });
  await act(async () => {});
}

beforeEach(() => {
  document.body.innerHTML = "";
  putSettings.mockClear();
  useUiStore.setState({ fileAttachmentMaxMb: 10, imageInlineMaxMb: 5, textPasteMaxMb: 1 });
});

describe("设置页上传上限分区", () => {
  test("(a) 三行渲染且缺省值 10/5/1", async () => {
    const c = await mount();
    const inputs = c.querySelectorAll('input[type="number"]');
    expect(inputs.length).toBe(3);
    expect(inputs[0].value).toBe("10");
    expect(inputs[1].value).toBe("5");
    expect(inputs[2].value).toBe("1");
    expect(c.querySelector('[data-testid="upload-limit-file"]')).toBeTruthy();
    expect(c.querySelector('[data-testid="upload-limit-image"]')).toBeTruthy();
    expect(c.querySelector('[data-testid="upload-limit-text"]')).toBeTruthy();
  });

  test("(b) 文件上限改 20 失焦 → PUT composer.fileAttachmentMaxMb 且 store 更新", async () => {
    const c = await mount();
    const input = c.querySelector('[data-testid="upload-limit-file"] input');
    await editAndBlur(input, "20");
    expect(putSettings).toHaveBeenCalledTimes(1);
    expect(putSettings).toHaveBeenCalledWith({ "composer.fileAttachmentMaxMb": "20" });
    expect(useUiStore.getState().fileAttachmentMaxMb).toBe(20);
  });

  test("(c) 非法值 0 → 行内提示且不 PUT", async () => {
    const c = await mount();
    const input = c.querySelector('[data-testid="upload-limit-image"] input');
    await editAndBlur(input, "0");
    expect(putSettings).not.toHaveBeenCalled();
    const row = c.querySelector('[data-testid="upload-limit-image"]');
    expect(row.textContent).toContain("1-1024");
    expect(useUiStore.getState().imageInlineMaxMb).toBe(5);
  });

  test("(d) 值未变失焦 → 不 PUT", async () => {
    const c = await mount();
    const input = c.querySelector('[data-testid="upload-limit-text"] input');
    await editAndBlur(input, "1");
    expect(putSettings).not.toHaveBeenCalled();
  });
});
