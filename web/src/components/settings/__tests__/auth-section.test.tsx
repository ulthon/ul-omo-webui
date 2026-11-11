// @ts-nocheck
// 设置页「认证」分区单测（r10 批次任务 13 + 凭证列表/删除/逐测/baseUrl 批次）。
// 环境说明同 rebind-section.test.tsx：@ts-nocheck + 被测模块动态 import + @happy-dom 全局
// 注册 + api 整模块代理 mock。验收：(a) 表单渲染（provider 下拉 + 密码框 type=password
// 不回显）；(b) 粘贴+提交调 saveAuthCredential 且入参正确（含可选 baseUrl）；(c) 成功 →
// ready 徽标 + key 清空；(d) 失败 → 失败原因外显（服务端 detail）、key 不回显入 DOM；(e)
// 凭证列表渲染（掩码+状态灯）、行内测试调 checkAuthProvider、删除二次确认流调
// deleteAuthProvider；(f) 全程 DOM 无明文 key。
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
const checkRowFn = vi.fn();
const deleteFn = vi.fn();
const listProvidersFn = vi.fn(() => Promise.resolve({ items: [], cliAvailable: true }));
const getAuthStatusFn = vi.fn(() => Promise.resolve({ status: "not_configured", provider: null, checkedAt: 1, detail: null }));
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "saveAuthCredential") return saveFn;
        if (key === "getAuthStatus") return getAuthStatusFn;
        if (key === "listAuthProviders") return listProvidersFn;
        if (key === "checkAuthProvider") return checkRowFn;
        if (key === "deleteAuthProvider") return deleteFn;
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

