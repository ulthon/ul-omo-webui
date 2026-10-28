// r10 todo 9：状态点准确性——waiting 写入链覆盖 + 回前台对账（确定性帧序列单测）。
// 场景（计划验收 ①②③④，无真实等待、无时序阈值断言）：
// ① 丢 agent_start：本地推断停旧值/未知 → 回前台对账校正状态；
// ② 对账请求在途 + 新 agent_start 帧到达 → 新帧胜出，旧对账结果不覆盖；
// ③ 对账返回 null / 行缺席（引擎未就绪）→ 保持未知灰，不误绿；
// ④ extension_ui_request 非四型 method → waiting 落状态点。
// 回前台触发面说明：vitest 环境为 node（无 document），单测直接调用
// reconcileRunStateOnVisible()——即 events.ts onVisibilityChange→visible 绑定的同一
// 函数；触发面接线（events.ts）与对账逻辑本文件分别覆盖。
// 确定性手段：api.listSessions 直接打桩 + Promise 手动放行 + setTimeout(0) 微任务
// 冲刷（同 event-dispatch-gap-tiering 惯用形态），零真实等待。
// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from "vitest";

const { useSessionsStore } = await import("@/stores/sessions");
const { useMessagesStore } = await import("@/stores/messages");
const { dispatchSseEvent, resetDispatchState, reconcileRunStateOnVisible } = await import("@/lib/event-dispatch");
const { api } = await import("@/lib/api");

/** 会话行 fixture（listSessions 回包；对账只读 id 与 runState） */
function row(id, runState) {
  return {
    id,
    project: "/p",
    path: `/p/${id}`,
    title: id,
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: runState === "running" || runState === "waiting",
    runState,
  };
}

/** wire 帧信封（路由键 sessionId；cursor 由调用方递增防误触游标回退分支） */
function frame(eventType, extra = {}) {
  return JSON.stringify({ projectPath: "/p", event: { type: eventType, sessionId: "s1", ...extra } });
}

/** 微任务冲刷：then + finally 链走完需两个 macrotask */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const ORIGINAL_LIST = api.listSessions;

beforeEach(() => {
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    runStateAt: {},
    runStateSeq: {},
    selectedId: "s1",
    allMode: false,
  });
  useMessagesStore.setState({ bySession: {} });
  resetDispatchState();
});

afterEach(() => {
  api.listSessions = ORIGINAL_LIST;
  resetDispatchState();
});

describe("r10 todo 9：回前台对账（场景①②③）", () => {
  test("① 丢 agent_start：本地停旧 idle，回前台对账校正为服务端 running", async () => {
    // 本地推断：上一回合 agent_end 已见（idle）；新回合 agent_start 丢失（后台/断线）
    useSessionsStore.setState({ runStates: { s1: "idle" }, runStateSeq: { s1: 1 } });
    api.listSessions = () => Promise.resolve({ project: null, archived: "all", sessions: [row("s1", "running")] });
    expect(useSessionsStore.getState().runStates.s1).toBe("idle");

    reconcileRunStateOnVisible(); // visibilitychange→visible 钩子调用的同一函数
    await flush();
    expect(useSessionsStore.getState().runStates.s1).toBe("running");
  });

  test("①补 本地零推断（未见任何帧）时对账同样写入（未知灰 → 权威态）", async () => {
    useSessionsStore.setState({ runStates: {}, runStateSeq: {} });
    api.listSessions = () => Promise.resolve({ project: null, archived: "all", sessions: [row("s1", "waiting")] });

    reconcileRunStateOnVisible();
    await flush();
    expect(useSessionsStore.getState().runStates.s1).toBe("waiting");
  });

  test("② 对账在途 + 新 agent_start 帧到达：新帧胜出，终态 running 不被旧对账覆盖", async () => {
    useSessionsStore.setState({ runStates: { s1: "idle" }, runStateSeq: { s1: 1 } });
    let resolveFetch;
    api.listSessions = () =>
      new Promise((res) => {
        resolveFetch = res;
      });

    reconcileRunStateOnVisible(); // 发起：快照 seq=1，请求在途（服务端探询滞后的旧快照）
    // 对账回包前：SSE 恢复，新回合 agent_start 帧到达（seq 1 → 2）
    dispatchSseEvent("agent_start", frame("agent_start"), 200);
    expect(useSessionsStore.getState().runStates.s1).toBe("running");

    // 迟到的旧对账快照回包（仍报 idle）——必须被顺序护栏丢弃
    resolveFetch({ project: null, archived: "all", sessions: [row("s1", "idle")] });
    await flush();
    expect(useSessionsStore.getState().runStates.s1).toBe("running");
  });

  test("③ 对账返回 null runState / 行缺席：保持未知，不误绿不误黄", async () => {
    useSessionsStore.setState({ runStates: {}, runStateSeq: {} });

    // 服务端行在但 runState=null（引擎未就绪探询 null）
    api.listSessions = () => Promise.resolve({ project: null, archived: "all", sessions: [row("s1", null)] });
    reconcileRunStateOnVisible();
    await flush();
    expect(useSessionsStore.getState().runStates.s1).toBeUndefined();
    expect(useSessionsStore.getState().runStates.s1 === "running").toBe(false);

    // 行整体缺席（跨端已删 / 列表未含）：同样不动
    api.listSessions = () => Promise.resolve({ project: null, archived: "all", sessions: [] });
    reconcileRunStateOnVisible();
    await flush();
    expect(useSessionsStore.getState().runStates.s1).toBeUndefined();
  });
});

