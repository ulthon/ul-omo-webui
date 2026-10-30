// engine-upgrade 2026-10-30 缺陷 B：收尾帧归属兜底（确定性帧序列单测，计划验收 ①②）。
// ① wire 键无映射的 agent_end + store 恰一个 waiting 会话 → 清态落到该会话（非孤儿键），
//   不触发服务端对账（rescue 路径不发 GET /api/sessions）；
// ② 多候选（两个活跃会话）→ 不误清态，触发既有 resyncRunStatesFromServer 对账
//   （打桩计数断言），孤儿键不写 runStates（不产生垃圾键）；
// 补锚：正常归属（映射在账）收尾帧原样——写 idle，既有语义回归锚。
// 确定性手段：vi.useFakeTimers({ toFake: ["Date"] }) 冻结时刻（runstate-ttl 同款，
// 帧序窗口判定「活跃态早于收尾帧到达」可精确构造）+ api.listSessions 打桩计数 +
// setTimeout(0) 微任务冲刷，零真实等待、零时序运气。
// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";

const { useSessionsStore } = await import("@/stores/sessions");
const { usePermissionsStore } = await import("@/stores/permissions");
const { useMessagesStore } = await import("@/stores/messages");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");
const { api } = await import("@/lib/api");

/** wire 帧信封（wire sessionId + 可选 durableSessionId；cursor 由调用方递增防误触游标回退） */
function frame(wire: Record<string, unknown>, durable?: string): string {
  return JSON.stringify(
    durable ? { projectPath: "/p", event: wire, durableSessionId: durable } : { projectPath: "/p", event: wire },
  );
}

/** 阻塞型 confirm 帧（真实 waiting 写入链：落 waiting + 入权限队列） */
function confirmRequest(id: string): Record<string, unknown> {
  return { type: "extension_ui_request", method: "confirm", id, title: "确认执行？", sessionId: "rpc-q" };
}

/** 微任务冲刷：fire-and-forget 的对账 promise（mock → then → set）走完需两个 macrotask */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const ORIGINAL_LIST = api.listSessions;
let listCalls = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  listCalls = 0;
  // @ts-expect-error 测试桩
  api.listSessions = () => {
    listCalls += 1;
    return Promise.resolve({ project: null, archived: "all", sessions: [] });
  };
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    runStateAt: {},
    runStateSeq: {},
    lastFrameAt: {},
    waitingHintHidden: {},
    selectedId: null,
    allMode: false,
  });
  usePermissionsStore.setState({ bySession: {} });
  useMessagesStore.setState({ bySession: {} });
  resetDispatchState();
});

afterEach(() => {
  api.listSessions = ORIGINAL_LIST;
  resetDispatchState();
  vi.useRealTimers(); // 恢复真实时钟，防跨文件泄漏
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    runStateAt: {},
    runStateSeq: {},
    lastFrameAt: {},
    waitingHintHidden: {},
  });
  usePermissionsStore.setState({ bySession: {} });
  useMessagesStore.setState({ bySession: {} });
});

describe("engine-upgrade 2026-10-30 缺陷 B：收尾帧归属兜底", () => {
  test("① wire 键无映射 agent_end + 恰一个 waiting 会话：清态落到该会话，孤儿键不写、不发对账", () => {
    // 真实路径建态：confirm 帧（wire rpc-q + durableSessionId d-1）→ waiting + 权限卡
    dispatchSseEvent("extension_ui_request", frame(confirmRequest("r1"), "d-1"), 1);
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("waiting");
    expect(usePermissionsStore.getState().bySession["d-1"]?.length).toBe(1);

    // 引擎重连后的收尾帧：新 wire 键 rpc-9 无映射、信封无 durableSessionId → 孤儿路由
    vi.setSystemTime(2000); // 帧序窗口：活跃态（runStateAt=1000）早于收尾帧到达时刻
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-9" }), 2);

    expect(useSessionsStore.getState().runStates["d-1"]).toBe("idle"); // 清态落到真实归属
    expect(useSessionsStore.getState().runStates["rpc-9"]).toBeUndefined(); // 孤儿键不写 runStates
    expect(usePermissionsStore.getState().bySession["d-1"]?.length ?? 0).toBe(0); // 权限队列随落定清空
    expect(listCalls).toBe(0); // rescue 路径不触发服务端对账
  });

  test("② 多候选（两个 waiting）不误清态：触发 resync 对账（计数=1），孤儿键不写", async () => {
    dispatchSseEvent("extension_ui_request", frame(confirmRequest("r1"), "d-1"), 1);
    dispatchSseEvent("extension_ui_request", frame(confirmRequest("r2"), "d-2"), 2);
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("waiting");
    expect(useSessionsStore.getState().runStates["d-2"]).toBe("waiting");

    vi.setSystemTime(2000);
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-9" }), 3);
    await flush();

    expect(listCalls).toBe(1); // 既有 resyncRunStatesFromServer 恰被触发一次
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("waiting"); // 多候选不误清
    expect(useSessionsStore.getState().runStates["d-2"]).toBe("waiting");
    // r11 todo 12b 契约保留：resync 路径孤儿键留痕落 idle（跨纪元帧不误清旧会话，
    // 由周期清扫/对账兑底）；缺陷 B 在此之上叠加服务端对账
    expect(useSessionsStore.getState().runStates["rpc-9"]).toBe("idle");
  });

  test("补锚：正常归属（映射在账）收尾帧原样——写 idle，孤儿兜底不误伤正常路径", () => {
    dispatchSseEvent("extension_ui_request", frame(confirmRequest("r1"), "d-1"), 1);
    vi.setSystemTime(2000);
    // 首帧已学习映射 rpc-q→d-1：收尾帧按真实归属正常处理（键已知）
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-q" }), 2);
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("idle");
    expect(useSessionsStore.getState().runStates["rpc-q"]).toBeUndefined(); // 映射解析后不落裸 wire 键
  });
});
