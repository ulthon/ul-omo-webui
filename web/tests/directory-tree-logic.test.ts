// 目录浏览纯逻辑 + DirectoryTree 懒加载单测（todo 16）。
// 补全触发判定/防抖目录变化/建议生成走纯函数；树懒加载走真实组件（happy-dom +
// react-dom/client）+ 注入 fetchDir（不触网）。端到端交互走浏览器 QA
//（.omo/qa/W5/add-project-browse.md）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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

  test("非绝对路径 / 空串 → null（静默不建议）；含 .. 不再拒绝（服务端 resolve 归一兜底）", () => {
    expect(logic.suggestDirOf("home/user")).toBeNull();
    expect(logic.suggestDirOf("")).toBeNull();
    expect(logic.suggestDirOf("/home/../etc")).toBe("/home/../");
    expect(logic.suggestDirOf("/etc/../")).toBe("/etc/../");
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

  test("非法路径恒不触发；含 .. 的输入按新语义正常触发", () => {
    expect(logic.nextSuggestDir("relative", "/home/")).toBeNull();
    expect(logic.nextSuggestDir("/a/../b", "/home/")).toBe("/a/../");
  });
});

describe("browsePathOf / suggestionBackfill", () => {
  test("根即文件系统根，原样传回（W5 todo 14：不再映射缺省参数）", () => {
    expect(logic.browsePathOf("/")).toBe("/");
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

  test("非法输入 → 空建议；含 .. 的目录部分有效（新语义）", () => {
    expect(logic.pickSuggestions("relative", ALL)).toEqual([]);
    // 目录部分 "/root/../etc/" 有效且段为空 → 全量建议
    expect(logic.pickSuggestions("/root/../etc/", ALL)).toHaveLength(ALL.length);
  });

  test("服务端合成的 .. 行不作为补全候选（回填会产生 //）", () => {
    const withParent = [entry("..", "/"), entry("b", "/root/b"), entry(".cache", "/root/.cache", true)];
    expect(logic.pickSuggestions("/root/", withParent).map((e) => e.name)).toEqual(["b", ".cache"]);
    expect(logic.pickSuggestions("/", withParent).map((e) => e.name)).toEqual(["b", ".cache"]);
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

  test("服务端合成的 .. 行置顶渲染且使用 folder-up 图标", async () => {
    // 契约：根列表（缺省参数与 path=/）不含 ..；仅非根列表头部有 ..——保证上行导航终止
    const fetcher: DirTreeFetcher = (path) =>
      Promise.resolve({
        entries:
          path === undefined
            ? [entry("..", "/"), entry("data", "/data")]
            : path === "/"
              ? [entry("data", "/data")]
              : [],
      });
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(DirectoryTree, { selectedPath: null, onSelect: () => {}, fetchDir: fetcher }));
    });
    await act(async () => {});
    // ".." 行存在且排首（服务端合成顺序即渲染顺序），图标为 lucide folder-up
    const parentRow = container.querySelector('[data-testid="dir-name-/"]');
    expect(parentRow).toBeTruthy();
    expect(parentRow?.textContent).toBe("..");
    const rows = [...container.querySelectorAll("[role='treeitem']")];
    expect(rows[0]?.getAttribute("data-testid")).toBe("dir-row-/");
    expect(parentRow?.querySelector("svg")?.classList.contains("lucide-folder-up")).toBe(true);
    // ".." 行不可展开：无 chevron 按钮、无 aria-expanded（防与同键父目录互相嵌套递归）
    expect(container.querySelector('[data-testid="dir-toggle-/"]')).toBeNull();
    expect(rows[0]?.getAttribute("aria-expanded")).toBeNull();
    // 普通目录行仍是 folder 图标
    const dataRow = container.querySelector('[data-testid="dir-name-/data"]');
    expect(dataRow?.querySelector("svg")?.classList.contains("lucide-folder")).toBe(true);
    // 点 ".." 行 = 选中父路径
    await clickAct(parentRow);
    await act(async () => {
      root.unmount();
    });
  });

  test("已注册项目行：置灰 + 已添加徽标 + 禁选但仍可下钻", async () => {
    const calls: string[] = [];
    const selected: string[] = [];
    const fetcher: DirTreeFetcher = (path) => {
      calls.push(path ?? "(root)");
      return Promise.resolve({
        entries:
          path === undefined || path === "/"
            ? [entry("a", "/root/a"), entry("b", "/root/b")]
            : path === "/root/a"
              ? [entry("c", "/root/a/c")]
              : [],
      });
    };
    const registered = new Set(["/root/a"]);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(DirectoryTree, {
          selectedPath: null,
          onSelect: (p: string) => selected.push(p),
          fetchDir: fetcher,
          registeredPaths: registered,
        }),
      );
    });
    await act(async () => {});
    // 徽标存在 + aria-disabled 标注
    expect(container.querySelector('[data-testid="dir-added-/root/a"]')?.textContent).toBe("已添加");
    expect(container.querySelector('[data-testid="dir-name-/root/a"]')?.getAttribute("aria-disabled")).toBe(
      "true",
    );
    // 未注册行无徽标
    expect(container.querySelector('[data-testid="dir-added-/root/b"]')).toBeNull();

    // 点已注册行：不选中，但仍下钻（navigable）
    await clickAct(row("/root/a"));
    expect(selected).toEqual([]);
    expect(calls).toEqual(["(root)", "/root/a"]);
    expect(row("/root/a/c")).toBeTruthy();

    // 未注册行点击照常选中
    await clickAct(row("/root/b"));
    expect(selected).toEqual(["/root/b"]);
    await act(async () => {
      root.unmount();
    });
  });

  test("回归：下钻链上的 .. 行（与已展开父目录同键）不触发递归渲染", async () => {
    const calls: string[] = [];
    const fetcher: DirTreeFetcher = (path) => {
      calls.push(path ?? "(root)");
      expect(calls.length).toBeLessThanOrEqual(3); // 超过 3 层取数即递归失控
      return Promise.resolve({
        entries:
          path === undefined
            ? [entry("data", "/data")]
            : path === "/data"
              ? [entry("..", "/"), entry("projects", "/data/projects")]
              : path === "/data/projects"
                ? [entry("..", "/data"), entry("ul-omo-webui", "/data/projects/ul-omo-webui")]
                : [],
      });
    };
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(DirectoryTree, {
          selectedPath: null,
          onSelect: () => {},
          fetchDir: fetcher,
          registeredPaths: new Set(["/data/projects/ul-omo-webui"]),
        }),
      );
    });
    await act(async () => {});
    await clickAct(row("/data"));
    await clickAct(row("/data/projects"));
    // /data/projects 下的 ".."（path=/data，与已展开的 data 行同键）必须保持折叠
    const parentAliasRow = container.querySelectorAll('[data-testid="dir-row-/data"]')[1];
    expect(parentAliasRow?.getAttribute("aria-expanded")).toBeNull();
    expect(row("/data/projects/ul-omo-webui")).toBeTruthy();
    expect(calls).toEqual(["(root)", "/data", "/data/projects"]);
    await act(async () => {
      root.unmount();
    });
  });
});

