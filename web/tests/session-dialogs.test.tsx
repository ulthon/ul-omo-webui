/**
 * 会话对话框回归测试（手机端走查实锤 bug 2）：
 * 单个删除成功后，重命名对话框卡在"保存中…"不收敛——服务端无新请求，关闭后改名未生效。
 * 根因：SessionDialogs 是列表级常驻单例（关闭只是不渲染，组件不卸载），
 * submitDelete 成功路径不复位 busy，重开对话框的 effect 也不重置——busy 泄漏为 true，
 * 下一次提交被 `if (busy) return` 守卫吞掉。
 * 场景走真实组件（happy-dom + react-dom/client）；radix Dialog 原语 mock 为透传容器，
 * api 层 mock fetch（按现有测试风格）。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

// bun test 单进程跑多文件：其他测试文件可能已注册（sidebar-single-list 等），双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// radix Dialog 原语透传化：Dialog 按 open 条件渲染 children，其余原语为普通容器。
// SessionDialogs 的状态机（busy/effect/submit 守卫）不依赖 radix 语义。
mock.module("@/components/ui/dialog", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Conditional = ({
    open,
    children,
  }: {
    open?: boolean;
    children?: React.ReactNode;
  }) => (open ? <div data-testid="dialog-root">{children}</div> : null);
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
const { createElement, useState } = await import("react");
const dialogs = await import("@/components/session-list/dialogs");
const { SessionDialogs } = dialogs;
/** 会话对话框状态（从组件 props 推导，避免动态 import 内联 type 解构） */
type SessionDialogState = NonNullable<Parameters<typeof SessionDialogs>[0]["state"]>;
const { useSessionsStore } = await import("@/stores/sessions");

const ORIGINAL_FETCH = globalThis.fetch;

function makeSession(id: string, title: string): SessionListItem {
  return {
    id,
    path: `/store/sessions/${id}.jsonl`,
    project: "/p",
    title,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
  };
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

const DELETED = makeSession("d1", "待删会话");
const RENAMED = makeSession("r1", "演示主会话");

/** 测试宿主：模拟 session-list 的单例托管（同一 SessionDialogs 实例切换 state） */
function TestHost({ onState }: { onState: (set: (s: SessionDialogState | null) => void) => void }) {
  const [state, setState] = useState<SessionDialogState | null>(null);
  onState(setState);
  return (
    <SessionDialogs state={state} onClose={() => setState(null)} onChanged={() => {}} />
  );
}

function findButton(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

beforeEach(() => {
  useSessionsStore.setState({ byProject: {}, runStates: {}, selectedId: null });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("会话对话框 busy 泄漏（走查实锤：单删成功后重命名卡保存中）", () => {
  test("单删成功后重开重命名对话框：保存可点且发出 PATCH（不卡保存中）", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (method === "DELETE" && path === "/api/sessions/d1") return okJson({ ok: true, deleted: { id: "d1", sessionPath: "/x", fileExisted: true } });
      if (method === "PATCH" && path === "/api/sessions/r1/meta") return okJson({ ok: true, sessionId: "r1", meta: null });
      return okJson({ ok: true });
    }) as typeof fetch;

    let setState: (s: SessionDialogState | null) => void = () => {};
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TestHost, { onState: (set) => (setState = set) }));
    });

    // 1) 打开删除确认并确认删除（成功路径）
    await act(async () => {
      setState({ kind: "delete", session: DELETED });
    });
    const deleteBtn = findButton(container, "删除");
    expect(deleteBtn).toBeDefined();
    await act(async () => {
      deleteBtn?.click();
      await Promise.resolve();
    });
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/sessions/d1")).toBe(true);

    // 2) 同一实例重开重命名对话框（走查第二次重命名场景）
    await act(async () => {
      setState({ kind: "rename", session: RENAMED });
    });
    // 保存按钮不得停留在"保存中…"禁用态（busy 泄漏时的 bug 现象）
    expect(findButton(container, "保存中…")).toBeUndefined();
    const saveBtn = findButton(container, "保存");
    expect(saveBtn).toBeDefined();
    expect(saveBtn?.disabled).toBe(false);

    // 3) 提交重命名必须发出 PATCH（busy 泄漏时被 `if (busy) return` 吞掉）
    await act(async () => {
      saveBtn?.click();
      await Promise.resolve();
    });
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/sessions/r1/meta")).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
