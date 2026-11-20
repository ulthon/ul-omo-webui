// 文件树 headless controller 单测（files-ux-revamp 任务 1）。
// 纯转移函数与失效矩阵走直接断言；hook 行为经 happy-dom + createRoot/act 挂载 Harness
// （同 directory-tree-logic.test.ts 口径），fetch 注入可编排 deferred，竞态/逐出/回源
// 范围断言落在 recording fetcher 与 ui store 替身上（pushGlobalError 以 setState 换 spies）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FsTreeEntry, FsTreeResponse } from "@/lib/api";
import type { FileTreeController, TreeFetcher } from "@/components/file-tree/file-tree-controller";

// bun test 单进程跑多文件：session-dialogs.test.tsx 可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const logic = await import("@/components/file-tree/file-tree-controller");
const { useUiStore } = await import("@/stores/ui");

function dir(name: string): FsTreeEntry {
  return { name, type: "directory" };
}
function file(name: string): FsTreeEntry {
  return { name, type: "file" };
}
function sym(name: string): FsTreeEntry {
  return { name, type: "symlink" };
}

interface PendingReq {
  key: string;
  resolve(res: FsTreeResponse): void;
  reject(err: unknown): void;
}

/** 可编排 deferred recording fetcher：每次调用记录路径（"" 为根）并挂起新 deferred；
 * settle/rejectKey 按路径取最早的挂起请求（旧 gen 的响应先落地，正是竞态用例需要的顺序） */
function makeDeferredFetcher() {
  const calls: string[] = [];
  const pending: PendingReq[] = [];
  const fetcher: TreeFetcher = (path) => {
    const key = path ?? "";
    calls.push(key);
    return new Promise<FsTreeResponse>((resolve, reject) => {
      pending.push({ key, resolve, reject });
    });
  };
  const take = (key: string): PendingReq => {
    const i = pending.findIndex((r) => r.key === key);
    if (i < 0) throw new Error(`无挂起请求：${key}`);
    return pending.splice(i, 1)[0];
  };
  const settle = (key: string, entries: FsTreeEntry[]): void => {
    take(key).resolve({ project: "p", path: key, entries });
  };
  const rejectKey = (key: string, err: unknown): void => {
    take(key).reject(err);
  };
  return { calls, pending, fetcher, settle, rejectKey };
}

/** 立即回包的 fixture fetcher：tree[path] 缺失即空目录 */
function makeFixtureFetcher(tree: Record<string, FsTreeEntry[]>) {
  const calls: string[] = [];
  const fetcher: TreeFetcher = (path) => {
    const key = path ?? "";
    calls.push(key);
    return Promise.resolve({ project: "p", path: key, entries: tree[key] ?? [] });
  };
  return { calls, fetcher };
}

type Mount = {
  ctrl: () => FileTreeController;
  setProject: (p: string) => Promise<void>;
};

let container: HTMLElement;
const mounted: Array<() => Promise<void>> = [];

async function mountController(project: string, fetcher: TreeFetcher): Promise<Mount> {
  let latest: FileTreeController | null = null;
  const Harness = (props: { project: string }) => {
    latest = logic.useFileTreeController(props.project, { fetch: fetcher });
    return null;
  };
  const root = createRoot(container);
  const render = async (p: string): Promise<void> => {
    await act(async () => {
      root.render(createElement(Harness, { project: p }));
    });
  };
  await render(project);
  const unmount = async (): Promise<void> => {
    await act(async () => {
      root.unmount();
    });
  };
  mounted.push(unmount);
  return {
    ctrl: () => {
      if (latest === null) throw new Error("controller 未挂载");
      return latest;
    },
    setProject: (p) => render(p),
  };
}

let restorePush: (() => void) | null = null;

/** 换掉 ui store 的 pushGlobalError 收集调用（须在挂载前调用，hook 渲染时才取到替身） */
function spyGlobalErrors(): string[] {
  const seen: string[] = [];
  const original = useUiStore.getState().pushGlobalError;
  useUiStore.setState({
    pushGlobalError: (text: string) => {
      seen.push(text);
    },
  });
  restorePush = () => {
    useUiStore.setState({ pushGlobalError: original });
    restorePush = null;
  };
  return seen;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  restorePush?.();
  while (mounted.length > 0) {
    const unmount = mounted.pop();
    if (unmount) await unmount();
  }
  container.remove();
});

