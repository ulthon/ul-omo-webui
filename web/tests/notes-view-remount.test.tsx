// 会话根架构 W1 t3 重挂载语义回归：NotesView 以 key={project} 整体重挂作为防串数据机制。
// - 同项目内切换选中会话（selectedId 变化、派生项目不变）→ key 不变不重挂：行内编辑器
//   展开态保留、列表不重取
// - 跨项目切换选中会话（派生项目变化）→ key 变化整体重挂：展开态归零、列表取新项目
// 惯例同 notes-inline.test.tsx：@happy-dom 全局注册 + createRoot/act 真实点击 + 可编程 fetch 路由。
// @ts-nocheck
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
const { useSessionsStore } = await import("@/stores/sessions");

const ORIGINAL_FETCH = globalThis.fetch;
const PROJECT_A = "/tmp/remount-a";
const PROJECT_B = "/tmp/remount-b";
const SESSION_A1 = "sa1";
const SESSION_A2 = "sa2";
const SESSION_B1 = "sb1";

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

/** 播种两个项目各若干会话，选中 A 项目第一个会话 */
function seedSessions(): void {
  useSessionsStore.setState({
    byProject: {
      [PROJECT_A]: [
        { id: SESSION_A1, project: PROJECT_A },
        { id: SESSION_A2, project: PROJECT_A },
      ],
      [PROJECT_B]: [{ id: SESSION_B1, project: PROJECT_B }],
    },
    selectedId: SESSION_A1,
  });
}

function listItem(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    preview: "",
    content: `${title} 全文`,
    tags: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function installDefaultRoutes(): void {
  installRoutes([
    {
      method: "GET",
      prefix: `/api/notes?project=${encodeURIComponent(PROJECT_A)}`,
      reply: () => [200, { notes: [listItem("na", "A项目笔记")] }],
    },
    {
      method: "GET",
      prefix: `/api/notes?project=${encodeURIComponent(PROJECT_B)}`,
      reply: () => [200, { notes: [listItem("nb", "B项目笔记")] }],
    },
  ]);
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
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  useSessionsStore.setState({ byProject: {}, selectedId: null });
  document.body.innerHTML = "";
});

function listHits(): number {
  return hits.filter((h) => h.url.includes("/api/notes?project=")).length;
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

describe("NotesView key=project 重挂语义（会话根架构 W1 t3）", () => {
  test("同项目切会话不重挂（编辑器展开态保留）；跨项目切会话整体重挂（展开态归零取新项目列表）", async () => {
    installDefaultRoutes();
    seedSessions();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const dirtyRef = { current: false };
    await act(async () => {
      root.render(createElement(NotesView, { dirtyRef }));
    });
    await waitFor(() => host.querySelector("[data-testid=note-item]") !== null, "A 项目列表就绪");

    // 展开行内编辑器（A 项目笔记，平铺直编免详情 GET）
    await act(async () => {
      click(q(host, "[data-testid=note-item]"));
    });
    await waitFor(() => host.querySelector("[data-testid=note-inline-editor]") !== null, "编辑器展开");
    const hitsBefore = listHits();

    // 同项目切换选中会话：派生项目不变 → key 不变 → 不重挂，展开态保留且列表不重取
    await act(async () => {
      useSessionsStore.setState({ selectedId: SESSION_A2 });
    });
    await flushMicrotasks();
    expect(host.querySelector("[data-testid=note-inline-editor]")).not.toBeNull();
    expect(listHits()).toBe(hitsBefore);

    // 跨项目切换选中会话：派生项目变化 → key 变化 → 整体重挂，展开态归零，列表取 B 项目
    await act(async () => {
      useSessionsStore.setState({ selectedId: SESSION_B1 });
    });
    await waitFor(() => host.textContent?.includes("B项目笔记") === true, "B 项目列表就绪");
    expect(host.querySelector("[data-testid=note-inline-editor]")).toBeNull();
    expect(hits.filter((h) => h.url.startsWith(`/api/notes?project=${encodeURIComponent(PROJECT_B)}`)).length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      root.unmount();
    });
  });
});
