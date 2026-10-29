// 笔记行内编辑组件测试（r11 todo7）：展开/自动保存/空新建取消/标题兜底/换行原样/
// dirty 拦截。happy-dom + createRoot + fetch mock 惯例沿用 web/tests 既有形态。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { NotesView } = await import("@/components/notes/notes-view");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;
const PROJECT = "/tmp/notes-inline-proj";

interface Req {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

let requests: Req[] = [];
let notes: Record<string, unknown>[] = [];
/** 可控的 PUT 失败开关（save error 路径） */
let failPut = false;

function fullNote(id: string, title: string, content: string, tags: string[] = []) {
  return {
    id,
    project: PROJECT,
    title,
    content,
    tags,
    deletedAt: null,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
  };
}

function listItem(id: string, title: string, preview: string) {
  return { id, title, preview, tags: [], updatedAt: "2026-10-29T00:00:00.000Z", deletedAt: null };
}

async function renderView(dirtyRef: { current: boolean }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(NotesView, { dirtyRef }));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** React 受控输入的原生赋值（绕过 value tracker 的去重，标准测试口径） */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(el: Element): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** 点外部（容器外 pointerdown）→ 行内编辑器收起自动保存 */
function clickOutside(): Promise<void> {
  return act(async () => {
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {});
}

function q(container: ParentNode, id: string): HTMLElement {
  const el = container.querySelector(`[data-testid=${id}]`);
  if (!el) throw new Error(`missing [data-testid=${id}]`);
  return el as HTMLElement;
}

function makeFetch() {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({ method, url, body });
    if (method === "GET" && url.startsWith("/api/notes?")) {
      return new Response(JSON.stringify({ notes }), { status: 200 });
    }
    if (method === "GET" && url.startsWith("/api/notes/")) {
      const id = decodeURIComponent(url.replace("/api/notes/", ""));
      const note = notes.find((n) => (n as { id: string }).id === id);
      if (!note) return new Response(JSON.stringify({ error: { code: "note_not_found", message: "x" } }), { status: 404 });
      return new Response(JSON.stringify({ note }), { status: 200 });
    }
    if (method === "POST" && url === "/api/notes") {
      const note = fullNote(`n-${requests.length}`, String(body.title ?? ""), String(body.content ?? ""), (body.tags as string[]) ?? []);
      notes = [note, ...notes];
      return new Response(JSON.stringify({ note }), { status: 201 });
    }
    if (method === "PUT" && url.startsWith("/api/notes/")) {
      if (failPut) return new Response(JSON.stringify({ error: { code: "boom", message: "disk full" } }), { status: 500 });
      const id = decodeURIComponent(url.replace("/api/notes/", ""));
      const idx = notes.findIndex((n) => (n as { id: string }).id === id);
      notes[idx] = { ...notes[idx], ...body };
      return new Response(JSON.stringify({ note: notes[idx] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: "unknown", message: "unmocked" } }), { status: 500 });
  }) as unknown as typeof fetch;
}

const writes = () => requests.filter((r) => r.method === "POST" || r.method === "PUT");

