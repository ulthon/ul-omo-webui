/**
 * Ctrl+P 快捷键测试（W2 todo 8）：shell 挂载的全局 keydown 打开输入区模型弹层。
 * 重点覆盖 Oracle 低-7 对话框守卫（事件目标在 [role=dialog] 内时完全让路）。
 * 被测对象是 shell.tsx 导出的 useCtrlPModelPicker hook——挂最小探针组件验证，
 * 不 mock 模块（bun mock.module 进程级粘滞，会污染同进程后跑的 bootstrap/events 测试）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// bun test 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { useCtrlPModelPicker } = await import("@/pages/shell");
const { useUiStore } = await import("@/stores/ui");

function Probe(): null {
  useCtrlPModelPicker();
  return null;
}

async function mountProbe(): Promise<() => Promise<void>> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });
  return async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
}

function keyOn(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  useUiStore.setState({
    models: [{ provider: "p", id: "m1", contextWindow: 1, reasoning: false }],
    modelsLoaded: true,
    selectedModel: "p/m1",
    selectedThinkingLevel: null,
    modelPickerOpen: false,
    drawerOpen: false,
    toast: null,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Ctrl+P 打开模型弹层（含对话框守卫）", () => {
  test("Ctrl+P / Cmd+P → 打开弹层并 preventDefault（压掉浏览器打印）", async () => {
    const unmount = await mountProbe();

    const ev = keyOn(window, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().modelPickerOpen).toBe(true);
    expect(ev.defaultPrevented).toBe(true);

    await act(async () => {
      useUiStore.getState().setModelPickerOpen(false);
    });
    const evMac = keyOn(window, { key: "P", metaKey: true });
    expect(useUiStore.getState().modelPickerOpen).toBe(true);
    expect(evMac.defaultPrevented).toBe(true);

    // 非 Ctrl/Cmd 或非 p：不动
    await act(async () => {
      useUiStore.getState().setModelPickerOpen(false);
    });
    keyOn(window, { key: "p" });
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
    keyOn(window, { key: "x", ctrlKey: true });
    expect(useUiStore.getState().modelPickerOpen).toBe(false);

    await unmount();
  });

  test("对话框守卫：事件目标在 [role=dialog] 内 → 完全让路（不开、不 preventDefault）", async () => {
    const unmount = await mountProbe();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("button");
    dialog.appendChild(inner);
    document.body.appendChild(dialog);

    const ev = keyOn(inner, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
    expect(ev.defaultPrevented).toBe(false);

    await unmount();
  });

  test("无可用模型（确认为空）→ preventDefault 但不打开弹层", async () => {
    useUiStore.setState({ models: [], modelsLoaded: true });
    const unmount = await mountProbe();

    const ev = keyOn(window, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
    expect(ev.defaultPrevented).toBe(true);

    await unmount();
  });
});
