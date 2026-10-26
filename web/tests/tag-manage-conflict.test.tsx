// 标签管理弹层整替冲突防护（r9）组件级测试：挂真实 TagManageDialog
//（happy-dom + react-dom/client；radix Dialog 原语 mock 透传、api 走 mock fetch，同 session-dialogs 风格）。
// 场景：
// 1) 对端已删除目标后本端重命名：putScope 重拉发现目标不在场 → toast 提示且不发出 PUT（防覆盖丢失）
// 2) 整替 409 tag_conflict：toast 提示，本地副本同步服务端最新、不回写旧值、不自动重试
// 3) 正常路径：PUT 载荷基于重拉的最新列表叠加，且携 baseRevision
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { TagDefinition } from "@/lib/api";
import type { TagOrphanCleanup } from "@/components/session-list/tag-manage-dialog";

// bun/单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// radix Dialog 原语透传化：Dialog 按 open 条件渲染 children，其余原语为普通容器
vi.mock("@/components/ui/dialog", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Conditional = ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <div data-testid="dialog-root">{children}</div> : null;
  return {
    Dialog: Conditional,
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
const { TagManageDialog } = await import("@/components/session-list/tag-manage-dialog");
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

const defsOf = (names: string[]): TagDefinition[] => names.map((name, i) => ({ name, sort: i }));

interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

/** fetch 桩：记录全部调用；GET /api/tags 回 stubLatest+revision，PUT /api/tags 可配 409 */
function installFetch(opts: { latest: TagDefinition[]; revision: string; putStatus?: number }) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/tags") {
      return okJson({ global: opts.latest, project: [], revision: opts.revision });
    }
    if (method === "PUT" && path === "/api/tags") {
      if (opts.putStatus === 409) return errJson(409, "tag_conflict", "标签定义已被其他端修改，请刷新后重试");
      return okJson({ tags: (body as { tags: TagDefinition[] }).tags });
    }
    return okJson({});
  }) as typeof fetch;
  return calls;
}