// ---------- Windows 路径形态（跨平台兼容：客户端不知服务端平台，两种绝对路径形态都放行） ----------

describe("isAbsoluteInput（绝对路径形态判定）", () => {
  test("POSIX / Windows 盘符 / UNC 均为绝对路径（分隔符 / 与 \\ 皆认）", () => {
    expect(logic.isAbsoluteInput("/home/u")).toBe(true);
    expect(logic.isAbsoluteInput("D:\\projects\\x")).toBe(true);
    expect(logic.isAbsoluteInput("d:/projects/x")).toBe(true);
    expect(logic.isAbsoluteInput("\\\\server\\share\\x")).toBe(true);
  });

  test("相对路径、裸盘符、空串 → false（裸 D: 是盘相对路径，不算绝对）", () => {
    expect(logic.isAbsoluteInput("home/u")).toBe(false);
    expect(logic.isAbsoluteInput("D:")).toBe(false);
    expect(logic.isAbsoluteInput("")).toBe(false);
    expect(logic.isAbsoluteInput("relative\\win")).toBe(false);
  });
});

describe("suggestDirOf（Windows 形态目录部分提取）", () => {
  test("反斜杠/正斜杠盘符路径取最后分隔符及之前", () => {
    expect(logic.suggestDirOf("D:\\projects\\my")).toBe("D:\\projects\\");
    expect(logic.suggestDirOf("D:/projects/my")).toBe("D:/projects/");
    expect(logic.suggestDirOf("D:\\projects\\")).toBe("D:\\projects\\");
    expect(logic.suggestDirOf("D:\\p")).toBe("D:\\");
  });

  test("盘根输入（D:\\）目录部分为盘根本身；UNC 取最后分隔符", () => {
    expect(logic.suggestDirOf("D:\\")).toBe("D:\\");
    expect(logic.suggestDirOf("\\\\srv\\share\\di")).toBe("\\\\srv\\share\\");
  });
});

describe("normalizeBrowsePath（Windows 形态判重键）", () => {
  test("盘根三形态统一为 D:\\（去尾会退化成盘相对路径 D:，必须保形）", () => {
    expect(logic.normalizeBrowsePath("D:\\")).toBe("D:\\");
    expect(logic.normalizeBrowsePath("D:")).toBe("D:\\");
    expect(logic.normalizeBrowsePath("D:/")).toBe("D:/");
  });

  test("盘内路径去尾分隔符；POSIX 行为不回归", () => {
    expect(logic.normalizeBrowsePath("D:\\projects\\x\\")).toBe("D:\\projects\\x");
    expect(logic.normalizeBrowsePath("D:\\projects\\x/")).toBe("D:\\projects\\x");
    expect(logic.normalizeBrowsePath("/home//u/")).toBe("/home/u");
    expect(logic.normalizeBrowsePath("/")).toBe("/");
    expect(logic.normalizeBrowsePath("")).toBe("");
  });
});

describe("suggestionBackfill（按路径分隔符形态补尾）", () => {
  test("win 形态补 \\，POSIX 形态补 /，盘根与 POSIX 根保形", () => {
    expect(logic.suggestionBackfill(entry("x", "D:\\projects\\x"))).toBe("D:\\projects\\x\\");
    expect(logic.suggestionBackfill(entry("x", "/home/x"))).toBe("/home/x/");
    expect(logic.suggestionBackfill(entry("C:\\", "C:\\"))).toBe("C:\\");
    expect(logic.suggestionBackfill(entry("/", "/"))).toBe("/");
  });
});
