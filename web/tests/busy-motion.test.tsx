// 忙碌动画族（docs08-r7 任务 13）：四位置接入契约测试。
//   1) 会话行状态点：running/waiting 挂 busy-pulse（不再用通用 animate-pulse），idle 无动画；
//   2) QueueBar 待发行：每行三竖线波形（busy-wave-bar ×3），无通用 spinner；
//   3) chat 首载骨架（ChatLoadSkeleton）：logo 呼吸 + 三点追逐 + role=status；
//   4) CSS 契约：index.css 三组 keyframes 仅 transform/opacity，prefers-reduced-motion
//      整族禁用（静态可辨形态由基类兜底）；
//   5) composer 发送中：POST 在途发送钮呼吸、无通用 spinner，回执后恢复（发送回归）。
// 挂载基建同 session-item-runstate / abort-settle-reset 惯例（happy-dom + createRoot + act）。
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SessionItem } = await import("@/components/session-list/session-item");
const { QueueBar } = await import("@/components/chat/queue-bar");
const { ChatLoadSkeleton } = await import("@/components/chat/chat-view");
const { Composer } = await import("@/components/composer/composer");
const { useHydrationRunLock } = await import("@/components/chat/hydration-lock");
const { useQueueStore } = await import("@/stores/queue");
import type { SessionListItem } from "@/lib/api";
import type { SessionRunState } from "@/stores/sessions";
const { useSessionsStore } = await import("@/stores/sessions");
const { useMessagesStore } = await import("@/stores/messages");
const { usePermissionsStore } = await import("@/stores/permissions");
const { useQuestionsStore } = await import("@/stores/questions");
const { useUiStore } = await import("@/stores/ui");
const { resetDispatchState } = await import("@/lib/event-dispatch");

const SID = "qa-busy-13";

const ORIGINAL_FETCH = globalThis.fetch;

function makeSession(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    path: `/store/${id}.jsonl`,
    project: "/p1",
    title: id,
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
    ...overrides,
  };
}

let mountedRoot: { unmount(): void } | null = null;

async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  mountedRoot = root;
  return container;
}

/** 行内状态点（size-1.5 圆点 span）的类列表（session-item-runstate 同款） */
function dotClasses(container: HTMLElement): string[] {
  const dot = [...container.querySelectorAll("span")].find((s) => s.className.includes("size-1.5"));
  expect(dot).toBeDefined();
  return dot!.className.split(/\s+/).filter(Boolean);
}

function resetStores(): void {
  useSessionsStore.setState({ byProject: {}, runStates: {}, runStateAt: {}, appliedModels: {}, selectedId: null });
  useMessagesStore.setState({ bySession: {} });
  useQueueStore.setState({ bySession: {} });
  usePermissionsStore.setState({ bySession: {} });
  useQuestionsStore.setState({ bySession: {} });
  useUiStore.setState({ currentProject: "/p1", toast: null });
}

function setRunState(state: SessionRunState): void {
  useSessionsStore.setState({ runStates: { [SID]: state } });
}

beforeEach(() => {
  resetStores();
});

afterEach(async () => {
  const root = mountedRoot;
  mountedRoot = null;
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
  resetStores();
  globalThis.fetch = ORIGINAL_FETCH;
  resetDispatchState();
});

