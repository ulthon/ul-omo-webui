// F-A 回归（docs08-r6 任务 19d）：流中 abort 后本地态随回合自然结束复位。
//   1) agent_start 流式中点中断（POST abort 送达），回合随后自然收尾（turn_end /
//      agent_end / agent_settled / agent_idle 实测帧序）→ 输入区恢复可发送（F-A 表面
//      "send 永久禁用"不复现）：发送钮可用、点击走 prompt 通道且不带排队参数；
//   2) 刷新 + SSE 重放（replay_begin/done 包夹帧尾重放）→ 重放复位可发送；
//   3) 重放/重开对账（reconcilePendingState）以服务端快照为准：API 已空则旧问题卡
//      不得滞留（重放窗口截断 question_resolved 时旧态复位）。
// 接线镜像 chat-view.tsx 的 Composer 传参（queueAvailable 保守并集 / permissionLocked /
// hydrationLocked）；状态一律经真实 dispatchSseEvent → stores 链路写入，测试零直改 store。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");
const { Composer } = await import("@/components/composer/composer");
const { useHydrationRunLock } = await import("@/components/chat/hydration-lock");
const { reconcilePendingState } = await import("@/components/chat/zombie-reset");
const { useMessagesStore } = await import("@/stores/messages");
const { usePermissionsStore } = await import("@/stores/permissions");
const { useQuestionsStore } = await import("@/stores/questions");
const { useQueueStore } = await import("@/stores/queue");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");

const SID = "qa-19d-1";

const ORIGINAL_FETCH = globalThis.fetch;

/** chat-view.tsx 的 Composer 接线镜像（queueAvailable 保守并集原样，单会话固定 SID） */
function Harness(props: { onSent: () => void; onAborted: () => void }) {
  const streaming = useMessagesStore((s) => s.bySession[SID]?.streaming ?? false);
  const hasPendingPermission = usePermissionsStore((s) => (s.bySession[SID]?.length ?? 0) > 0);
  const runState = useSessionsStore((s) => s.runStates[SID]);
  const { hydrationLocked, knownRunning } = useHydrationRunLock(SID);
  return createElement(Composer, {
    sessionId: SID,
    queueAvailable: streaming || knownRunning || runState === "running" || runState === "waiting",
    permissionLocked: hasPendingPermission,
    hydrationLocked,
    onSent: props.onSent,
    onAborted: props.onAborted,
  });
}

interface RecordedCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

/** fetch 桩：记录调用并按端点回形状正确的最小响应（`questions` 支持按用例覆写） */
function installFetch(opts: { questions?: unknown[] } = {}): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const okJson = (data: unknown): Response =>
    new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    if (url.startsWith("/api/sessions?")) {
      return okJson({
        sessions: [
          {
            id: SID,
            path: `/p/${SID}.jsonl`,
            project: "/p",
            title: SID,
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
            active: null,
            runState: "idle",
          },
        ],
      });
    }
    if (url.endsWith("/abort")) return okJson({ ok: true, sessionId: SID });
    if (url.endsWith("/prompt")) return okJson({ sessionId: SID, disposition: "sent", streaming: false });
    if (url.endsWith("/questions")) return okJson({ questions: opts.questions ?? [] });
    if (url.endsWith("/queue")) return okJson({ steering: [], followUp: [] });
    if (url.endsWith("/settings")) return okJson({ settings: {} });
    return okJson({});
  }) as typeof fetch;
  return { calls };
}

function wireFrame(wire: Record<string, unknown>): string {
  return JSON.stringify({ projectPath: "/p", event: wire, durableSessionId: SID });
}

async function renderHarness(
  onSent: () => void,
  onAborted: () => void,
): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Harness, { onSent, onAborted }));
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

