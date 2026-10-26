// 常用语管理整替冲突防护（r9 F1-B1，BLOCKER-1 修复后口径）组件级测试：挂真实
// SnippetManage（happy-dom + react-dom/client；radix Dialog 原语 mock 透传、api 走
// mock fetch，同 tag-manage-conflict 风格）。锁基线为按组独立 revision（global 组用
// globalRevision、project 组用 projectRevision，读写面同口径）。场景：
// 1) 正常路径（project:null 与 非空）：提交前重拉，PUT 携对应组 revision，成功后输入清空
// 2) 基线已被对端改写：重拉发现基线不一致 → 不发出 PUT、本地同步服务端最新、行内冲突提示
// 3) PUT 409 snippet_conflict：行内错误提示、本地同步最新、不自动重试；手动重试携
//    新组 revision 成功（BLOCKER-1 死锁回归：活跃项目下重试不再恒 409）
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SnippetEntry } from "@/lib/api";

// bun/单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// radix Dialog 原语透传化：DialogTitle 为普通容器（SnippetManage/SnippetImport 仅用标题）
vi.mock("@/components/ui/dialog", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    Dialog: Passthrough,
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
const { SnippetManage } = await import("@/components/composer/snippet-manage");

const ORIGINAL_FETCH = globalThis.fetch;

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function errJson(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const entry = (content: string, sort = 0): SnippetEntry => ({ content, sort });

interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

/** GET 快照：按组独立 revision（r9 BLOCKER-1 修复后服务端契约，两源聚合 revision 保留但不作锁基线） */
interface GetSnapshot {
  global: SnippetEntry[];
  project?: SnippetEntry[];
  globalRevision: string;
  projectRevision: string;
}

/** fetch 桩：记录全部调用；GET /api/snippets 逐次返回 queue 中的快照，PUT 状态码按序列配置 */
function installFetch(opts: {
  gets: GetSnapshot[];
  /** 每次 PUT 的状态码序列（缺省全 200；超出长度复用尾值） */
  putStatuses?: number[];
  putResult?: SnippetEntry[];
}) {
  const calls: FetchCall[] = [];
  let putCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/api/snippets")) {
      const idx = calls.filter((c) => c.method === "GET").length - 1;
      const snapshot = opts.gets[Math.min(idx, opts.gets.length - 1)];
      return okJson({
        global: snapshot.global,
        project: snapshot.project ?? [],
        revision: "aggregate-not-lock-basis",
        globalRevision: snapshot.globalRevision,
        projectRevision: snapshot.projectRevision,
      });
    }
    if (method === "PUT" && path === "/api/snippets") {
      const status = opts.putStatuses ? opts.putStatuses[Math.min(putCount, opts.putStatuses.length - 1)] : 200;
      putCount += 1;
      if (status !== 200) return errJson(status, "snippet_conflict", "常用语已被其他端修改，请刷新后重试");
      return okJson({ snippets: opts.putResult ?? [] });
    }
    return okJson({});
  }) as typeof fetch;
  return calls;
}

