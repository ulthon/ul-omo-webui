// @ts-nocheck
// 2026-11-08 直做批 #32/#30：总览笔记区新增/删除入口冒烟 + 区块顺序（引擎区下移）。
// 环境说明同 overview-background-tasks.test：@happy-dom 全局注册 + createRoot/act，
// 被测模块动态 import，标记断言走 DOM 查询。
import { describe, expect, test, beforeEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { OverviewPanel } = await import("../overview-panel");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");
const notesApiMod = await import("@/components/notes/notes-api");

const ORIGINAL_LIST = notesApiMod.notesApi.list;

function seed(project, notes = []) {
  useUiStore.setState({ overviewNotesCount: 3 });
  useSessionsStore.setState({
    selectedId: project ? "s0" : null,
    byProject: project
      ? { [project]: [{ id: "s0", title: "会话", project, updatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }] }
      : {},
  });
  // @ts-expect-error 测试桩
  notesApiMod.notesApi.list = async () => ({
    notes: notes.map((n) => ({ id: n.id, title: n.title, content: n.content ?? "笔记正文", preview: "", tags: [], deletedAt: null, updatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" })),
  });
}

async function mountPanel() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(OverviewPanel, { sessionId: null }));
  });
  return { container, root };
}

beforeEach(() => {
  seed(null);
  notesApiMod.notesApi.list = ORIGINAL_LIST;
});

describe("总览笔记区新增/删除入口（#32）", () => {
  test("无项目时新增钮禁用", async () => {
    const { container } = await mountPanel();
    const add = container.querySelector('[data-testid="overview-notes-add"]');
    expect(add).not.toBeNull();
    expect(add.disabled).toBe(true);
  });

  test("有项目点新增钮：顶部展开空笔记行内编辑器", async () => {
    seed("/p1", [{ id: "n1", title: "既有笔记" }]);
    const { container } = await mountPanel();
    await act(async () => {});
    await act(async () => {});
    expect(container.querySelector('[data-testid="overview-note-item"]')).not.toBeNull();
    await act(async () => {
      container.querySelector('[data-testid="overview-notes-add"]').click();
    });
    // draft 编辑器出现：笔记区内出现输入元素（title/content 输入域）
    const notesSection = container.querySelector('[data-testid="overview-notes"]');
    expect(notesSection.querySelector("input, textarea")).not.toBeNull();
  });

  test("笔记条目带行内删除钮", async () => {
    seed("/p1", [{ id: "n1", title: "待删笔记" }]);
    const { container } = await mountPanel();
    await act(async () => {});
    await act(async () => {});
    expect(container.querySelector('[data-testid="overview-note-delete-n1"]')).not.toBeNull();
  });

  test("笔记块不再限高内部滚动（去 max-h）", async () => {
    seed("/p1", [{ id: "n1", title: "笔记" }]);
    const { container } = await mountPanel();
    await act(async () => {});
    await act(async () => {});
    const section = container.querySelector('[data-testid="overview-notes"]');
    const body = section.querySelector("div:not([data-testid])");
    expect(body.className).not.toContain("max-h-64");
    expect(body.className).not.toContain("overflow-y-auto");
  });
});

describe("总览区块顺序（#30 引擎区下移）", () => {
  test("引擎状态/引擎诊断位于面板尾部而非顶部", async () => {
    seed("/p1");
    const { container } = await mountPanel();
    await act(async () => {});
    const children = Array.from(container.querySelector('[data-testid="overview-panel"]').children);
    // Plan/Engine 块可按 sessionId/引擎态条件缺席；锁定：首块不含引擎域，末块为引擎诊断折叠
    const first = children[0];
    expect(first.getAttribute("data-testid")).not.toMatch(/engine|diagnostics/);
    expect(first.querySelector("[data-testid*='engine'], [data-testid*='diagnostics']")).toBeNull();
    const last = children[children.length - 1];
    expect(
      (last.getAttribute("data-testid") ?? "").includes("engine-diagnostics") ||
        last.querySelector("[data-testid*='engine-diagnostics'], [data-testid*='diagnostics']") !== null,
    ).toBe(true);
    children.slice(0, -1).forEach((el) => {
      expect((el.getAttribute("data-testid") ?? "")).not.toMatch(/engine-diagnostics/);
    });  });
});
