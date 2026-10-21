// 运行态水合锁测试（docs08-r5 任务 6）：刷新/会话打开后至首个权威运行态信号前，
// 悲观默认按「进行中」阻塞。覆盖计划验收路径：
//   水合期锁定；runStates 写入 running → 解锁且排队态可用；active=true/false → 解锁；
//   探询完成仍 null（引擎不可用）→ 解锁；重挂载（再次刷新）重置水合窗口；
//   组件级：Composer 接线点受 hydrationLocked 控制（docs08-r6 任务 13：CommandBar 已随组件退役）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionListItem } from "@/lib/api";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { useSessionsStore } = await import("@/stores/sessions");
const { useHydrationRunLock } = await import("@/components/chat/hydration-lock");
const { Composer } = await import("@/components/composer/composer");
const { useMessagesStore } = await import("@/stores/messages");
const { useUiStore } = await import("@/stores/ui");
const { useQueueStore } = await import("@/stores/queue");
const { usePermissionsStore } = await import("@/stores/permissions");
const { useQuestionsStore } = await import("@/stores/questions");

const ORIGINAL_FETCH = globalThis.fetch;

function makeSession(id: string, active: boolean | null): SessionListItem {
  return {
    id,
    path: `/store/sessions/${id}.jsonl`,
    project: "/p",
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
    active,
  };
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

/** 挂一个暴露钩子返回值的探针组件 */
function Probe({ sessionId, onValue }: { sessionId: string; onValue: (v: { hydrationLocked: boolean; knownRunning: boolean }) => void }) {
  onValue(useHydrationRunLock(sessionId));
  return null;
}

function resetStores() {
  useSessionsStore.setState({ byProject: {}, runStates: {}, runStateAt: {}, selectedId: null, loading: false });
  useMessagesStore.setState({ bySession: {} });
  useQueueStore.setState({ bySession: {} });
  usePermissionsStore.setState({ bySession: {} });
  useQuestionsStore.setState({ bySession: {} });
  useUiStore.setState({ currentProject: "/p", toast: null });
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("useHydrationRunLock 水合锁", () => {
  test("水合期（无 runStates、无探询数据）默认锁定", async () => {
    // fetch 挂起不返：探询未完成窗口
    globalThis.fetch = () => new Promise(() => {});
    let value = { hydrationLocked: true, knownRunning: false };
    const { unmount } = await render(
      createElement(Probe, { sessionId: "s1", onValue: (v) => (value = v) }),
    );
    expect(value.hydrationLocked).toBe(true);
    await unmount();
  });

  test("runStates 写入 running → 解锁且 knownRunning（排队态可用）", async () => {
    globalThis.fetch = () => new Promise(() => {});
    let value = { hydrationLocked: true, knownRunning: false };
    const { unmount } = await render(
      createElement(Probe, { sessionId: "s1", onValue: (v) => (value = v) }),
    );
    expect(value.hydrationLocked).toBe(true);
    await act(async () => {
      useSessionsStore.getState().setRunState("s1", "running");
    });
    await vi.waitFor(() => expect(value.hydrationLocked).toBe(false));
    expect(value.knownRunning).toBe(true);
    await unmount();
  });

  test("探询带回 active=true → 解锁（knownRunning）", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ sessions: [makeSession("s1", true)] }), { status: 200 }))) as typeof fetch;
    useUiStore.setState({ currentProject: "/p" });
    let value = { hydrationLocked: true, knownRunning: false };
    const { unmount } = await render(
      createElement(Probe, { sessionId: "s1", onValue: (v) => (value = v) }),
    );
    await vi.waitFor(() => expect(value.hydrationLocked).toBe(false));
    expect(value.knownRunning).toBe(true);
    await unmount();
  });

  test("探询带回 active=false → 解锁（空闲，knownRunning=false）", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ sessions: [makeSession("s1", false)] }), { status: 200 }))) as typeof fetch;
    useUiStore.setState({ currentProject: "/p" });
    let value = { hydrationLocked: true, knownRunning: false };
    const { unmount } = await render(
      createElement(Probe, { sessionId: "s1", onValue: (v) => (value = v) }),
    );
    await vi.waitFor(() => expect(value.hydrationLocked).toBe(false));
    expect(value.knownRunning).toBe(false);
    await unmount();
  });

  test("探询完成仍 unknown（引擎不可用 active 持续 null）→ 解锁不永久锁死", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ sessions: [makeSession("s1", null)] }), { status: 200 }))) as typeof fetch;
    useUiStore.setState({ currentProject: "/p" });
    let value = { hydrationLocked: true, knownRunning: false };
    const { unmount } = await render(
      createElement(Probe, { sessionId: "s1", onValue: (v) => (value = v) }),
    );
    await vi.waitFor(() => expect(value.hydrationLocked).toBe(false));
    await unmount();
  });

  test("解锁后 runStates 清除不回锁；重挂载（再次刷新）重置水合窗口", async () => {
    globalThis.fetch = () => new Promise(() => {});
    let value = { hydrationLocked: true, knownRunning: false };
    const first = await render(createElement(Probe, { sessionId: "s1", onValue: (v) => (value = v) }));
    await act(async () => {
      useSessionsStore.getState().setRunState("s1", "idle");
    });
    expect(value.hydrationLocked).toBe(false);
    await act(async () => {
      useSessionsStore.getState().clearRunState("s1");
    });
    expect(value.hydrationLocked).toBe(false); // 闩住不回锁
    await first.unmount();
    // 重挂载 = 刷新：水合窗口重置（fetch 挂起 → 探询未完成 → 再锁定）
    const second = await render(createElement(Probe, { sessionId: "s1", onValue: (v) => (value = v) }));
    expect(value.hydrationLocked).toBe(true);
    await second.unmount();
  });
});

describe("Composer 接线（hydrationLocked）", () => {
  test("水合期：可输入但发送钮禁用；解锁后（排队态）发送钮可用且排队模式钮在场", async () => {
    globalThis.fetch = () => new Promise(() => {});
    useUiStore.setState({ currentProject: "/p", modelsLoaded: true });
    const harness = (locked: boolean, queueAvailable: boolean) =>
      createElement(Composer, {
        sessionId: "s1",
        queueAvailable,
        permissionLocked: false,
        hydrationLocked: locked,
        onSent: () => {},
        onAborted: () => {},
      });
    const lockedView = await render(harness(true, false));
    const input = lockedView.container.querySelector("[data-testid=composer-input]") as HTMLTextAreaElement;
    const sendBtn = lockedView.container.querySelector("[data-testid=send-btn]") as HTMLButtonElement;
    expect(input.disabled).toBe(false); // 水合锁只禁发送，不禁输入
    await act(async () => {
      const setVal = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setVal.call(input, "hello");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(sendBtn.disabled).toBe(true); // 有文本仍禁发送：悲观默认
    await lockedView.unmount();

    // 解锁 + 已知 running → 排队态：输入后发送可用，排队模式切换钮（followUp/steer）在场
    const queuedView = await render(harness(false, true));
    const input2 = queuedView.container.querySelector("[data-testid=composer-input]") as HTMLTextAreaElement;
    await act(async () => {
      const setVal = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setVal.call(input2, "queued");
      input2.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sendBtn2 = queuedView.container.querySelector("[data-testid=send-btn]") as HTMLButtonElement;
    const modeBtn = queuedView.container.querySelector("[data-testid=queue-mode-btn]");
    expect(sendBtn2.disabled).toBe(false);
    expect(modeBtn).not.toBeNull();
    await queuedView.unmount();
  });
});
