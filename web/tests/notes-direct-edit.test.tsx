// @ts-nocheck
// r11 笔记直接编辑定向测试：笔记 tab 点内容行就地展开编辑器并保存（PUT，库层既有
// 方法为 PUT 而非 PATCH），总览面板笔记条目就地编辑保存，输入法组合中收起不丢字。
// 惯例同 notes-inline.test.tsx：@happy-dom 全局注册 + createRoot/act 真实点击，
// fetch 走本文件内可编程路由 mock。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const { NotesView } = await import("@/components/notes/notes-view");
const { OverviewPanel } = await import("@/components/layout/overview-panel");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;
const PROJECT = "/tmp/notes-direct-edit-proj";

interface RouteHit {
  method: string;
  url: string;
  body: unknown;
}

let hits: RouteHit[] = [];
/** 路由表：url 前缀匹配（首个命中），handler 返回 Response 或 [status, payload] */
let routes: Array<{ method: string; prefix: string; reply: (hit: RouteHit) => Response | [number, unknown] }>;

function respond(reply: Response | [number, unknown]): Response {
  if (reply instanceof Response) return reply;
  return new Response(JSON.stringify(reply[1]), {
    status: reply[0],
    headers: { "content-type": "application/json" },
  });
}

function installRoutes(table: typeof routes): void {
  routes = table;
}

