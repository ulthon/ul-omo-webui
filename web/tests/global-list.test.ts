// 全局平铺列表纯逻辑单测（todo 10）：
// - groupOrder 分组排序（当前项目组最前，其余按各组最新 modified 降序）
// - recentTop 最近 8 条选取（跨项目按 modified 降序，置顶自然参与）
// - 折叠记忆（readCollapsed/writeCollapsed 回环 + isGroupExpanded 优先级）
// - crossProjectDecision 跨项目点击切换判定
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionListItem } from "@/lib/api";
import {
  COLLAPSE_PREFIX,
  RECENT_LIMIT,
  crossProjectDecision,
  flattenSessions,
  groupOrder,
  isGroupExpanded,
  latestModified,
  readCollapsed,
  recentTop,
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

describe("crossProjectDecision 跨项目点击切换判定", () => {
  const projects = [
    { projectPath: "/a", preferredModel: "zai-coding-cn/glm-5.3-flash" },
    { projectPath: "/b", preferredModel: "zai-coding-cn/glm-4.6v" },
  ];

  test("同项目：仅选中，不切换", () => {
    expect(crossProjectDecision("/a", "/a", projects)).toEqual({ switchProject: false, preferredModel: null });
  });

  test("跨项目：切换并携带目标项目偏好模型", () => {
    expect(crossProjectDecision("/b", "/a", projects)).toEqual({
      switchProject: true,
      preferredModel: "zai-coding-cn/glm-4.6v",
    });
  });

  test("目标项目未注册或无偏好：preferredModel 为 null（仍切换）", () => {
    expect(crossProjectDecision("/ghost", "/a", projects)).toEqual({ switchProject: true, preferredModel: null });
    expect(crossProjectDecision("/c", "/a", [{ projectPath: "/c", preferredModel: null }])).toEqual({
      switchProject: true,
      preferredModel: null,
    });
  });
});
