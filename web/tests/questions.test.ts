// 提问卡片单测（q1）：question 帧入队路由、question_updated/question_resolved 生命周期、
// waitForAnswer 语义（waiting 仅阻塞型置位）、异形载荷防御、去重与出队。
import { beforeEach, describe, expect, test } from "vitest";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import { questionDraftKey, useQuestionsStore } from "@/stores/questions";
import { useMessagesStore } from "@/stores/messages";
import { usePermissionsStore } from "@/stores/permissions";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

const SID = "sess-q1-1";

/** 构造并分发一帧 question 型 extension_ui_request */
function dispatchQuestion(id: string, extra: Record<string, unknown> = {}, askedAtMs?: number): void {
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
        askedAtMs: askedAtMs ?? 1234567890,
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
  useQuestionsStore.setState({ bySession: {}, drafts: {}, resolvedSummaries: {} });
  useMessagesStore.setState({ bySession: {} });
  usePermissionsStore.setState({ bySession: {}, autoAllow: {} });
  useSessionsStore.setState({ runStates: {}, runStateAt: {} });
  useUiStore.setState({ toast: null });
});

describe("question 帧分发路由", () => {
  test("结构化载荷完整入队（questions/deadline/waitForAnswer/askedAtMs 保留；锚点=消息流末条）", () => {
    // 消息流已有两条：末条 a1 即锚点（r11 todo 6b）
    useMessagesStore.getState().setEntries(
      SID,
      [
        { type: "message", id: "u1", message: { role: "user", content: [] } },
        { type: "message", id: "a1", message: { role: "assistant", content: [] } },
      ],
      null,
      null,
    );
    dispatchQuestion("q-req-1", {}, 1700000000000);
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
    expect(q[0].askedAtMs).toBe(1700000000000); // wire askedAtMs 不再丢弃
    expect(q[0].anchorEntryId).toBe("a1"); // 锚点=提问时消息流末条
  });

  test("空消息流提问：锚点 null（渲染层挂流末兑底）；askedAtMs 缺席用本地时钟兑底", () => {
    dispatchQuestion("q-noanchor");
    const q = queue();
    expect(q[0].anchorEntryId).toBeNull();
    expect(q[0].askedAtMs).toBeGreaterThan(0);
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

  test("question_resolved 出队并留一行瞬态摘要（r11 todo 6e：锄点沿用、幂等、刷新即无）", () => {
    useMessagesStore.getState().setEntries(
      SID,
      [{ type: "message", id: "m1", message: { role: "user", content: [] } }],
      null,
      null,
    );
    dispatchQuestion("q-1");
    dispatchWire("question_resolved", { id: "q-1", outcome: "answered" });
    expect(queue().length).toBe(0);
    const summaries = useQuestionsStore.getState().resolvedSummaries[SID] ?? [];
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe("q-1");
    expect(summaries[0].outcome).toBe("answered");
    expect(summaries[0].anchorEntryId).toBe("m1");
    expect(summaries[0].snippet).toContain("Which environment?");
    // 幂等：重放窗口重播同一 resolved 帧不二次报
    dispatchWire("question_resolved", { id: "q-1", outcome: "answered" });
    expect(useQuestionsStore.getState().resolvedSummaries[SID]).toHaveLength(1);
    // 未知 id（异端先答后本端才见）：无卡可替 no-op
    dispatchWire("question_resolved", { id: "q-unknown", outcome: "answered" });
    expect(useQuestionsStore.getState().resolvedSummaries[SID]).toHaveLength(1);
  });

  test("question_resolved 出队（超时/取消/异端应答广播）", () => {
    dispatchQuestion("q-1");
    dispatchQuestion("q-2");
    dispatchWire("question_resolved", { id: "q-1", outcome: "timed_out" });
    expect(queue().map((r) => r.id)).toEqual(["q-2"]);
  });

  test("重放窗口内 question 帧重投不双列（同 id 去重保原锚）", () => {
    useMessagesStore.getState().setEntries(
      SID,
      [
        { type: "message", id: "u1", message: { role: "user", content: [] } },
        { type: "message", id: "a1", message: { role: "assistant", content: [] } },
      ],
      null,
      null,
    );
    dispatchQuestion("q-r");
    // 重放窗口包夹内重投
    dispatchSseEvent("replay_begin", "{}", 2);
    dispatchQuestion("q-r");
    dispatchSseEvent("replay_done", "{}", 3);
    const q = queue();
    expect(q).toHaveLength(1);
    expect(q[0].anchorEntryId).toBe("a1"); // 首帧锚点为准不漂移
  });

  test("回合落定不清队（waitForAnswer=false 跨回合存活，与权限队列语义不同）", () => {
    dispatchQuestion("q-1", { waitForAnswer: false });
    dispatchWire("agent_settled", {});
    expect(queue().length).toBe(1);
  });

  test("store 原语：push 去重 / remove / clear（草稿连带清理）", () => {
    const store = useQuestionsStore.getState();
    const req = {
      id: "q-x",
      waitForAnswer: false,
      questions: [{ id: "q1", header: "H", question: "Q?", options: [], multiSelect: false }],
      deadlineAtMs: 1,
      timeout: 1,
      askedAtMs: 1,
      anchorEntryId: null,
    };
    store.pushRequest(SID, req);
    store.pushRequest(SID, req);
    expect(queue().length).toBe(1);
    store.setDraft(SID, "q-x", { comment: "半答" });
    expect(useQuestionsStore.getState().drafts[questionDraftKey(SID, "q-x")]!.comment).toBe("半答");
    store.removeRequest(SID, "q-x");
    expect(useQuestionsStore.getState().drafts[questionDraftKey(SID, "q-x")]).toBeUndefined(); // 草稿随出队清理
    store.removeRequest(SID, "q-x"); // 幂等
    store.clearSession(SID); // 幂等
    expect(queue().length).toBe(0);
  });

  test("setDraft 守卫：请求不在队列不复活草稿（resolved 后迟到的镜像写）", () => {
    useQuestionsStore.getState().setDraft(SID, "q-gone", { comment: "迟到" });
    expect(useQuestionsStore.getState().drafts[questionDraftKey(SID, "q-gone")]).toBeUndefined();
  });

  test("resolveRequest：出队+摘要+草稿三联动；removeRequest 不留摘要（忽略路径）", () => {
    dispatchQuestion("q-a");
    dispatchQuestion("q-b");
    useQuestionsStore.getState().setDraft(SID, "q-a", { comment: "答了一半" });
    useQuestionsStore.getState().resolveRequest(SID, "q-a", "cancelled");
    expect(queue().map((r) => r.id)).toEqual(["q-b"]);
    expect(useQuestionsStore.getState().resolvedSummaries[SID] ?? []).toHaveLength(1);
    expect(useQuestionsStore.getState().drafts[questionDraftKey(SID, "q-a")]).toBeUndefined();
    // 忽略路径：removeRequest 不产生摘要（用户主动取消无痕）
    useQuestionsStore.getState().removeRequest(SID, "q-b");
    expect(useQuestionsStore.getState().resolvedSummaries[SID]).toHaveLength(1);
  });
});
