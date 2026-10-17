// 提问卡片单测（q1）：question 帧入队路由、question_updated/question_resolved 生命周期、
// waitForAnswer 语义（waiting 仅阻塞型置位）、异形载荷防御、去重与出队。
import { beforeEach, describe, expect, test } from "vitest";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import { useQuestionsStore } from "@/stores/questions";
import { usePermissionsStore } from "@/stores/permissions";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

const SID = "sess-q1-1";

/** 构造并分发一帧 question 型 extension_ui_request */
function dispatchQuestion(id: string, extra: Record<string, unknown> = {}): void {
  dispatchSseEvent(
    "extension_ui_request",
    JSON.stringify({
      projectPath: "/p",
      event: {
        type: "extension_ui_request",
        sessionId: "rpc-9",
        id,
        method: "question",
        waitForAnswer: true,
        questions: [
          {
            id: "q1",
            header: "Deploy",
            question: "Which environment?",
            options: [
              { label: "staging", description: "stage first" },
              { label: "production" },
            ],
            multiSelect: false,
          },
        ],
        timeout: 1800000,
        deadlineAtMs: Date.now() + 1800000,
        remainingMs: 1800000,
        ...extra,
      },
      durableSessionId: SID,
    }),
    1,
  );
}

function dispatchWire(type: string, payload: Record<string, unknown>): void {
  dispatchSseEvent(
    type,
    JSON.stringify({ projectPath: "/p", event: { type, sessionId: "rpc-9", ...payload }, durableSessionId: SID }),
    1,
  );
}

function queue() {
  return useQuestionsStore.getState().bySession[SID] ?? [];
}

beforeEach(() => {
  resetDispatchState();
  useQuestionsStore.setState({ bySession: {} });
  usePermissionsStore.setState({ bySession: {}, autoAllow: {} });
  useSessionsStore.setState({ runStates: {}, runStateAt: {} });
  useUiStore.setState({ toast: null });
});

describe("question 帧分发路由", () => {
  test("结构化载荷完整入队（questions/deadline/waitForAnswer 保留）", () => {
    dispatchQuestion("q-req-1");
    const q = queue();
    expect(q.length).toBe(1);
    expect(q[0].id).toBe("q-req-1");
    expect(q[0].waitForAnswer).toBe(true);
    expect(q[0].questions).toHaveLength(1);
    expect(q[0].questions[0].header).toBe("Deploy");
    expect(q[0].questions[0].options).toEqual([
      { label: "staging", description: "stage first" },
      { label: "production" },
    ]);
    expect(q[0].questions[0].multiSelect).toBe(false);
    expect(q[0].timeout).toBe(1800000);
  });

  test("waitForAnswer=true 置 waiting；false 不置（回合继续）", () => {
    dispatchQuestion("q-wait", { waitForAnswer: true });
    expect(useSessionsStore.getState().runStates[SID]).toBe("waiting");

    dispatchQuestion("q-nowait", { waitForAnswer: false });
    const noWaitIdx = queue().findIndex((r) => r.id === "q-nowait");
    expect(noWaitIdx).toBeGreaterThanOrEqual(0);
    // 第二帧不覆盖既有 waiting（第一条仍阻塞）；此处只验证不抛错且入队
    expect(queue().length).toBe(2);
  });

  test("同 id 重投去重（SSE 重连/重放/对账拉取同帧）", () => {
    dispatchQuestion("q-dup");
    dispatchQuestion("q-dup");
    expect(queue().length).toBe(1);
  });

  test("异形载荷防御：questions 空数组/非数组不入队", () => {
    dispatchQuestion("q-bad-1", { questions: [] });
    dispatchQuestion("q-bad-2", { questions: "not-array" });
    dispatchQuestion("q-bad-3", { questions: [{ not: "a-question" }] });
    expect(queue().length).toBe(0);
  });

  test("四型对话框不受 question 分支影响（互不串道）", () => {
    dispatchSseEvent(
      "extension_ui_request",
      JSON.stringify({
        projectPath: "/p",
        event: { type: "extension_ui_request", sessionId: "rpc-9", id: "sel-1", method: "select", title: "T", options: ["a"] },
        durableSessionId: SID,
      }),
      1,
    );
    expect(queue().length).toBe(0);
    expect((usePermissionsStore.getState().bySession[SID] ?? []).length).toBe(1);
  });
});

describe("question 生命周期", () => {
  test("question_updated 刷新截止时刻（未知 id 忽略）", () => {
    dispatchQuestion("q-1");
    const newDeadline = Date.now() + 60000;
    dispatchWire("question_updated", { id: "q-1", deadlineAtMs: newDeadline, remainingMs: 60000 });
    expect(queue()[0].deadlineAtMs).toBe(newDeadline);
    dispatchWire("question_updated", { id: "unknown", deadlineAtMs: 1, remainingMs: 1 });
    expect(queue()[0].deadlineAtMs).toBe(newDeadline);
  });

  test("question_resolved 出队（超时/取消/异端应答广播）", () => {
    dispatchQuestion("q-1");
    dispatchQuestion("q-2");
    dispatchWire("question_resolved", { id: "q-1", outcome: "timed_out" });
    expect(queue().map((r) => r.id)).toEqual(["q-2"]);
  });

  test("回合落定不清队（waitForAnswer=false 跨回合存活，与权限队列语义不同）", () => {
    dispatchQuestion("q-1", { waitForAnswer: false });
    dispatchWire("agent_settled", {});
    expect(queue().length).toBe(1);
  });

  test("store 原语：push 去重 / remove / clear", () => {
    const store = useQuestionsStore.getState();
    const req = {
      id: "q-x",
      waitForAnswer: false,
      questions: [{ id: "q1", header: "H", question: "Q?", options: [], multiSelect: false }],
      deadlineAtMs: 1,
      timeout: 1,
    };
    store.pushRequest(SID, req);
    store.pushRequest(SID, req);
    expect(queue().length).toBe(1);
    store.removeRequest(SID, "q-x");
    expect(queue().length).toBe(0);
    store.removeRequest(SID, "q-x"); // 幂等
    store.clearSession(SID); // 幂等
    expect(queue().length).toBe(0);
  });
});
