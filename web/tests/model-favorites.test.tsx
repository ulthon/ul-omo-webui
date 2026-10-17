/**
 * 模型弹层收藏组测试（CLI settings.json 收藏在 webui 的只读展示）：
 * 置顶渲染（不在 models 列表的收藏也照常渲染）、点击选中、搜索过滤、
 * 无收藏不渲染；空态判定 = 普通分组与收藏组全空。
 * radix Popover mock 同 model-thinking-chips.test.tsx（受控透传，modelPickerOpen 置位即开）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createContext, useContext, type ReactNode } from "react";
import type { ModelInfo } from "@/lib/api";

// bun test 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// radix Popover 透传化：Root 下发 open 上下文，Content 按上下文条件渲染（未受控 = 恒开）
const OpenContext = createContext(true);
vi.mock("@/components/ui/popover", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Popover = ({ open, children }: { open?: boolean; children?: ReactNode }) => (
    <OpenContext.Provider value={open ?? true}>{children}</OpenContext.Provider>
  );
  const PopoverContent = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => {
    const open = useContext(OpenContext);
    if (!open) return null;
    // 字面 data-testid 置于展开之后：组件透传的 testid 不顶掉测试锚点
    return <div {...(rest as object)} data-testid="popover-content">{children}</div>;
  };
  return { Popover, PopoverTrigger: Passthrough, PopoverClose: Passthrough, PopoverContent };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { ModelChip } = await import("@/components/composer/chips");
const { useUiStore } = await import("@/stores/ui");
const { cancelPendingPreferencePersist } = await import("@/lib/preferences");

function model(extra?: Partial<ModelInfo>): ModelInfo {
  return { provider: "zai-coding-cn", id: "glm-5.3-flash", contextWindow: 1000, reasoning: true, ...extra };
}

async function render(ui: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function el(root: ParentNode, testid: string): HTMLElement | null {
  return root.querySelector(`[data-testid=${testid}]`);
}

async function type(root: ParentNode, value: string): Promise<void> {
  const input = el(root, "model-chip-search") as HTMLInputElement | null;
  if (!input) throw new Error("搜索框未渲染");
  await act(async () => {
    // 绕过 React 受控 input 的 value tracker（直接赋 .value 会被去重不触发 onChange）
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  useUiStore.setState({
    models: [],
    modelsLoaded: true,
    favoriteModels: [],
    selectedModel: null,
    selectedThinkingLevel: null,
    modelPickerOpen: true,
    currentProject: "/p1",
    projects: [{ projectPath: "/p1", preferredModel: null, lastOpenedAt: null }],
    toast: null,
  });
});

afterEach(async () => {
  cancelPendingPreferencePersist();
  document.body.innerHTML = "";
});

describe("模型弹层收藏组", () => {
  test("置顶渲染：收藏组在 provider 分组之前，不在 models 列表的收藏也照常渲染", async () => {
    useUiStore.setState({
      models: [model()],
      favoriteModels: [
        "zai-coding-cn/glm-5.3",
        "zai-coding-cn/glm-5.3-4k",
        "commandcode/deepseek/deepseek-v4.1-flash",
      ],
      selectedModel: "zai-coding-cn/glm-5.3-flash",
    });
    const { container, unmount } = await render(createElement(ModelChip));
    const favs = [...container.querySelectorAll("[data-testid=model-chip-fav-item]")];
    expect(favs.map((n) => n.getAttribute("data-value"))).toEqual([
      "zai-coding-cn/glm-5.3",
      "zai-coding-cn/glm-5.3-4k",
      "commandcode/deepseek/deepseek-v4.1-flash",
    ]);
    // 展示名取首个 "/" 后的模型段
    expect(favs[1]?.textContent).toContain("glm-5.3-4k");
    // 收藏组标题与普通分组并存
    expect(container.textContent).toContain("收藏");
    expect(container.querySelectorAll("[data-testid=model-chip-item]")).toHaveLength(1);
    // 收藏组位于第一个普通分组之前
    const firstFav = favs[0];
    const firstItem = container.querySelector("[data-testid=model-chip-item]");
    if (firstFav && firstItem) {
      expect(firstFav.compareDocumentPosition(firstItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    await unmount();
  });

  test("点击收藏项 → 写入 selectedModel", async () => {
    useUiStore.setState({
      models: [model()],
      favoriteModels: ["zai-coding-cn/glm-5.3-4k"],
      selectedModel: "zai-coding-cn/glm-5.3-flash",
    });
    const { container, unmount } = await render(createElement(ModelChip));
    const item = container.querySelector(
      '[data-testid=model-chip-fav-item][data-value="zai-coding-cn/glm-5.3-4k"]',
    ) as HTMLButtonElement;
    await act(async () => {
      item.click();
    });
    expect(useUiStore.getState().selectedModel).toBe("zai-coding-cn/glm-5.3-4k");
    await unmount();
  });

  test("搜索过滤收藏组（按整串子串匹配）", async () => {
    useUiStore.setState({
      models: [model()],
      favoriteModels: ["zai-coding-cn/glm-5.3", "zai-coding-cn/glm-5.3-4k"],
      selectedModel: null,
    });
    const { container, unmount } = await render(createElement(ModelChip));
    await type(container, "4k");
    const favs = [...container.querySelectorAll("[data-testid=model-chip-fav-item]")];
    expect(favs.map((n) => n.getAttribute("data-value"))).toEqual(["zai-coding-cn/glm-5.3-4k"]);
    await unmount();
  });

  test("无收藏：收藏组不渲染；列表与收藏全空才显示空态，仅有收藏不算空态", async () => {
    useUiStore.setState({ models: [], favoriteModels: [], selectedModel: null });
    const { container, unmount } = await render(createElement(ModelChip));
    expect(container.querySelectorAll("[data-testid=model-chip-fav-item]")).toHaveLength(0);
    expect(el(container, "model-chip-empty")?.textContent).toContain("无匹配模型");
    await unmount();

    // 首次卸载的清理会把 modelPickerOpen 复位 false，二次渲染前补置打开态
    useUiStore.setState({ modelPickerOpen: true, favoriteModels: ["zai-coding-cn/glm-5.3"] });
    const { container: c2, unmount: u2 } = await render(createElement(ModelChip));
    expect(el(c2, "model-chip-empty")).toBeNull();
    expect(c2.querySelectorAll("[data-testid=model-chip-fav-item]")).toHaveLength(1);
    await u2();
  });
});
