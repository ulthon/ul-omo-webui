// @ts-nocheck
// 设置页「引擎」分区单测（2026-11-04 空闲回收配置化 + 进程管理）。环境说明同
// auth-section.test.tsx：@ts-nocheck + 被测模块动态 import + @happy-dom 全局注册 +
// api 整模块代理 mock。验收：(a) 六档单选渲染、缺省 7 天选中；(b) kv 为 never 时
// 「永不」选中；(c) 换档调 putSettings 且入参正确；(d) 进程列表渲染（项目名/状态/
// 停止钮）；(e) 运行回合 >0 时 confirm 确认后调 stopEngine，取消则不调。
import { describe, expect, test, vi, beforeEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
(globalThis as { confirm?: () => boolean }).confirm ??= () => true;

const getSettingsFn = vi.fn();
const putSettingsFn = vi.fn(() => Promise.resolve({ ok: true, settings: {} }));
const listEnginesFn = vi.fn();
const stopEngineFn = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "getSettings") return getSettingsFn;
        if (key === "putSettings") return putSettingsFn;
        if (key === "listEngines") return listEnginesFn;
        if (key === "stopEngine") return stopEngineFn;
        return () => Promise.resolve({});
      },
    },
  ),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, code: string, message: string) {
      super(message);
    }
  },
}));

vi.mock("@/i18n/i18n", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    key + (vars ? ":" + JSON.stringify(vars) : ""),
}));
vi.mock("@/i18n/errors", () => ({ apiErrorMessage: (_e: unknown, fallback: string) => fallback }));
vi.mock("@/stores/ui", () => ({ useUiStore: (sel: (s: unknown) => unknown) => sel({ showToast: () => {} }) }));
vi.mock("@/components/notes/notes-logic", () => ({ relTime: (iso: string) => iso ?? "—" }));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EngineSection, ENGINE_IDLE_TIMEOUT_KV } = await import("@/components/settings/engine-section");

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(EngineSection));
  });
  return { container, root };
}

function radio(container: Element, value: string): HTMLInputElement {
  return container.querySelector(`input[name="engine-idle-timeout"][value="${value}"]`);
}

async function flush() {
  await act(async () => {});
}

describe("引擎分区（2026-11-04）", () => {
  beforeEach(() => {
    getSettingsFn.mockReset().mockResolvedValue({ settings: {} });
    putSettingsFn.mockClear();
    listEnginesFn.mockReset().mockResolvedValue({ engines: [] });
    stopEngineFn.mockClear();
  });

  test("(a) 六档单选渲染；kv 缺省时默认 7 天选中", async () => {
    const { container } = mount();
    await flush();
    const values = [...container.querySelectorAll('input[name="engine-idle-timeout"]')].map((i) => i.value);
    expect(values).toEqual(["30", "60", "240", "1440", "10080", "never"]);
    expect(radio(container, "10080").checked).toBe(true);
  });

  test("(b) kv=never → 「永不」选中", async () => {
    getSettingsFn.mockResolvedValue({ settings: { [ENGINE_IDLE_TIMEOUT_KV]: "never" } });
    const { container } = mount();
    await flush();
    expect(radio(container, "never").checked).toBe(true);
  });

  test("(c) 换档调 putSettings 且键值正确", async () => {
    const { container } = mount();
    await flush();
    const opt = radio(container, "never");
    act(() => {
      opt.click();
    });
    await flush();
    expect(putSettingsFn).toHaveBeenCalledWith({ [ENGINE_IDLE_TIMEOUT_KV]: "never" });
  });

  test("(d) 进程列表渲染项目名与停止钮", async () => {
    listEnginesFn.mockResolvedValue({
      engines: [
        { projectPath: "/data/projects/alpha", state: "ready", pid: 42, restarts: 0, runningSessions: 0, lastActivityAt: 1793800000000 },
        { projectPath: "/data/projects/beta", state: "inactive", restarts: 0, runningSessions: 0, lastActivityAt: null },
      ],
    });
    const { container } = mount();
    await flush();
    expect(container.querySelector('[data-testid="engine-proc-row-alpha"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="engine-proc-stop-alpha"]')).toBeTruthy();
    expect(container.textContent).toContain("alpha");
  });

  test("(e) 运行回合>0：confirm 取消不调 stopEngine，确认则调", async () => {
    listEnginesFn.mockResolvedValue({
      engines: [{ projectPath: "/data/projects/busy", state: "ready", pid: 7, restarts: 0, runningSessions: 2, lastActivityAt: null }],
    });
    const confirmSpy = vi.spyOn(globalThis, "confirm");
    const { container } = mount();
    await flush();
    const btn = container.querySelector('[data-testid="engine-proc-stop-busy"]');

    confirmSpy.mockReturnValueOnce(false);
    btn.click();
    expect(stopEngineFn).not.toHaveBeenCalled();

    confirmSpy.mockReturnValueOnce(true);
    btn.click();
    await flush();
    expect(stopEngineFn).toHaveBeenCalledWith("/data/projects/busy");
    confirmSpy.mockRestore();
  });
});
