// 常用语管理整替冲突防护（r9 F1-B1）组件级测试：挂真实 SnippetManage
//（happy-dom + react-dom/client；radix Dialog 原语 mock 透传、api 走 mock fetch，
// 同 tag-manage-conflict 风格）。场景：
// 1) 正常路径：提交前重拉，PUT 携 baseRevision，成功后新增输入清空
// 2) 基线已被对端改写：重拉发现基线不一致 → 不发出 PUT、本地同步服务端最新、行内冲突提示
// 3) PUT 409 snippet_conflict：行内错误提示（apiErrorMessage 映射）、本地副本同步
//    服务端最新、不回写旧值、不自动重试
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

/** fetch 桩：记录全部调用；GET /api/snippets 逐次返回 queue 中的快照，PUT 可配 409 */
function installFetch(opts: {
  gets: { global: SnippetEntry[]; revision: string }[];
  putStatus?: number;
  putResult?: SnippetEntry[];
}) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/snippets") {
      const snapshot = opts.gets[Math.min(calls.filter((c) => c.method === "GET").length - 1, opts.gets.length - 1)];
      return okJson({ global: snapshot.global, project: [], revision: snapshot.revision });
    }
    if (method === "PUT" && path === "/api/snippets") {
      if (opts.putStatus === 409) return errJson(409, "snippet_conflict", "常用语已被其他端修改，请刷新后重试");
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

async function mountManage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SnippetManage, { project: null, onBack: () => {} }));
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

const typeAndAdd = async (container: ParentNode, value: string) => {
  const input = container.querySelector<HTMLTextAreaElement>('textarea[data-testid="snippet-new-input-global"]');
  expect(input).toBeDefined();
  await act(async () => {
    typeTextarea(input!, value);
    await Promise.resolve();
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[data-testid="snippet-add-global"]')?.click();
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
      gets: [{ global: [entry("a")], revision: "rev1" }],
      putResult: [entry("a"), entry("b", 1)],
    });
    const { container, unmount } = await mountManage();

    await typeAndAdd(container, "b");

    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/snippets");
    expect(put).toBeDefined();
    const body = put!.body as { scope: string; snippets: SnippetEntry[]; baseRevision?: string };
    expect(body.scope).toBe("global");
    // 携重拉所得 revision 提交
    expect(body.baseRevision).toBe("rev1");
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
        { global: [entry("a")], revision: "rev1" },
        { global: [entry("a"), entry("peer", 1)], revision: "rev2" },
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
        { global: [entry("a")], revision: "rev1" },
        { global: [entry("a")], revision: "rev1" },
        { global: [entry("a"), entry("peer", 1)], revision: "rev2" },
      ],
      putStatus: 409,
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
});