// ---------- 纯转移函数 ----------

describe("文件树纯转移函数", () => {
  test("初始态：根目录即在加载中", () => {
    const d = logic.initialFileTreeData();
    expect(d.loading.has("")).toBe(true);
    expect(d.children.size).toBe(0);
    expect(d.expanded.size).toBe(0);
  });

  test("treeExpand：无缓存置 loading；有缓存不置；重复展开幂等", () => {
    let d = logic.treeExpand(logic.initialFileTreeData(), "a");
    expect(d.expanded.has("a")).toBe(true);
    expect(d.loading.has("a")).toBe(true);
    const cached = logic.treeLoaded(logic.initialFileTreeData(), "a", []);
    d = logic.treeExpand(cached, "a");
    expect(d.expanded.has("a")).toBe(true);
    expect(d.loading.has("a")).toBe(false);
    expect(logic.treeExpand(d, "a")).toBe(d);
  });

  test("treeCollapse 收起；未展开时幂等（引用不变）", () => {
    const d = logic.treeExpand(logic.initialFileTreeData(), "a");
    const c = logic.treeCollapse(d, "a");
    expect(c.expanded.has("a")).toBe(false);
    expect(logic.treeCollapse(c, "a")).toBe(c);
  });

  test("treeLoaded 写入并清 loading；treeLoadFailed 收回展开与 loading", () => {
    let d = logic.treeExpand(logic.initialFileTreeData(), "a");
    d = logic.treeLoaded(d, "a", [file("f.txt")]);
    expect(d.loading.has("a")).toBe(false);
    expect(d.children.get("a")).toEqual([file("f.txt")]);
    let e = logic.treeExpand(logic.initialFileTreeData(), "dead");
    e = logic.treeLoadFailed(e, "dead");
    expect(e.expanded.has("dead")).toBe(false);
    expect(e.loading.has("dead")).toBe(false);
  });

  test("treeInvalidate 子树逐出：子/孙缓存与 loading 一并移除；expanded 保留", () => {
    const d: logic.FileTreeData = {
      children: new Map([
        ["", [dir("a"), dir("x")]],
        ["a", [dir("b")]],
        ["a/b", [file("c.txt")]],
        ["x", []],
      ]),
      expanded: new Set(["a", "a/b"]),
      loading: new Set(["a/b/c"]),
    };
    const out = logic.treeInvalidate(d, ["a"]);
    expect([...out.children.keys()].sort()).toEqual(["", "x"]);
    expect(out.loading.size).toBe(0);
    expect(out.expanded).toBe(d.expanded); // 引用不变：expanded 不参与逐出（IS-2）
    expect(out).not.toBe(d);
    // 原状态不被就地修改（不可变约定）
    expect(d.children.has("a")).toBe(true);
    expect(d.loading.has("a/b/c")).toBe(true);
  });

  test("treeInvalidate：无命中返回原引用；空串按规则仅移除根条目", () => {
    const d = logic.treeLoaded(logic.initialFileTreeData(), "a", []);
    expect(logic.treeInvalidate(d, ["不存在"])).toBe(d);
    const rootOnly = logic.treeInvalidate(logic.treeLoaded(d, "", [dir("x")]), [""]);
    expect(rootOnly.children.has("")).toBe(false);
    expect(rootOnly.children.has("a")).toBe(true); // 后代缓存不受牵连（键不含首斜杠）
  });

  test("parentOf 边界：空串、单段、深路径、首分隔符、尾随 /", () => {
    expect(logic.parentOf("")).toBe("");
    expect(logic.parentOf("a")).toBe("");
    expect(logic.parentOf("a/b/c")).toBe("a/b");
    expect(logic.parentOf("/x")).toBe("");
    expect(logic.parentOf("a/b/")).toBe("a/b");
  });
});

// ---------- dirsAfterOp 失效矩阵 ----------

