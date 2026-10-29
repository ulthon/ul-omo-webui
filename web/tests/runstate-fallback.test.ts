// r11 todo 12（runState 回落簇）单测：帧序列注入式（禁时序依赖——vitest fakeTimers 只冻
// Date，对账节拍显式触发，微任务链用真实 setTimeout 排空，runstate-ttl 同款基建）。
//   (c) 新建空会话全链零 waiting 误显：创建 RPC 窗口内 boot 帧抢写 → markAliasId/markPendingId
//       入口归零；入口归零后无关帧（其他会话/裸 wire 键）不写空会话键；
//   (b) 收尾帧归属：双 id 同帧学习 wire→durable 映射，信封缺席的收尾帧按映射落真实会话清态；
//       跨会话帧序各清各的；游标回退清学习账本防跨纪元误归属；
//   (a) 对账兜底：服务端缺席/null 时叠加陈旧判定（阈值与周期清扫同源），超阈值回落 idle；
//       守卫：阈值内活跃会话（帧持续刷新账本）不误杀。
//   ②  正常输出完成后 runState 回落 idle（agent_end 收尾权威空闲）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionListItem } from "@/lib/api";
import { dispatchSseEvent, reconcileRunStateOnVisible, resetDispatchState } from "@/lib/event-dispatch";
import { useMessagesStore } from "@/stores/messages";
import { usePermissionsStore } from "@/stores/permissions";
import { useQuestionsStore } from "@/stores/questions";
import {
  BACKGROUND_STALE_MS,
  RUNNING_STALE_MS,
  useSessionsStore,
  WAITING_STALE_MS,
} from "@/stores/sessions";

const ORIGINAL_FETCH = globalThis.fetch;

function makeSession(
  id: string,
  runState: "running" | "waiting" | "idle" | null = "idle",
): SessionListItem {
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
    active: runState === "running" || runState === "waiting",
    runState,
  };
}

function frame(wire: Record<string, unknown>, durable?: string): string {
  return JSON.stringify(durable ? { projectPath: "/p", event: wire, durableSessionId: durable } : { projectPath: "/p", event: wire });
}

/** 排空 mock fetch → then → set 微任务链（重同步/对账均为 fire-and-forget promise） */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function ledger(): Record<string, number> {
  return useSessionsStore.getState().runStateAt;
}

function runStates(): Record<string, string | undefined> {
  return useSessionsStore.getState().runStates;
}