describe("r10 todo 9：waiting 写入链覆盖（场景④）", () => {
  test("④ extension_ui_request 非四型 method 落 waiting", () => {
    useSessionsStore.setState({ runStates: {}, runStateSeq: {} });
    dispatchSseEvent(
      "extension_ui_request",
      frame("extension_ui_request", { method: "save_memory_confirm", title: "确认保存" }),
      300,
    );
    expect(useSessionsStore.getState().runStates.s1).toBe("waiting");
  });

  test("notify（fire-and-forget，计划 249）不落 waiting：运行中蓝点不被误降琥珀", () => {
    useSessionsStore.setState({ runStates: { s1: "running" }, runStateSeq: { s1: 1 } });
    dispatchSseEvent("extension_ui_request", frame("extension_ui_request", { method: "notify", tone: "warning", message: "w" }), 310);
    expect(useSessionsStore.getState().runStates.s1).toBe("running");
  });

  test("method 缺席的畸形 extension_ui_request 不落 waiting（无语义可依）", () => {
    useSessionsStore.setState({ runStates: {}, runStateSeq: {} });
    dispatchSseEvent("extension_ui_request", frame("extension_ui_request"), 320);
    expect(useSessionsStore.getState().runStates.s1).toBeUndefined();
  });
});

describe("r10 todo 9：对账护栏边界", () => {
  test("对账失败静默：状态不变，在途标志复位（下次回前台可再发射）", async () => {
    useSessionsStore.setState({ runStates: { s1: "idle" }, runStateSeq: { s1: 1 } });
    let rejectFetch;
    api.listSessions = () =>
      new Promise((_, rej) => {
        rejectFetch = rej;
      });
    reconcileRunStateOnVisible();
    let secondFired = false;
    api.listSessions = () => {
      secondFired = true;
      return Promise.resolve({ project: null, archived: "all", sessions: [row("s1", "running")] });
    };
    rejectFetch(new Error("network down"));
    await flush();
    expect(useSessionsStore.getState().runStates.s1).toBe("idle"); // 失败不动

    reconcileRunStateOnVisible(); // 标志已复位：能再次发射
    await flush();
    expect(secondFired).toBe(true);
    expect(useSessionsStore.getState().runStates.s1).toBe("running");
  });

  test("对账在途时切走会话：回包作废，不写旧目标", async () => {
    useSessionsStore.setState({ runStates: {}, runStateSeq: {}, selectedId: "s1" });
    let resolveFetch;
    api.listSessions = () =>
      new Promise((res) => {
        resolveFetch = res;
      });
    reconcileRunStateOnVisible();
    useSessionsStore.setState({ selectedId: "s2" }); // 用户切走
    resolveFetch({ project: null, archived: "all", sessions: [row("s1", "running"), row("s2", "waiting")] });
    await flush();
    const runStates = useSessionsStore.getState().runStates;
    expect(runStates.s1).toBeUndefined(); // 旧目标不写
    expect(runStates.s2).toBeUndefined(); // 也不串写新目标（对账目标以发起时为准）
  });

  test("单飞去重：对账在途时重复回前台不重复发射", async () => {
    useSessionsStore.setState({ runStates: {}, runStateSeq: {} });
    let calls = 0;
    let resolveFetch;
    api.listSessions = () => {
      calls += 1;
      return new Promise((res) => {
        resolveFetch = res;
      });
    };
    reconcileRunStateOnVisible();
    reconcileRunStateOnVisible();
    reconcileRunStateOnVisible();
    resolveFetch({ project: null, archived: "all", sessions: [row("s1", "idle")] });
    await flush();
    expect(calls).toBe(1);
    expect(useSessionsStore.getState().runStates.s1).toBe("idle");
  });

  test("无选中会话时回前台对账零请求", async () => {
    useSessionsStore.setState({ selectedId: null });
    let calls = 0;
    api.listSessions = () => {
      calls += 1;
      return Promise.resolve({ project: null, archived: "all", sessions: [] });
    };
    reconcileRunStateOnVisible();
    await flush();
    expect(calls).toBe(0);
  });
});
