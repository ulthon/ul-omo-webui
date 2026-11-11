// @ts-nocheck
// 设置页「更新」分区单测（engine-upgrade-5169 批 4a）：引擎通道 501 错误码
// engine_upgrade_via_webui_release 命中时渲染 i18n 说明文案 update.engineViaRelease。
// 环境说明同 engine-section.test.tsx：@ts-nocheck + 动态 import + @happy-dom 全局注册 +
// api 整模块代理 mock（useT 透传键名，断言键出现即文案渲染）。
import { describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const updateCheckFn = vi.fn(() =>
  Promise.resolve({
    webui: { current: "2026.11.10-1", latest: "2026.11.10-2", hasUpdate: true },
    engine: { current: "2026.11.5-1", latest: "2026.11.10-2", hasUpdate: true },
    lastInstall: null,
  }),
);
const updateInstallFn = vi.fn(() =>
  Promise.reject(new ApiError(501, "engine_upgrade_via_webui_release", "引擎升级搭载 webui 发版，请更新 webui")),
);

vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "updateCheck") return updateCheckFn;
        if (key === "updateInstall") return updateInstallFn;
        return () => Promise.resolve({});
      },
    },
  ),
  ApiError,
}));

vi.mock("@/i18n/i18n", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    key + (vars ? ":" + JSON.stringify(vars) : ""),
}));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { UpdateSection } = await import("@/components/settings/update-section");

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(UpdateSection));
  });
  return { container, root };
}

async function settle(times = 5) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

describe("UpdateSection engine 501 文案", () => {
  test("确认后渲染 update.engineViaRelease 说明文案", async () => {
    const { container, root } = mount();
    await settle();
    const btn = container.querySelector('[data-testid="update-confirm-btn"]');
    expect(btn).not.toBeNull();
    await act(async () => {
      btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    await settle();
    const err = container.querySelector('[data-testid="update-error"]');
    expect(err).not.toBeNull();
    expect(err.textContent).toContain("update.engineViaRelease");
    act(() => root.unmount());
    container.remove();
  });
});
