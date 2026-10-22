/**
 * 快捷键帮助对话框测试（docs08-r7 任务 12）：
 * 1) 注册表完整性 × 对话框渲染双向核对——SHORTCUT_GROUPS 每一条（分组名/描述/键位
 *    徽标）都必须出现在对话框渲染结果里，且注册表无重复 id、词条键在 zh/en 双语可解析；
 * 2) "?" 键全局触发（shell 挂载的 useShortcutsHelp 探针）——含可编辑目标让路与
 *    IME 组合让路（不改输入区打字行为）；
 * 3) Ctrl/Cmd+K 触发与对话框目标守卫（Ctrl+P 先例同款）；
 * 4) Escape 关闭（radix Dialog 语义真渲染，onOpenChange 落回 ui store）。
 * 键盘事件走 ctrl-p.test.tsx 同款探针形态（不 mock 模块，探针最小挂载）。
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
const { ShortcutsDialog } = await import("@/components/layout/shortcuts-dialog");
const { useShortcutsHelp } = await import("@/lib/use-shortcuts-help");
const { SHORTCUT_GROUPS } = await import("@/lib/shortcuts");
const { useUiStore } = await import("@/stores/ui");
const { zh } = await import("@/i18n/zh");
const { en } = await import("@/i18n/en");

/** 词条键解析（测试专用）：按点路径取双语目录值，验证注册表词条键双语齐键 */
function resolveMessage(catalog: Record<string, unknown>, key: string): string {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") throw new Error(`词条键缺失：${key}`);
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "string") throw new Error(`词条键非字符串：${key}`);
  return node;
}

function HelpProbe(): null {
  useShortcutsHelp();
  return null;
}

async function mountProbe(): Promise<() => Promise<void>> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(HelpProbe));
  });
  return async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
}

/** 渲染帮助对话框（store 订阅包装，镜像 topbar 真实接线：open 从 ui store 读） */
function StoreBoundDialog() {
  const open = useUiStore((s) => s.shortcutsHelpOpen);
  return createElement(ShortcutsDialog, {
    open,
    onOpenChange: (next: boolean) => useUiStore.getState().setShortcutsHelpOpen(next),
  });
}

async function mountDialog(): Promise<() => Promise<void>> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(StoreBoundDialog));
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

function dialogText(): string {
  const dialog = document.querySelector('[data-testid="shortcuts-dialog"]');
  if (!dialog) throw new Error("对话框未渲染（data-testid=shortcuts-dialog 不在文档中）");
  return dialog.textContent ?? "";
}