function qa(container: Element, sel: string): Element[] {
  return [...container.querySelectorAll(sel)];
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const PROV_ROW = {
  name: "zai-coding-cn",
  type: null,
  keyMask: "sk-***cdef",
  hasBaseUrl: false,
};

describe("AuthSection（r10 任务 13 + 列表/删除/逐测/baseUrl 批次）", () => {
  test("渲染：provider 下拉 + API key 密码框（type=password 不回显）+ 测试按钮 + baseUrl 输入框 + 挂载拉列表", async () => {
    const { container } = mount();
    await flush();
    expect(q(container, '[data-testid="auth-section"]')).toBeTruthy();
    expect(q(container, '[data-testid="auth-provider"]')).toBeTruthy();
    const keyInput = q(container, '[data-testid="auth-api-key"]') as HTMLInputElement;
    expect(keyInput.getAttribute("type")).toBe("password");
    expect(q(container, '[data-testid="auth-test"]')).toBeTruthy();
    expect(q(container, '[data-testid="auth-base-url"]')).toBeTruthy();
    expect(q(container, '[data-testid="auth-status-badge"]').textContent).toContain("凭证未配置");
    expect(listProvidersFn).toHaveBeenCalled();
    expect(q(container, '[data-testid="auth-providers-empty"]').textContent).toContain("暂无已保存凭证");
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
    expect(saveFn).toHaveBeenCalledWith("zai-coding-cn", KEY, "");
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
    expect(useUiStore.getState().globalNotifs.some((t) => t.text.includes("请粘贴 API key"))).toBe(true);
  });

  test("凭证列表渲染：行含 provider 名+掩码+未测灰灯；掩码入 DOM、完整 key 不入", async () => {
    listProvidersFn.mockReset().mockReturnValue(
      Promise.resolve({ items: [PROV_ROW, { name: "deepseek", type: "api", keyMask: "***", hasBaseUrl: true }], cliAvailable: true }),
    );
    const { container } = mount();
    await flush();
    const rows = qa(container, '[data-testid="auth-provider-row"]');
    expect(rows).toHaveLength(2);
    expect(q(rows[0], '[data-testid="auth-row-name"]').textContent).toBe("zai-coding-cn");
    expect(q(rows[0], '[data-testid="auth-row-keymask"]').textContent).toBe("sk-***cdef");
    expect(q(rows[0], '[data-testid="auth-row-status"]').textContent).toContain("未测");
    expect(q(rows[1], '[data-testid="auth-row-keymask"]').textContent).toBe("***");
    expect(rows[1].textContent).toContain("api");
    expect(document.body.textContent).not.toContain(KEY);
  });

  test("行内测试：调 checkAuthProvider(name) → 状态灯转可用；失败 → 红 + detail title", async () => {
    listProvidersFn.mockReset().mockReturnValue(
      Promise.resolve({ items: [PROV_ROW], cliAvailable: true }),
    );
    const { container } = mount();
    await flush();
    const rows = () => qa(container, '[data-testid="auth-provider-row"]');
    checkRowFn.mockReset().mockReturnValueOnce(
      Promise.resolve({ status: "ready", provider: "zai-coding-cn", checkedAt: 4, detail: null }),
    );
    click(q(rows()[0], '[data-testid="auth-row-test"]'));
    await flush();
    expect(checkRowFn).toHaveBeenCalledWith("zai-coding-cn");
    expect(q(rows()[0], '[data-testid="auth-row-status"]').textContent).toContain("可用");

    checkRowFn.mockReset().mockReturnValueOnce(
      Promise.resolve({ status: "error", provider: "zai-coding-cn", checkedAt: 5, detail: "上游 401" }),
    );
    click(q(rows()[0], '[data-testid="auth-row-test"]'));
    await flush();
    const badge = q(rows()[0], '[data-testid="auth-row-status"]');
    expect(badge.textContent).toContain("失败");
    expect(badge.getAttribute("title")).toContain("上游 401");
  });

  test("删除确认流：首击变「确认删除」不调 API，再击调 deleteAuthProvider 并刷新列表", async () => {
    listProvidersFn
      .mockReset()
      .mockReturnValueOnce(Promise.resolve({ items: [PROV_ROW], cliAvailable: true }))
      .mockReturnValueOnce(Promise.resolve({ items: [], cliAvailable: true }));
    deleteFn.mockReset().mockReturnValue(Promise.resolve({ ok: true, name: "zai-coding-cn" }));
    const { container } = mount();
    await flush();
    const rows = () => qa(container, '[data-testid="auth-provider-row"]');
    expect(rows()).toHaveLength(1);
    const del = () => q(rows()[0], '[data-testid="auth-row-delete"]');
    click(del());
    await flush();
    expect(del().textContent).toContain("确认删除");
    expect(deleteFn).not.toHaveBeenCalled();
    click(del());
    await flush();
    expect(deleteFn).toHaveBeenCalledWith("zai-coding-cn");
    expect(qa(container, '[data-testid="auth-provider-row"]')).toHaveLength(0);
    expect(q(container, '[data-testid="auth-providers-empty"]')).toBeTruthy();
  });

  test("baseUrl 传递：填写合法 URL → saveAuthCredential 第三参携带；非法 URL → 不调 API 提示", async () => {
    saveFn.mockReset().mockReturnValue(
      Promise.resolve({ status: "ready", provider: "zai-coding-cn", checkedAt: 6, detail: null }),
    );
    const { container } = mount();
    await flush();
    const keyInput = q(container, '[data-testid="auth-api-key"]') as HTMLInputElement;
    const baseUrlInput = q(container, '[data-testid="auth-base-url"]') as HTMLInputElement;
    setInput(keyInput, KEY);
    setInput(baseUrlInput, "https://api.example.com/v1");
    click(q(container, '[data-testid="auth-test"]'));
    await flush();
    expect(saveFn).toHaveBeenCalledWith("zai-coding-cn", KEY, "https://api.example.com/v1");

    saveFn.mockReset();
    setInput(baseUrlInput, "not a url");
    setInput(keyInput, KEY);
    click(q(container, '[data-testid="auth-test"]'));
    await flush();
    expect(saveFn).not.toHaveBeenCalled();
    const { useUiStore } = await import("@/stores/ui");
    expect(useUiStore.getState().globalNotifs.some((t) => t.text.includes("Base URL"))).toBe(true);
    expect(document.body.textContent).not.toContain(KEY);
  });
});
