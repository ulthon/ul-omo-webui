// @ts-nocheck
// r10 todo 11：后台活动条组件——三断言组件面（非空快照出现含任务行、快照推进更新、
// 空快照消失不残留）+ 展开列表 label/状态 + 运行中 spinner。环境说明同 auth-section：
// @happy-dom 全局注册 + createRoot/act 交互，被测模块动态 import（晚于 preload shim）。
import { describe, expect, test, beforeEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ActivityBar } = await import("../activity-bar");
const { useTasksStore } = await import("@/stores/tasks");

const SID = "dur-activity-bar";

function task(id, status, summary) {
  return { id, status, label: summary ?? `task ${id}` };
}

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(ActivityBar, { sessionId: SID }));
  });
  return { container, root };
}

function click(el) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function q(container, sel) {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

function setTasks(sessionId, tasks) {
  act(() => {
    useTasksStore.getState().applySnapshot(sessionId, tasks);
  });
}

beforeEach(() => {
  useTasksStore.setState({ bySession: {} });
});

describe("ActivityBar（r10 todo 11）", () => {
  test("出现：非空快照渲染活动条（后台任务 N），默认收起，展开见任务行 label+状态", () => {
    setTasks(SID, [
      { task_id: "t1", status: "running", task_summary: "Run echo hello" },
      { task_id: "t2", status: "completed", task_summary: "Write report" },
    ]);
    const { container } = mount();
    expect(q(container, '[data-testid="activity-bar"]')).toBeTruthy();
    expect(q(container, '[data-testid="activity-bar-toggle"]').textContent).toContain("后台任务 2");
    // 默认收起：无任务列表；点标题行展开后出现任务行
    expect(container.querySelector('[data-testid="activity-task-list"]')).toBeNull();
    click(q(container, '[data-testid="activity-bar-toggle"]'));
    const rows = container.querySelectorAll('[data-testid="activity-task"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Run echo hello");
    expect(rows[0].querySelector('[data-testid="activity-task-status"]').textContent).toContain("运行中");
    expect(rows[1].querySelector('[data-testid="activity-task-status"]').textContent).toContain("已结束");
  });

  test("推进：快照更新反映到活动条（计数与运行态）", () => {
    setTasks(SID, [{ task_id: "t1", status: "running", task_summary: "A" }]);
    const { container } = mount();
    expect(q(container, '[data-testid="activity-bar-toggle"]').textContent).toContain("后台任务 1");
    expect(q(container, '[data-testid="activity-bar-spinner"]')).toBeTruthy();
    setTasks(SID, [
      { task_id: "t1", status: "completed", task_summary: "A" },
      { task_id: "t2", status: "running", task_summary: "B" },
    ]);
    expect(q(container, '[data-testid="activity-bar-toggle"]').textContent).toContain("后台任务 2");
  });

  test("消失：空快照后活动条不渲染无残留", () => {
    setTasks(SID, [{ task_id: "t1", status: "running", task_summary: "A" }]);
    const { container } = mount();
    expect(q(container, '[data-testid="activity-bar"]')).toBeTruthy();
    setTasks(SID, []);
    expect(container.querySelector('[data-testid="activity-bar"]')).toBeNull();
  });

  test("会话隔离：其他会话的快照不渲染进本会话活动条", () => {
    setTasks("dur-other", [{ task_id: "t9", status: "running", task_summary: "X" }]);
    const { container } = mount();
    expect(container.querySelector('[data-testid="activity-bar"]')).toBeNull();
  });
});
