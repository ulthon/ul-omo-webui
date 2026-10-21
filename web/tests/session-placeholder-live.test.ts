// task 19f（docs08-r6 IS-5）回归：新会话首条消息流中占位行不丢。
// 真实链路（F3 FAIL 根因）：新建会话 upsert 别名占位行 → 首条消息回执 adoptSessionId
// 换真实 id → ChatSession 按 sessionId 重挂载 → hydration 探询 refreshSessions 用
// 尚未含新会话的服务端列表整替 byProject。修复前 adopt 移除别名保护，行被冲掉且
// SSE 实时路径（仅 patchSession）无法补回，直到下次刷新才重现。
import { afterEach, describe, expect, test } from "vitest";
import type { SessionListItem } from "@/lib/api";
import { useSessionsStore } from "@/stores/sessions";

function makeSession(id: string, project: string, path = `${project}/${id}.jsonl`): SessionListItem {
  return {
    id,
    path,
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

const freshSession = makeSession("fresh", "/p1");

afterEach(() => {
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    runStateAt: {},
    appliedModels: {},
    allMode: false,
    selectedId: null,
    aliasIds: {},
    pendingIds: {},
    q: "",
    archived: "false",
    loading: false,
  });
});

describe("新会话占位行随流实时派生（task 19f IS-5）", () => {
  test("adopt 后 hydration 整替（服务端列表尚无新会话）：占位行保留且已是真实 id", () => {
    const store = useSessionsStore.getState();
    store.upsertSession("/p1", makeSession("alias-1", "/p1", "/p1/new.jsonl"));
    store.markAliasId("alias-1");
    // 首条消息回执带回真实 id：行换 key，选中随迁
    store.upsertSession("/p1", freshSession); // 常规行同组，验证不干扰
    useSessionsStore.getState().adoptSessionId("alias-1", "durable-1");
    const afterAdopt = useSessionsStore.getState();
    expect(afterAdopt.pendingIds["durable-1"]).toBe(true);
    expect(afterAdopt.aliasIds["alias-1"]).toBeUndefined();
    expect(afterAdopt.byProject["/p1"].map((s) => s.id)).toEqual(["durable-1", "fresh"]);
    // adopt 触发重挂载的探询刷新：此刻服务端列表只有旧会话，不含新落盘会话
    useSessionsStore.getState().setSessions("/p1", [freshSession]);
    expect(useSessionsStore.getState().byProject["/p1"].map((s) => s.id)).toEqual(["durable-1", "fresh"]);
  });

  test("服务端列表带回真实行后以服务端行胜出（同 id 不双行、同 path 不双行）", () => {
    const store = useSessionsStore.getState();
    store.upsertSession("/p1", makeSession("alias-1", "/p1", "/p1/same.jsonl"));
    store.markAliasId("alias-1");
    store.adoptSessionId("alias-1", "durable-1");
    const durableRow = { ...makeSession("durable-1", "/p1"), path: "/p1/same.jsonl", messageCount: 2 };
    useSessionsStore.getState().setSessions("/p1", [durableRow]);
    const rows = useSessionsStore.getState().byProject["/p1"];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("durable-1");
    expect(rows[0].messageCount).toBe(2);
  });

  test("adopt 聚合视图同口径：setAllSessions 尚无新会话时占位行追回", () => {
    const store = useSessionsStore.getState();
    store.upsertSession("/p1", makeSession("alias-1", "/p1"));
    store.markAliasId("alias-1");
    store.adoptSessionId("alias-1", "durable-1");
    // 聚合响应此刻只有旧项目旧会话（新会话项目尚无 durable 行）
    useSessionsStore.getState().setAllSessions([makeSession("old-1", "/p0")]);
    expect(useSessionsStore.getState().byProject["/p1"].map((s) => s.id)).toEqual(["durable-1"]);
    expect(useSessionsStore.getState().byProject["/p0"].map((s) => s.id)).toEqual(["old-1"]);
  });

  test("removeSession 清 pending 保护：删除后整替不复活（沿用别名语义）", () => {
    const store = useSessionsStore.getState();
    store.upsertSession("/p1", makeSession("alias-1", "/p1"));
    store.markAliasId("alias-1");
    store.adoptSessionId("alias-1", "durable-1");
    store.removeSession("durable-1");
    expect(useSessionsStore.getState().pendingIds["durable-1"]).toBeUndefined();
    useSessionsStore.getState().setSessions("/p1", [freshSession]);
    expect(useSessionsStore.getState().byProject["/p1"].map((s) => s.id)).toEqual(["fresh"]);
  });

  test("select 已 adopt 的真实 id 照常入 URL（pending 不参与别名清参语义）", async () => {
    const store = useSessionsStore.getState();
    store.upsertSession("/p1", makeSession("alias-1", "/p1"));
    store.markAliasId("alias-1");
    store.adoptSessionId("alias-1", "durable-1");
    // writeSessionUrl 操作 location：jsdom 未启用 history 的环境下仅验证不抛出，
    // 关键断言是 pendingIds 不在 aliasIds（URL 清参判定读 aliasIds）
    expect(() => useSessionsStore.getState().select("durable-1")).not.toThrow();
    expect(useSessionsStore.getState().aliasIds["durable-1"]).toBeUndefined();
  });
});

