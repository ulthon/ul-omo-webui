// 打标签下拉挂载整替冲突防护（r9 F1-B1）组件级测试：挂真实 TagDropdown
//（happy-dom + react-dom/client；api 走 mock fetch，同 tag-manage-conflict 风格）。
// 场景：
// 1) 勾选携打开时刻行 revision 提交 → 409 tag_mount_conflict：toast 冲突提示（词典映射）、
//    重拉该会话最新挂载进快照、勾选态不变（可按新快照重试）
// 2) 按重拉后的新 revision 重试 → PUT 成功，勾选态生效
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

// bun/单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { TagDropdown } = await import("@/components/session-list/tag-dropdown");
const { useUiStore } = await import("@/stores/ui");

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

/** 单会话行（打开时刻：已挂 a，行 revision rev0） */
function sessionRow(): SessionListItem {
  return {
    id: "s1",
    path: "/p/s1.jsonl",
    project: "/p",
    title: "S1",
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
    tags: [{ scope: "global", name: "a" }],
    tagsRevision: "rev0",
  };
}

interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

/** fetch 桩：挂载 PUT 首打 409、重打 200；GET 单会话挂载返回对端已新增 peer 的最新态 */
function installFetch() {
  const calls: FetchCall[] = [];
  let putCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path, body });
    if (method === "PUT" && path === "/api/sessions/s1/tags") {
      putCount += 1;
      if (putCount === 1) return errJson(409, "tag_mount_conflict", "标签挂载已被其他端修改，请刷新后重试");
      return okJson({
        tags: [
          { scope: "global", name: "a" },
          { scope: "global", name: "peer" },
          { scope: "global", name: "b" },
        ],
        revision: "rev2",
      });
    }
    if (method === "GET" && path === "/api/sessions/s1/tags") {
      return okJson({
        tags: [
          { scope: "global", name: "a" },
          { scope: "global", name: "peer" },
        ],
        revision: "rev1",
      });
    }
    return okJson({});
  }) as typeof fetch;
  return calls;
}

async function mountDropdown() {
  const anchor = document.createElement("div");
  document.body.appendChild(anchor);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(TagDropdown, {
        anchor,
        sessions: [sessionRow()],
        defs: { global: [{ name: "b", sort: 0 }], project: [] },
        manageScope: null,
        onManage: () => {},
        onClose: () => {},
      }),
    );
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

const clickTag = async (container: ParentNode, name: string) => {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`button[data-tag="${name}"]`)?.click();
    await new Promise((r) => setTimeout(r, 0));
  });
};

const checkedState = (container: ParentNode): string | null =>
  container.querySelector<HTMLButtonElement>('button[data-tag="b"]')?.getAttribute("aria-checked") ?? null;

beforeEach(() => {
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("TagDropdown 挂载整替冲突防护（r9 F1-B1）", () => {
  test("首打携行 revision → 409：toast 冲突提示、重拉最新挂载进快照、勾选态不变", async () => {
    const calls = installFetch();
    const { container, unmount } = await mountDropdown();

    await clickTag(container, "b");

    // 首打：携打开时刻的行 revision + 整替载荷（快照 [a] + b）
    const puts = calls.filter((c) => c.method === "PUT" && c.path === "/api/sessions/s1/tags");
    expect(puts).toHaveLength(1);
    const firstBody = puts[0].body as {
      tags: { scope: string; name: string }[];
      source: string;
      baseRevision?: string;
    };
    expect(firstBody.baseRevision).toBe("rev0");
    expect(firstBody.source).toBe("tag-dropdown");
    expect(firstBody.tags).toEqual([{ scope: "global", name: "a" }, { scope: "global", name: "b" }]);
    // 409 后重拉该会话最新挂载（对端新增不丢，快照可重试）
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/sessions/s1/tags")).toBe(true);
    // toast 冲突提示（apiErrorMessage 映射 tag_mount_conflict → zh 词典文案）
    const toasts = useUiStore.getState().toasts.map((t) => t.text).join("|");
    expect(toasts).toContain("标签挂载已被其他端修改");
    // 勾选态不变（失败项下次点击按快照重算，可重试）
    expect(checkedState(container)).toBe("false");
    await unmount();
  });

  test("按重拉后的新 revision 重试 → PUT 成功，勾选态生效", async () => {
    const calls = installFetch();
    const { container, unmount } = await mountDropdown();

    await clickTag(container, "b");
    await clickTag(container, "b");

    // 重打：携重拉所得新 revision，载荷基于最新快照（含对端新增 peer）
    const puts = calls.filter((c) => c.method === "PUT" && c.path === "/api/sessions/s1/tags");
    expect(puts).toHaveLength(2);
    const retryBody = puts[1].body as { tags: { scope: string; name: string }[]; baseRevision?: string };
    expect(retryBody.baseRevision).toBe("rev1");
    expect(retryBody.tags).toEqual([
      { scope: "global", name: "a" },
      { scope: "global", name: "peer" },
      { scope: "global", name: "b" },
    ]);
    expect(checkedState(container)).toBe("true");
    await unmount();
  });
});
