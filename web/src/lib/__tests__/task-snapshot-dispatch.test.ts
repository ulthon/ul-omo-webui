// r10 todo 11：omo.task.updated 全量快照分发进 tasks store——三断言（首帧出现、
// 帧到推进、空快照消失）+ 乱序快照整包替换不合并（snapshot 语义）+ 路由键取
// data.parent_session_id（wire sessionId=rpc-N 连接 handle 不作路由）。
// engine-upgrade 2026-10-30 todo 7：fixture 升级到 5.1.51 快照字段面（锚点字段
// parent_session_id/task_id/task_summary/name 之外，新增 residency_state 与
// truncated_tasks 可选字段），并补未知 method 的 extension_ui_request 落 waiting
// 守卫断言（event-dispatch 既有行为，防契约回退）。
// 仿 event-dispatch-session-events.test.ts：@ts-nocheck + 动态 import + fake 帧。
import { describe, expect, test, beforeEach, afterEach } from "vitest";

const { useTasksStore } = await import("@/stores/tasks");
const { useSessionsStore } = await import("@/stores/sessions");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");

const SID = "dur-task-test";

function emitTaskFrame(
  parentSessionId: string,
  tasks: unknown[],
  cursor: number | null = 200,
): void {
  dispatchSseEvent(
    "extension_event",
    JSON.stringify({
      event: { type: "extension_event", name: "omo.task.updated", data: { parent_session_id: parentSessionId, tasks }, sessionId: "rpc-1" },
    }),
    cursor,
  );
}

// 5.1.51 omo-task.js 快照字段面：residency_state 常驻字段 + truncated_tasks 可选字段
const task = (id: string, status: string, summary?: string) => ({
  task_id: id,
  status,
  task_summary: summary ?? `task ${id}`,
  name: id,
  residency_state: "resident",
});

beforeEach(() => {
  useTasksStore.setState({ bySession: {} });
  resetDispatchState();
});

afterEach(() => {
  resetDispatchState();
});

describe("r10 todo 11：快照三断言", () => {
  test("首帧出现：非空快照到达即建键且任务行齐全", () => {
    emitTaskFrame(SID, [task("t1", "running"), task("t2", "completed")]);
    const tasks = useTasksStore.getState().bySession[SID];
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ id: "t1", status: "running", label: "task t1" });
    expect(tasks[1].status).toBe("completed");
  });

  test("帧到推进：后续快照更新状态与数量", () => {
    emitTaskFrame(SID, [task("t1", "running")]);
    emitTaskFrame(SID, [task("t1", "running"), task("t2", "running")]);
    let tasks = useTasksStore.getState().bySession[SID];
    expect(tasks).toHaveLength(2);
    emitTaskFrame(SID, [task("t1", "completed"), task("t2", "completed")]);
    tasks = useTasksStore.getState().bySession[SID];
    expect(tasks.every((t) => t.status === "completed")).toBe(true);
  });

  test("空快照消失：终局快照清空列表（键保留空数组 = 活动条消失语义）", () => {
    emitTaskFrame(SID, [task("t1", "running")]);
    emitTaskFrame(SID, []);
    const tasks = useTasksStore.getState().bySession[SID];
    expect(tasks).toEqual([]);
  });

  test("乱序快照整包替换不合并：后到旧快照覆盖为引擎真相（snapshot 非 delta）", () => {
    emitTaskFrame(SID, [task("t1", "running"), task("t2", "running")]);
    // 乱序：较早的引擎快照（仅 t1）后到达 —— 整包替换，不得残留 t2
    emitTaskFrame(SID, [task("t1", "running")], 199);
    const tasks = useTasksStore.getState().bySession[SID];
    expect(tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(tasks[0].status).toBe("running");
  });

  test("路由键 = data.parent_session_id：异会话帧不串台；wire handle rpc-1 不入键", () => {
    emitTaskFrame("dur-other", [task("t9", "running")]);
    emitTaskFrame(SID, [task("t1", "running")]);
    const bySession = useTasksStore.getState().bySession;
    expect(Object.keys(bySession).sort()).toEqual([SID, "dur-other"].sort());
    expect(bySession[SID].map((t) => t.id)).toEqual(["t1"]);
    expect(bySession["dur-other"].map((t) => t.id)).toEqual(["t9"]);
  });

  test("5.1.51 新字段面：快照携带 truncated_tasks 等未知字段不破坏分发（store 只取锚点字段）", () => {
    emitTaskFrame(SID, [{ ...task("t1", "running"), truncated_tasks: 3 }]);
    const tasks = useTasksStore.getState().bySession[SID];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "t1", status: "running" });
  });

  test("守卫：未知 method 的 extension_ui_request 落 waiting（防状态点契约回退）", () => {
    useSessionsStore.setState({ runStates: {} });
    dispatchSseEvent(
      "extension_ui_request",
      JSON.stringify({ event: { type: "extension_ui_request", method: "some_future_method", sessionId: "rpc-1" } }),
      400,
    );
    // 路由键：无 durableSessionId 信封时回退 wire sessionId（rpc-1）
    expect(useSessionsStore.getState().runStates["rpc-1"]).toBe("waiting");
  });

  test("畸形帧容错：缺 parent_session_id / tasks 非数组不崩，未知 extension_event 忽略", () => {
    dispatchSseEvent(
      "extension_event",
      JSON.stringify({ event: { type: "extension_event", name: "omo.task.updated", data: { tasks: [task("t1", "running")] }, sessionId: "rpc-1" } }),
      300,
    );
    dispatchSseEvent(
      "extension_event",
      JSON.stringify({ event: { type: "extension_event", name: "omo.unknown", data: { parent_session_id: SID }, sessionId: "rpc-1" } }),
      301,
    );
    expect(useTasksStore.getState().bySession[SID]).toBeUndefined();
  });
});