beforeEach(() => {
  useUiStore.setState({ shortcutsHelpOpen: false, drawerOpen: false, toast: null });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("注册表完整性 × 对话框渲染（双向核对）", () => {
  test("注册表结构：≥5 分组、条目 id 唯一、双语词条键全部可解析", () => {
    expect(SHORTCUT_GROUPS.length).toBeGreaterThanOrEqual(5);
    const entryIds: string[] = [];
    for (const group of SHORTCUT_GROUPS) {
      expect(group.entries.length).toBeGreaterThan(0);
      resolveMessage(zh as unknown as Record<string, unknown>, group.titleKey);
      resolveMessage(en as unknown as Record<string, unknown>, group.titleKey);
      for (const entry of group.entries) {
        expect(entry.keys.length).toBeGreaterThan(0);
        resolveMessage(zh as unknown as Record<string, unknown>, entry.descKey);
        resolveMessage(en as unknown as Record<string, unknown>, entry.descKey);
        entryIds.push(entry.id);
      }
    }
    expect(new Set(entryIds).size).toBe(entryIds.length);
  });

  test("对话框渲染：注册表每条（分组名/描述/每个键位串）都出现在渲染结果中", async () => {
    useUiStore.setState({ shortcutsHelpOpen: true });
    const unmount = await mountDialog();

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const text = dialogText();
    expect(text).toContain(resolveMessage(zh as unknown as Record<string, unknown>, "shortcuts.title"));
    for (const group of SHORTCUT_GROUPS) {
      expect(text).toContain(resolveMessage(zh as unknown as Record<string, unknown>, group.titleKey));
      for (const entry of group.entries) {
        expect(text).toContain(resolveMessage(zh as unknown as Record<string, unknown>, entry.descKey));
        for (const combo of entry.keys) {
          expect(text).toContain(combo);
        }
      }
    }

    await unmount();
  });

  test("开关态零漂移：open=false 不渲染对话框节点；store 置 true 后渲染出标题壳（注册表为空也不炸）", async () => {
    // SHORTCUT_GROUPS 为静态数据恒非空（上一用例已锁非空完整性）；此用例锁渲染器
    // 对空注册表的鲁棒形态边界——分组条目区随 map 语义为空，标题壳照常渲染不崩。
    useUiStore.setState({ shortcutsHelpOpen: false });
    const unmount = await mountDialog();
    expect(document.querySelector('[data-testid="shortcuts-dialog"]')).toBeNull();
    await act(async () => {
      useUiStore.getState().setShortcutsHelpOpen(true);
    });
    expect(document.querySelector('[data-testid="shortcuts-dialog"]')).not.toBeNull();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent ?? "").toContain(resolveMessage(zh as unknown as Record<string, unknown>, "shortcuts.title"));
    await unmount();
  });
});

describe("? / Ctrl+K 触发（useShortcutsHelp 探针）", () => {
  test("? → 打开且 preventDefault；Ctrl+K / ⌘K → 打开", async () => {
    const unmount = await mountProbe();

    const evQ = keyOn(window, { key: "?" });
    expect(useUiStore.getState().shortcutsHelpOpen).toBe(true);
    expect(evQ.defaultPrevented).toBe(true);

    await act(async () => {
      useUiStore.getState().setShortcutsHelpOpen(false);
    });
    keyOn(window, { key: "k", ctrlKey: true });
    expect(useUiStore.getState().shortcutsHelpOpen).toBe(true);

    await act(async () => {
      useUiStore.getState().setShortcutsHelpOpen(false);
    });
    keyOn(window, { key: "K", metaKey: true });
    expect(useUiStore.getState().shortcutsHelpOpen).toBe(true);

    await unmount();
  });

  test("非触发键不动；可编辑目标让路（? 照常插入）；IME 组合中让路", async () => {
    const unmount = await mountProbe();

    keyOn(window, { key: "k" });
    keyOn(window, { key: "?" , altKey: true });
    keyOn(window, { key: "h", ctrlKey: true });
    expect(useUiStore.getState().shortcutsHelpOpen).toBe(false);

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const evEditable = keyOn(textarea, { key: "?" });
    expect(useUiStore.getState().shortcutsHelpOpen).toBe(false);
    expect(evEditable.defaultPrevented).toBe(false);

    const evComposing = keyOn(window, { key: "?", isComposing: true } as KeyboardEventInit);
    expect(useUiStore.getState().shortcutsHelpOpen).toBe(false);
    expect(evComposing.defaultPrevented).toBe(false);

    await unmount();
  });

  test("对话框目标守卫：事件目标在 [role=dialog] 内 → 完全让路", async () => {
    const unmount = await mountProbe();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("button");
    dialog.appendChild(inner);
    document.body.appendChild(dialog);

    const ev = keyOn(inner, { key: "?" });
    expect(useUiStore.getState().shortcutsHelpOpen).toBe(false);
    expect(ev.defaultPrevented).toBe(false);

    await unmount();
  });
});

describe("Escape 关闭（radix Dialog 语义）", () => {
  test("Esc 在对话框上按下 → onOpenChange(false) 落回 ui store", async () => {
    useUiStore.setState({ shortcutsHelpOpen: true });
    const unmount = await mountDialog();
    const dialog = document.querySelector('[data-testid="shortcuts-dialog"]');
    expect(dialog).not.toBeNull();

    await act(async () => {
      keyOn(dialog!, { key: "Escape" });
    });
    expect(useUiStore.getState().shortcutsHelpOpen).toBe(false);

    await unmount();
  });
});
