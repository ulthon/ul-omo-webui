// @ts-nocheck
// 右栏总览「后台任务」区（2026-11-03）：omo.task.updated 全量快照（tasks store 同源）
// 组件面断言——空态（无会话 / 空快照）、进行中/已完成分组全量渲染、时间列与状态文案。
// 环境说明同 activity-bar.test：@happy-dom 全局注册 + createRoot/act，被测模块动态 import。
import { describe, expect, test, beforeEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { OverviewPanel } = await import("../overview-panel");
const { useTasksStore } = await import("@/stores/tasks");

const SID = "dur-overview-bg-tasks";

function mountPanel(sessionId) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(OverviewPanel, { sessionId }));
  });
  return { container, root };
}

function section(container) {
  const el = container.querySelector('[data-testid="overview-bg-tasks"]');
  if (!el) throw new Error("missing overview-bg-tasks");
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

describe("总览后台任务区（2026-11-03）", () => {
  test("空快照：渲染空态文案「暂无后台任务」", () => {
    setTasks(SID, []);
    const { container } = mountPanel(SID);
    expect(section(container).textContent).toContain("暂无后台任务");
  });

  test("无会话：渲染「未选择会话」空态", () => {
    const { container } = mountPanel(null);
    expect(section(container).textContent).toContain("未选择会话");
  });

  test("全量渲染：进行中+已完成混合快照，两组各出全量行（含 label/状态/时间列）", () => {
    const tasks = [
      { task_id: "r1", status: "running", task_summary: "Run watcher", updated_at: "2026-11-03T10:00:00.000Z" },
      { task_id: "r2", status: "running", task_summary: "Run build", updated_at: "2026-11-03T10:01:00.000Z" },
      { task_id: "d1", status: "completed", task_summary: "Write report", updated_at: "2026-11-03T09:30:00.000Z" },
      { task_id: "d2", status: "completed", task_summary: "Send mail", updated_at: "" },
    ];
    setTasks(SID, tasks);
    const { container } = mountPanel(SID);
    const sec = section(container);
    // 两组标题计数
    expect(sec.textContent).toContain("进行中 2");
    expect(sec.textContent).toContain("已完成 2");
    // 全量行数 = 快照行数（4），不只列进行中
    const rows = sec.querySelectorAll('[data-testid="overview-bg-task"]');
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain("Run watcher");
    expect(rows[0].textContent).toContain("运行中");
    expect(rows[2].textContent).toContain("Write report");
    expect(rows[2].textContent).toContain("已结束");
    // 时间列：updated_at 转本地 HH:mm 显示；缺席落 "—"
    expect(rows[0].textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(rows[3].textContent).toContain("—");
    // 会话隔离：只渲染本会话快照（上面已验证行数对齐，其他会话不混入）
    setTasks("dur-other", [{ task_id: "x", status: "running", task_summary: "X" }]);
    expect(sec.querySelectorAll('[data-testid="overview-bg-task"]')).toHaveLength(4);
  });
});
