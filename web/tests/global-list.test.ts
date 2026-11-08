// 全局平铺列表纯逻辑单测（todo 10）：
// - groupOrder 分组排序（当前项目组最前，其余按各组最新 modified 降序）
// - recentTop 最近 8 条选取（跨项目按 modified 降序，置顶自然参与）
// - 折叠记忆（readCollapsed/writeCollapsed 回环 + isGroupExpanded 优先级）
// （跨项目点击判定已随会话根架构 W2 任务 6 内联进 sessions store 的 select，
//  调用点只调内聚 select）
import { afterEach, describe, expect, test } from "vitest";
import type { SessionListItem } from "@/lib/api";
import {
  COLLAPSE_PREFIX,
  RECENT_LIMIT,
  SESSION_ORDER_KV,
  SESSION_SORT_KV,
  flattenSessions,
  groupOrder,
  isGroupExpanded,
  latestModified,
  orderSessions,
  parseManualProjectOrder,
  parseManualSessionOrder,
  parseProjectSort,
  parseSessionSort,
  readCollapsed,
  recentTop,
  sessionActivityKey,
  writeCollapsed,
} from "@/components/session-list/global-list-data";

function makeSession(
  id: string,
  project: string,
  modified = "2026-01-01T00:00:00.000Z",
  pinned = false,
): SessionListItem {
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
    messageCount: 2,
    firstMessage: id,
    pinned,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
  };
}