/** mock fetch：/api/sessions? 返回聚合快照（重同步/回前台对账权威源），其余返回空消息页 */
function mockFetchSessions(sessions: SessionListItem[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/sessions?")) {
      return new Response(JSON.stringify({ project: null, archived: "all", sessions }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ sessionId: "", entries: [], leafId: null, cursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  // 只冻结 Date（时刻确定性），setTimeout 保持真实——tick() 排微任务链依赖它
  vi.useFakeTimers({ toFake: ["Date"] });
  resetDispatchState();
  useSessionsStore.setState({ byProject: {}, runStates: {}, runStateAt: {}, runStateSeq: {}, selectedId: null });
  usePermissionsStore.setState({ bySession: {} });
  useQuestionsStore.setState({ bySession: {} });
  useMessagesStore.setState({ bySession: {} });
});

afterEach(() => {
  resetDispatchState();
  vi.useRealTimers(); // 恢复真实时钟，防跨文件泄漏
  globalThis.fetch = ORIGINAL_FETCH;
  useSessionsStore.setState({ byProject: {}, runStates: {}, runStateAt: {}, runStateSeq: {}, selectedId: null });
  usePermissionsStore.setState({ bySession: {} });
  useQuestionsStore.setState({ bySession: {} });
  useMessagesStore.setState({ bySession: {} });
});

describe("(c) 新建空会话全链零 waiting 误显", () => {
  test("创建 RPC 窗口内 boot 帧抢写：markPendingId/markAliasId 入口归零", () => {
    vi.setSystemTime(1000);
    // 残留路径一（durable=true 回执键）：创建 RPC 冷启动窗口内，boot 帧按回执键抢写 waiting
    dispatchSseEvent(
      "extension_ui_request",
      frame({ type: "extension_ui_request", method: "confirm", id: "boot-1", sessionId: "rpc-boot" }, "d-new"),
      1,
    );
    expect(runStates()["d-new"]).toBe("waiting");
    useSessionsStore.getState().markPendingId("d-new");
    expect(runStates()["d-new"]).toBeUndefined();
    expect(ledger()["d-new"]).toBeUndefined();

    // 残留路径二（实录形态，durable=false 回执 id 即 routing handle）：裸 wire 键 boot 抢写
    dispatchSseEvent(
      "extension_ui_request",
      frame({ type: "extension_ui_request", method: "select", id: "boot-2", sessionId: "rpc-7" }),
      2,
    );
    expect(runStates()["rpc-7"]).toBe("waiting");
    useSessionsStore.getState().markAliasId("rpc-7");
    expect(runStates()["rpc-7"]).toBeUndefined();
    expect(ledger()["rpc-7"]).toBeUndefined();
  });

  test("入口归零后注入无关帧：空会话键零写入（waitingHint 条件恒假）", () => {
    vi.setSystemTime(1000);
    useSessionsStore.getState().markPendingId("d-new");
    // 无关帧连击：其他会话的阻塞提问帧（waiting 生产者）、裸 wire 键对话框帧、其他会话回合帧
    dispatchSseEvent(
      "extension_ui_request",
      frame(
        {
          type: "extension_ui_request",
          method: "question",
          id: "q-other",
          questions: [{ id: "q1", question: "继续吗？" }],
          waitForAnswer: true,
          sessionId: "rpc-1",
        },
        "d-other",
      ),
      1,
    );
    dispatchSseEvent(
      "extension_ui_request",
      frame({ type: "extension_ui_request", method: "input", id: "dlg-1", sessionId: "rpc-9" }),
      2,
    );
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-2" }, "d-other"), 3);
    // 空会话键从未被写入：runStates 无 d-new（composer waitingHint 的 runState==="waiting" 恒假）
    expect(runStates()["d-new"]).toBeUndefined();
    expect(Object.keys(runStates()).sort()).toEqual(["d-other", "rpc-9"]);
  });
});

describe("(b) 收尾帧归属（跨会话帧序/映射迟到）", () => {
  test("双 id 同帧学习映射后，信封缺席的收尾帧落真实会话清态（不裸写 wire 键）", () => {
    vi.setSystemTime(1000);
    // 回合启动（信封带 durable，回填后常态帧形态）：学习 rpc-a → d-a
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-a" }, "d-a"), 1);
    expect(runStates()["d-a"]).toBe("running");
    // 信封缺席（映射丢失形态）的收尾帧：按学习映射归属 d-a 落 idle，不产生 rpc-a 孤儿键
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-a" }), 2);
    expect(runStates()["d-a"]).toBe("idle");
    expect(runStates()["rpc-a"]).toBeUndefined();
  });

  test("跨会话帧序：A/B 交错，各自收尾帧各清各的", () => {
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-a" }, "d-a"), 1);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-b" }, "d-b"), 2);
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-b" }, "d-b"), 3);
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-a" }, "d-a"), 4);
    expect(runStates()["d-a"]).toBe("idle");
    expect(runStates()["d-b"]).toBe("running"); // A 的收尾不误清 B
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-b" }, "d-b"), 5);
    expect(runStates()["d-b"]).toBe("idle");
  });

  test("游标回退清学习账本：跨纪元同 handle 不误归属", () => {
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-a" }, "d-a"), 5); // 学习 rpc-a→d-a
    // 游标回退（服务重启，handle 全换）：学习账本清空
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-z" }, "d-z"), 1);
    // 新纪元：同 handle rpc-a 属于另一会话（信封缺席）——不得按旧映射把收尾写到 d-a
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-a" }), 2);
    expect(runStates()["rpc-a"]).toBe("idle"); // 落在新纪元 wire 键（孤儿键，由清扫兜底）
    expect(runStates()["d-a"]).toBe("running"); // 旧会话不被跨纪元帧误清（交给对账兜底）
  });
});