describe("durable=true 创建路径（task 19h IS-5）", () => {
  test("真实创建后 hydration 整替（服务端列表尚无新会话）：行保留且随流可见", () => {
    const store = useSessionsStore.getState();
    // session-list 创建回执 durable=true：upsert 本地副本 + markPendingId（无别名换 key）
    store.upsertSession("/p1", makeSession("dur-new", "/p1", "/p1/new.jsonl"));
    store.markPendingId("dur-new");
    expect(useSessionsStore.getState().byProject["/p1"].map((s) => s.id)).toEqual(["dur-new"]);
    // 随后探询/流中刷新：服务端列表仍只有旧会话，占位行不得被冲掉
    useSessionsStore.getState().setSessions("/p1", [freshSession]);
    expect(useSessionsStore.getState().byProject["/p1"].map((s) => s.id)).toEqual(["dur-new", "fresh"]);
    useSessionsStore.getState().setAllSessions([makeSession("old-0", "/p0")]);
    expect(useSessionsStore.getState().byProject["/p1"].map((s) => s.id)).toEqual(["dur-new"]);
  });

  test("服务端列表带回真实行后以服务端行胜出（同 id / 同 path 均不双行）", () => {
    const store = useSessionsStore.getState();
    store.upsertSession("/p1", { ...makeSession("dur-new", "/p1", "/p1/new.jsonl"), messageCount: 0 });
    store.markPendingId("dur-new");
    const serverRow = { ...makeSession("dur-new", "/p1"), messageCount: 3 };
    useSessionsStore.getState().setSessions("/p1", [freshSession, serverRow]);
    const rows = useSessionsStore.getState().byProject["/p1"];
    expect(rows).toHaveLength(2);
    expect(rows.find((s) => s.id === "dur-new")?.messageCount).toBe(3);
    // 同 path 不同 id（服务端换名场景）：弃占位行，防双行
    const renamed = { ...makeSession("dur-other", "/p1"), path: "/p1/new.jsonl" };
    useSessionsStore.getState().upsertSession("/p1", { ...makeSession("dur-new2", "/p1", "/p1/new2.jsonl") });
    useSessionsStore.getState().markPendingId("dur-new2");
    useSessionsStore.getState().setSessions("/p1", [freshSession, renamed]);
    const rows2 = useSessionsStore.getState().byProject["/p1"];
    expect(rows2.filter((s) => s.path === "/p1/new.jsonl")).toHaveLength(1);
    expect(rows2.find((s) => s.path === "/p1/new.jsonl")?.id).toBe("dur-other");
  });

  test("removeSession 清保护：删除后整替不复活", () => {
    const store = useSessionsStore.getState();
    store.upsertSession("/p1", makeSession("dur-new", "/p1"));
    store.markPendingId("dur-new");
    store.removeSession("dur-new");
    useSessionsStore.getState().setSessions("/p1", [freshSession]);
    expect(useSessionsStore.getState().byProject["/p1"].map((s) => s.id)).toEqual(["fresh"]);
  });
});
