/**
 * 项目管理区测试（W1 缺陷 #1）：设置面板「项目管理」分区的确认流与状态清理。
 * 走真实组件（happy-dom + react-dom/client）；radix Dialog 原语 mock 为透传容器，
 * api 层 mock fetch（与 session-dialogs.test.tsx 同款风格）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ProjectMeta, SessionListItem } from "@/lib/api";

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
const { ProjectManagementSection } = await import("@/pages/settings");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");

const ORIGINAL_FETCH = globalThis.fetch;

function project(path: string, extra?: Partial<ProjectMeta>): ProjectMeta {
  return {
    projectPath: path,
    preferredModel: null,
    ...extra,
  };
}

/** 最小完整会话行（t10B：判定派生自选中会话所属项目，需真实种入 byProject） */
function session(id: string, proj: string): SessionListItem {
  return {
    id,
    path: `${proj}/${id}.jsonl`,
    project: proj,
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
    active: null,
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

/** 按项目路径定位行内的「隐藏」按钮（同 removeButtonOf 定位口径） */
function hideButtonOf(container: ParentNode, projectPath: string): HTMLButtonElement | undefined {
  const row = [...container.querySelectorAll("[data-testid=project-management-row]")].find((li) =>
    li.querySelector(`[title="${projectPath}"]`),
  );
  return row ? findButton(row, "隐藏") : undefined;
}

/** 微任务 + 宏任务双重冲刷（remove 链路为 DELETE → GET 两次串行 fetch） */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  useUiStore.setState({ projects: [], toast: null });
  useSessionsStore.setState({ selectedId: null, byProject: {} });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("设置面板项目管理区（W1 #1）", () => {
  test("确认流：对话框文案含 survivability 承诺，确认后 DELETE + refetch，移除选中会话所属项目清选中态", async () => {
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
    });
    useSessionsStore.setState({ selectedId: "s1", byProject: { "/p1": [session("s1", "/p1")] } });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ProjectManagementSection));
    });

    // 列表渲染两个项目，选中会话所属项目带「当前」标记，missing 项目带「已丢失」徽标由字段驱动
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

    // 确认移除选中会话（s1）所属项目 /p1：DELETE → refetch → 清选中会话
    await act(async () => {
      removeButtonOf(container, "/p1")?.click();
    });
    await act(async () => {
      findButton(container, "确认移除")?.click();
    });
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/projects")).toBe(true);
    expect(useUiStore.getState().projects.map((p) => p.projectPath)).toEqual(["/p2"]);
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
    });
    useSessionsStore.setState({ selectedId: "s1", byProject: { "/p1": [session("s1", "/p1")] } });

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
    });
    useSessionsStore.setState({ selectedId: "s1", byProject: { "/p1": [session("s1", "/p1")] } });

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
    expect(useUiStore.getState().globalNotifs.length).toBeGreaterThanOrEqual(1);
    expect(useSessionsStore.getState().selectedId).toBe("s1");

    await act(async () => {
      root.unmount();
    });
  });

  test("隐藏守卫（t10B 判定，W3 任务 12 派生口径）：活动项目隐藏走确认弹层并清选中，无关项目直隐不动选中", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (method === "PUT" && path === "/api/projects/hidden") return okJson({ ok: true, project: null });
      if (method === "GET" && path === "/api/projects") {
        return okJson({ projects: [project("/p1"), project("/p2", { hidden: true })] });
      }
      return okJson({ ok: true });
    }) as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    // 相位一：选中 s1∈/p1（活动项目=/p1 派生）→ 隐藏 /p1 为可感知变化，弹确认层；
    // 确认后 setHidden 守卫判定命中 → 清选中
    useUiStore.setState({ projects: [project("/p1"), project("/p2")], toast: null });
    useSessionsStore.setState({
      selectedId: "s1",
      byProject: { "/p1": [session("s1", "/p1")], "/p2": [session("s2", "/p2")] },
    });
    await act(async () => {
      root.render(createElement(ProjectManagementSection));
    });
    await act(async () => {
      hideButtonOf(container, "/p1")?.click();
    });
    expect(container.querySelector("[data-testid=dialog-root]")).not.toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="project-hide-confirm"]') as HTMLElement)?.click();
    });
    await flush();
    expect(calls.some((c) => c.method === "PUT" && c.path === "/api/projects/hidden")).toBe(true);
    expect(useSessionsStore.getState().selectedId).toBeNull();

    // 相位二：选中 s2∈/p2，隐藏无关项目 /p1 → 直隐路径（无弹层），选中保持
    await act(async () => {
      useSessionsStore.setState({ selectedId: "s2" });
    });
    await act(async () => {
      hideButtonOf(container, "/p1")?.click();
    });
    await flush();
    expect(container.querySelector("[data-testid=dialog-root]")).toBeNull();
    expect(useSessionsStore.getState().selectedId).toBe("s2");

    await act(async () => {
      root.unmount();
    });
  });
});