/** React 受控 textarea 赋值：原生 setter + input 事件 */
function typeTextarea(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mountManage(project: string | null = null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SnippetManage, { project, onBack: () => {} }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

const typeAndAdd = async (container: ParentNode, value: string, scope: "global" | "project" = "global") => {
  const input = container.querySelector<HTMLTextAreaElement>(`textarea[data-testid="snippet-new-input-${scope}"]`);
  expect(input).toBeDefined();
  await act(async () => {
    typeTextarea(input!, value);
    await Promise.resolve();
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`button[data-testid="snippet-add-${scope}"]`)?.click();
    await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("SnippetManage 整替冲突防护（r9 F1-B1）", () => {
  test("正常路径：提交前重拉，PUT 携 baseRevision，成功后输入清空", async () => {
    const calls = installFetch({
      gets: [{ global: [entry("a")], globalRevision: "grev1", projectRevision: "prev0" }],
      putResult: [entry("a"), entry("b", 1)],
    });
    const { container, unmount } = await mountManage();

    await typeAndAdd(container, "b");

    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/snippets");
    expect(put).toBeDefined();
    const body = put!.body as { scope: string; snippets: SnippetEntry[]; baseRevision?: string };
    expect(body.scope).toBe("global");
    // 携重拉所得 global 组独立 revision 提交（读写面同口径）
    expect(body.baseRevision).toBe("grev1");
    // 载荷 = 提交前重拉的最新列表 + 本次新增（sort 重编）
    expect(body.snippets).toEqual([
      { content: "a", sort: 0 },
      { content: "b", sort: 1 },
    ]);
    // 成功后新增输入清空
    const input = container.querySelector<HTMLTextAreaElement>('textarea[data-testid="snippet-new-input-global"]');
    expect(input!.value).toBe("");
    await unmount();
  });

  test("基线已被对端改写：不发出 PUT，本地同步服务端最新，行内冲突提示", async () => {
    // 首次 GET（装载）返回 [a]；提交时重拉返回 [a, peer]（对端已新增）→ 基线不一致
    const calls = installFetch({
      gets: [
        { global: [entry("a")], globalRevision: "grev1", projectRevision: "prev0" },
        { global: [entry("a"), entry("peer", 1)], globalRevision: "grev2", projectRevision: "prev0" },
      ],
    });
    const { container, unmount } = await mountManage();

    await typeAndAdd(container, "b");

    // 绝不把基于旧副本的载荷发出去
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    // 行内冲突提示（zh 词典 errors.snippetConflict）
    const error = container.querySelector<HTMLParagraphElement>('[data-testid="snippet-manage-error"]');
    expect(error?.textContent).toContain("已被其他端修改");
    // 本地副本同步为服务端最新（列表出现对端新增条目）
    expect(container.textContent).toContain("peer");
    await unmount();
  });

  test("PUT 409 snippet_conflict：行内错误提示，本地副本同步最新，不自动重试", async () => {
    // 重拉序列：装载 [a]；提交时重拉仍 [a]（PUT 得以发出）；409 后重拉返回对端最新 [a, peer]
    const calls = installFetch({
      gets: [
        { global: [entry("a")], globalRevision: "grev1", projectRevision: "prev0" },
        { global: [entry("a")], globalRevision: "grev1", projectRevision: "prev0" },
        { global: [entry("a"), entry("peer", 1)], globalRevision: "grev2", projectRevision: "prev0" },
      ],
      putStatuses: [409],
    });
    const { container, unmount } = await mountManage();

    await typeAndAdd(container, "b");

    // 一打 409 后不自动重试（重试即覆盖对端）
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    // 行内错误提示（apiErrorMessage 映射 snippet_conflict → zh 词典文案）
    const error = container.querySelector<HTMLParagraphElement>('[data-testid="snippet-manage-error"]');
    expect(error?.textContent).toContain("已被其他端修改");
    expect(error?.textContent).toContain("请刷新后重试");
    // 本地副本同步为服务端最新（409 后的重拉结果），不回写本端旧编辑
    expect(container.textContent).toContain("peer");
    await unmount();
  });

  test("project 非空：global 组保存携 globalRevision 成功（BLOCKER-1 死锁回归）", async () => {
    // round-1 漏网场景：活跃项目且 project 有条目时，GET 带 ?project；global 组基线
    // 必须取 global 组独立 revision（旧实现误用两源聚合 → 恒 409）
    const calls = installFetch({
      gets: [
        {
          global: [entry("a")],
          project: [entry("p1")],
          globalRevision: "grev1",
          projectRevision: "prev1",
        },
      ],
      putResult: [entry("a"), entry("b", 1)],
    });
    const { container, unmount } = await mountManage("/w/demo");

    // 装载即带 ?project 拉取（前端主导路径）
    expect(calls[0].path).toBe(`/api/snippets?project=${encodeURIComponent("/w/demo")}`);

    await typeAndAdd(container, "b");

    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/snippets");
    expect(put).toBeDefined();
    const body = put!.body as { scope: string; project?: string; baseRevision?: string; snippets: SnippetEntry[] };
    expect(body.scope).toBe("global");
    // global 组整替不带 project 字段；基线为 global 组独立 revision（非两源聚合）
    expect("project" in body).toBe(false);
    expect(body.baseRevision).toBe("grev1");
    expect(body.snippets).toEqual([
      { content: "a", sort: 0 },
      { content: "b", sort: 1 },
    ]);
    await unmount();
  });

  test("project 非空 409：同步最新后手动重试携新 globalRevision 成功（死锁回归）", async () => {
    // 两客户端串行改 global：本端携 grev1 提交 → 409（对端已写）；409 后重拉同步到
    // [a, peer]（grev2）；用户手动重做提交 → 携 grev2 成功，不再死锁
    const calls = installFetch({
      gets: [
        { global: [entry("a")], project: [entry("p1")], globalRevision: "grev1", projectRevision: "prev1" },
        { global: [entry("a")], project: [entry("p1")], globalRevision: "grev1", projectRevision: "prev1" },
        {
          global: [entry("a"), entry("peer", 1)],
          project: [entry("p1")],
          globalRevision: "grev2",
          projectRevision: "prev1",
        },
        {
          global: [entry("a"), entry("peer", 1)],
          project: [entry("p1")],
          globalRevision: "grev2",
          projectRevision: "prev1",
        },
      ],
      putStatuses: [409, 200],
      putResult: [entry("a"), entry("peer", 1), entry("b", 2)],
    });
    const { container, unmount } = await mountManage("/w/demo");

    await typeAndAdd(container, "b");

    // 第一打携旧基线 grev1 → 409；不自动重试（此时恰一打）
    const firstPuts = calls.filter((c) => c.method === "PUT");
    expect(firstPuts).toHaveLength(1);
    expect((firstPuts[0].body as { baseRevision?: string }).baseRevision).toBe("grev1");
    expect(container.textContent).toContain("peer");

    // 手动重试（用户重做输入再提交）：携同步后的新 globalRevision grev2，成功
    await typeAndAdd(container, "b");
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    const retryBody = puts[1].body as { scope: string; baseRevision?: string; snippets: SnippetEntry[] };
    expect(retryBody.baseRevision).toBe("grev2");
    // 载荷基于同步后的最新列表（对端条目保留，不静默覆盖）
    expect(retryBody.snippets).toEqual([
      { content: "a", sort: 0 },
      { content: "peer", sort: 1 },
      { content: "b", sort: 2 },
    ]);
    // 成功后错误提示与新增输入复位
    expect(container.querySelector('[data-testid="snippet-manage-error"]')).toBeNull();
    const input = container.querySelector<HTMLTextAreaElement>('textarea[data-testid="snippet-new-input-global"]');
    expect(input!.value).toBe("");
    await unmount();
  });

  test("project 非空：project 组保存携 projectRevision 与 project 字段", async () => {
    const calls = installFetch({
      gets: [
        {
          global: [entry("a")],
          project: [entry("p1")],
          globalRevision: "grev1",
          projectRevision: "prev1",
        },
      ],
      putResult: [entry("p1"), entry("p2", 1)],
    });
    const { container, unmount } = await mountManage("/w/demo");

    await typeAndAdd(container, "p2", "project");

    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/snippets");
    expect(put).toBeDefined();
    const body = put!.body as { scope: string; project?: string; baseRevision?: string; snippets: SnippetEntry[] };
    expect(body.scope).toBe("project");
    expect(body.project).toBe("/w/demo");
    // project 组基线 = project 组独立 revision（global 组变更不影响本组锁基线）
    expect(body.baseRevision).toBe("prev1");
    expect(body.snippets).toEqual([
      { content: "p1", sort: 0 },
      { content: "p2", sort: 1 },
    ]);
    await unmount();
  });
});
