// 切换 sheet 会话行四件套（r10 todo 3）：状态点（running/waiting/idle 颜色语义）、
// 置顶 Pin 标、相对时间（formatRelative，冻结时钟保证确定性）、未读徽标（>99 → "99+"）。
// 惯例沿 topbar-session-switcher-sheet：@happy-dom 全局注册 + createRoot/act 真实渲染
// Radix Dialog；DropdownMenu mock 透传（桌面分支仍在用）；时钟仅伪造 Date，不碰定时器。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/ui/dropdown-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Passthrough,
    DropdownMenuLabel: Passthrough,
    DropdownMenuSeparator: Passthrough,
  };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { SessionSwitcherSheet } = await import("@/components/layout/topbar");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;
// 冻结时钟：相对时间与 modified 的差值恒定，断言无边界抖动
const FROZEN_NOW = new Date("2026-10-28T12:00:00.000Z").getTime();

function makeSession(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    path: `/store/${id}.jsonl`,
    project: "/p1",
    title: `会话-${id}`,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: new Date(FROZEN_NOW - 5 * 3600 * 1000).toISOString(),
    messageCount: 1,
    firstMessage: "hi",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
    ...overrides,
  };
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

async function mountSheet(byProject: Record<string, SessionListItem[]>, runStates: Record<string, string> = {}): Promise<HTMLElement> {
  useSessionsStore.setState({ byProject, runStates: runStates as never, selectedId: null });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(SessionSwitcherSheet, {
        open: true,
        onOpenChange: () => {},
        onAddProject: () => {},
      }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

function row(id: string): HTMLElement {
  const row = document.querySelector(`[data-testid="sheet-session-item"][data-session-id="${id}"]`);
  if (!row) throw new Error(`missing sheet row ${id}`);
  return row as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/tags")) return okJson({ global: [], project: [] });
    return okJson({ models: [], favorites: [], defaults: null });
  }) as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("切换 sheet 行四件套（r10 todo 3）", () => {
  test("状态点：running 天蓝呼吸 / waiting 琥珀呼吸 / idle 灰（权威链 SSE runStates → 行 runState）", async () => {
    await mountSheet(
      {
        "/p1": [
          makeSession("s-run"),
          makeSession("s-wait", { runState: "waiting" as const }),
          makeSession("s-idle"),
        ],
      },
      { "s-run": "running" },
    );
    // running：SSE runStates 权威值 → sky + busy-pulse
    const dotRun = row("s-run").querySelector("span.size-1\\.5");
    expect(dotRun?.className).toContain("bg-sky-500");
    expect(dotRun?.className).toContain("animate-busy-pulse");
    // waiting：行 runState 回落值 → amber + busy-pulse
    const dotWait = row("s-wait").querySelector("span.size-1\\.5");
    expect(dotWait?.className).toContain("bg-amber-500");
    expect(dotWait?.className).toContain("animate-busy-pulse");
    // idle：无任何状态源 → 灰点，无呼吸动画
    const dotIdle = row("s-idle").querySelector("span.size-1\\.5");
    expect(dotIdle?.className).toContain("bg-muted-foreground/30");
    expect(dotIdle?.className).not.toContain("animate-busy-pulse");
  });

  test("置顶标：pinned=true 渲染 Pin 图标，未置顶不渲染", async () => {
    await mountSheet({ "/p1": [makeSession("s-pin", { pinned: true }), makeSession("s-nopin")] });
    expect(row("s-pin").querySelector(".lucide-pin")).not.toBeNull();
    expect(row("s-nopin").querySelector(".lucide-pin")).toBeNull();
  });

  test("相对时间：冻结时钟下 5h 前的 modified 显示 5h", async () => {
    await mountSheet({ "/p1": [makeSession("s-time")] });
    expect(row("s-time").textContent).toContain("5h");
  });

  test("未读徽标：普通值原样显示，150 → 99+，0 不渲染", async () => {
    await mountSheet({
      "/p1": [makeSession("s-u7", { unreadCount: 7 }), makeSession("s-u150", { unreadCount: 150 }), makeSession("s-u0")],
    });
    const b7 = row("s-u7").querySelector('[data-testid="row-unread-badge"]');
    expect(b7?.textContent).toBe("7");
    const b150 = row("s-u150").querySelector('[data-testid="row-unread-badge"]');
    expect(b150?.textContent).toBe("99+");
    expect(row("s-u0").querySelector('[data-testid="row-unread-badge"]')).toBeNull();
  });
});