beforeEach(() => {
  hits = [];
  routes = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const hit: RouteHit = { method, url, body };
    hits.push(hit);
    for (const route of routes) {
      if (route.method === method && url.startsWith(route.prefix)) {
        return respond(route.reply(hit));
      }
    }
    return new Response(JSON.stringify({ error: { code: "unmocked", message: url } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  useUiStore.setState({ currentProject: PROJECT });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function listItem(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "n1",
    title: "已有笔记",
    preview: "首行摘要",
    tags: [],
    updatedAt: "2026-10-29T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function noteDetail(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "n1",
    project: PROJECT,
    title: "已有笔记",
    content: "第一行\n第二行",
    tags: [],
    deletedAt: null,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    ...overrides,
  };
}

async function renderView(el: (props: { dirtyRef: { current: boolean } }) => unknown, dirtyRef: { current: boolean } = { current: false }): Promise<{
  host: HTMLElement;
  root: ReturnType<typeof createRoot>;
}> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(el as never, { dirtyRef }));
  });
  return { host, root };
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!pred()) throw new Error(`timeout: ${what}`);
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function q(host: HTMLElement, sel: string): Element {
  const el = host.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("r11 笔记直接编辑", () => {
  test("tab：点笔记内容行就地入编辑态，改正文收起 → PUT 保存 → 列表刷新", async () => {
    let putBody: unknown = null;
    let listFetches = 0;
    installRoutes([
      {
        method: "GET",
        prefix: `/api/notes?project=${encodeURIComponent(PROJECT)}`,
        reply: () => {
          listFetches += 1;
          return [200, { notes: [listItem()] }];
        },
      },
      {
        method: "GET",
        prefix: "/api/notes/n1",
        reply: () => [200, { note: noteDetail() }],
      },
      {
        method: "PUT",
        prefix: "/api/notes/n1",
        reply: (hit) => {
          putBody = hit.body;
          return [200, { note: noteDetail({ content: "直接编辑的新正文" }) }];
        },
      },
    ]);
    const { host, root } = await renderView((p) => NotesView(p));
    await waitFor(() => host.querySelectorAll("[data-testid=note-item]").length === 1, "list ready");

    // 点内容行（非表单按钮）即入编辑态：列表行被编辑器原位替换，无整页/整卡切换
    await act(async () => {
      click(q(host, "[data-testid=note-item]"));
    });
    await waitFor(() => host.querySelector("[data-testid=note-inline-editor]") !== null, "editor expanded");
    await waitFor(() => (q(host, "[data-testid=note-content-input]") as HTMLTextAreaElement).value === "第一行\n第二行", "detail loaded");
    expect(host.querySelector("[data-testid=note-item]")).toBeNull();

    const ta = q(host, "[data-testid=note-content-input]") as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(ta, "直接编辑的新正文");
    });
    await act(async () => {
      click(q(host, "[data-testid=note-collapse-btn]"));
    });
    await waitFor(() => putBody !== null, "PUT sent");
    expect((putBody as { content: string }).content).toBe("直接编辑的新正文");
    await waitFor(() => host.querySelector("[data-testid=note-inline-editor]") === null, "collapsed");
    await waitFor(() => listFetches === 2, "list refetched");
    await act(async () => {
      root.unmount();
    });
  });

  test("总览：点笔记条目就地入编辑态并保存 PUT，收起后列表重取", async () => {
    let putBody: unknown = null;
    let listFetches = 0;
    installRoutes([
      {
        method: "GET",
        prefix: `/api/notes?project=${encodeURIComponent(PROJECT)}`,
        reply: () => {
          listFetches += 1;
          return [200, { notes: [listItem()] }];
        },
      },
      {
        method: "GET",
        prefix: "/api/notes/n1",
        reply: () => [200, { note: noteDetail() }],
      },
      {
        method: "PUT",
        prefix: "/api/notes/n1",
        reply: (hit) => {
          putBody = hit.body;
          return [200, { note: noteDetail({ content: "总览里改的正文" }) }];
        },
      },
    ]);
    const { host, root } = await renderView((p) => OverviewPanel({ ...p, sessionId: null }) as never);
    await waitFor(() => host.querySelectorAll("[data-testid=overview-note-item]").length === 1, "overview notes ready");

    await act(async () => {
      click(q(host, "[data-testid=overview-note-item]"));
    });
    await waitFor(() => host.querySelector("[data-testid=note-inline-editor]") !== null, "inline editor expanded");
    await waitFor(() => (q(host, "[data-testid=note-content-input]") as HTMLTextAreaElement).value === "第一行\n第二行", "detail loaded");

    const ta = q(host, "[data-testid=note-content-input]") as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(ta, "总览里改的正文");
    });
    await act(async () => {
      click(q(host, "[data-testid=note-collapse-btn]"));
    });
    await waitFor(() => putBody !== null, "PUT sent");
    expect((putBody as { content: string }).content).toBe("总览里改的正文");
    await waitFor(() => host.querySelector("[data-testid=note-inline-editor]") === null, "collapsed");
    await waitFor(() => listFetches === 2, "list refetched");
    await waitFor(() => host.querySelector("[data-testid=overview-note-item]") !== null, "item row back");
    await act(async () => {
      root.unmount();
    });
  });

  test("tab：输入法组合中收起不丢字——挂起保存，compositionend 后完整上屏再 PUT", async () => {
    let putBody: unknown = null;
    let putCalls = 0;
    installRoutes([
      {
        method: "GET",
        prefix: `/api/notes?project=${encodeURIComponent(PROJECT)}`,
        reply: () => [200, { notes: [listItem()] }],
      },
      {
        method: "GET",
        prefix: "/api/notes/n1",
        reply: () => [200, { note: noteDetail() }],
      },
      {
        method: "PUT",
        prefix: "/api/notes/n1",
        reply: (hit) => {
          putCalls += 1;
          putBody = hit.body;
          return [200, { note: noteDetail({ content: "和大家好" }) }];
        },
      },
    ]);
    const { host, root } = await renderView((p) => NotesView(p));
    await waitFor(() => host.querySelectorAll("[data-testid=note-item]").length === 1, "list ready");
    await act(async () => {
      click(q(host, "[data-testid=note-item]"));
    });
    await waitFor(() => host.querySelector("[data-testid=note-content-input]") !== null, "editor ready");
    const ta = q(host, "[data-testid=note-content-input]") as HTMLTextAreaElement;
    // 已上屏「和」后进入组合（拼音未上屏）
    await act(async () => {
      setNativeValue(ta, "和");
      ta.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    });
    // 组合未结束即收起：不保存、编辑器仍在（挂起）
    await act(async () => {
      click(q(host, "[data-testid=note-collapse-btn]"));
    });
    expect(putCalls).toBe(0);
    expect(host.querySelector("[data-testid=note-inline-editor]")).not.toBeNull();
    // 组合落定：末次 input 完整上屏 + compositionend → 延后一步后保存完整文本
    await act(async () => {
      setNativeValue(ta, "和大家好");
      ta.dispatchEvent(new Event("compositionend", { bubbles: true }));
      await flushMicrotasks();
    });
    await waitFor(() => putCalls === 1, "PUT after compositionend");
    expect((putBody as { content: string }).content).toBe("和大家好");
    await act(async () => {
      root.unmount();
    });
  });
});