function findButton(root: ParentNode, ariaLabel: string): HTMLButtonElement | undefined {
  return root.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`) ?? undefined;
}

/** React 受控 input 赋值：原生 setter + input 事件 */
function typeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 挂弹框：global scope，本地初始 defs 由 props 给入（父级视角）；orphanCleanups 可选传入 */
async function mountDialog(initialNames: string[], orphanCleanups?: TagOrphanCleanup[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    scope: "global" as const,
    defs: { global: defsOf(initialNames), project: [] as TagDefinition[] },
    ...(orphanCleanups ? { orphanCleanups } : {}),
    onChanged: () => {},
    onClose: () => {},
  };
  await act(async () => {
    root.render(createElement(TagManageDialog, props));
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

beforeEach(() => {
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("TagManageDialog 整替冲突防护（r9）", () => {
  test("对端已删除目标后本端重命名：重拉发现目标不在场 → toast 提示且不发出 PUT", async () => {
    // 对端视图：a 已被删除，只剩 b；revision 前移
    const calls = installFetch({ latest: defsOf(["b"]), revision: "rev-peer" });
    const { container, unmount } = await mountDialog(["a", "b"]);

    // 本端对 a 发起重命名（列表仍显示旧副本）
    await act(async () => {
      findButton(container, "重命名 a")?.click();
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>('input[data-testid="tag-rename-input"]');
    expect(input).toBeDefined();
    await act(async () => {
      typeValue(input!, "a2");
      await Promise.resolve();
    });
    await act(async () => {
      findButton(container, "确认重命名")?.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    // 发出了重拉 GET，但绝不发出 PUT（基于旧副本的载荷不得出网）
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/tags")).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    // toast 提示（zh：目标已不在场，本次变更未提交）
    const toasts = useUiStore.getState().toasts.map((t) => t.text).join("|");
    expect(toasts).toContain("未提交");
    expect(toasts).toContain("a");
    await unmount();
  });

  test("409 tag_conflict：toast 提示，本地副本同步服务端最新、不回写旧值、无自动重试", async () => {
    // 重拉返回最新 [a,b]；PUT 一律 409（模拟提交瞬间对端又抢先写入）
    const calls = installFetch({ latest: defsOf(["a", "b"]), revision: "rev1", putStatus: 409 });
    const { container, unmount } = await mountDialog(["a", "b"]);

    await act(async () => {
      findButton(container, "重命名 a")?.click();
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>('input[data-testid="tag-rename-input"]');
    expect(input).toBeDefined();
    await act(async () => {
      typeValue(input!, "a2");
      await Promise.resolve();
    });
    await act(async () => {
      findButton(container, "确认重命名")?.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    // 一打 409 后不自动重试（重试即覆盖对端）
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    // toast 提示（zh：冲突，未提交）
    const toasts = useUiStore.getState().toasts.map((t) => t.text).join("|");
    expect(toasts).toContain("冲突");
    expect(toasts).toContain("未提交");
    // 本地副本不回写旧值：列表同步为服务端最新 [a, b]，而非本端旧编辑 a2
    const names = [...container.querySelectorAll('[data-testid="tag-manage-name"]')].map((el) => el.textContent);
    expect(names).toEqual(["a", "b"]);
    await unmount();
  });

  test("正常路径：PUT 载荷基于重拉最新列表叠加且携 baseRevision", async () => {
    const calls = installFetch({ latest: defsOf(["a", "b"]), revision: "rev1" });
    const { container, unmount } = await mountDialog(["a", "b"]);

    await act(async () => {
      findButton(container, "重命名 a")?.click();
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>('input[data-testid="tag-rename-input"]');
    expect(input).toBeDefined();
    await act(async () => {
      typeValue(input!, "a2");
      await Promise.resolve();
    });
    await act(async () => {
      findButton(container, "确认重命名")?.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/tags");
    expect(put).toBeDefined();
    const body = put!.body as { scope: string; tags: TagDefinition[]; baseRevision?: string };
    expect(body.scope).toBe("global");
    expect(body.baseRevision).toBe("rev1");
    // 载荷 = 最新列表 + 本次变更（对端新增也保留；本端编辑叠加其后）
    expect(body.tags.map((t) => t.name)).toEqual(["a2", "b"]);
    await unmount();
  });

  test("孤儿清理：提交前重拉最新挂载，保留集按最新重算携 baseRevision（对端新增不误删）", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/sessions/s1/tags") {
        // 服务端最新：孤儿 ghost 仍在场，保留 work 还在，对端新增的已定义挂载 peer 也已到达
        return okJson({
          tags: [
            { scope: "global", name: "ghost" },
            { scope: "global", name: "work" },
            { scope: "global", name: "peer" },
          ],
          revision: "mount-rev1",
        });
      }
      if (method === "PUT" && path === "/api/sessions/s1/tags") {
        return okJson({ tags: (body as { tags: unknown }).tags, revision: "mount-rev2" });
      }
      return okJson({});
    }) as typeof fetch;
    const { container, unmount } = await mountDialog([], [
      {
        sessionId: "s1",
        sessionTitle: "S1",
        orphans: [{ scope: "global", name: "ghost" }],
        keep: [{ scope: "global", name: "work" }],
      },
    ]);

    // 两段式确认：点「清理」变确认钮，再点确认才发整替
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-testid="tag-orphan-clean"]')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-testid="tag-orphan-clean-confirm"]')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/sessions/s1/tags");
    expect(put).toBeDefined();
    const body = put!.body as {
      tags: { scope: string; name: string }[];
      source: string;
      baseRevision?: string;
    };
    expect(body.source).toBe("tag-manage-dialog:orphan-clean");
    // 携重拉所得挂载 revision 提交
    expect(body.baseRevision).toBe("mount-rev1");
    // 保留集按最新挂载重算：ghost 剔除、work 保留、对端新增 peer 不被打开时刻的旧 keep 误删
    expect(body.tags.map((t) => t.name).sort()).toEqual(["peer", "work"]);
    await unmount();
  });
});
