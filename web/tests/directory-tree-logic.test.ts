// 目录浏览纯逻辑 + DirectoryTree 懒加载单测（todo 16）。
// 补全触发判定/防抖目录变化/建议生成走纯函数；树懒加载走真实组件（happy-dom +
// react-dom/client）+ 注入 fetchDir（不触网）。端到端交互走浏览器 QA
//（.omo/qa/W5/add-project-browse.md）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FsBrowseEntry } from "@/lib/api";
import type { DirTreeFetcher } from "@/components/file-tree/directory-tree";

// bun test 单进程跑多文件：session-dialogs.test.tsx 可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const logic = await import("@/components/file-tree/directory-tree-logic");
const { DirectoryTree } = await import("@/components/file-tree/directory-tree");

function entry(name: string, path: string, hidden = false): FsBrowseEntry {
  return { name, path, hidden };
}

describe("suggestDirOf（目录部分提取与合法性）", () => {
  test("绝对路径取最后一个 / 及之前", () => {
    expect(logic.suggestDirOf("/home/u")).toBe("/home/");
    expect(logic.suggestDirOf("/home/user/proj")).toBe("/home/user/");
    expect(logic.suggestDirOf("/home/")).toBe("/home/");
  });

  test("以 / 结尾 = 目录本身；仅一个 / 时为根", () => {
    expect(logic.suggestDirOf("/")).toBe("/");
    expect(logic.suggestDirOf("/home")).toBe("/");
  });

  test("非绝对路径 / 空串 / 含 .. → null（静默不建议）", () => {
    expect(logic.suggestDirOf("home/user")).toBeNull();
    expect(logic.suggestDirOf("")).toBeNull();
    expect(logic.suggestDirOf("/home/../etc")).toBeNull();
    expect(logic.suggestDirOf("/etc/../")).toBeNull();
  });
});

describe("nextSuggestDir（防抖触发判定：目录部分变化才取）", () => {
  test("首次输入：目录部分有效即触发", () => {
    expect(logic.nextSuggestDir("/home/u", null)).toBe("/home/");
    expect(logic.nextSuggestDir("/", null)).toBe("/");
  });

  test("同一段内继续打字：目录部分不变，不重复请求", () => {
    expect(logic.nextSuggestDir("/home/ub", "/home/")).toBeNull();
  });

  test("跨过新的 /（新增路径段）：触发", () => {
    expect(logic.nextSuggestDir("/home/user/", "/home/")).toBe("/home/user/");
  });

  test("非法路径恒不触发（含上次有效）", () => {
    expect(logic.nextSuggestDir("relative", "/home/")).toBeNull();
    expect(logic.nextSuggestDir("/a/../b", "/home/")).toBeNull();
  });
});

describe("browsePathOf / suggestionBackfill", () => {
  test("根目录映射为缺省参数（服务端取 home），其余原样", () => {
    expect(logic.browsePathOf("/")).toBeUndefined();
    expect(logic.browsePathOf("/root/docs/")).toBe("/root/docs/");
  });

  test("回填 = 建议绝对路径 + 尾随 /（可继续下钻）", () => {
    expect(logic.suggestionBackfill(entry("proj", "/root/proj"))).toBe("/root/proj/");
  });
});

describe("pickSuggestions（建议列表生成）", () => {
  const ALL = [
    entry("zoo", "/root/zoo"),
    entry(".cache", "/root/.cache", true),
    entry("projects", "/root/projects"),
    entry("probe", "/root/probe"),
    entry("Documents", "/root/Documents"),
  ];

  test("以 / 结尾：全部子目录，非隐藏在前、名称序", () => {
    expect(logic.pickSuggestions("/root/", ALL).map((e) => e.name)).toEqual([
      "Documents",
      "probe",
      "projects",
      "zoo",
      ".cache",
    ]);
  });

  test("尾部未完成段过滤（大小写不敏感子串），前缀命中优先", () => {
    expect(logic.pickSuggestions("/root/pro", ALL).map((e) => e.name)).toEqual(["probe", "projects"]);
    expect(logic.pickSuggestions("/root/DOC", ALL).map((e) => e.name)).toEqual(["Documents"]);
  });

  test("隐藏目录排在非隐藏之后（无段时也在尾部）", () => {
    expect(logic.pickSuggestions("/root/", [entry(".a", "/root/.a", true), entry("b", "/root/b")]).map((e) => e.name))
      .toEqual(["b", ".a"]);
  });

  test("非法输入或目录不匹配 → 空建议", () => {
    expect(logic.pickSuggestions("relative", ALL)).toEqual([]);
    expect(logic.pickSuggestions("/root/../etc/", ALL)).toEqual([]);
  });

  test("条数截断到 SUGGEST_LIMIT", () => {
    const many = Array.from({ length: 50 }, (_, i) => entry(`d${String(i).padStart(2, "0")}`, `/root/d${i}`));
    expect(logic.pickSuggestions("/root/", many)).toHaveLength(logic.SUGGEST_LIMIT);
  });
});

