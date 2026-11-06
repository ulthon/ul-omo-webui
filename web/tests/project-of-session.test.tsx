// session → 项目派生查询单测（会话根架构 W1 任务 1）：
// - projectOfSession 纯函数：命中返回所属项目键；未命中 / null 选中 / 空分组返回 null
// - useActiveProject hook：经 selectedId + byProject 活派生（渲染探针观察重派生）
// - setAllSessions 整替不残留陈旧缓存：每次全新线性扫描，无记忆化
import { afterEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

// 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { projectOfSession, useActiveProject, useSessionsStore } = await import("@/stores/sessions");

function makeSession(id: string, project: string): SessionListItem {
  return {
    id,
    path: `${project}/${id}.jsonl`,
    project,
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
    active: false,
  };
}

/** useActiveProject 探针：每次渲染把派生结果追加进 log */
function ActiveProjectProbe({ log }: { log: (project: string | null) => void }) {
  log(useActiveProject());
  return null;
}

async function renderProbe(log: (project: string | null) => void): Promise<ReturnType<typeof createRoot>> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ActiveProjectProbe, { log }));
  });
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
  useSessionsStore.setState({ byProject: {}, selectedId: null });
});

describe("projectOfSession / useActiveProject 派生（会话根架构 W1 任务 1）", () => {
  test("纯函数：命中返回所属项目，未命中 / null 选中 / 空分组返回 null", () => {
    const byProject = {
      "/p1": [makeSession("s1", "/p1")],
      "/p2": [makeSession("s2", "/p2")],
    };
    expect(projectOfSession(byProject, "s2")).toBe("/p2");
    expect(projectOfSession(byProject, "ghost")).toBeNull();
    expect(projectOfSession(byProject, null)).toBeNull();
    expect(projectOfSession({}, "s1")).toBeNull();
  });

  test("useActiveProject：未选中为 null；选中后反查返回所属项目", async () => {
    useSessionsStore.setState({ byProject: { "/p1": [makeSession("s1", "/p1")] }, selectedId: null });
    const values: (string | null)[] = [];
    const root = await renderProbe((v) => values.push(v));
    await act(async () => {
      useSessionsStore.setState({ selectedId: "s1" });
    });
    expect(values).toEqual([null, "/p1"]);
    // 卸载探针后再由 afterEach 复位 store：订阅已解除，不触发 act 外更新告警
    await act(async () => {
      root.unmount();
    });
  });

  test("setAllSessions 整替不残留陈旧缓存：同会话迁往他项目后重派生得新答案", async () => {
    useSessionsStore.setState({ byProject: { "/p1": [makeSession("s1", "/p1")] }, selectedId: "s1" });
    const values: (string | null)[] = [];
    const root = await renderProbe((v) => values.push(v));
    // 整替：s1 的 project 字段迁往 /p2，旧 /p1 键随整替消失
    await act(async () => {
      useSessionsStore.getState().setAllSessions([makeSession("s1", "/p2")]);
    });
    expect(values).toEqual(["/p1", "/p2"]);
    // 纯函数同标准：对当前 byProject 全新扫描，无残留
    expect(projectOfSession(useSessionsStore.getState().byProject, "s1")).toBe("/p2");
    await act(async () => {
      root.unmount();
    });
  });
});
