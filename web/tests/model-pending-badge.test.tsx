/**
 * 胶囊模型待生效徽标（docs08-r6 任务 8 ④）条件渲染用例：
 * - CapsuleModelTag 直渲染：pendingEffect 真→徽标在（文案词条）；假/缺省→不渲染。
 * - Composer 手机档接线：queueAvailable && selectedModel !== appliedModel 才挂徽标——
 *   生效模型回执到达（appliedModels 收敛为所选）即摘除；非排队期不挂。
 * （api.ts 排队剥模型注入点为铁律区域，本用例零触碰，只验展示层条件。）
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createContext, useContext, type ReactNode } from "react";
import type { ModelInfo } from "@/lib/api";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// radix Popover 透传化（model-thinking-chips.test.tsx 同款）：Root 下发 open 上下文，
// Content 按上下文条件渲染（未受控 = 恒开）
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
    return (
      <div {...(rest as object)} data-testid="popover-content">
        {children}
      </div>
    );
  };
  return { Popover, PopoverTrigger: Passthrough, PopoverClose: Passthrough, PopoverContent };
});

// 手机胶囊档强制命中（Composer isCompact 分支才渲染 CapsuleModelTag）
vi.mock("@/lib/use-is-mobile", () => ({ useIsMobile: () => true }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { CapsuleModelTag } = await import("@/components/composer/chips");
const { Composer } = await import("@/components/composer/composer");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");
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

beforeEach(() => {
  useUiStore.setState({
    models: [model()],
    modelsLoaded: true,
    selectedModel: null,
    selectedThinkingLevel: null,
    modelPickerOpen: false,
    currentProject: "/p1",
    projects: [{ projectPath: "/p1", preferredModel: null, lastOpenedAt: null }],
    toast: null,
  });
  useSessionsStore.setState({ appliedModels: {}, runStates: {}, byProject: {}, selectedId: null });
});

afterEach(async () => {
  cancelPendingPreferencePersist();
  document.body.innerHTML = "";
});

describe("CapsuleModelTag 待生效徽标（docs08-r6 任务 8 ④）", () => {
  test("pendingEffect=true 渲染徽标与词条文案；缺省不渲染", async () => {
    const on = await render(createElement(CapsuleModelTag, { pendingEffect: true }));
    const badge = el(on.container, "capsule-model-pending");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("已选，待可发送时生效");
    await on.unmount();

    const off = await render(createElement(CapsuleModelTag, {}));
    expect(el(off.container, "capsule-model-pending")).toBeNull();
    expect(el(off.container, "capsule-model-tag")).not.toBeNull();
    await off.unmount();
  });
});

describe("Composer 手机档接线：选中 ≠ 生效 才挂徽标", () => {
  const composerProps = {
    sessionId: "d-1",
    queueAvailable: true,
    permissionLocked: false,
    hydrationLocked: false,
    onSent: () => {},
    onAborted: () => {},
  };

  test("排队期所选模型未生效 → 徽标在；回执收敛（appliedModels=所选）→ 徽标摘除", async () => {
    useUiStore.setState({ selectedModel: "zai-coding-cn/glm-4.7" });
    const { container, unmount } = await render(createElement(Composer, composerProps));

    // 生效模型未知（null）：保守显示待生效
    expect(el(container, "capsule-model-pending")).not.toBeNull();

    // prompt 回执/SSE model_changed 写入生效模型 = 所选 → 摘除
    await act(async () => {
      useSessionsStore.getState().setAppliedModel("d-1", "zai-coding-cn/glm-4.7");
    });
    expect(el(container, "capsule-model-pending")).toBeNull();
    await unmount();
  });

  test("非排队期（queueAvailable=false）不挂徽标；切换为所选即生效模型也不挂", async () => {
    useUiStore.setState({ selectedModel: "zai-coding-cn/glm-4.7" });
    const idle = await render(createElement(Composer, { ...composerProps, queueAvailable: false }));
    expect(el(idle.container, "capsule-model-pending")).toBeNull();
    await idle.unmount();

    // 排队期但已生效另一模型且用户改选回它？——生效=glm-5.3-flash、选 glm-4.7：仍待生效
    const { container, unmount } = await render(createElement(Composer, composerProps));
    await act(async () => {
      useSessionsStore.getState().setAppliedModel("d-1", "zai-coding-cn/glm-5.3-flash");
    });
    expect(el(container, "capsule-model-pending")).not.toBeNull();
    await unmount();
  });
});
