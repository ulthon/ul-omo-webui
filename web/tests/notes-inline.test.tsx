// @ts-nocheck
// r11 todo7 笔记行内管理编辑组件测试（从零补齐）：列表行就地展开、收起自动保存
// （存量 PUT/新建 POST）、空新建收起零请求无痕取消、列表行标题兜底、换行原样、
// dirty 契约（dirtyRef 上报 + beforeunload 拦截）。
// 惯例同 question-card/file-editor 测试：@happy-dom 全局注册 + createRoot/act 真实点击，
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
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;
const PROJECT = "/tmp/notes-inline-proj";

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
    preview: "",
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

async function renderView(dirtyRef: { current: boolean } = { current: false }): Promise<{
  host: HTMLElement;
  root: ReturnType<typeof createRoot>;
}> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(NotesView, { dirtyRef }));
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

describe("r11 todo7 笔记行内编辑", () => {
  test("展开：点行就地展开行内编辑器并载入详情（GET），无详情页两级导航", async () => {
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
    ]);
    const { host, root } = await renderView();
    await waitFor(() => host.querySelectorAll("[data-testid=note-item]").length === 1, "list ready");

    await act(async () => {
      click(q(host, "[data-testid=note-item]"));
    });
    await waitFor(() => host.querySelector("[data-testid=note-inline-editor]") !== null, "editor expanded");
    await waitFor(() => (q(host, "[data-testid=note-title-input]") as HTMLInputElement).value === "已有笔记", "detail loaded");
    expect((q(host, "[data-testid=note-content-input]") as HTMLTextAreaElement).value).toBe("第一行\n第二行");
    // 列表行被编辑器原位替换：同一时刻不存在列表行 + 编辑器并存（存量行）
    expect(host.querySelector("[data-testid=note-item]")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  test("自动保存：改正文后收起 → PUT 载荷原样（含换行）→ 列表刷新收起", async () => {
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
          return [200, { note: noteDetail({ content: "改后第一行\n\n改后第三行" }) }];
        },
      },
    ]);
    const { host, root } = await renderView();
    await waitFor(() => host.querySelectorAll("[data-testid=note-item]").length === 1, "list ready");
    await act(async () => {
      click(q(host, "[data-testid=note-item]"));
    });
    await waitFor(() => host.querySelector("[data-testid=note-content-input]") !== null, "editor ready");

    const ta = q(host, "[data-testid=note-content-input]") as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(ta, "改后第一行\n\n改后第三行");
    });
    await act(async () => {
      click(q(host, "[data-testid=note-collapse-btn]"));
    });
    await waitFor(() => putBody !== null, "PUT sent");
    expect((putBody as { content: string }).content).toBe("改后第一行\n\n改后第三行");
    // 保存后收起：编辑器消失，列表重取
    await waitFor(() => host.querySelector("[data-testid=note-inline-editor]") === null, "collapsed");
    await waitFor(() => listFetches === 2, "list refetched");
    await act(async () => {
      root.unmount();
    });
  });

  test("空新建取消：新建空行收起时标题正文全空 → 零请求无痕取消", async () => {
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
    ]);
    const { host, root } = await renderView();
    await waitFor(() => listFetches === 1, "list ready");
    await act(async () => {
      click(q(host, "[data-testid=note-new-btn]"));
    });
    await waitFor(() => host.querySelector("[data-testid=note-inline-editor]") !== null, "draft row shown");
    expect((q(host, "[data-testid=note-inline-editor]") as HTMLElement).getAttribute("data-note-id")).toBe("draft");

    await act(async () => {
      click(q(host, "[data-testid=note-collapse-btn]"));
    });
    await waitFor(() => host.querySelector("[data-testid=note-inline-editor]") === null, "draft removed");
    // 零请求：除初始列表外无任何 POST
    expect(hits.filter((h) => h.method === "POST")).toHaveLength(0);
    expect(listFetches).toBe(1);
    await act(async () => {
      root.unmount();
    });
  });

  test("新建保存：有内容的新建行收起 → POST 创建 → 列表刷新", async () => {
    let postBody: unknown = null;
    let listFetches = 0;
    installRoutes([
      {
        method: "GET",
        prefix: `/api/notes?project=${encodeURIComponent(PROJECT)}`,
        reply: () => {
          listFetches += 1;
          return [200, { notes: [] }];
        },
      },
      {
        method: "POST",
        prefix: "/api/notes",
        reply: (hit) => {
          postBody = hit.body;
          return [201, { note: noteDetail({ id: "created-1", title: "新建标题", content: "正文" }) }];
        },
      },
    ]);
    const { host, root } = await renderView();
    await waitFor(() => listFetches === 1, "list ready");
    await act(async () => {
      click(q(host, "[data-testid=note-new-btn]"));
    });
    await waitFor(() => host.querySelector("[data-testid=note-title-input]") !== null, "draft ready");
    const input = q(host, "[data-testid=note-title-input]") as HTMLInputElement;
    await act(async () => {
      setNativeValue(input, "新建标题");
    });
    await act(async () => {
      click(q(host, "[data-testid=note-collapse-btn]"));
    });
    await waitFor(() => postBody !== null, "POST sent");
    expect(postBody).toMatchObject({ project: PROJECT, title: "新建标题" });
    await waitFor(() => host.querySelector("[data-testid=note-inline-editor]") === null, "collapsed");
    expect(listFetches).toBe(2);
    await act(async () => {
      root.unmount();
    });
  });

  test("标题兜底：空标题行展示正文首行摘要，非空标题原样", async () => {
    installRoutes([
      {
        method: "GET",
        prefix: `/api/notes?project=${encodeURIComponent(PROJECT)}`,
        reply: () => [
          200,
          {
            notes: [
              listItem({ id: "empty-title", title: "", preview: "首行摘要内容" }),
              listItem({ id: "with-title", title: "有标题", preview: "不应显示" }),
            ],
          },
        ],
      },
    ]);
    const { host, root } = await renderView();
    await waitFor(() => host.querySelectorAll("[data-testid=note-item]").length === 2, "list ready");
    const rows = [...host.querySelectorAll("[data-testid=note-item]")];
    const rowText = (id: string) => (host.querySelector(`[data-testid=note-item][data-note-id=${id}]`) as HTMLElement).textContent;
    expect(rowText("empty-title")).toContain("首行摘要内容");
    expect(rowText("with-title")).toContain("有标题");
    expect(rowText("with-title")).not.toContain("不应显示");
    void rows;
    await act(async () => {
      root.unmount();
    });
  });

  test("dirty 契约：编辑未保存 → dirtyRef 置真并挂 beforeunload；保存成功复位", async () => {
    let putBody: unknown = null;
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
          putBody = hit.body;
          return [200, { note: noteDetail() }];
        },
      },
    ]);
    const added: string[] = [];
    const removed: string[] = [];
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "beforeunload") added.push(type);
      return (origAdd as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "beforeunload") removed.push(type);
      return (origRemove as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.removeEventListener;

    const dirtyRef = { current: false };
    const { host, root } = await renderView(dirtyRef);
    try {
      await waitFor(() => host.querySelectorAll("[data-testid=note-item]").length === 1, "list ready");
      await act(async () => {
        click(q(host, "[data-testid=note-item]"));
      });
      await waitFor(() => host.querySelector("[data-testid=note-content-input]") !== null, "editor ready");
      expect(dirtyRef.current).toBe(false);
      expect(added).toHaveLength(0);

      const ta = q(host, "[data-testid=note-content-input]") as HTMLTextAreaElement;
      await act(async () => {
        setNativeValue(ta, "新内容");
      });
      expect(dirtyRef.current).toBe(true);
      expect(added).toContain("beforeunload");

      await act(async () => {
        click(q(host, "[data-testid=note-collapse-btn]"));
      });
      await waitFor(() => putBody !== null, "PUT sent");
      await waitFor(() => host.querySelector("[data-testid=note-inline-editor]") === null, "collapsed");
      expect(dirtyRef.current).toBe(false);
      expect(removed).toContain("beforeunload");
    } finally {
      window.addEventListener = origAdd;
      window.removeEventListener = origRemove;
      await act(async () => {
        root.unmount();
      });
    }
  });

  test("换行原样：编辑态 textarea 值含换行字符，保存载荷逐字节一致", async () => {
    let putBody: unknown = null;
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
          putBody = hit.body;
          return [200, { note: noteDetail() }];
        },
      },
    ]);
    const { host, root } = await renderView();
    await waitFor(() => host.querySelectorAll("[data-testid=note-item]").length === 1, "list ready");
    await act(async () => {
      click(q(host, "[data-testid=note-item]"));
    });
    await waitFor(() => host.querySelector("[data-testid=note-content-input]") !== null, "editor ready");
    const ta = q(host, "[data-testid=note-content-input]") as HTMLTextAreaElement;
    expect(ta.value).toBe("第一行\n第二行");
    expect((q(host, "[data-testid=note-title-input]") as HTMLInputElement).value).toBe("已有笔记");
    await act(async () => {
      click(q(host, "[data-testid=note-collapse-btn]"));
    });
    await waitFor(() => putBody !== null, "PUT sent");
    expect((putBody as { content: string }).content).toBe("第一行\n第二行");
    await act(async () => {
      root.unmount();
    });
  });
});
