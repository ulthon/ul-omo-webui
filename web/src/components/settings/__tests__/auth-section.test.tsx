// @ts-nocheck
// 设置页「认证」分区单测（r10 批次任务 13）。环境说明同 rebind-section.test.tsx：
// @ts-nocheck + 被测模块动态 import + @happy-dom 全局注册 + api 整模块代理 mock。
// 验收：(a) 表单渲染（provider 下拉 + 密码框 type=password 不回显）；(b) 粘贴+提交调
// saveAuthCredential 且入参正确；(c) 成功 → ready 徽标 + key 清空；(d) 失败 → 失败原因
// 外显（服务端 detail）、key 不回显入 DOM；(e) 全程 DOM 无明文 key。
import { describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
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

const KEY = "sk-test-secret-9876543210abcdef";

const saveFn = vi.fn();
const getAuthStatusFn = vi.fn(() => Promise.resolve({ status: "not_configured", provider: null, checkedAt: 1, detail: null }));
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "saveAuthCredential") return saveFn;
        if (key === "getAuthStatus") return getAuthStatusFn;
        return () => Promise.resolve({});
      },
    },
  ),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AuthSection } = await import("@/components/settings/auth-section");

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(AuthSection));
  });
  return { container, root };
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function setInput(el: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function q(container: Element, sel: string): Element {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AuthSection（r10 任务 13）", () => {
  test("渲染：provider 下拉 + API key 密码框（type=password 不回显）+ 测试按钮 + 挂载拉状态", async () => {
    const { container } = mount();
    await flush();
    expect(q(container, '[data-testid="auth-section"]')).toBeTruthy();
    expect(q(container, '[data-testid="auth-provider"]')).toBeTruthy();
    const keyInput = q(container, '[data-testid="auth-api-key"]') as HTMLInputElement;
    expect(keyInput.getAttribute("type")).toBe("password");
    expect(q(container, '[data-testid="auth-test"]')).toBeTruthy();
    expect(q(container, '[data-testid="auth-status-badge"]').textContent).toContain("凭证未配置");
  });

  test("粘贴+提交：调 saveAuthCredential（provider+key），成功 → ready 徽标 + key 清空不回显", async () => {
    saveFn.mockReset().mockReturnValue(
      Promise.resolve({ status: "ready", provider: "zai-coding-cn", checkedAt: 2, detail: null }),
    );
    const { container } = mount();
    await flush();
    const keyInput = q(container, '[data-testid="auth-api-key"]') as HTMLInputElement;
    setInput(keyInput, KEY);
    click(q(container, '[data-testid="auth-test"]'));
    await flush();
    expect(saveFn).toHaveBeenCalledWith("zai-coding-cn", KEY);
    expect(q(container, '[data-testid="auth-status-badge"]').textContent).toContain("凭证就绪");
    expect((q(container, '[data-testid="auth-api-key"]') as HTMLInputElement).value).toBe("");
    expect(container.innerHTML).not.toContain(KEY);
  });

  test("失败：detail 外显（auth-fail-detail），key 不入 DOM，无崩溃", async () => {
    saveFn.mockReset().mockReturnValue(
      Promise.resolve({ status: "not_configured", provider: "zai-coding-cn", checkedAt: 3, detail: "无效 key" }),
    );
    const { container } = mount();
    await flush();
    setInput(q(container, '[data-testid="auth-api-key"]') as HTMLInputElement, KEY);
    click(q(container, '[data-testid="auth-test"]'));
    await flush();
    const detail = q(container, '[data-testid="auth-fail-detail"]');
    expect(detail.textContent).toContain("无效 key");
    // 明文 key 不以文本形式出现在 DOM；输入框仍为密码态（受控值保留属用户已输入内容）
    expect(document.body.textContent).not.toContain(KEY);
    expect((q(container, '[data-testid="auth-api-key"]') as HTMLInputElement).getAttribute("type")).toBe("password");
  });

  test("空 key 提交：不调 API，toast 提示必填", async () => {
    saveFn.mockReset();
    const { container } = mount();
    await flush();
    click(q(container, '[data-testid="auth-test"]'));
    await flush();
    expect(saveFn).not.toHaveBeenCalled();
    const { useUiStore } = await import("@/stores/ui");
    expect(useUiStore.getState().toasts.some((t) => t.text.includes("请粘贴 API key"))).toBe(true);
  });
});
