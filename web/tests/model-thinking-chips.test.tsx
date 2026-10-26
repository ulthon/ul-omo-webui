/**
 * 输入区模型 / 思考 chip 组件测试（W2 todo 8）。
 * radix Popover 原语 mock 为受控透传（open 上下文门控内容渲染）；chips 逻辑层
 * （store / 偏好防抖）为真实实现，防抖计时在 preferences.test 单独覆盖，此处
 * afterEach 取消未落定写入防跨用例泄漏。
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
const { ModelChip, ThinkingChip } = await import("@/components/composer/chips");
const { useUiStore } = await import("@/stores/ui");
const { cancelPendingPreferencePersist } = await import("@/lib/preferences");

const ORIGINAL_FETCH = globalThis.fetch;

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
    modelsLoaded: false,
    selectedModel: null,
    selectedThinkingLevel: null,
    modelPickerOpen: false,
    currentProject: "/p1",
    projects: [{ projectPath: "/p1", preferredModel: null, lastOpenedAt: null }],
    toast: null,
  });
});

afterEach(async () => {
  cancelPendingPreferencePersist();
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("思考 chip", () => {
  test("模型未下发 supportedThinkingLevels → 整体不渲染（缺席即隐藏，非禁用）", async () => {
    useUiStore.setState({
      models: [model()],
      modelsLoaded: true,
      selectedModel: "zai-coding-cn/glm-5.3-flash",
    });
    const { container, unmount } = await render(createElement(ThinkingChip));
    expect(el(container, "thinking-chip")).toBeNull();
    await unmount();
  });

  test("支持档过滤到服务端集合（off 被剔除），当前档高亮", async () => {
    useUiStore.setState({
      models: [model({ supportedThinkingLevels: ["off", "low", "high", "max"] })],
      modelsLoaded: true,
      selectedModel: "zai-coding-cn/glm-5.3-flash",
      selectedThinkingLevel: "high",
    });
    const { container, unmount } = await render(createElement(ThinkingChip));
    const chip = el(container, "thinking-chip");
    expect(chip).not.toBeNull();
    expect(el(container, "thinking-chip-label")?.textContent).toBe("high");
    const values = [...container.querySelectorAll("[data-testid=thinking-chip-item]")].map((n) =>
      n.getAttribute("data-value"),
    );
    expect(values).toEqual(["low", "high", "max"]);
    // 44px 触控目标
    expect(chip?.className).toContain("min-h-11");
    await unmount();
  });

  test("过滤后为空（仅 off）→ 整体不渲染", async () => {
    useUiStore.setState({
      models: [model({ supportedThinkingLevels: ["off"] })],
      modelsLoaded: true,
      selectedModel: "zai-coding-cn/glm-5.3-flash",
    });
    const { container, unmount } = await render(createElement(ThinkingChip));
    expect(el(container, "thinking-chip")).toBeNull();
    await unmount();
  });

  test("点选档位写入 store（防抖 PATCH 由 preferences.test 覆盖）", async () => {
    useUiStore.setState({
      models: [model({ supportedThinkingLevels: ["low", "high", "max"] })],
      modelsLoaded: true,
      selectedModel: "zai-coding-cn/glm-5.3-flash",
    });
    const { container, unmount } = await render(createElement(ThinkingChip));
    const item = container.querySelector('[data-testid=thinking-chip-item][data-value="max"]') as HTMLButtonElement;
    await act(async () => {
      item.click();
    });
    expect(useUiStore.getState().selectedThinkingLevel).toBe("max");
    expect(el(container, "thinking-chip-label")?.textContent).toBe("max");
    await unmount();
  });

  test("未选档显示「默认」", async () => {
    useUiStore.setState({
      models: [model({ supportedThinkingLevels: ["low", "high", "max"] })],
      modelsLoaded: true,
      selectedModel: "zai-coding-cn/glm-5.3-flash",
      selectedThinkingLevel: null,
    });
    const { container, unmount } = await render(createElement(ThinkingChip));
    expect(el(container, "thinking-chip-label")?.textContent).toBe("默认");
    await unmount();
  });
});

describe("模型 chip", () => {
  test("收起态：显示当前模型 label，弹层内容不渲染", async () => {
    useUiStore.setState({
      models: [model(), model({ provider: "openrouter", id: "claude-x" })],
      modelsLoaded: true,
      selectedModel: "zai-coding-cn/glm-5.3-flash",
      modelPickerOpen: false,
    });
    const { container, unmount } = await render(createElement(ModelChip));
    expect(el(container, "model-chip")?.textContent).toContain("glm-5.3-flash");
    expect(container.querySelector("[data-testid=popover-content]")).toBeNull();
    // 44px 触控目标
    expect(el(container, "model-chip")?.className).toContain("min-h-11");
    await unmount();
  });

  test("Ctrl+L 置位打开态 → 弹层渲染 provider 分组列表（与顶栏同款镜像）", async () => {
    useUiStore.setState({
      models: [model(), model({ provider: "openrouter", id: "claude-x" })],
      modelsLoaded: true,
      selectedModel: "zai-coding-cn/glm-5.3-flash",
      modelPickerOpen: true,
    });
    const { container, unmount } = await render(createElement(ModelChip));
    const content = container.querySelector("[data-testid=popover-content]");
    expect(content).not.toBeNull();
    const texts = [...content!.querySelectorAll("div")].map((n) => n.textContent);
    expect(texts.some((t) => t === "zai-coding-cn")).toBe(true);
    expect(texts.some((t) => t === "openrouter")).toBe(true);
    const items = [...container.querySelectorAll("[data-testid=model-chip-item]")];
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("data-value")).toBe("zai-coding-cn/glm-5.3-flash");
    await unmount();
  });

  test("键入即过滤（provider/model 子串，大小写不敏感），无匹配显示空态", async () => {
    useUiStore.setState({
      models: [model(), model({ provider: "openrouter", id: "claude-x" })],
      modelsLoaded: true,
      selectedModel: null,
      modelPickerOpen: true,
    });
    const { container, unmount } = await render(createElement(ModelChip));
    await type(container, "CLAUDE");
    let items = [...container.querySelectorAll("[data-testid=model-chip-item]")];
    expect(items).toHaveLength(1);
    expect(items[0].getAttribute("data-value")).toBe("openrouter/claude-x");
    await type(container, "不存在的模型");
    expect(el(container, "model-chip-empty")).not.toBeNull();
    expect(container.querySelectorAll("[data-testid=model-chip-item]")).toHaveLength(0);
    await unmount();
  });

  test("选中模型写入 store 并关闭弹层；modelsLoaded 且列表为空 → chip 禁用", async () => {
    useUiStore.setState({
      models: [model(), model({ provider: "openrouter", id: "claude-x" })],
      modelsLoaded: true,
      selectedModel: "zai-coding-cn/glm-5.3-flash",
      modelPickerOpen: true,
    });
    const { container, unmount } = await render(createElement(ModelChip));
    const item = container.querySelector(
      '[data-testid=model-chip-item][data-value="openrouter/claude-x"]',
    ) as HTMLButtonElement;
    await act(async () => {
      item.click();
    });
    expect(useUiStore.getState().selectedModel).toBe("openrouter/claude-x");
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
    expect(container.querySelector("[data-testid=popover-content]")).toBeNull();
    await unmount();

    // 无可用模型：chip 禁用（与顶栏模型下拉同语义）
    useUiStore.setState({ models: [], modelsLoaded: true, modelPickerOpen: false });
    const { container: c2, unmount: unmount2 } = await render(createElement(ModelChip));
    const chip = el(c2, "model-chip") as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.textContent).toContain("无可用模型");
    await unmount2();
  });
});