describe("会话行状态点（位置 3）", () => {
  test("running 挂 busy-pulse，通用 animate-pulse 退役；waiting 同族", async () => {
    useSessionsStore.setState({ runStates: { [SID]: "running", [`${SID}-w`]: "waiting" } });
    const container = await mount(
      createElement(SessionItem, {
        session: makeSession(SID, { runState: null }),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    const running = dotClasses(container);
    expect(running).toContain("bg-sky-500");
    expect(running).toContain("animate-busy-pulse");
    expect(running).not.toContain("animate-pulse");

    const container2 = await mount(
      createElement(SessionItem, {
        session: makeSession(`${SID}-w`, { runState: null }),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    const waiting = dotClasses(container2);
    expect(waiting).toContain("bg-amber-500");
    expect(waiting).toContain("animate-busy-pulse");
    expect(waiting).not.toContain("animate-pulse");
  });

  test("idle 行静态无忙碌动画", async () => {
    setRunState("idle");
    const container = await mount(
      createElement(SessionItem, {
        session: makeSession(SID, { runState: null }),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    const idle = dotClasses(container);
    expect(idle).toContain("bg-muted-foreground/30");
    expect(idle).not.toContain("animate-busy-pulse");
    expect(idle).not.toContain("animate-pulse");
  });
});

describe("QueueBar 待发行（位置 2）", () => {
  test("每行三竖线波形 busy-wave-bar，无通用 spinner", async () => {
    useQueueStore.setState({
      bySession: {
        [SID]: {
          items: [
            { text: "第一条", mode: "steer", enqueueOrder: 0, enqueuedAt: Date.now() },
            { text: "第二条", mode: "followUp", enqueueOrder: 1, enqueuedAt: Date.now() },
          ],
        },
      },
    });
    const container = await mount(createElement(QueueBar, { sessionId: SID }));
    const rows = container.querySelectorAll("[data-testid=queue-item]");
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const wave = row.querySelector("[data-testid=queue-item-wave]");
      expect(wave).not.toBeNull();
      expect(wave!.querySelectorAll(".busy-wave-bar").length).toBe(3);
    }
    // 通用 spinner 在排队条零残留（位置 2 grep 门）
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });
});

describe("chat 首载骨架（位置 4）", () => {
  test("logo 呼吸 + 三点追逐 + role=status，无通用 spinner", () => {
    const html = renderToStaticMarkup(createElement(ChatLoadSkeleton));
    expect(html).toContain('src="/favicon.svg"');
    expect(html).toContain("animate-busy-pulse");
    expect((html.match(/busy-dot /g) ?? []).length).toBe(3);
    expect(html).toContain('role="status"');
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("animate-pulse");
  });
});

describe("index.css 忙碌动画契约（位置 0：关键帧与 reduced-motion）", () => {
  const cssPath = new URL("../src/index.css", import.meta.url);

  /** 提取 @keyframes NAME 的花括号配平块体 */
  function keyframesBlock(css: string, name: string): string {
    const start = css.indexOf(`@keyframes ${name} {`);
    expect(start, `@keyframes ${name} 应存在`).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = start; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) return css.slice(start, i + 1);
      }
    }
    throw new Error(`@keyframes ${name} 花括号不配平`);
  }

  /** 媒体查询块体（同配平法） */
  function mediaBlock(css: string, query: string): string {
    const start = css.indexOf(`@media (${query}) {`);
    expect(start, `@media (${query}) 应存在`).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = start; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) return css.slice(start, i + 1);
      }
    }
    throw new Error(`@media (${query}) 花括号不配平`);
  }

  test("三组 keyframes 仅 transform/opacity（零布局抖动），节奏标注 150/200/300ms 档", async () => {
    const css = await readFile(cssPath, "utf8");
    const layoutProps = /\b(width|height|margin|padding|top|left|right|bottom|font-size|gap)\s*:/;
    for (const name of ["busy-pulse", "busy-wave", "busy-dots"]) {
      const block = keyframesBlock(css, name);
      const decls = block.match(/[a-z-]+\s*:/g) ?? [];
      const propNames = decls.map((d) => d.replace(/[\s:]/g, "")).filter((p) => p !== "transform" && p !== "opacity");
      expect(propNames, `${name} 只允许 transform/opacity，实际 ${propNames.join(",")}`).toEqual([]);
      expect(layoutProps.test(block.replace(/@keyframes/, ""))).toBe(false);
    }
  });

  test("prefers-reduced-motion 整族禁用动画（降级静态可辨）", async () => {
    const css = await readFile(cssPath, "utf8");
    const reduce = mediaBlock(css, "prefers-reduced-motion: reduce");
    for (const cls of [".animate-busy-pulse", ".busy-wave-bar", ".busy-dot"]) {
      expect(reduce).toContain(cls);
    }
    expect(reduce).toContain("animation: none");
  });
});

describe("composer 发送中忙碌态（位置 1）", () => {
  /** chat-view.tsx 的 Composer 接线镜像（abort-settle-reset 同款） */
  function Harness(props: { onSent: () => void }) {
    const streaming = useMessagesStore((s) => s.bySession[SID]?.streaming ?? false);
    const hasPendingPermission = usePermissionsStore((s) => (s.bySession[SID]?.length ?? 0) > 0);
    const runState = useSessionsStore((s) => s.runStates[SID]);
    const { hydrationLocked, knownRunning } = useHydrationRunLock(SID);
    return createElement(Composer, {
      sessionId: SID,
      queueAvailable: streaming || knownRunning || runState === "running" || runState === "waiting",
      permissionLocked: hasPendingPermission,
      hydrationLocked,
      onSent: props.onSent,
      onAborted: () => {},
    });
  }

  async function typeText(container: HTMLElement, text: string): Promise<void> {
    const input = container.querySelector("[data-testid=composer-input]") as HTMLTextAreaElement;
    await act(async () => {
      const setVal = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setVal.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function click(el: Element): Promise<void> {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  test("POST 在途发送钮呼吸，回执后恢复直发（发送回归）", async () => {
    const promptCalls: Record<string, unknown>[] = [];
    let resolvePrompt!: (value: Response) => void;
    const okJson = (data: unknown): Response =>
      new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      if (url.endsWith("/prompt") && method === "POST") {
        promptCalls.push(body ?? {});
        return new Promise<Response>((resolve) => {
          resolvePrompt = resolve;
        });
      }
      return okJson({});
    }) as typeof fetch;

    const onSent = vi.fn();
    const { container, unmount } = await (async () => {
      const el = document.createElement("div");
      document.body.appendChild(el);
      const root = createRoot(el);
      await act(async () => {
        root.render(createElement(Harness, { onSent }));
      });
      return {
        container: el,
        unmount: async () => {
          await act(async () => {
            root.unmount();
          });
          el.remove();
        },
      };
    })();

    await typeText(container, "忙碌回归");
    const sendBtn = container.querySelector("[data-testid=send-btn]") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    expect(sendBtn.className).not.toContain("animate-busy-pulse");

    await click(sendBtn);
    // POST 在途：呼吸类挂上、无通用 spinner、按钮禁用语义保持
    expect(promptCalls.length).toBe(1);
    expect(promptCalls[0]).toMatchObject({ text: "忙碌回归" });
    expect(sendBtn.className).toContain("animate-busy-pulse");
    expect(sendBtn.className).not.toContain("animate-spin");
    expect(sendBtn.disabled).toBe(true);

    // 回执：呼吸类退场、onSent 回调、按钮恢复（发送链路未被动画包装破坏）
    await act(async () => {
      resolvePrompt(okJson({ sessionId: SID, disposition: "sent", streaming: false }));
    });
    expect(sendBtn.className).not.toContain("animate-busy-pulse");
    expect(onSent).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
