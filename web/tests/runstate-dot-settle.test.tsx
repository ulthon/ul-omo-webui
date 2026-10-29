// r11 todo 12 验收③：状态点完成后即灰（docs/08:64 现场语义权威——「明明工作完成了小点点
// 还有颜色」为缺陷，完成后小点点不得有颜色）。帧序列注入驱动真实权威链数据（dispatchSseEvent
// 写 runStates），SessionItem 真实组件断言状态点视觉态：running=蓝（bg-sky-500）→ agent_end
// 后=灰（bg-muted-foreground/30），amber（waiting 误彩）/sky 均不得残留。
// 基建同 session-item-runstate.test.tsx（happy-dom + GlobalRegistrator + createRoot）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

// vitest 单文件独立 worker，双注册防御（session-item-runstate 同款）
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { SessionItem } = await import("@/components/session-list/session-item");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");
const { useSessionsStore } = await import("@/stores/sessions");

function makeSession(id: string): SessionListItem {
  return {
    id,
    path: `/store/${id}.jsonl`,
    project: "/p1",
    title: id,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
  };
}

function frame(wire: Record<string, unknown>, durable?: string): string {
  return JSON.stringify(durable ? { projectPath: "/p1", event: wire, durableSessionId: durable } : { projectPath: "/p1", event: wire });
}

let mountedRoot: { unmount(): void } | null = null;

async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  mountedRoot = root;
  return container;
}

async function unmount(): Promise<void> {
  const root = mountedRoot;
  mountedRoot = null;
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
}

/** 行内状态点（size-1.5 圆点 span）的类列表 */
function dotClasses(container: HTMLElement): string[] {
  const dot = [...container.querySelectorAll("span")].find((s) => s.className.includes("size-1.5"));
  expect(dot).toBeDefined();
  return dot!.className.split(/\s+/).filter(Boolean);
}

beforeEach(() => {
  resetDispatchState();
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    runStateAt: {},
    runStateSeq: {},
    allMode: false,
    selectedId: null,
    loading: false,
    view: "all",
    q: "",
    archived: "false",
    tagFilter: [],
  });
});

afterEach(async () => {
  resetDispatchState(); // 拆防清扫定时器（帧注入会布防）
  await unmount();
  document.body.innerHTML = "";
});

describe("状态点完成后即灰（r11 todo 12 验收③）", () => {
  test("帧序注入：running 蓝点 → agent_end 收尾 → 灰点（无 amber/sky 残留）", async () => {
    // 回合进行中：SSE 权威链 running → 蓝点（bg-sky-500）
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-1" }, "s-dot"), 1);
    expect(useSessionsStore.getState().runStates["s-dot"]).toBe("running");
    const runningContainer = await mount(
      createElement(SessionItem, {
        session: makeSession("s-dot"),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    expect(dotClasses(runningContainer)).toContain("bg-sky-500");
    await unmount();

    // 正常输出完成：agent_end 收尾帧 → 权威空闲 → 灰点；完成态小点点不得有颜色
    // （docs/08:64 反向实录：明明工作完成了小点点还有颜色=缺陷）
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-1" }, "s-dot"), 2);
    expect(useSessionsStore.getState().runStates["s-dot"]).toBe("idle");
    const settledContainer = await mount(
      createElement(SessionItem, {
        session: makeSession("s-dot"),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    const settled = dotClasses(settledContainer);
    expect(settled).toContain("bg-muted-foreground/30");
    expect(settled).not.toContain("bg-sky-500");
    expect(settled).not.toContain("bg-amber-500");
  });
});
