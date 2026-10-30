// @ts-nocheck
// 登录页站点名副标题（engine-upgrade 2026-10-30 批次 todo3）两态渲染。
// 环境说明同 topbar-mobile-declutter.test.tsx：@ts-nocheck + 被测模块动态 import +
// @happy-dom 全局注册；渲染断言走 createRoot 真实 DOM。
// 验收：(a) 设置 window.__SITE_NAME__ 时副标题行渲染站点名（data-testid=login-site-name）；
//       (b) 未设置时不渲染；(c) 默认标题与副标题不受站点名影响。
import { describe, expect, test, vi, beforeEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

// api.health 必须拒绝：登录页「已登录跳回 /」副作用要留在登录页（happy-dom 下
// location.replace 真导航会撕裂测试 DOM）
vi.mock("@/lib/api", () => ({
  api: {
    health: vi.fn(() => Promise.reject(new Error("unauthorized"))),
    login: vi.fn(() => Promise.reject(new Error("unused"))),
  },
  ApiError: class ApiError extends Error {},
}));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LoginPage } = await import("../login");

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(LoginPage));
  });
  await act(async () => {}); // 冲刷 health 副作用微任务（拒绝路径 setChecking(false)）
  return container;
}

beforeEach(() => {
  document.body.innerHTML = "";
  delete window.__SITE_NAME__;
});

describe("登录页站点名副标题（todo3）", () => {
  test("(a) 设置时渲染站点名一行", async () => {
    window.__SITE_NAME__ = "测试站";
    const c = await mount();
    const el = c.querySelector('[data-testid="login-site-name"]');
    expect(el).toBeTruthy();
    expect(el.textContent).toBe("测试站");
  });

  test("(b) 未设置时不渲染", async () => {
    const c = await mount();
    expect(c.querySelector('[data-testid="login-site-name"]')).toBeNull();
  });

  test("(c) 默认标题与副标题不受站点名影响（零新增 i18n 键）", async () => {
    window.__SITE_NAME__ = "测试站";
    const c = await mount();
    expect(c.querySelector("h1").textContent).toBe("ul-omo webui");
    expect(c.textContent).toContain("输入访问密码登录");
  });
});