describe("(a) 对账兜底：服务端缺席/null 时陈旧判定回落", () => {
  test("question 后 question_resolved 丢失：游标回退对账节拍超阈值回落 idle（列表缺席）", async () => {
    mockFetchSessions([makeSession("d-other", "idle")]); // d-q 故意缺席
    vi.setSystemTime(1000);
    dispatchSseEvent(
      "extension_ui_request",
      frame(
        {
          type: "extension_ui_request",
          method: "question",
          id: "q1",
          questions: [{ id: "q1", question: "继续吗？" }],
          waitForAnswer: true,
          sessionId: "rpc-q",
        },
        "d-q",
      ),
      5,
    );
    expect(runStates()["d-q"]).toBe("waiting");
    const at = ledger()["d-q"]!;
    // question_resolved 与 agent_end 双丢：无任何后续帧，账本冻结在 at
    vi.setSystemTime(at + WAITING_STALE_MS + 1);
    // 对账节拍（既有游标回退重同步，零新增轮询）：服务端缺席 → 陈旧判定兜底
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-z" }, "d-z"), 1);
    await tick();
    await tick();
    expect(runStates()["d-q"]).toBe("idle");
  });

  test("服务端 runState null（引擎未就绪）同样兜底：陈旧 running 回落", async () => {
    mockFetchSessions([makeSession("d-r", null)]); // 行在但 runState null
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-r" }, "d-r"), 5);
    const at = ledger()["d-r"]!;
    vi.setSystemTime(at + RUNNING_STALE_MS + 1);
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-z" }, "d-z"), 1);
    await tick();
    await tick();
    expect(runStates()["d-r"]).toBe("idle");
  });

  test("background_running 陈旧同口径回落；账本缺时刻不判超时", async () => {
    mockFetchSessions([]);
    vi.setSystemTime(1000);
    useSessionsStore.setState({
      runStates: { "d-bg": "background_running", "d-ghost": "waiting" },
      runStateAt: { "d-bg": 1000 }, // d-ghost 外部直写残留无账本时刻
    });
    // 先发一帧建立游标基线（回退检测需 lastCursor 在场），再触发对账节拍
    vi.setSystemTime(1000 + BACKGROUND_STALE_MS);
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-z" }, "d-z"), 9);
    vi.setSystemTime(1000 + BACKGROUND_STALE_MS + 1);
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-z" }, "d-z"), 1);
    await tick();
    await tick();
    expect(runStates()["d-bg"]).toBe("idle");
    expect(runStates()["d-ghost"]).toBe("waiting"); // 宁可不回落
  });

  test("守卫：阈值内活跃会话不误杀（帧刷新账本后对账节拍保持 running，超新阈值才回落）", async () => {
    mockFetchSessions([makeSession("d-other", "idle")]);
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-a" }, "d-a"), 5);
    // +5min 处流式帧——活跃记账刷新账本基准
    vi.setSystemTime(1000 + 5 * 60_000);
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-a" }, "d-a"), 6);
    // 已过原始 10min 死线：游标回退对账节拍触发，但账本新基准（+5min）未超阈值——不误杀
    vi.setSystemTime(1000 + RUNNING_STALE_MS + 1);
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-z" }, "d-z"), 1);
    await tick();
    await tick();
    expect(runStates()["d-a"]).toBe("running");
    // 回前台对账节拍同口径：账本新基准 +10min 后才回落
    useSessionsStore.getState().select("d-a");
    vi.setSystemTime(1000 + 5 * 60_000 + RUNNING_STALE_MS + 1);
    reconcileRunStateOnVisible();
    await tick();
    await tick();
    expect(runStates()["d-a"]).toBe("idle");
  });

  test("对账节拍不覆盖权威三态：服务端 waiting 照常对齐（兜底只在缺席/null 分支）", async () => {
    mockFetchSessions([makeSession("d-w", "waiting")]);
    vi.setSystemTime(1000);
    dispatchSseEvent(
      "extension_ui_request",
      frame({ type: "extension_ui_request", method: "confirm", id: "r1", sessionId: "rpc-w" }, "d-w"),
      5,
    );
    const at = ledger()["d-w"]!;
    vi.setSystemTime(at + WAITING_STALE_MS + 1); // 已超阈值，但服务端权威 waiting
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-z" }, "d-z"), 1);
    await tick();
    await tick();
    expect(runStates()["d-w"]).toBe("waiting"); // 权威链上层胜出，陈旧判定不参与
  });
});

describe("正常输出完成后 runState 回落 idle", () => {
  test("agent_start → 输出帧 → agent_end：收尾帧落权威空闲（waitingHint 条件恒假）", () => {
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-1" }, "d-1"), 1);
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-1" }, "d-1"), 2);
    dispatchSseEvent(
      "message_end",
      frame({ type: "message_end", sessionId: "rpc-1", message: { role: "assistant", content: [] } }, "d-1"),
      3,
    );
    expect(runStates()["d-1"]).toBe("running");
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-1" }, "d-1"), 4);
    expect(runStates()["d-1"]).toBe("idle");
    expect(runStates()["d-1"]).not.toBe("waiting");
  });
});
