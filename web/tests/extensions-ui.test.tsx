// @ts-nocheck
// 「扩展与凭证」分区单测（docs08-2026-10-22 批次任务 24）：schedule-ui 惯例——@happy-dom
// 全局注册 + createRoot/act 真实交互 + fetch 桩走真 api 层。覆盖：(1) 清单分组渲染与
// GET 一致（三目录 + package）；(2) 启停开关 PUT 载荷与乐观对账（串行 busy）；(3) auth
// 三态徽标（ready/error/not_configured）与检查钮重查；(4) 空清单诚实空态 + CLI 缺失降级；
// (5) install 非法 source 拦截（不发生 POST）与合法 POST 载荷；(6) i18n 键双语齐备。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { ExtensionsSection } = await import("@/components/extensions/extensions-section");

const ORIGINAL_FETCH = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function stubFetch(respond: (call: { url: string; method: string; body?: unknown }) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { url, method, body };
    calls.push(call);
    const res = respond(call);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const FIXTURE_ITEMS = [
  { name: "diff", kind: "extension", enabled: true },
  { name: "mail", kind: "skill", enabled: true },
  { name: "pause-plan", kind: "prompt", enabled: false },
  { name: "oh-my-pi", kind: "package", enabled: true, source: "npm:oh-my-pi@0.2.0" },
];

const nativeInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
function setInputValue(el: HTMLInputElement, value: string): void {
  nativeInputSetter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function mount(): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(createElement(ExtensionsSection));
  return { container, unmount: () => root.unmount() };
}

const q = (c: HTMLElement, sel: string): HTMLElement | null => c.querySelector(sel);
const qAll = (c: HTMLElement, sel: string): HTMLElement[] => [...c.querySelectorAll(sel)];

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("ExtensionsSection", () => {
  test("清单分组渲染与 GET 一致；启停开关 PUT 载荷正确且列表对账", async () => {
    const items = FIXTURE_ITEMS.map((it) => ({ ...it }));
    const calls = stubFetch((call) => {
      if (call.url === "/api/extensions" && call.method === "GET") {
        return { status: 200, body: { items, cliAvailable: true } };
      }
      if (call.url === "/api/extensions/mail" && call.method === "PUT") {
        const it = items.find((i) => i.kind === "skill" && i.name === "mail");
        if (it) it.enabled = (call.body as { enabled: boolean }).enabled;
        return { status: 200, body: call.body };
      }
      if (call.url === "/api/auth/status") return { status: 200, body: { status: "not_configured", provider: null, checkedAt: 1, detail: null } };
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { container, unmount } = mount();
    await act(async () => {});
    // 分组渲染
    expect(q(container, '[data-testid="extensions-section"]')).not.toBeNull();
    expect(q(container, '[data-testid="ext-item-extension-diff"]')).not.toBeNull();
    expect(q(container, '[data-testid="ext-item-skill-mail"]')).not.toBeNull();
    expect(q(container, '[data-testid="ext-item-prompt-pause-plan"]')).not.toBeNull();
    expect(qAll(container, "[data-testid^='ext-item-']")).toHaveLength(4);
    // package 无开关（有 remove），其余有
    expect(q(container, '[data-testid="ext-toggle-package-oh-my-pi"]')).toBeNull();
    expect(q(container, '[data-testid="ext-remove-oh-my-pi"]')).not.toBeNull();
    // 启停：点 mail → PUT {enabled:false,kind:"skill"} → 对账后开关翻面
    const before = q(container, '[data-testid="ext-toggle-skill-mail"]') as HTMLElement;
    expect(before.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      before.click();
    });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ enabled: false, kind: "skill" });
    const after = q(container, '[data-testid="ext-toggle-skill-mail"]') as HTMLElement;
    expect(after.getAttribute("aria-checked")).toBe("false");
    unmount();
  });

  test("auth 徽标三态与检查钮重查", async () => {
    let authState = { status: "ready", provider: "zai-coding-cn", checkedAt: 1, detail: null };
    stubFetch((call) => {
      if (call.url === "/api/extensions") return { status: 200, body: { items: [], cliAvailable: true } };
      if (call.url === "/api/auth/status") return { status: 200, body: authState };
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { container, unmount } = mount();
    await act(async () => {});
    const badge = () => q(container, '[data-testid="extensions-auth-badge"]') as HTMLElement;
    expect(badge().textContent).toContain("凭证就绪");
    // 重查到 error 态
    authState = { status: "error", provider: "zai-coding-cn", checkedAt: 2, detail: "boom" };
    await act(async () => {
      (q(container, '[data-testid="extensions-auth-check"]') as HTMLElement).click();
    });
    expect(badge().textContent).toContain("凭证异常");
    // 未配置态
    authState = { status: "not_configured", provider: null, checkedAt: 3, detail: null };
    await act(async () => {
      (q(container, '[data-testid="extensions-auth-check"]') as HTMLElement).click();
    });
    expect(badge().textContent).toContain("凭证未配置");
    // 无凭证材料出现在 DOM
    expect(container.textContent).not.toContain("sk-");
    unmount();
  });

  test("空清单诚实空态；CLI 缺失降级提示且动作禁用", async () => {
    stubFetch((call) => {
      if (call.url === "/api/extensions") return { status: 200, body: { items: [], cliAvailable: false } };
      if (call.url === "/api/auth/status") return { status: 200, body: { status: "error", provider: "p", checkedAt: 1, detail: "cli missing" } };
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { container, unmount } = mount();
    await act(async () => {});
    expect(q(container, '[data-testid="extensions-empty"]')).not.toBeNull();
    expect(container.textContent).toContain("未找到 omo CLI");
    expect((q(container, '[data-testid="extensions-auth-check"]') as HTMLButtonElement).disabled).toBe(true);
    expect((q(container, '[data-testid="extensions-update"]') as HTMLButtonElement).disabled).toBe(true);
    unmount();
  });

  test("install：非法 source 拦截不发生 POST；合法 source POST 载荷透传", async () => {
    const calls = stubFetch((call) => {
      if (call.url === "/api/extensions") return { status: 200, body: { items: FIXTURE_ITEMS, cliAvailable: true } };
      if (call.url === "/api/extensions/install") return { status: 200, body: { ok: true, message: "done" } };
      if (call.url === "/api/auth/status") return { status: 200, body: { status: "ready", provider: "p", checkedAt: 1, detail: null } };
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { container, unmount } = mount();
    await act(async () => {});
    const input = q(container, '[data-testid="extensions-install-source"]') as HTMLInputElement;
    const btn = q(container, '[data-testid="extensions-install"]') as HTMLButtonElement;
    // 非法（含空格）→ 拦截
    await act(async () => {
      setInputValue(input, "npm:bad pkg");
    });
    await act(async () => {
      btn.click();
    });
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/extensions/install")).toBe(false);
    // 合法 → POST {source}
    await act(async () => {
      setInputValue(input, "npm:oh-my-pi@0.2.0");
    });
    await act(async () => {
      btn.click();
    });
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/extensions/install");
    expect(post?.body).toEqual({ source: "npm:oh-my-pi@0.2.0" });
    unmount();
  });

  test("i18n：extensions 域键 zh/en 双语齐备", async () => {
    const { zh } = await import("@/i18n/zh");
    const { en } = await import("@/i18n/en");
    const keys = Object.keys(zh.extensions);
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) {
      expect((en.extensions as Record<string, string>)[k]?.length).toBeGreaterThan(0);
      expect(typeof (zh.extensions as Record<string, string>)[k]).toBe("string");
    }
  });
});
