/**
 * 项目管理区测试（W1 缺陷 #1）：设置面板「项目管理」分区的确认流与状态清理。
 * 走真实组件（happy-dom + react-dom/client）；radix Dialog 原语 mock 为透传容器，
 * api 层 mock fetch（与 session-dialogs.test.tsx 同款风格）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ProjectMeta } from "@/lib/api";

// bun test 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// radix Dialog 原语透传化：Dialog 按 open 条件渲染 children，其余原语为普通容器
vi.mock("@/components/ui/dialog", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Conditional = ({
    open,
    children,
  }: {
    open?: boolean;
    children?: React.ReactNode;
  }) => (open ? <div data-testid="dialog-root">{children}</div> : null);
  return {
    Dialog: Conditional,
    DialogContent: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { ProjectManagementSection } = await import("@/components/layout/topbar");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");

const ORIGINAL_FETCH = globalThis.fetch;

function project(path: string, extra?: Partial<ProjectMeta>): ProjectMeta {
  return {
    projectPath: path,
    preferredModel: null,
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function findButton(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

/** 按项目路径定位行内的「移除」按钮（行 title 属性携带完整路径） */
function removeButtonOf(container: ParentNode, projectPath: string): HTMLButtonElement | undefined {
  const row = [...container.querySelectorAll("[data-testid=project-management-row]")].find((li) =>
    li.querySelector(`[title="${projectPath}"]`),
  );
  return row ? findButton(row, "移除") : undefined;
}

/** 微任务 + 宏任务双重冲刷（remove 链路为 DELETE → GET 两次串行 fetch） */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  useUiStore.setState({ projects: [], currentProject: null, toast: null });
  useSessionsStore.setState({ selectedId: null });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("设置面板项目管理区（W1 #1）", () => {
  test("确认流：对话框文案含 survivability 承诺，确认后 DELETE + refetch，移除当前项目清选中态", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (method === "DELETE" && path === "/api/projects") return okJson({ path: "/p1", removed: true });
      if (method === "GET" && path === "/api/projects") return okJson({ projects: [project("/p2")] });
      return okJson({ ok: true });
    }) as typeof fetch;

    useUiStore.setState({
      projects: [project("/p1"), project("/p2")],
      currentProject: "/p1",
    });
    useSessionsStore.setState({ selectedId: "s1" });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ProjectManagementSection));
    });

    // 列表渲染两个项目，当前项目带「当前」标记，missing 项目带「已丢失」徽标由字段驱动
    expect(container.querySelectorAll("[data-testid=project-management-row]")).toHaveLength(2);

    // 打开确认对话框：文案必须包含重新添加可恢复置顶/改名/标签的产品承诺
    await act(async () => {
      removeButtonOf(container, "/p1")?.click();
    });
    const dialog = container.querySelector("[data-testid=dialog-root]");
    expect(dialog).toBeDefined();
    expect(dialog?.textContent).toContain("重新添加可恢复置顶/改名/标签");
    expect(dialog?.textContent).toContain("项目内会话数据不受影响");

    // 取消路径：不发 DELETE
    await act(async () => {
      findButton(container, "取消")?.click();
    });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(container.querySelector("[data-testid=dialog-root]")).toBeNull();

    // 确认移除当前项目：DELETE → refetch → 清 currentProject 与选中会话
    await act(async () => {
      removeButtonOf(container, "/p1")?.click();
    });
    await act(async () => {
      findButton(container, "确认移除")?.click();
    });
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/projects")).toBe(true);
    expect(useUiStore.getState().projects.map((p) => p.projectPath)).toEqual(["/p2"]);
    expect(useUiStore.getState().currentProject).toBeNull();
    expect(useSessionsStore.getState().selectedId).toBeNull();
    expect(container.querySelector("[data-testid=dialog-root]")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  test("移除非当前项目：选中态不受影响，仅项目列表收缩", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (method === "DELETE" && path === "/api/projects") return okJson({ path: "/p2", removed: true });
      if (method === "GET" && path === "/api/projects") return okJson({ projects: [project("/p1")] });
      return okJson({ ok: true });
    }) as typeof fetch;

    useUiStore.setState({
      projects: [project("/p1"), project("/p2")],
      currentProject: "/p1",
    });
    useSessionsStore.setState({ selectedId: "s1" });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ProjectManagementSection));
    });

    await act(async () => {
      removeButtonOf(container, "/p2")?.click();
    });
    await act(async () => {
      findButton(container, "确认移除")?.click();
    });
    await flush();

    expect(useUiStore.getState().projects.map((p) => p.projectPath)).toEqual(["/p1"]);
    expect(useUiStore.getState().currentProject).toBe("/p1");
    expect(useSessionsStore.getState().selectedId).toBe("s1");

    await act(async () => {
      root.unmount();
    });
  });

  test("missing 项目带「已丢失」徽标；移除失败不清理选中态", async () => {
    let deleteCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (method === "DELETE" && path === "/api/projects") {
        deleteCalled = true;
        return new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && path === "/api/projects") return okJson({ projects: [project("/p1"), project("/p2", { missing: true })] });
      return okJson({ ok: true });
    }) as typeof fetch;

    useUiStore.setState({
      projects: [project("/p1"), project("/p2", { missing: true })],
      currentProject: "/p1",
    });
    useSessionsStore.setState({ selectedId: "s1" });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ProjectManagementSection));
    });

    const lostBadge = [...container.querySelectorAll("span")].find((s) => s.textContent === "已丢失");
    expect(lostBadge).toBeDefined();

    // 失败路径：DELETE 报错 → toast 错误、对话框保持打开、选中态不动
    await act(async () => {
      removeButtonOf(container, "/p2")?.click();
    });
    await act(async () => {
      findButton(container, "确认移除")?.click();
    });
    await flush();
    expect(deleteCalled).toBe(true);
    expect(useUiStore.getState().toasts.at(-1)?.kind).toBe("error");
    expect(useUiStore.getState().currentProject).toBe("/p1");
    expect(useSessionsStore.getState().selectedId).toBe("s1");

    await act(async () => {
      root.unmount();
    });
  });
});