beforeEach(() => {
  requests = [];
  failPut = false;
  notes = [fullNote("n1", "已有笔记", "第一行\n第二行", ["work"])];
  globalThis.fetch = makeFetch();
  useUiStore.setState({ currentProject: PROJECT, toast: null });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("笔记行内编辑（r11 todo7）", () => {
  test("点行就地展开：载入详情后表单回显，改文点外部自动 PUT 保存并刷新列表", async () => {
    const dirtyRef = { current: false };
    const { container, unmount } = await renderView(dirtyRef);
    await flush();
    expect(container.querySelectorAll("[data-testid=note-item]").length).toBe(1);

    await click(q(container, "note-item"));
    await flush();
    const editor = q(container, "note-inline-editor");
    const titleInput = editor.querySelector<HTMLInputElement>("[data-testid=note-title-input]")!;
    const contentInput = editor.querySelector<HTMLTextAreaElement>("[data-testid=note-content-input]")!;
    expect(titleInput.value).toBe("已有笔记");
    expect(contentInput.value).toBe("第一行\n第二行");

    setNativeValue(titleInput, "改过的标题");
    setNativeValue(contentInput, "新正文");
    await flush();
    expect(dirtyRef.current).toBe(true);

    await clickOutside();
    await flush();
    const puts = writes().filter((r) => r.method === "PUT");
    expect(puts.length).toBe(1);
    expect(puts[0].url).toBe("/api/notes/n1");
    expect(puts[0].body).toMatchObject({ title: "改过的标题", content: "新正文" });
    expect(dirtyRef.current).toBe(false);
    // 保存后收起并重取列表
    await flush();
    expect(container.querySelector("[data-testid=note-inline-editor]")).toBeNull();
    await unmount();
  });

  test("新建：列表顶插入空行，输入后收起自动 POST 恰一次", async () => {
    const dirtyRef = { current: false };
    const { container, unmount } = await renderView(dirtyRef);
    await flush();

    await click(q(container, "note-new-btn"));
    await flush();
    const editor = q(container, "note-inline-editor");
    expect(editor.getAttribute("data-note-id")).toBe("draft");
    // 空行插在列表最前
    const list = q(container, "notes-list");
    expect(list.firstElementChild).toBe(editor);

    setNativeValue(editor.querySelector<HTMLInputElement>("[data-testid=note-title-input]")!, "新笔记");
    await click(q(container, "note-collapse-btn"));
    await flush();
    const posts = writes().filter((r) => r.method === "POST");
    expect(posts.length).toBe(1);
    expect(posts[0].body).toMatchObject({ project: PROJECT, title: "新笔记" });
    expect(dirtyRef.current).toBe(false);
    await unmount();
  });

  test("新建全空收起：零写请求无痕取消，列表复原", async () => {
    const { container, unmount } = await renderView({ current: false });
    await flush();
    await click(q(container, "note-new-btn"));
    await flush();
    await click(q(container, "note-collapse-btn"));
    await flush();
    expect(writes().length).toBe(0);
    expect(container.querySelector("[data-testid=note-inline-editor]")).toBeNull();
    await unmount();
  });

  test("标题兜底：空标题行显正文首行摘要，全空行显「无标题」", async () => {
    notes = [{ ...fullNote("n1", "", "首行内容\n次行"), preview: "首行内容" }, { ...fullNote("n2", "", ""), preview: "" }];
    const { container, unmount } = await renderView({ current: false });
    await flush();
    const rows = [...container.querySelectorAll("[data-testid=note-item]")];
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("首行内容");
    expect(rows[1].textContent).toContain("无标题");
    await unmount();
  });

  test("换行原样：textarea 多行值保存后逐字保留", async () => {
    const { container, unmount } = await renderView({ current: false });
    await flush();
    await click(q(container, "note-item"));
    await flush();
    const editor = q(container, "note-inline-editor");
    setNativeValue(editor.querySelector<HTMLTextAreaElement>("[data-testid=note-content-input]")!, "行甲\n行乙\n\n行丙");
    await click(q(container, "note-collapse-btn"));
    await flush();
    const put = writes().find((r) => r.method === "PUT")!;
    expect(put.body.content).toBe("行甲\n行乙\n\n行丙");
    await unmount();
  });

  test("dirty 拦截：编辑中 dirtyRef 置位并挂 beforeunload；保存失败保持 dirty", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const dirtyRef = { current: false };
    const { container, unmount } = await renderView(dirtyRef);
    await flush();
    expect(dirtyRef.current).toBe(false);

    await click(q(container, "note-item"));
    await flush();
    setNativeValue(q(container, "note-inline-editor").querySelector<HTMLTextAreaElement>("[data-testid=note-content-input]")!, "未保存的改动");
    await flush();
    expect(dirtyRef.current).toBe(true);
    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));

    // 保存失败：编辑器保持展开、错误行内展示、dirty 不解除
    failPut = true;
    await click(q(container, "note-collapse-btn"));
    await flush();
    expect(container.querySelector("[data-testid=note-save-error]")).not.toBeNull();
    expect(container.querySelector("[data-testid=note-inline-editor]")).not.toBeNull();
    expect(dirtyRef.current).toBe(true);
    addSpy.mockRestore();
    await unmount();
  });
});