describe("目录树状态转移（纯函数）", () => {
  test("初始态根目录即在加载中", () => {
    const init = logic.initialDirTree();
    expect(init.loading.has("")).toBe(true);
    expect(init.children.get("")).toBeUndefined();
  });

  test("展开无缓存目录置 loading；加载成功写入并清除", () => {
    let d = logic.treeExpand(logic.initialDirTree(), "/root/a");
    expect(d.expanded.has("/root/a")).toBe(true);
    expect(d.loading.has("/root/a")).toBe(true);
    d = logic.treeLoaded(d, "/root/a", [entry("c", "/root/a/c")]);
    expect(d.loading.has("/root/a")).toBe(false);
    expect(d.children.get("/root/a")).toHaveLength(1);
  });

  test("已缓存目录再展开不置 loading（不重复请求）", () => {
    let d = logic.treeLoaded(logic.initialDirTree(), "/root/a", []);
    d = logic.treeExpand(d, "/root/a");
    expect(d.loading.has("/root/a")).toBe(false);
  });

  test("加载失败收回展开并清 loading", () => {
    let d = logic.treeExpand(logic.initialDirTree(), "/root/dead");
    d = logic.treeLoadFailed(d, "/root/dead");
    expect(d.expanded.has("/root/dead")).toBe(false);
    expect(d.loading.has("/root/dead")).toBe(false);
  });

  test("收起重复调用幂等（引用不变）", () => {
    const d = logic.initialDirTree();
    expect(logic.treeCollapse(d, "/root/a")).toBe(d);
  });
});

// ---------- DirectoryTree 组件（注入 fetchDir，懒加载行为） ----------

describe("DirectoryTree 懒加载", () => {
  let container: HTMLElement;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    container.remove();
    globalThis.fetch = originalFetch;
  });

  function row(path: string): HTMLElement | null {
    return container.querySelector(`[data-testid="dir-name-${path}"]`);
  }

  function toggleBtn(path: string): HTMLElement | null {
    return container.querySelector(`[data-testid="dir-toggle-${path}"]`);
  }

  /** 点击 + 额外冲刷微任务（fetch 承诺链的 setData 落在 act 窗口内，免 act 告警） */
  async function clickAct(el: HTMLElement | null): Promise<void> {
    await act(async () => {
      el?.click();
      await Promise.resolve();
    });
  }

  test("挂载取根（无 path 参数）；行点击 = 选中 + 懒加载下钻；缓存层不重复请求", async () => {
    const calls: string[] = [];
    const selected: string[] = [];
    const fetcher: DirTreeFetcher = (path) => {
      calls.push(path ?? "(root)");
      const entries =
        path === undefined
          ? [entry("a", "/root/a"), entry("b", "/root/b")]
          : path === "/root/a"
            ? [entry("c", "/root/a/c")]
            : [];
      return Promise.resolve({ entries });
    };
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(DirectoryTree, { selectedPath: null, onSelect: (p: string) => selected.push(p), fetchDir: fetcher }),
      );
    });
    await act(async () => {}); // 冲刷根目录取数承诺
    expect(calls).toEqual(["(root)"]);
    expect(row("/root/a")).toBeTruthy();

    // 行点击：选中 + 展开触发子层懒加载
    await clickAct(row("/root/a"));
    expect(selected).toEqual(["/root/a"]);
    expect(calls).toEqual(["(root)", "/root/a"]);
    expect(row("/root/a/c")).toBeTruthy();

    // 收起再展开：命中缓存，零新请求
    await clickAct(toggleBtn("/root/a"));
    expect(row("/root/a/c")).toBeNull();
    await clickAct(toggleBtn("/root/a"));
    expect(calls).toEqual(["(root)", "/root/a"]);
    expect(row("/root/a/c")).toBeTruthy();
    await act(async () => {
      root.unmount();
    });
  });

  test("加载失败：行收回、错误行内展示、可重试", async () => {
    const calls: string[] = [];
    const fetcher: DirTreeFetcher = (path) => {
      calls.push(path ?? "(root)");
      if (path === "/root/dead") return Promise.reject(new Error("路径逃逸被拒绝"));
      return Promise.resolve({ entries: path === undefined ? [entry("dead", "/root/dead")] : [] });
    };
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(DirectoryTree, { selectedPath: null, onSelect: () => {}, fetchDir: fetcher }),
      );
    });
    await act(async () => {});
    await clickAct(row("/root/dead"));
    expect(calls).toEqual(["(root)", "/root/dead"]);
    expect(container.querySelector('[data-testid="dir-tree-error"]')?.textContent).toContain("路径逃逸被拒绝");
    expect(row("/root/dead")).toBeTruthy(); // 行仍在（只是收回展开）

    // 重试：再点重新发起请求
    await clickAct(row("/root/dead"));
    expect(calls).toEqual(["(root)", "/root/dead", "/root/dead"]);
    await act(async () => {
      root.unmount();
    });
  });
});