describe("dirsAfterOp 失效矩阵", () => {
  test("create / mkdir：仅刷新父目录，无逐出", () => {
    expect(logic.dirsAfterOp({ op: "create", path: "a/b.txt" })).toEqual({ refresh: ["a"], evict: [] });
    expect(logic.dirsAfterOp({ op: "mkdir", path: "x" })).toEqual({ refresh: [""], evict: [] });
  });

  test("delete：刷新父目录 + 逐出被删路径", () => {
    expect(logic.dirsAfterOp({ op: "delete", path: "a/b" })).toEqual({ refresh: ["a"], evict: ["a/b"] });
  });

  test("move：双父目录刷新（去重）+ 逐出来源；同目录改名去重为单一刷新路径", () => {
    expect(logic.dirsAfterOp({ op: "move", from: "a/b", to: "c/d" })).toEqual({
      refresh: ["a", "c"],
      evict: ["a/b"],
    });
    expect(logic.dirsAfterOp({ op: "move", from: "a/b", to: "a/B" })).toEqual({
      refresh: ["a"],
      evict: ["a/b"],
    });
  });

  test("upload：仅刷新上传目录（unicode 路径原样保留）", () => {
    expect(logic.dirsAfterOp({ op: "upload", dir: "w/中文" })).toEqual({ refresh: ["w/中文"], evict: [] });
  });
});

// ---------- hook：注入 fetcher ----------

