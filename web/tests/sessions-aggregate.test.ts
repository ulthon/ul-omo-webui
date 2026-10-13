// 会话聚合 store 单测（todo 9）：
// - setAllSessions 按 session.project 分组写入 byProject（整体替换语义，清残留）
// - allMode 切换 + refreshSessions 分支：allMode 走聚合端点（无 project 参数），否则单项目现状路径
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionListItem } from "@/lib/api";
import { api } from "@/lib/api";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch;
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function makeSession(id: string, project: string, modified = "2026-01-01T00:00:00.000Z"): SessionListItem {
  return {
    id,
    path: `${project}/${id}.jsonl`,
    project,
    title: id,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified,
    messageCount: 0,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
  };
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    allMode: false,
    selectedId: null,
    loading: false,
    view: "all",
    q: "",
    archived: "false",
  });
  useUiStore.setState({ currentProject: null });
});

describe("setAllSessions 分组写入", () => {
  test("按 session.project 分组，组内保持响应顺序（聚合已全局排序）", () => {
    const a = makeSession("a1", "/p1", "2026-01-04T00:00:00.000Z");
    const b = makeSession("b1", "/p2", "2026-01-02T00:00:00.000Z");
    const a2 = makeSession("a2", "/p1", "2026-01-01T00:00:00.000Z");
    useSessionsStore.getState().setAllSessions([a, b, a2]);
    const state = useSessionsStore.getState();
    expect(Object.keys(state.byProject).sort()).toEqual(["/p1", "/p2"]);
    expect(state.byProject["/p1"].map((s) => s.id)).toEqual(["a1", "a2"]);
    expect(state.byProject["/p2"].map((s) => s.id)).toEqual(["b1"]);
  });

  test("整体替换语义：清掉单项目模式残留的旧分组（stale state 不滞留）", () => {
    useSessionsStore.getState().setSessions("/old-proj", [makeSession("x1", "/old-proj")]);
    useSessionsStore.getState().setAllSessions([makeSession("a1", "/p1")]);
    const state = useSessionsStore.getState();
    expect(state.byProject["/old-proj"]).toBeUndefined();
    expect(Object.keys(state.byProject)).toEqual(["/p1"]);
  });

  test("空聚合响应清空 byProject（已删除项目的空组不滞留）", () => {
    useSessionsStore.getState().setSessions("/p1", [makeSession("a1", "/p1")]);
    useSessionsStore.getState().setAllSessions([]);
    expect(useSessionsStore.getState().byProject).toEqual({});
  });

  test("setSessions 单项目签名不变（追加式替换该项目键）", () => {
    useSessionsStore.getState().setAllSessions([makeSession("a1", "/p1")]);
    useSessionsStore.getState().setSessions("/p2", [makeSession("b1", "/p2")]);
    const state = useSessionsStore.getState();
    expect(state.byProject["/p1"].map((s) => s.id)).toEqual(["a1"]);
    expect(state.byProject["/p2"].map((s) => s.id)).toEqual(["b1"]);
  });
});

describe("allMode 与 refreshSessions 分支", () => {
  test("allMode=true：调聚合端点（URL 无 project 参数），结果分组写入", async () => {
    let requestedUrl = "";
    mockFetch(async (input) => {
      requestedUrl = String(input);
      return okJson({
        project: null,
        archived: "false",
        sessions: [makeSession("a1", "/p1"), makeSession("b1", "/p2")],
      });
    });
    useSessionsStore.setState({ allMode: true });
    // currentProject 故意留在 ui store（模拟曾打开过项目），allMode 下不得使用它
    useUiStore.setState({ currentProject: "/stale-proj" });
    await useSessionsStore.getState().refreshSessions();
    expect(requestedUrl).toContain("/api/sessions?");
    expect(requestedUrl).not.toContain("project=");
    const state = useSessionsStore.getState();
    expect(state.byProject["/p1"].map((s) => s.id)).toEqual(["a1"]);
    expect(state.byProject["/p2"].map((s) => s.id)).toEqual(["b1"]);
    expect(state.loading).toBe(false);
  });

  test("allMode=false：单项目现状路径（URL 带 project 参数，写入该项目键）", async () => {
    let requestedUrl = "";
    mockFetch(async (input) => {
      requestedUrl = String(input);
      return okJson({ project: "/cur", archived: "false", sessions: [makeSession("c1", "/cur")] });
    });
    useUiStore.setState({ currentProject: "/cur" });
    await useSessionsStore.getState().refreshSessions();
    expect(requestedUrl).toContain("project=%2Fcur");
    expect(useSessionsStore.getState().byProject["/cur"].map((s) => s.id)).toEqual(["c1"]);
  });

  test("archived/q 随请求携带、view 不再序列化（W3 todo 9，两种模式一致）", async () => {
    const urls: string[] = [];
    mockFetch(async (input) => {
      urls.push(String(input));
      return okJson({ project: null, archived: "all", sessions: [] });
    });
    // 故意留 view="human"：残留 UI 态不得再进请求串
    useSessionsStore.setState({ allMode: true, view: "human", archived: "all", q: "fix" });
    await useSessionsStore.getState().refreshSessions();
    expect(urls[0]).not.toContain("view=");
    expect(urls[0]).toContain("archived=all");
    expect(urls[0]).toContain("q=fix");
  });

  test("allMode=false 且无当前项目：不发请求直接返回", async () => {
    let called = false;
    mockFetch(async () => {
      called = true;
      return okJson({ project: null, archived: "false", sessions: [] });
    });
    useUiStore.setState({ currentProject: null });
    await useSessionsStore.getState().refreshSessions();
    expect(called).toBe(false);
    expect(useSessionsStore.getState().loading).toBe(false);
  });

  test("请求失败非 401：loading 复位（toast 路径不抛出）", async () => {
    mockFetch(async () => new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), { status: 500 }));
    useSessionsStore.setState({ allMode: true });
    await useSessionsStore.getState().refreshSessions();
    expect(useSessionsStore.getState().loading).toBe(false);
  });
});

describe("api.listSessions 参数形态", () => {
  test("project 可选：不传时 URL 无 project 参数（聚合端点），view 不再序列化", async () => {
    let requestedUrl = "";
    mockFetch(async (input) => {
      requestedUrl = String(input);
      return okJson({ project: null, archived: "false", sessions: [] });
    });
    // view 参数类型暂留（session-list 过渡），但不再写入查询串；响应无 view 字段亦可用
    const res = await api.listSessions({ view: "human" });
    expect(requestedUrl).toBe("/api/sessions?");
    expect(requestedUrl).not.toContain("view=");
    expect(res.project).toBeNull();
  });

  test("tag 参数透传到查询串（server todo 3 落地前不过滤）", async () => {
    let requestedUrl = "";
    mockFetch(async (input) => {
      requestedUrl = String(input);
      return okJson({ project: null, archived: "false", sessions: [] });
    });
    await api.listSessions({ tag: "work" });
    expect(requestedUrl).toContain("tag=work");
    expect(requestedUrl).not.toContain("project=");
  });
});