// localStorage fake（bun 测试无 DOM，经参数注入；组件路径缺省走浏览器 localStorage）
function fakeStorage(): { get(k: string): string | null; set(k: string, v: string): void; map: Map<string, string> } & Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return {
    map,
    get: (k: string) => (map.has(k) ? map.get(k)! : null),
    set: (k: string, v: string) => void map.set(k, v),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

afterEach(() => {
  // 全局 localStorage 守卫路径（无注入时）在 bun 下返回 null，无残留；此处兜底清注入 map 引用即可
});

describe("groupOrder 分组排序", () => {
  test("当前项目组最前，其余按各组最新 modified 降序", () => {
    const byProject = {
      "/a": [makeSession("a1", "/a", "2026-01-05T00:00:00.000Z")],
      "/b": [
        makeSession("b1", "/b", "2026-01-02T00:00:00.000Z"),
        makeSession("b2", "/b", "2026-01-09T00:00:00.000Z"),
      ],
      "/c": [makeSession("c1", "/c", "2026-01-07T00:00:00.000Z")],
    };
    // 组取最新 modified：a=01-05、b=01-09、c=01-07 → b > c > a
    expect(groupOrder(["/a", "/b", "/c"], byProject, "/a")).toEqual(["/a", "/b", "/c"]);
    // 当前切到 c：c 最前，其余仍按最新 modified 降序
    expect(groupOrder(["/a", "/b", "/c"], byProject, "/c")).toEqual(["/c", "/b", "/a"]);
  });

  test("当前项目不在注册集时不产生幽灵组；无数据项目按空 modified 排尾", () => {
    const byProject = { "/b": [makeSession("b1", "/b", "2026-01-09T00:00:00.000Z")] };
    expect(groupOrder(["/a", "/b"], byProject, "/ghost")).toEqual(["/b", "/a"]);
    expect(groupOrder(["/a", "/b"], byProject, null)).toEqual(["/b", "/a"]);
  });

  test("latestModified：空组为空串（恒排尾）", () => {
    expect(latestModified([])).toBe("");
    expect(latestModified([makeSession("x", "/p", "2026-02-03T00:00:00.000Z")])).toBe("2026-02-03T00:00:00.000Z");
  });
});

describe("groupOrder 排序三档（C16 docs08-r3 todo 9）", () => {
  const byProject = {
    "/a": [makeSession("a1", "/a", "2026-01-05T00:00:00.000Z")],
    "/b": [makeSession("b1", "/b", "2026-01-09T00:00:00.000Z")],
    "/c": [makeSession("c1", "/c", "2026-01-07T00:00:00.000Z")],
  };

  test("activity 档（缺省）与无参数调用同结果：当前置顶 + 最新 modified 降序", () => {
    expect(groupOrder(["/a", "/b", "/c"], byProject, "/a")).toEqual(["/a", "/b", "/c"]);
    expect(groupOrder(["/a", "/b", "/c"], byProject, "/a", { mode: "activity" })).toEqual(["/a", "/b", "/c"]);
  });

  test("added 档：按 createdAt 升序；存量行（createdAt 同值）保持传入稳定序", () => {
    // 迁移后注册时间：c < a < b（与 activity 序不同，验证档位生效）
    const meta = {
      "/a": { createdAt: "2026-03-02T00:00:00.000Z" },
      "/b": { createdAt: "2026-03-03T00:00:00.000Z" },
      "/c": { createdAt: "2026-03-01T00:00:00.000Z" },
    };
    expect(groupOrder(["/a", "/b", "/c"], byProject, null, { mode: "added", meta })).toEqual(["/c", "/a", "/b"]);
    // 当前项目组置顶规则不动
    expect(groupOrder(["/a", "/b", "/c"], byProject, "/b", { mode: "added", meta })).toEqual(["/b", "/c", "/a"]);
    // 存量行：createdAt 全部同为迁移时刻 → 保持传入稳定序（W3 任务 11：打开链路退化序
    // 已退役，createdAt 是唯一排序依据）
    const legacy = {
      "/x": { createdAt: "2026-03-01T00:00:00.000Z" },
      "/y": { createdAt: "2026-03-01T00:00:00.000Z" },
      "/z": { createdAt: "2026-03-01T00:00:00.000Z" },
    };
    expect(groupOrder(["/x", "/y", "/z"], byProject, null, { mode: "added", meta: legacy })).toEqual(["/x", "/y", "/z"]);
    // meta 缺失 defensively 当空值走稳定序（不崩）
    expect(groupOrder(["/a", "/b"], byProject, null, { mode: "added" })).toEqual(["/a", "/b"]);
  });

  test("manual 档：kv 序生效，未列项目按 activity 规则追加，未知/重复路径忽略不崩", () => {
    // kv 序 [c, a]：b 未列 → 按 modified 降序追加到尾
    expect(groupOrder(["/a", "/b", "/c"], byProject, null, { mode: "manual", manualOrder: ["/c", "/a"] })).toEqual([
      "/c",
      "/a",
      "/b",
    ]);
    // 未知路径（已注销）与重复项忽略
    expect(groupOrder(["/a", "/b", "/c"], byProject, null, { mode: "manual", manualOrder: ["/ghost", "/c", "/c", "/a"] })).toEqual([
      "/c",
      "/a",
      "/b",
    ]);
    // 当前项目组置顶规则不动（kv 序仅作用于其余组）
    expect(groupOrder(["/a", "/b", "/c"], byProject, "/c", { mode: "manual", manualOrder: ["/a", "/c"] })).toEqual([
      "/c",
      "/a",
      "/b",
    ]);
    // 无 kv 序（undefined）回退 activity 规则
    expect(groupOrder(["/a", "/b", "/c"], byProject, null, { mode: "manual" })).toEqual(["/b", "/c", "/a"]);
  });

  test("parseProjectSort：合法值透传，缺失/未知/空回退 activity", () => {
    expect(parseProjectSort("activity")).toBe("activity");
    expect(parseProjectSort("added")).toBe("added");
    expect(parseProjectSort("manual")).toBe("manual");
    expect(parseProjectSort(undefined)).toBe("activity");
    expect(parseProjectSort(null)).toBe("activity");
    expect(parseProjectSort("")).toBe("activity");
    expect(parseProjectSort("bogus")).toBe("activity");
  });

  test("parseManualProjectOrder：合法数组透传；非法 JSON/非数组/非字符串项/重复项容错", () => {
    expect(parseManualProjectOrder('["/a","/b"]')).toEqual(["/a", "/b"]);
    // 重复项去重
    expect(parseManualProjectOrder('["/a","/a","/b"]')).toEqual(["/a", "/b"]);
    // 非字符串项忽略
    expect(parseManualProjectOrder('["/a",3,null,"/b"]')).toEqual(["/a", "/b"]);
    // 缺失/空串 → null（回退当前档规则）
    expect(parseManualProjectOrder(undefined)).toBeNull();
    expect(parseManualProjectOrder(null)).toBeNull();
    expect(parseManualProjectOrder("")).toBeNull();
    // 非法 JSON / 非数组 → null 不崩
    expect(parseManualProjectOrder("{not-json")).toBeNull();
    expect(parseManualProjectOrder('"plain-string"')).toBeNull();
    expect(parseManualProjectOrder('{"a":1}')).toBeNull();
    expect(parseManualProjectOrder("42")).toBeNull();
  });
});

describe("recentTop 最近会话选取", () => {
  test("跨项目按 modified 降序取前 8 条；置顶会话自然参与（无特殊排序）", () => {
    const all = [
      makeSession("old-pinned", "/a", "2026-01-01T00:00:00.000Z", true),
      makeSession("n1", "/b", "2026-01-12T00:00:00.000Z"),
      makeSession("n2", "/a", "2026-01-11T00:00:00.000Z"),
      makeSession("n3", "/c", "2026-01-10T00:00:00.000Z"),
      makeSession("n4", "/b", "2026-01-09T00:00:00.000Z"),
      makeSession("n5", "/c", "2026-01-08T00:00:00.000Z"),
      makeSession("n6", "/a", "2026-01-07T00:00:00.000Z"),
      makeSession("n7", "/b", "2026-01-06T00:00:00.000Z"),
      makeSession("n8", "/c", "2026-01-05T00:00:00.000Z"),
      makeSession("n9", "/a", "2026-01-04T00:00:00.000Z"),
      makeSession("n10", "/b", "2026-01-03T00:00:00.000Z"),
    ];
    const top = recentTop(flattenSessions({ "/a": all.filter((s) => s.project === "/a"), "/b": all.filter((s) => s.project === "/b"), "/c": all.filter((s) => s.project === "/c") }));
    expect(top).toHaveLength(RECENT_LIMIT);
    expect(RECENT_LIMIT).toBe(8);
    // 最新 8 条 = n1..n8（按 modified 降序）；旧置顶会话与 n9/n10 落选
    expect(top.map((s) => s.id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]);
    expect(top.some((s) => s.pinned)).toBe(false);
  });

  test("新近的置顶会话按 modified 自然进入最近区", () => {
    const all = [
      makeSession("pin-new", "/a", "2026-02-01T00:00:00.000Z", true),
      makeSession("plain", "/b", "2026-01-01T00:00:00.000Z"),
    ];
    const top = recentTop(all);
    expect(top[0].id).toBe("pin-new");
  });

  test("不足 8 条全返回；limit 参数生效", () => {
    expect(recentTop([makeSession("a", "/p")])).toHaveLength(1);
    expect(recentTop([makeSession("a", "/p", "2026-01-02T00:00:00.000Z"), makeSession("b", "/p", "2026-01-01T00:00:00.000Z")], 1).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("折叠记忆", () => {
  test("writeCollapsed/readCollapsed 回环；未写入返回 null", () => {
    const ls = fakeStorage();
    expect(readCollapsed("/p", ls)).toBeNull();
    writeCollapsed("/p", true, ls);
    expect(readCollapsed("/p", ls)).toBe(true);
    expect(ls.map.get(COLLAPSE_PREFIX + "/p")).toBe("1");
    writeCollapsed("/p", false, ls);
    expect(readCollapsed("/p", ls)).toBe(false);
    expect(ls.map.get(COLLAPSE_PREFIX + "/p")).toBe("0");
  });

  test("isGroupExpanded 优先级：显式覆盖 > localStorage 记忆 > 默认（当前展开/其余折叠）", () => {
    const ls = fakeStorage();
    // 无记忆无覆盖：当前项目展开，其余折叠
    expect(isGroupExpanded("/cur", "/cur", undefined, ls)).toBe(true);
    expect(isGroupExpanded("/other", "/cur", undefined, ls)).toBe(false);
    // 记忆优先于默认：当前项目被记成折叠则折叠
    writeCollapsed("/cur", true, ls);
    expect(isGroupExpanded("/cur", "/cur", undefined, ls)).toBe(false);
    // 覆盖优先于记忆：本次会话内点开过则展开
    expect(isGroupExpanded("/cur", "/cur", true, ls)).toBe(true);
    // 记忆展开的非当前项目
    writeCollapsed("/other", false, ls);
    expect(isGroupExpanded("/other", "/cur", undefined, ls)).toBe(true);
  });
});

// ---- 会话排序三模式（2026-11-09）：auto/pin/manual ----

describe("sessionActivityKey", () => {
  test("lastActiveAt 优先，空串/缺席回退 modified（查看触发的非消息写不上浮）", () => {
    expect(sessionActivityKey({ lastActiveAt: "2026-06-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z" })).toBe(
      "2026-06-01T00:00:00.000Z",
    );
    expect(sessionActivityKey({ lastActiveAt: null, modified: "2026-01-01T00:00:00.000Z" })).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(sessionActivityKey({ lastActiveAt: "", modified: "2026-01-01T00:00:00.000Z" })).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});

describe("orderSessions 三模式语义", () => {
  const mk = (id: string, modified: string, pinned = false, lastActiveAt?: string | null): SessionListItem => ({
    ...({ id, modified, pinned } as unknown as SessionListItem),
    ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
  });

  test("auto：仅按活跃键降序，置顶标记不参与（有消息才提前）", () => {
    // a 的文件 mtime 最新但最后消息更旧；b 消息最新 → b 第一；c 置顶但不参与
    const a = mk("a", "2026-06-10T00:00:00.000Z", true, "2026-05-01T00:00:00.000Z");
    const b = mk("b", "2026-01-01T00:00:00.000Z", false, "2026-06-01T00:00:00.000Z");
    const c = mk("c", "2026-05-02T00:00:00.000Z", true);
    expect(orderSessions([a, b, c], "auto", []).map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  test("auto：纯查看不置顶——mtime 被查看刷新到最新但消息活跃更旧时不提前", () => {
    // 服务端真实形态：纯查看会话 lastActiveAt = 最后一条消息时刻（旧），仅 mtime（modified）新
    const viewed = mk("viewed", "2026-06-10T00:00:00.000Z", false, "2026-05-01T00:00:00.000Z");
    const messaged = mk("messaged", "2026-01-01T00:00:00.000Z", false, "2026-06-01T00:00:00.000Z");
    expect(orderSessions([viewed, messaged], "auto", []).map((s) => s.id)).toEqual(["messaged", "viewed"]);
  });

  test("pin：置顶优先，置顶组内按活跃序，非置顶活跃序", () => {
    const p1 = mk("p1", "2026-01-01T00:00:00.000Z", true, "2026-05-01T00:00:00.000Z");
    const p2 = mk("p2", "2026-01-02T00:00:00.000Z", true, "2026-06-01T00:00:00.000Z");
    const n1 = mk("n1", "2026-01-03T00:00:00.000Z", false, "2026-04-01T00:00:00.000Z");
    expect(orderSessions([n1, p1, p2], "pin", []).map((s) => s.id)).toEqual(["p2", "p1", "n1"]);
  });

  test("manual：按顺序数组，未列入（含新会话）按活跃序追加组尾，置顶不插队", () => {
    const a = mk("a", "2026-06-01T00:00:00.000Z", true);
    const b = mk("b", "2026-05-01T00:00:00.000Z");
    const c = mk("c", "2026-04-01T00:00:00.000Z");
    // c 最新消息但数组中排在最后；新会话 new 不在数组 → 尾部
    expect(orderSessions([a, b, c], "manual", ["c", "a"]).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  test("稳定性：同键行保持传入相对序", () => {
    const a = mk("a", "2026-01-01T00:00:00.000Z");
    const b = mk("b", "2026-01-01T00:00:00.000Z");
    expect(orderSessions([a, b], "auto", []).map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("会话排序 kv 解析与键名", () => {
  test("parseSessionSort：缺失/未知回退 auto；合法档透传", () => {
    expect(parseSessionSort(null)).toBe("auto");
    expect(parseSessionSort(undefined)).toBe("auto");
    expect(parseSessionSort("")).toBe("auto");
    expect(parseSessionSort("wat")).toBe("auto");
    expect(parseSessionSort("pin")).toBe("pin");
    expect(parseSessionSort("manual")).toBe("manual");
  });

  test("kv 键名与项目排序键同前缀不同名", () => {
    expect(SESSION_SORT_KV).toBe("sidebar.sessionSort");
    expect(SESSION_ORDER_KV).toBe("sidebar.sessionOrder");
  });

  test("parseManualSessionOrder 与项目序同一解析器：非法回退 null、去重", () => {
    expect(parseManualSessionOrder(null)).toBeNull();
    expect(parseManualSessionOrder("no-json")).toBeNull();
    expect(parseManualSessionOrder(JSON.stringify(["a", "a", "b"]))).toEqual(["a", "b"]);
    expect(parseManualProjectOrder(JSON.stringify(["x"]))).toEqual(["x"]);
  });
});