async function typeText(container: HTMLElement, text: string): Promise<void> {
  const input = container.querySelector("[data-testid=composer-input]") as HTMLTextAreaElement;
  await act(async () => {
    const setVal = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setVal.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function resetStores(): void {
  useSessionsStore.setState({ byProject: {}, runStates: {}, runStateAt: {}, appliedModels: {}, selectedId: null });
  useMessagesStore.setState({ bySession: {} });
  useQueueStore.setState({ bySession: {} });
  usePermissionsStore.setState({ bySession: {} });
  useQuestionsStore.setState({ bySession: {} });
  useUiStore.setState({ currentProject: "/p", toast: null });
}

beforeEach(() => {
  resetDispatchState();
  resetStores();
});

afterEach(() => {
  resetDispatchState();
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
  resetStores();
});

describe("F-A 回归：abort 后本地态随回合自然结束复位", () => {
  test("流中 abort → turn_end/agent_end/settled/idle 自然收尾 → 发送恢复直发", async () => {
    const { calls } = installFetch();
    const onSent = vi.fn();
    const onAborted = vi.fn();
    const { container, unmount } = await renderHarness(onSent, onAborted);

    // 流式开始：agent_start 置流式 → 停止钮与排队模式钮在场（发送钮因空文本禁用属正常）
    dispatchSseEvent("agent_start", wireFrame({ type: "agent_start", sessionId: "rpc-9" }), 1);
    await act(async () => {});
    expect(useMessagesStore.getState().bySession[SID]?.streaming).toBe(true);
    expect(container.querySelector("[data-testid=abort-btn]")).not.toBeNull();

    // 中断：点停止钮 → POST abort 送达 + onAborted 标注位（chat-view interrupted）
    await click(container.querySelector("[data-testid=abort-btn]")!);
    expect(calls.some((c) => c.url.endsWith("/abort"))).toBe(true);
    expect(onAborted).toHaveBeenCalledTimes(1);

    // 回合自然收尾（服务端 abort 后实测帧序：turn_end → end → settled → idle）
    dispatchSseEvent("turn_end", wireFrame({ type: "turn_end", sessionId: "rpc-9", message: { role: "assistant", content: "半截" } }), 2);
    dispatchSseEvent("agent_end", wireFrame({ type: "agent_end", sessionId: "rpc-9" }), 3);
    dispatchSseEvent("agent_settled", wireFrame({ type: "agent_settled", sessionId: "rpc-9" }), 4);
    dispatchSseEvent("agent_idle", wireFrame({ type: "agent_idle", sessionId: "rpc-9" }), 5);
    await act(async () => {});

    // F-A 表面：流式已清、runState=idle、停止钮退场
    expect(useMessagesStore.getState().bySession[SID]?.streaming).toBe(false);
    expect(useSessionsStore.getState().runStates[SID]).toBe("idle");
    expect(container.querySelector("[data-testid=abort-btn]")).toBeNull();

    // 发送恢复：输入后发送钮可用，点击走 prompt 直发（不带 streamingBehavior 排队参数）
    await typeText(container, "追加一轮");
    const sendBtn = container.querySelector("[data-testid=send-btn]") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    await click(sendBtn);
    const promptCall = calls.find((c) => c.url.endsWith("/prompt"));
    expect(promptCall).toBeDefined();
    expect(promptCall?.body).toMatchObject({ text: "追加一轮" });
    expect(promptCall?.body).not.toHaveProperty("streamingBehavior");
    expect(onSent).toHaveBeenCalledTimes(1);
    await unmount();
  });

  test("刷新 + SSE 重放帧尾（replay_begin/done 包夹）→ 复位可发送", async () => {
    callsRef = installFetch();
    // 重放先于挂载到达（等价刷新后建连重放）：此前流式回合的帧尾被整段重发
    dispatchSseEvent("replay_begin", JSON.stringify({ after: 100, buffered: 4 }), 100);
    dispatchSseEvent("agent_start", wireFrame({ type: "agent_start", sessionId: "rpc-9" }), 101);
    dispatchSseEvent("turn_end", wireFrame({ type: "turn_end", sessionId: "rpc-9", message: { role: "assistant", content: "残段" } }), 102);
    dispatchSseEvent("agent_end", wireFrame({ type: "agent_end", sessionId: "rpc-9" }), 103);
    dispatchSseEvent("agent_settled", wireFrame({ type: "agent_settled", sessionId: "rpc-9" }), 104);
    dispatchSseEvent("agent_idle", wireFrame({ type: "agent_idle", sessionId: "rpc-9" }), 105);
    dispatchSseEvent("replay_done", JSON.stringify({ replayed: 5 }), 106);

    // 刷新 = 全新挂载（重放后 store 态 + 新组件实例）
    const onSent = vi.fn();
    const { container, unmount } = await renderHarness(onSent, vi.fn());
    await act(async () => {});
    expect(useMessagesStore.getState().bySession[SID]?.streaming ?? false).toBe(false);
    expect(container.querySelector("[data-testid=abort-btn]")).toBeNull();

    await typeText(container, "重放后继续");
    const sendBtn = container.querySelector("[data-testid=send-btn]") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    await click(sendBtn);
    const promptCall = callsRef.calls.find((c) => c.url.endsWith("/prompt"));
    expect(promptCall).toBeDefined();
    expect(promptCall?.body).toMatchObject({ text: "重放后继续" });
    expect(onSent).toHaveBeenCalledTimes(1);
    await unmount();
  });
});

/** installFetch 句柄的测试内可见镜像（需要断言调用的用例覆写） */
let callsRef: { calls: RecordedCall[] } = { calls: [] };

describe("F-A 回归：重放/重开对账以服务端快照复位旧态", () => {
  test("questions API 已空时，滞留的问题卡随对账清空（replay 截断 resolved 帧的面）", async () => {
    callsRef = installFetch();
    // 旧态：重放窗口内 question 帧已入队，其 resolved 帧落在窗口外（截断）→ store 滞留
    dispatchSseEvent(
      "extension_ui_request",
      wireFrame({
        type: "extension_ui_request",
        sessionId: "rpc-9",
        id: "q-stale-1",
        method: "question",
        waitForAnswer: true,
        questions: [{ id: "q1", question: "继续吗？", options: [{ label: "是" }] }],
      }),
      107,
    );
    expect(useQuestionsStore.getState().bySession[SID]?.length).toBe(1);

    // 重开/重放对账：服务端快照为空 → 滞留旧态复位
    const { questions } = await reconcilePendingState(SID, () => false);
    expect(questions).toEqual([]);
    expect(useQuestionsStore.getState().bySession[SID]?.length ?? 0).toBe(0);
  });
});
