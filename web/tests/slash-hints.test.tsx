// SlashHints 斜杠提示组件测试（docs08-r5 任务 7）：移动端消费 AnchoredPanel inline
// 档——流内形态断言（data-presentation=inline、非 fixed、w-full）+ 三段渲染/受控高亮
// + 开合与点选语义（Esc 截停关闭、外点关闭、textarea 锚豁免不关闭、点选回调）。
// 键盘上下/回车导航在宿主 composer keystroke 域（本任务零改动，浏览器 QA 覆盖）。
import { describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// bun test 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { SlashHints } = await import("@/components/composer/slash-hints");
import type { CommandsResponse } from "@/lib/api";
import type { SlashItem, SlashSection } from "@/components/composer/composer-logic";

const SHEET_QUERY = "(max-width: 639.98px)";

const DATA: CommandsResponse = {
  project: "/p",
  available: true,
  commands: {
    extension: [
      { name: "init", source: "extension", description: "Initialize" },
      { name: "history", source: "extension" },
    ],
    skill: [{ name: "skill:git-master", source: "skill", description: "Git 操作" }],
    prompt: [{ name: "doctor", source: "prompt" }],
  },
};

const EMPTY_GROUPS: Record<SlashSection, SlashItem[]> = { extension: [], skill: [], prompt: [], webui: [] };

interface SlashHandle {
  panel: HTMLElement;
  /** 锚元素（textarea，外点豁免断言用） */
  anchor: HTMLTextAreaElement;
  onCloseCount: () => number;
  selected: SlashItem[];
  unmount: () => void;
}

/** stub matchMedia（命中手机档断点）渲染 SlashHints：inline 档生效路径。
 *  groups 补 webui 缺省（docs08-r5 任务 8 新段；本文件用三段字面量构造） */
function renderHints(groups: Record<SlashSection, SlashItem[]>, highlight = 0): SlashHandle {
  const fullGroups: Record<SlashSection, SlashItem[]> = { webui: [], ...groups };
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((query: string) =>
    ({
      matches: query === SHEET_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  const anchor = document.createElement("textarea");
  document.body.appendChild(anchor);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const selected: SlashItem[] = [];
  let onCloseCalls = 0;
  try {
    act(() => {
      root.render(
        createElement(SlashHints, {
          anchor,
          groups: fullGroups,
          highlight,
          onSelect: (item: SlashItem) => {
            selected.push(item);
          },
          onClose: () => {
            onCloseCalls += 1;
          },
        }),
      );
    });
  } finally {
    window.matchMedia = real;
  }
  const panel = host.querySelector<HTMLElement>('[data-testid="slash-hints"]');
  if (!panel) throw new Error("slash-hints 未渲染");
  return { panel, anchor, onCloseCount: () => onCloseCalls, selected, unmount: () => act(() => root.unmount()) };
}

describe("SlashHints 移动端 inline 档（docs08-r5 任务 7）", () => {
  test("inline 流内形态：data-presentation=inline、非 fixed、w-full、圆角/边框/影、无 sheet 拖拽条", () => {
    const { panel, unmount } = renderHints(DATA.commands);
    try {
      expect(panel.dataset.presentation).toBe("inline");
      expect(panel.style.position).not.toBe("fixed");
      expect(panel.style.width).toBe("100%");
      expect(panel.classList.contains("w-full")).toBe(true);
      expect(panel.classList.contains("rounded-lg")).toBe(true);
      expect(panel.classList.contains("ring-1")).toBe(true);
      expect(panel.classList.contains("shadow-md")).toBe(true);
      expect(panel.querySelector('[data-presentation="sheet"]')).toBeNull();
      // 无 sheet 顶部拖拽条：首子元素是 listbox 内容区
      expect(panel.firstElementChild?.getAttribute("role")).toBe("listbox");
    } finally {
      unmount();
    }
  });

  test("三段渲染 + 分组头 + 受控高亮（扁平序下标 aria-selected/data-highlighted）", () => {
    const { panel, unmount } = renderHints(DATA.commands, 1);
    try {
      const labels = [...panel.querySelectorAll("p")].map((p) => p.textContent);
      expect(labels).toContain("引擎命令");
      expect(labels).toContain("技能");
      expect(labels).toContain("用户提示");
      expect(panel.querySelector('[data-testid="slash-item-init"]')).not.toBeNull();
      expect(panel.querySelector('[data-testid="slash-item-skill:git-master"]')).not.toBeNull();
      expect(panel.querySelector('[data-testid="slash-item-doctor"]')).not.toBeNull();
      // highlight=1 → 第二行（history）高亮，首行不高亮
      const first = panel.querySelector<HTMLButtonElement>('[data-testid="slash-item-init"]')!;
      const second = panel.querySelector<HTMLButtonElement>('[data-testid="slash-item-history"]')!;
      expect(first.getAttribute("aria-selected")).toBe("false");
      expect(first.hasAttribute("data-highlighted")).toBe(false);
      expect(second.getAttribute("aria-selected")).toBe("true");
      expect(second.hasAttribute("data-highlighted")).toBe(true);
    } finally {
      unmount();
    }
  });

  test("点选：click 回调 onSelect 携带条目对象", () => {
    const { panel, selected, unmount } = renderHints(DATA.commands, 0);
    try {
      const row = panel.querySelector<HTMLButtonElement>('[data-testid="slash-item-init"]')!;
      act(() => {
        row.click();
      });
      expect(selected).toHaveLength(1);
      expect(selected[0]!.name).toBe("init");
    } finally {
      unmount();
    }
  });

  test("开合语义：Esc 截停关闭、外点关闭、textarea 锚豁免不关闭", () => {
    const { panel, anchor, onCloseCount, unmount } = renderHints(DATA.commands, 0);
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(onCloseCount()).toBe(1);
      const outsider = document.createElement("div");
      document.body.appendChild(outsider);
      outsider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(onCloseCount()).toBe(2);
      // 锚豁免保留：textarea（宿主输入框）点击不关闭
      anchor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(onCloseCount()).toBe(2);
      // 面板内点击不关闭
      panel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(onCloseCount()).toBe(2);
      outsider.remove();
    } finally {
      unmount();
    }
  });

  test("空态：无匹配命令占位仍在 inline 面板内渲染", () => {
    const { panel, unmount } = renderHints(EMPTY_GROUPS, 0);
    try {
      expect(panel.dataset.presentation).toBe("inline");
      const empty = panel.querySelector('[data-testid="slash-empty"]');
      expect(empty?.textContent).toBe("无匹配命令");
    } finally {
      unmount();
    }
  });
});