describe("useFileTreeController（注入 fetcher）", () => {
  test("挂载即加载根目录", async () => {
    const { calls, fetcher } = makeFixtureFetcher({ "": [dir("docs"), file("README.md")] });
    const h = await mountController("p", fetcher);
    expect(calls).toEqual([""]);
    expect(h.ctrl().data.loading.has("")).toBe(false);
    expect(h.ctrl().data.children.get("")).toEqual([dir("docs"), file("README.md")]);
  });

  test("toggleDir 懒加载：展开拉取、缓存命中不重复请求、收起再展开不拉取", async () => {
    const f = makeDeferredFetcher();
    const h = await mountController("p", f.fetcher);
    await act(async () => {
      f.settle("", [dir("docs")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("docs");
    });
    expect(f.calls).toEqual(["", "docs"]);
    expect(h.ctrl().data.expanded.has("docs")).toBe(true);
    expect(h.ctrl().data.loading.has("docs")).toBe(true);
    await act(async () => {
      f.settle("docs", [file("a.txt")]);
    });
    expect(h.ctrl().data.children.get("docs")).toEqual([file("a.txt")]);
    expect(h.ctrl().data.loading.has("docs")).toBe(false);
    await act(async () => {
      h.ctrl().toggleDir("docs"); // 收起
    });
    expect(h.ctrl().data.expanded.has("docs")).toBe(false);
    await act(async () => {
      h.ctrl().toggleDir("docs"); // 再展开：缓存命中
    });
    expect(f.calls).toEqual(["", "docs"]);
    expect(h.ctrl().data.expanded.has("docs")).toBe(true);
    expect(h.ctrl().data.loading.has("docs")).toBe(false);
    expect(h.ctrl().data.children.get("docs")).toEqual([file("a.txt")]);
  });

  test("reveal 成功：逐段展开加载、unicode 路径、设置定位与高亮", async () => {
    const { calls, fetcher } = makeFixtureFetcher({
      "": [dir("docs"), file("README.md")],
      docs: [dir("子目录")],
      "docs/子目录": [file("文件.txt")],
    });
    const h = await mountController("p", fetcher);
    let r: logic.RevealResult | undefined;
    await act(async () => {
      r = await h.ctrl().reveal("docs/子目录/文件.txt");
    });
    expect(r).toEqual({ kind: "revealed", path: "docs/子目录/文件.txt" });
    expect(calls).toEqual(["", "docs", "docs/子目录"]);
    expect(h.ctrl().data.expanded.has("docs")).toBe(true);
    expect(h.ctrl().data.expanded.has("docs/子目录")).toBe(true);
    expect(h.ctrl().data.children.get("docs/子目录")).toEqual([file("文件.txt")]);
    expect(h.ctrl().revealTarget).toBe("docs/子目录/文件.txt");
    expect(h.ctrl().highlightPath).toBe("docs/子目录/文件.txt");
  });

  test("reveal 缺失：末段与中途缺失报 not_found 于最近存在祖先，不回滚已展开祖先", async () => {
    const { fetcher } = makeFixtureFetcher({ "": [dir("docs")], docs: [file("a.txt")] });
    const h = await mountController("p", fetcher);
    let r1: logic.RevealResult | undefined;
    let r2: logic.RevealResult | undefined;
    await act(async () => {
      r1 = await h.ctrl().reveal("docs/不存在");
    });
    expect(r1).toEqual({ kind: "missing", at: "docs", reason: "not_found" });
    expect(h.ctrl().data.expanded.has("docs")).toBe(true); // 已展开祖先不回滚
    await act(async () => {
      r2 = await h.ctrl().reveal("无/更深");
    });
    expect(r2).toEqual({ kind: "missing", at: "", reason: "not_found" });
  });

  test("reveal 非目录段：file 与 symlink 中途下钻均报 not_directory", async () => {
    const { fetcher } = makeFixtureFetcher({
      "": [dir("docs"), sym("link")],
      docs: [file("a.txt")],
    });
    const h = await mountController("p", fetcher);
    let r1: logic.RevealResult | undefined;
    let r2: logic.RevealResult | undefined;
    await act(async () => {
      r1 = await h.ctrl().reveal("docs/a.txt/内层");
    });
    expect(r1).toEqual({ kind: "missing", at: "docs", reason: "not_directory" });
    await act(async () => {
      r2 = await h.ctrl().reveal("link/inner");
    });
    expect(r2).toEqual({ kind: "missing", at: "", reason: "not_directory" });
  });

  test("reveal 畸形路径：.. 报 invalid_path；空路径与 . 归一为根定位且无额外请求", async () => {
    const { calls, fetcher } = makeFixtureFetcher({ "": [dir("docs")] });
    const h = await mountController("p", fetcher);
    let r1: logic.RevealResult | undefined;
    let r2: logic.RevealResult | undefined;
    let r3: logic.RevealResult | undefined;
    await act(async () => {
      r1 = await h.ctrl().reveal("a/../b");
    });
    expect(r1).toEqual({ kind: "missing", at: "", reason: "invalid_path" });
    const before = calls.length;
    await act(async () => {
      r2 = await h.ctrl().reveal("");
    });
    await act(async () => {
      r3 = await h.ctrl().reveal("./.");
    });
    expect(r2).toEqual({ kind: "revealed", path: "" });
    expect(r3).toEqual({ kind: "revealed", path: "" });
    expect(h.ctrl().revealTarget).toBe("");
    expect(calls.length).toBe(before); // no-op：零额外请求
  });

  test("reveal 代纪元作废：后发 reveal 使在途 reveal 报 superseded，状态反映后者", async () => {
    const f = makeDeferredFetcher();
    const h = await mountController("p", f.fetcher);
    let p1: Promise<logic.RevealResult> | undefined;
    let p2: Promise<logic.RevealResult> | undefined;
    await act(async () => {
      p1 = h.ctrl().reveal("docs/x/y");
    });
    await act(async () => {
      p2 = h.ctrl().reveal("README.md");
    });
    await act(async () => {
      f.settle("", [dir("docs"), file("README.md")]); // 共享的根层在途请求落地
    });
    const [r1, r2] = await Promise.all([p1 as Promise<logic.RevealResult>, p2 as Promise<logic.RevealResult>]);
    expect(r2).toEqual({ kind: "revealed", path: "README.md" });
    expect(r1).toEqual({ kind: "superseded" });
    expect(h.ctrl().revealTarget).toBe("README.md");
    expect(h.ctrl().highlightPath).toBe("README.md");
    expect(f.calls).toEqual([""]); // 两次 reveal 共享同一根层在途请求；superseded 方不再发 docs 请求
  });

  test("gen 竞态：refresh 后旧响应迟到被静默丢弃，新响应正常提交", async () => {
    const f = makeDeferredFetcher();
    const errors = spyGlobalErrors();
    const h = await mountController("p", f.fetcher);
    await act(async () => {
      f.settle("", [dir("docs")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("docs"); // 首次加载在途（gen 0）
    });
    await act(async () => {
      h.ctrl().refreshDirs(["docs"], []); // gen 1 + 立即回源（当前展开）
    });
    expect(f.pending.map((r) => r.key)).toEqual(["docs", "docs"]);
    expect(h.ctrl().data.children.has("docs")).toBe(false); // 缓存已逐出
    expect(h.ctrl().data.expanded.has("docs")).toBe(true); // 局部刷新保留展开态（IS-2）
    expect(h.ctrl().data.loading.has("docs")).toBe(true);
    const before = h.ctrl().data;
    await act(async () => {
      f.settle("docs", [file("旧响应.txt")]); // 旧 gen 迟到落地
    });
    expect(h.ctrl().data).toBe(before); // 无任何状态变化
    expect(errors).toEqual([]);
    await act(async () => {
      f.settle("docs", [file("新响应.txt")]); // 新 gen 落地
    });
    expect(h.ctrl().data.children.get("docs")).toEqual([file("新响应.txt")]);
    expect(h.ctrl().data.loading.has("docs")).toBe(false);
    expect(errors).toEqual([]);
  });

  test("局部刷新保留展开态：展开中的目录刷新后仍在展开且子项重载（IS-2）", async () => {
    const f = makeDeferredFetcher();
    const h = await mountController("p", f.fetcher);
    await act(async () => {
      f.settle("", [dir("docs")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("docs");
    });
    await act(async () => {
      f.settle("docs", [file("a.txt")]);
    });
    await act(async () => {
      h.ctrl().refreshDirs(["docs"], []);
    });
    expect(h.ctrl().data.expanded.has("docs")).toBe(true); // 刷新不收起
    expect(h.ctrl().data.loading.has("docs")).toBe(true); // 立即回源
    await act(async () => {
      f.settle("docs", [file("b.txt"), file("c.txt")]);
    });
    expect(h.ctrl().data.children.get("docs")).toEqual([file("b.txt"), file("c.txt")]);
    expect(h.ctrl().data.expanded.has("docs")).toBe(true); // 重载完成仍在展开
    expect(h.ctrl().data.loading.has("docs")).toBe(false);
  });

  test("纯驱逐（refresh 空）：evict 子树收起与逐出、不回源、根不受牵连", async () => {
    const f = makeDeferredFetcher();
    const errors = spyGlobalErrors();
    const h = await mountController("p", f.fetcher);
    await act(async () => {
      f.settle("", [dir("docs")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("docs");
    });
    await act(async () => {
      f.settle("docs", [dir("子目录")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("docs/子目录");
    });
    await act(async () => {
      f.settle("docs/子目录", []);
    });
    const callsBefore = f.calls.length;
    await act(async () => {
      h.ctrl().refreshDirs([], ["docs"]);
    });
    expect(f.calls.length).toBe(callsBefore); // evict 集绝不回源
    expect(h.ctrl().data.children.has("docs")).toBe(false);
    expect(h.ctrl().data.children.has("docs/子目录")).toBe(false);
    expect(h.ctrl().data.expanded.has("docs")).toBe(false); // 死亡子树收起
    expect(h.ctrl().data.expanded.has("docs/子目录")).toBe(false);
    expect(h.ctrl().data.children.has("")).toBe(true); // 根缓存不受牵连
    expect(errors).toEqual([]);
  });

  test("gen 竞态：过期请求的失败响应同样静默丢弃，不推全局错误", async () => {
    const f = makeDeferredFetcher();
    const errors = spyGlobalErrors();
    const h = await mountController("p", f.fetcher);
    await act(async () => {
      f.settle("", [dir("中文目录")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("中文目录"); // gen 0 在途
    });
    await act(async () => {
      h.ctrl().refreshDirs(["中文目录"], []); // gen 1 回源
    });
    await act(async () => {
      f.rejectKey("中文目录", new Error("boom")); // 先落地的 gen 0 失败（已过期）
    });
    expect(errors).toEqual([]); // 过期失败静默丢弃
    expect(h.ctrl().data.children.has("中文目录")).toBe(false);
    await act(async () => {
      f.settle("中文目录", [file("ok.txt")]); // gen 1 正常提交
    });
    expect(h.ctrl().data.children.get("中文目录")).toEqual([file("ok.txt")]);
    expect(errors).toEqual([]);
  });

  test("refreshDirs：未加载目录不请求；已加载（含已收起）目录回源替换缓存", async () => {
    const f = makeDeferredFetcher();
    const h = await mountController("p", f.fetcher);
    await act(async () => {
      f.settle("", [dir("docs")]);
    });
    const callsBefore = f.calls.length;
    await act(async () => {
      h.ctrl().refreshDirs(["ghost"], []); // 从未加载：不请求、不留 loading
    });
    expect(f.calls.length).toBe(callsBefore);
    expect(h.ctrl().data.children.has("ghost")).toBe(false);
    expect(h.ctrl().data.loading.has("ghost")).toBe(false);
    // 加载 docs 后收起（缓存保留），刷新仍应回源（loadedEver 命中）
    await act(async () => {
      h.ctrl().toggleDir("docs");
    });
    await act(async () => {
      f.settle("docs", [file("a.txt")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("docs"); // 收起
    });
    await act(async () => {
      h.ctrl().refreshDirs(["docs"], []);
    });
    expect(f.calls[f.calls.length - 1]).toBe("docs");
    await act(async () => {
      f.settle("docs", [file("b.txt")]);
    });
    expect(h.ctrl().data.children.get("docs")).toEqual([file("b.txt")]);
  });

  test("expanded 目录删除（evict 集）：不回源、无全局错误、子树整体逐出", async () => {
    const f = makeDeferredFetcher();
    const errors = spyGlobalErrors();
    const h = await mountController("p", f.fetcher);
    await act(async () => {
      f.settle("", [dir("docs")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("docs");
    });
    await act(async () => {
      f.settle("docs", [dir("子目录")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("docs/子目录");
    });
    await act(async () => {
      f.settle("docs/子目录", [file("文件.txt")]);
    });
    const callsBefore = f.calls.length;
    await act(async () => {
      h.ctrl().refreshDirs([""], ["docs"]); // 删除 docs：根刷新，docs 子树逐出
    });
    // 只有根回源；evict 集及其子树绝不回源
    expect(f.calls.slice(callsBefore)).toEqual([""]);
    expect(h.ctrl().data.children.has("docs")).toBe(false);
    expect(h.ctrl().data.children.has("docs/子目录")).toBe(false);
    expect(h.ctrl().data.expanded.has("docs")).toBe(false);
    expect(h.ctrl().data.expanded.has("docs/子目录")).toBe(false);
    expect(h.ctrl().data.loading.has("docs")).toBe(false);
    expect(errors).toEqual([]); // 不产生假 404 toast
    await act(async () => {
      f.settle("", [file("README.md")]);
    });
    expect(h.ctrl().data.children.get("")).toEqual([file("README.md")]);
    expect(h.ctrl().data.children.has("docs/子目录")).toBe(false);
  });

  test("refreshAll：回源 loadedEver ∪ 根，未加载目录不请求", async () => {
    const f = makeDeferredFetcher();
    const h = await mountController("p", f.fetcher);
    await act(async () => {
      f.settle("", [dir("docs"), dir("中文目录")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("docs");
    });
    await act(async () => {
      f.settle("docs", [file("a.txt")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("中文目录");
    });
    await act(async () => {
      f.settle("中文目录", []);
    });
    const callsBefore = f.calls.length;
    await act(async () => {
      h.ctrl().refreshAll();
    });
    expect(f.calls.slice(callsBefore).sort()).toEqual(["", "docs", "中文目录"]);
    await act(async () => {
      f.settle("", [dir("docs"), dir("中文目录")]);
      f.settle("docs", [file("a2.txt")]);
      f.settle("中文目录", []);
    });
    expect(h.ctrl().data.children.get("docs")).toEqual([file("a2.txt")]);
    expect(h.ctrl().data.children.has("")).toBe(true);
  });

  test("项目切换：整树重置回根 loading、清定位与高亮、跨项目迟到响应被拦截", async () => {
    const f = makeDeferredFetcher();
    const errors = spyGlobalErrors();
    const h = await mountController("p1", f.fetcher);
    await act(async () => {
      f.settle("", [dir("docs")]);
    });
    await act(async () => {
      h.ctrl().toggleDir("docs"); // p1 的 docs 请求在途
    });
    await h.setProject("p2");
    expect(h.ctrl().data.children.size).toBe(0);
    expect(h.ctrl().data.loading.has("")).toBe(true);
    expect(h.ctrl().data.expanded.size).toBe(0);
    expect(h.ctrl().revealTarget).toBeNull();
    expect(h.ctrl().highlightPath).toBeNull();
    expect(f.calls).toEqual(["", "docs", ""]); // p2 根请求已发出
    await act(async () => {
      f.settle("docs", [file("旧项目文件.txt")]); // p1 的 docs 响应迟到
    });
    expect(h.ctrl().data.children.has("docs")).toBe(false);
    expect(errors).toEqual([]);
    await act(async () => {
      f.settle("", [dir("src")]); // p2 根落地
    });
    expect(h.ctrl().data.children.get("")).toEqual([dir("src")]);
    expect(h.ctrl().data.loading.has("")).toBe(false);
  });

  test("项目切换作废在途 reveal：报 project_changed", async () => {
    const f = makeDeferredFetcher();
    const h = await mountController("p1", f.fetcher);
    await act(async () => {
      f.settle("", [dir("docs")]);
    });
    let rp: Promise<logic.RevealResult> | undefined;
    await act(async () => {
      rp = h.ctrl().reveal("docs/a.txt"); // docs 请求在途
    });
    await h.setProject("p2");
    await act(async () => {
      f.settle("docs", [file("a.txt")]); // 旧项目响应迟到（在途请求已过期）
    });
    const r = await (rp as Promise<logic.RevealResult>);
    expect(r).toEqual({ kind: "missing", at: "docs", reason: "project_changed" }); // at = 已确认存在的祖先
  });

  test("reveal 成功后高亮 HIGHLIGHT_CLEAR_MS 自动清除", async () => {
    vi.useFakeTimers();
    try {
      const { fetcher } = makeFixtureFetcher({ "": [file("a.txt")] });
      const h = await mountController("p", fetcher);
      await act(async () => {
        await h.ctrl().reveal("a.txt");
      });
      expect(h.ctrl().highlightPath).toBe("a.txt");
      await act(async () => {
        vi.advanceTimersByTime(logic.HIGHLIGHT_CLEAR_MS);
      });
      expect(h.ctrl().highlightPath).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // F3b ADV-1 回归：定位状态与项目绑定，项目偏离挂载值后写入方须携新项目落章，
  // 否则读侧派生归零永不恢复（旧实现切项目后 reveal 永久失效，切回挂载项目才恢复）
  test("F3b ADV-1：项目切换后新项目 reveal 定位与高亮永久生效，旧定位不残留", async () => {
    const { fetcher } = makeFixtureFetcher({
      "": [dir("web")],
      web: [dir("tests"), file("app.ts")],
      "web/tests": [file("a.test.ts")],
    });
    const h = await mountController("/proj-a", fetcher);
    await act(async () => {
      await h.ctrl().reveal("web/app.ts");
    });
    expect(h.ctrl().revealTarget).toBe("web/app.ts");
    expect(h.ctrl().highlightPath).toBe("web/app.ts");

    // 切到 B：旧项目定位/高亮立即清空（无残留）
    await h.setProject("/proj-b");
    expect(h.ctrl().revealTarget).toBeNull();
    expect(h.ctrl().highlightPath).toBeNull();

    // B 项目的 reveal 永久生效（旧实现此处 revealTarget/highlightPath 恒 null）
    await act(async () => {
      await h.ctrl().reveal("web/tests/a.test.ts");
    });
    expect(h.ctrl().revealTarget).toBe("web/tests/a.test.ts");
    expect(h.ctrl().highlightPath).toBe("web/tests/a.test.ts");
    await act(async () => {
      await h.ctrl().reveal("web/app.ts");
    });
    expect(h.ctrl().revealTarget).toBe("web/app.ts");
    expect(h.ctrl().highlightPath).toBe("web/app.ts");
  });

  test("F3b ADV-1：挂载时项目未知，项目就位后 reveal 生效", async () => {
    const { fetcher } = makeFixtureFetcher({
      "": [dir("web")],
      web: [file("app.ts")],
    });
    const h = await mountController("", fetcher);
    await h.setProject("/proj-b");
    await act(async () => {
      await h.ctrl().reveal("web/app.ts");
    });
    expect(h.ctrl().revealTarget).toBe("web/app.ts");
    expect(h.ctrl().highlightPath).toBe("web/app.ts");
  });

  test("F3b ADV-1：切走再切回，旧定位不复活", async () => {
    const { fetcher } = makeFixtureFetcher({
      "": [dir("web")],
      web: [file("app.ts")],
    });
    const h = await mountController("/proj-a", fetcher);
    await act(async () => {
      await h.ctrl().reveal("web/app.ts");
    });
    expect(h.ctrl().revealTarget).toBe("web/app.ts");
    await h.setProject("/proj-b");
    await h.setProject("/proj-a");
    // 旧定位不复活：项目切换即作废，不随切回恢复（旧实现会复活陈旧定位）
    expect(h.ctrl().revealTarget).toBeNull();
    expect(h.ctrl().highlightPath).toBeNull();
    // 切回后的新 reveal 正常生效
    await act(async () => {
      await h.ctrl().reveal("web/app.ts");
    });
    expect(h.ctrl().revealTarget).toBe("web/app.ts");
    expect(h.ctrl().highlightPath).toBe("web/app.ts");
  });
});
