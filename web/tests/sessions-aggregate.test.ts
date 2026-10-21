// 会话聚合 store 单测（todo 9）：
// - setAllSessions 按 session.project 分组写入 byProject（整体替换语义，清残留）
// - allMode 切换 + refreshSessions 分支：allMode 走聚合端点（无 project 参数），否则单项目现状路径
import { afterEach, describe, expect, test } from "vitest";
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

describe("整替合并保占位行（docs08-r6 任务 7）", () => {
  test("setSessions 整替后仍别名且不在服务端列表的占位行原位追回", () => {
    // 组件流同源：新建会话逐个 upsert 占位行并 markAliasId（alias-a、alias-c），
    // b1 为服务端常规行；刷新整替只回 b1——两个占位行追回且保持原相对位置
    // （alias-a 在 b1 前、alias-c 在 b1 后，非仅存在性断言）
    const aliasA = { ...makeSession("alias-a", "/p1") };
    const b1 = makeSession("b1", "/p1");
    const aliasC = { ...makeSession("alias-c", "/p1") };
    const store = useSessionsStore.getState();
    store.upsertSession("/p1", aliasA);
    store.upsertSession("/p1", b1);
    store.upsertSession("/p1", aliasC);
    useSessionsStore.getState().markAliasId("alias-a");
    useSessionsStore.getState().markAliasId("alias-c");
    useSessionsStore.getState().setSessions("/p1", [b1]);
    const ids = useSessionsStore.getState().byProject["/p1"].map((s) => s.id);
    expect(ids).toEqual(["alias-a", "b1", "alias-c"]);
  });

  test("setSessions 同 path durable 行已在：弃别名行选 durable 行防双行", () => {
    // 首条消息落盘后刷新：服务端以真实 id 回同一 sessionPath 行——别名行必须丢弃，
    // 结果恰好一行且为 durable id（真触发 path 去重分支，非 id 命中旁路）
    const alias = { ...makeSession("alias-a", "/p1"), path: "/p1/same.jsonl" };
    const durable = { ...makeSession("durable-a", "/p1"), path: "/p1/same.jsonl" };
    const store = useSessionsStore.getState();
    store.upsertSession("/p1", alias);
    store.markAliasId("alias-a");
    store.setSessions("/p1", [durable]);
    const rows = useSessionsStore.getState().byProject["/p1"];
    expect(rows.map((s) => s.id)).toEqual(["durable-a"]);
    expect(rows.filter((s) => s.path === "/p1/same.jsonl")).toHaveLength(1);
  });

  test("setAllSessions 同口径：消失的项目键只重建别名占位行且原位追回", () => {
    const alias = { ...makeSession("alias-a", "/p1") };
    const b1 = makeSession("b1", "/p1");
    const c1 = makeSession("c1", "/p2");
    const store = useSessionsStore.getState();
    store.upsertSession("/p1", alias);
    store.upsertSession("/p1", b1);
    store.markAliasId("alias-a");
    store.setAllSessions([b1, c1]);
    const state = useSessionsStore.getState();
    expect(state.byProject["/p1"].map((s) => s.id)).toEqual(["alias-a", "b1"]);
    expect(state.byProject["/p2"].map((s) => s.id)).toEqual(["c1"]);
    // 聚合响应完全不含别名行所在项目：仅重建该键，不残留非别名行
    store.setAllSessions([c1]);
    expect(Object.keys(useSessionsStore.getState().byProject).sort()).toEqual(["/p1", "/p2"]);
    expect(useSessionsStore.getState().byProject["/p1"].map((s) => s.id)).toEqual(["alias-a"]);
  });

  test("removeSession 清别名后整替不复活占位行（MUST NOT 绕过清别名语义）", () => {
    const alias = makeSession("alias-a", "/p1");
    const durable = makeSession("durable-b", "/p1");
    const store = useSessionsStore.getState();
    store.upsertSession("/p1", alias);
    store.markAliasId("alias-a");
    store.removeSession("alias-a");
    expect(useSessionsStore.getState().aliasIds["alias-a"]).toBeUndefined();
    // 删除与刷新的并发窗口：陈旧 SSE upsert 把行重新插入列表，随后整替——
    // 别名集合已清，追回分支不得复活该行
    useSessionsStore.getState().upsertSession("/p1", alias);
    useSessionsStore.getState().setSessions("/p1", [durable]);
    expect(useSessionsStore.getState().byProject["/p1"].map((s) => s.id)).toEqual(["durable-b"]);
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
