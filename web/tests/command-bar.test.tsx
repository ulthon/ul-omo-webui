// CommandBar 组件测试（docs08-r3 任务 14：A4 命令行数据驱动显隐）。
// 不 mock 命令模块（mock.module 会污染单进程内其他测试文件的模块缓存）：
// 直接翻转真实 CHAT_COMMANDS 条目的 supported 字段模拟混合支持表，afterEach 还原。
// 现状四命令全不支持（实证 docs/verification/05）→ 组件整条不渲染；
// 翻转任一命令 supported=true → 组件回归可见且仅支持项可点（数据驱动）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// bun test 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { CommandBar } = await import("@/components/chat/command-bar");
const { CHAT_COMMANDS } = await import("@/components/chat/commands");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;

async function render(ui: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
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

function bar(container: ParentNode): HTMLElement | null {
  return container.querySelector("[data-testid=command-bar]");
}

function cmdButton(container: ParentNode, name: string): HTMLButtonElement | null {
  return container.querySelector(`[data-testid=cmd-${name}]`);
}

/** 翻转指定命令 supported（组件按表数据驱动显隐），返回还原函数 */
function flip(name: string, supported: boolean): () => void {
  const cmd = CHAT_COMMANDS.find((c) => c.name === name)!;
  const prev = cmd.supported;
  cmd.supported = supported;
  return () => {
    cmd.supported = prev;
  };
}

beforeEach(() => {
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("CommandBar 数据驱动显隐", () => {
  test("四命令全不支持（实证现状）→ 整条不渲染（document 级无 command-bar 与任何 cmd-* 按钮）", async () => {
    const { container, unmount } = await render(createElement(CommandBar, { sessionId: "s1", busy: false }));
    // container 挂在 document.body 下：document 级断言等价于整页 DOM 无该元素
    expect(document.querySelector("[data-testid=command-bar]")).toBeNull();
    expect(document.querySelector("[data-testid^=cmd-]")).toBeNull();
    expect(bar(container)).toBeNull();
    expect(container.textContent).not.toContain("（引擎不支持，已禁用）");
    await unmount();
  });

  test("翻转任一命令 supported=true → 组件渲染，仅支持项可点（其余禁用）", async () => {
    const restore = flip("compact", true);
    try {
      const { container, unmount } = await render(createElement(CommandBar, { sessionId: "s1", busy: false }));
      expect(bar(container)).not.toBeNull();
      expect(cmdButton(container, "compact")?.disabled).toBe(false);
      for (const cmd of CHAT_COMMANDS) {
        if (cmd.name === "compact") continue;
        expect(cmdButton(container, cmd.name)?.disabled).toBe(true);
      }
      expect(container.textContent).not.toContain("（引擎不支持，已禁用）");
      await unmount();
    } finally {
      restore();
    }
  });

  test("点支持项走 POST prompt 原文（支持路径保留）；不支持项 disabled 拦截点击", async () => {
    const restore = flip("clear", true);
    try {
      const calls: { url: string; body: string }[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;
      const { container, unmount } = await render(createElement(CommandBar, { sessionId: "s1", busy: false }));
      await act(async () => {
        cmdButton(container, "clear")!.click();
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("/api/sessions/s1/prompt");
      expect(calls[0].body).toContain("/clear");
      await unmount();
    } finally {
      restore();
    }
  });

  test("支持表静态非运行时数据：显隐在挂载时按表判定（翻转后重挂载可见性跟随）", async () => {
    // 对抗 stale state：现状支持表为静态常量（commands.ts:17-42，非运行时下发），
    // 组件每次渲染即时读表，无快照缓存——翻转后重挂载即跟随，不存在陈旧态窗口。
    const first = await render(createElement(CommandBar, { sessionId: "s1", busy: false }));
    expect(bar(first.container)).toBeNull();
    await first.unmount();
    const restore = flip("new", true);
    try {
      const { container, unmount } = await render(createElement(CommandBar, { sessionId: "s1", busy: false }));
      expect(bar(container)).not.toBeNull();
      await unmount();
    } finally {
      restore();
    }
  });
});
