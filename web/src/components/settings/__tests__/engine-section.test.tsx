// @ts-nocheck
// 设置页「引擎」分区单测（2026-11-04 空闲回收配置化 + 进程管理）。环境说明同
// auth-section.test.tsx：@ts-nocheck + 被测模块动态 import + @happy-dom 全局注册 +
// api 整模块代理 mock。验收：(a) 六档单选渲染、缺省 7 天选中；(b) kv 为 never 时
// 「永不」选中；(c) 换档调 putSettings 且入参正确；(d) 进程列表每会话一行渲染
// （项目·会话/状态/停止钮；inactive 行灰显不误报 ready）；(e) 行内定向停以
// {sessionPath} 形态调 stopEngine（confirm 拦截保留）；(f) 头部「全部停止」按项目
// 去重以 {project} 形态调 stopEngine，仅 inactive 行时禁用。
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

  test("(d) 进程列表每会话一行：项目·会话短显；inactive 行灰显不误报 ready", async () => {
    listEnginesFn.mockResolvedValue({
      engines: [
        { projectPath: "/data/projects/alpha", sessionPath: "/store/alpha/s-aaa.jsonl", state: "ready", pid: 42, restarts: 0, runningSessions: 0, lastActivityAt: 1793800000000 },
        { projectPath: "/data/projects/alpha", sessionPath: "/store/alpha/s-bbb.jsonl", state: "ready", pid: 43, restarts: 0, runningSessions: 1, lastActivityAt: 1793800000000 },
        { projectPath: "/data/projects/beta", sessionPath: null, state: "inactive", restarts: 0, runningSessions: 0, lastActivityAt: null },
      ],
    });
    const { container } = mount();
    await flush();
    // 双会话双行 + inactive 项目行
    expect(container.querySelector('[data-testid="engine-proc-row-s-aaa"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="engine-proc-row-s-bbb"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="engine-proc-row-beta"]')).toBeTruthy();
    // 会话文件名短显（去 .jsonl 后缀）与项目名同展
    expect(container.textContent).toContain("alpha · s-aaa");
    expect(container.textContent).toContain("alpha · s-bbb");
    // 头部项目级停止入口保留
    expect(container.querySelector('[data-testid="engine-proc-stop-all"]')).toBeTruthy();
    // inactive 行灰显且不误报 ready/运行中（stale_state 对抗）
    const betaRow = container.querySelector('[data-testid="engine-proc-row-beta"]');
    expect(betaRow.className).toContain("opacity-50");
    expect(betaRow.textContent).toContain("engineStateInactive");
    expect(betaRow.textContent).not.toContain("engineStateReady");
    expect(betaRow.textContent).not.toContain("engineProcRunningSessions");
    const betaStop = container.querySelector('[data-testid="engine-proc-stop-beta"]') as HTMLButtonElement;
    expect(betaStop.disabled).toBe(true);
  });

  test("(e) 行内定向停：入参为 {sessionPath} 对象形态；confirm 取消不调，确认则调", async () => {
    listEnginesFn.mockResolvedValue({
      engines: [
        { projectPath: "/data/projects/alpha", sessionPath: "/store/alpha/s-aaa.jsonl", state: "ready", pid: 7, restarts: 0, runningSessions: 2, lastActivityAt: null },
        { projectPath: "/data/projects/alpha", sessionPath: "/store/alpha/s-bbb.jsonl", state: "ready", pid: 8, restarts: 0, runningSessions: 0, lastActivityAt: null },
      ],
    });
    const confirmSpy = vi.spyOn(globalThis, "confirm");
    const { container } = mount();
    await flush();
    // 空闲会话定向停：无需 confirm，入参必须是 {sessionPath} 形态（非仅按钮存在）
    const idleBtn = container.querySelector('[data-testid="engine-proc-stop-s-bbb"]') as HTMLButtonElement;
    idleBtn.click();
    await flush();
    expect(stopEngineFn).toHaveBeenCalledTimes(1);
    expect(stopEngineFn).toHaveBeenCalledWith({ sessionPath: "/store/alpha/s-bbb.jsonl" });
    expect(stopEngineFn).not.toHaveBeenCalledWith({ project: expect.anything() });

    // 忙会话定向停：confirm 取消不调，确认后仍以 {sessionPath} 形态定向
    stopEngineFn.mockClear();
    const busyBtn = container.querySelector('[data-testid="engine-proc-stop-s-aaa"]') as HTMLButtonElement;
    confirmSpy.mockReturnValueOnce(false);
    busyBtn.click();
    expect(stopEngineFn).not.toHaveBeenCalled();
    confirmSpy.mockReturnValueOnce(true);
    busyBtn.click();
    await flush();
    expect(stopEngineFn).toHaveBeenCalledWith({ sessionPath: "/store/alpha/s-aaa.jsonl" });
    confirmSpy.mockRestore();
  });

  test("(f) 全部停止：按项目去重以 {project} 形态调用；取消不调；仅 inactive 行时禁用", async () => {
    listEnginesFn.mockResolvedValue({
      engines: [
        { projectPath: "/data/projects/alpha", sessionPath: "/store/alpha/s-aaa.jsonl", state: "ready", pid: 1, restarts: 0, runningSessions: 1, lastActivityAt: null },
        { projectPath: "/data/projects/alpha", sessionPath: "/store/alpha/s-bbb.jsonl", state: "ready", pid: 2, restarts: 0, runningSessions: 0, lastActivityAt: null },
        { projectPath: "/data/projects/beta", sessionPath: "/store/beta/s-ccc.jsonl", state: "ready", pid: 3, restarts: 0, runningSessions: 0, lastActivityAt: null },
      ],
    });
    const confirmSpy = vi.spyOn(globalThis, "confirm");
    const { container } = mount();
    await flush();
    const stopAllBtn = container.querySelector('[data-testid="engine-proc-stop-all"]') as HTMLButtonElement;
    confirmSpy.mockReturnValueOnce(false);
    stopAllBtn.click();
    expect(stopEngineFn).not.toHaveBeenCalled();
    confirmSpy.mockReturnValueOnce(true);
    stopAllBtn.click();
    await flush();
    // alpha 两个会话只触发一次项目级停；beta 一次；共两次 {project} 形态
    expect(stopEngineFn).toHaveBeenCalledTimes(2);
    expect(stopEngineFn).toHaveBeenCalledWith({ project: "/data/projects/alpha" });
    expect(stopEngineFn).toHaveBeenCalledWith({ project: "/data/projects/beta" });
    expect(stopEngineFn).not.toHaveBeenCalledWith({ sessionPath: expect.anything() });
    confirmSpy.mockRestore();
  });

  test("(g) 仅 inactive 行时全部停止禁用", async () => {
    listEnginesFn.mockResolvedValue({
      engines: [{ projectPath: "/data/projects/beta", sessionPath: null, state: "inactive", restarts: 0, runningSessions: 0, lastActivityAt: null }],
    });
    const { container } = mount();
    await flush();
    const stopAllBtn = container.querySelector('[data-testid="engine-proc-stop-all"]') as HTMLButtonElement;
    expect(stopAllBtn.disabled).toBe(true);
  });
});
