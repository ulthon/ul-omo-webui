/**
 * 模型快捷键测试（r9 2026-10-26 批次，对齐 native 键位；由 ctrl-p.test.tsx 演进而来，
 * 旧「Ctrl+P 开弹层」断言随键位语义变更被本文件取代）：
 * - Ctrl/Cmd+P 正向、Shift+Ctrl/Cmd+P 反向在 CLI 收藏内 wrap 循环（useModelShortcuts 探针）
 * - 无收藏 → toast 提示 + 打开弹层兜底
 * - Ctrl/Cmd+L 打开弹层；焦点在 textarea 内仍触发且 preventDefault（不向输入区漏字符）
 * - 对话框守卫（[role=dialog] 目标完全让路）与「确认为空不动作」守卫沿用 Ctrl+P 时代语义
 * - 收藏两次按键间变更 → 下一次按键立即按新表循环（无旧快照）；nextFavoriteModel 直测
 * 键盘事件沿用探针形态（不 mock 模块，探针最小挂载）。
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
const { useModelShortcuts } = await import("@/pages/shell");
const { useUiStore } = await import("@/stores/ui");
const { nextFavoriteModel } = await import("@/lib/model-cycle");
const { cancelPendingPreferencePersist } = await import("@/lib/preferences");
const { t } = await import("@/i18n/i18n");

function Probe(): null {
  useModelShortcuts();
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

const FAVS = ["p/m1", "p/m2", "p/m3"];

beforeEach(() => {
  useUiStore.setState({
    models: [{ provider: "p", id: "m1", contextWindow: 1, reasoning: false }],
    modelsLoaded: true,
    favoriteModels: [...FAVS],
    selectedModel: "p/m2",
    selectedThinkingLevel: null,
    modelPickerOpen: false,
    shortcutsHelpOpen: false,
    drawerOpen: false,
    toasts: [],
    currentProject: null,
    projects: [],
  });
});

afterEach(async () => {
  cancelPendingPreferencePersist();
  document.body.innerHTML = "";
});

describe("Ctrl+P / Shift+Ctrl+P 循环收藏（useModelShortcuts 探针）", () => {
  test("QA1 正向：3 收藏从当前切下一条，尾 wrap 回首；⌘P 同效", async () => {
    const unmount = await mountProbe();

    keyOn(window, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m3");
    keyOn(window, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m1");
    keyOn(window, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m2");

    // 循环不开弹层、不弹提示
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
    expect(useUiStore.getState().toasts).toHaveLength(0);

    // Mac ⌘P 同效
    useUiStore.setState({ selectedModel: "p/m1" });
    keyOn(window, { key: "p", metaKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m2");

    await unmount();
  });

  test("QA2 反向：Shift+Ctrl+P 反向 wrap；Shift+⌘P 同效", async () => {
    const unmount = await mountProbe();

    keyOn(window, { key: "P", ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m1");
    keyOn(window, { key: "P", ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m3");
    keyOn(window, { key: "P", ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m2");

    useUiStore.setState({ selectedModel: "p/m3" });
    keyOn(window, { key: "P", metaKey: true, shiftKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m2");

    await unmount();
  });

  test("QA3 无收藏 → toast 提示 + 打开弹层兜底，选中不变（正反向同路）", async () => {
    useUiStore.setState({ favoriteModels: [] });
    const unmount = await mountProbe();

    const ev = keyOn(window, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().modelPickerOpen).toBe(true);
    expect(useUiStore.getState().toasts).toHaveLength(1);
    expect(useUiStore.getState().toasts[0]?.text).toBe(t("shortcuts.noFavoritesToast"));
    expect(useUiStore.getState().selectedModel).toBe("p/m2");
    expect(ev.defaultPrevented).toBe(true);

    useUiStore.setState({ modelPickerOpen: false, toasts: [] });
    keyOn(window, { key: "P", ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().modelPickerOpen).toBe(true);
    expect(useUiStore.getState().toasts).toHaveLength(1);
    expect(useUiStore.getState().selectedModel).toBe("p/m2");

    await unmount();
  });

  test("当前不在收藏内：正向取首、反向取尾；单收藏循环同值不重复写", async () => {
    useUiStore.setState({ favoriteModels: ["p/a", "p/b"], selectedModel: "q/other" });
    const unmount = await mountProbe();

    keyOn(window, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/a");

    useUiStore.setState({ selectedModel: "q/other" });
    keyOn(window, { key: "P", ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/b");

    // 单收藏且已是选中：循环原地不动（同值不写、无提示、不开弹层）
    useUiStore.setState({ favoriteModels: ["p/only"], selectedModel: "p/only" });
    keyOn(window, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/only");
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
    expect(useUiStore.getState().toasts).toHaveLength(0);

    await unmount();
  });

  test("stale state：两次按键间收藏变更 → 下一次按键立即按新表循环", async () => {
    useUiStore.setState({ favoriteModels: ["p/m1", "p/m2"], selectedModel: "p/m1" });
    const unmount = await mountProbe();

    keyOn(window, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m2");

    // 列表热替换（SSE/刷新同型）：当前选中落到新表首位，再按须按新表走到 p/m3
    useUiStore.setState({ favoriteModels: ["p/m2", "p/m3"] });
    keyOn(window, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m3");

    await unmount();
  });
});

describe("Ctrl+L 打开模型选择弹层", () => {
  test("QA4 Ctrl+L 开弹层；焦点在 textarea 内仍触发且 preventDefault、不输入字符", async () => {
    const unmount = await mountProbe();

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    const ev = keyOn(textarea, { key: "l", ctrlKey: true });
    expect(useUiStore.getState().modelPickerOpen).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    expect(textarea.value).toBe("");

    useUiStore.setState({ modelPickerOpen: false });
    keyOn(window, { key: "l", metaKey: true });
    expect(useUiStore.getState().modelPickerOpen).toBe(true);

    await unmount();
  });

  test("非触发键不动（裸 p / 裸 l / Ctrl+X / Shift+P）", async () => {
    const unmount = await mountProbe();

    for (const init of [
      { key: "p" },
      { key: "l" },
      { key: "x", ctrlKey: true },
      { key: "P", shiftKey: true },
    ] as KeyboardEventInit[]) {
      keyOn(window, init);
    }
    expect(useUiStore.getState().selectedModel).toBe("p/m2");
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
    expect(useUiStore.getState().toasts).toHaveLength(0);

    await unmount();
  });
});

describe("守卫沿用（Ctrl+P 时代语义）", () => {
  test("对话框守卫：目标在 [role=dialog] 内 → 循环/反向/开弹层都完全让路", async () => {
    const unmount = await mountProbe();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("button");
    dialog.appendChild(inner);
    document.body.appendChild(dialog);

    const evCycle = keyOn(inner, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m2");
    expect(evCycle.defaultPrevented).toBe(false);

    const evBack = keyOn(inner, { key: "P", ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m2");
    expect(evBack.defaultPrevented).toBe(false);

    const evPicker = keyOn(inner, { key: "l", ctrlKey: true });
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
    expect(evPicker.defaultPrevented).toBe(false);

    await unmount();
  });

  test("确认为空守卫：modelsLoaded 且 models 空 → preventDefault 但不切/不开/不提示", async () => {
    useUiStore.setState({ models: [], modelsLoaded: true });
    const unmount = await mountProbe();

    const evCycle = keyOn(window, { key: "p", ctrlKey: true });
    expect(useUiStore.getState().selectedModel).toBe("p/m2");
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
    expect(useUiStore.getState().toasts).toHaveLength(0);
    expect(evCycle.defaultPrevented).toBe(true);

    const evPicker = keyOn(window, { key: "l", ctrlKey: true });
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
    expect(evPicker.defaultPrevented).toBe(true);

    await unmount();
  });
});

describe("nextFavoriteModel 纯函数", () => {
  test("空表 → null；selectedModel null → 正向取首、反向取尾", () => {
    expect(nextFavoriteModel([], "p/m1", 1)).toBeNull();
    expect(nextFavoriteModel([], null, -1)).toBeNull();
    expect(nextFavoriteModel(["p/a", "p/b"], null, 1)).toBe("p/a");
    expect(nextFavoriteModel(["p/a", "p/b"], null, -1)).toBe("p/b");
  });

  test("wrap：正向尾部回首、反向头部到尾", () => {
    const list = ["p/a", "p/b", "p/c"];
    expect(nextFavoriteModel(list, "p/c", 1)).toBe("p/a");
    expect(nextFavoriteModel(list, "p/a", -1)).toBe("p/c");
    expect(nextFavoriteModel(list, "p/a", 1)).toBe("p/b");
    expect(nextFavoriteModel(list, "p/b", -1)).toBe("p/a");
  });

  test("归一定位：大小写与首尾空白不阻断当前项匹配", () => {
    expect(nextFavoriteModel(["P/M1", "p/m2"], " p/m1 ", 1)).toBe("p/m2");
  });
});
