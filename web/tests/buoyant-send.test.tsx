// 发消息即上浮（docs08 2026-10-23/24 批次任务 13）：乐观更新 + 多时点触发刷新。
// 覆盖：(a) composer 直发 → 会话行浮到置顶组之下首位（置顶行不被挤下）；
// (b) appendLocalUserEntry 路径同浮（store 单元）+ 排队回执经 onSent 上浮；
// (c) agent_start 帧触发 refreshSessions；(d) followUp 排队投递（出队宣布）触发
// refreshSessions；(e) 乐观位与服务端真相收敛（刷新返回后序不变、无重复行）。
// 惯例：happy-dom 全局注册 + createRoot/act 真实交互（composer-mobile-layout 同款），
// api 层 vi.spyOn 桩，无网络、无定时器轮询。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useSessionsStore } = await import("@/stores/sessions");
const { useMessagesStore } = await import("@/stores/messages");
const { useQueueStore } = await import("@/stores/queue");
const { useUiStore } = await import("@/stores/ui");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");
const { Composer } = await import("@/components/composer/composer");
const apiMod = await import("@/lib/api");
import type { SessionListItem } from "@/lib/api";

const PROJECT = "/p";
const SID = "qa-buoy-c";

function makeSession(id: string, modified: string, pinned = false): SessionListItem {
  return {
    id,
    path: `/store/sessions/${id}.jsonl`,
    project: PROJECT,
    title: id,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified,
    messageCount: 0,
    firstMessage: "",
    pinned,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
  };
}

/** 基线数据：A 置顶（modified 最新也在顶）、B 次新、C（发送目标）最旧（均早于当前时刻，
 *  乐观 modified=now 必然最大） */
const T0 = Date.now();
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString();
function seedList(): void {
  useSessionsStore.setState({
    byProject: {
      [PROJECT]: [
        makeSession("A", iso(3600_000), true),
        makeSession("B", iso(7200_000)),
        makeSession(SID, iso(86400_000)),
      ],
    },
    selectedId: SID,
    allMode: false,
  });
}

function orderOf(project = PROJECT): string[] {
  return (useSessionsStore.getState().byProject[project] ?? []).map((s) => s.id);
}

async function typeAndSend(container: HTMLElement): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"]');
  expect(textarea).not.toBeNull();
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(textarea, "上浮消息");
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const sendBtn = container.querySelector<HTMLButtonElement>('button[data-testid="send-btn"]');
  expect(sendBtn).not.toBeNull();
  await act(async () => {
    sendBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** chat-view onSent 回调契约（任务 13 ①：store 现读 selectedId 兑底 props sessionId） */
function chatViewOnSent(): void {
  const cur = useSessionsStore.getState();
  cur.floatSessionUp(cur.selectedId ?? SID);
}

beforeEach(() => {
  resetDispatchState();
  useMessagesStore.setState({ bySession: {} });
  useQueueStore.setState({ bySession: {} });
  useUiStore.setState({ toast: null, currentProject: null });
  seedList();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDispatchState();
});

describe("任务 13：发消息即上浮（乐观更新 + 多时点刷新）", () => {
  test("(b) floatSessionUp：非置顶行浮到非置顶区之首，置顶行仍在顶；无任何网络刷新", () => {
    const listSpy = vi.spyOn(apiMod.api, "listSessions");
    useSessionsStore.getState().floatSessionUp(SID);
    expect(orderOf()).toEqual(["A", SID, "B"]);
    expect(listSpy).not.toHaveBeenCalled();
    // modified 已乐观前移（超过基线最新行）
    const row = useSessionsStore.getState().byProject[PROJECT].find((s) => s.id === SID)!;
    expect(row.modified > iso(3600_000)).toBe(true);
  });

  test("(b) 置顶行上浮仍在顶；未知 id no-op；连续双发幂等（stale_state：不闪跳）", () => {
    useSessionsStore.getState().floatSessionUp("A");
    expect(orderOf()).toEqual(["A", "B", SID]);
    useSessionsStore.getState().floatSessionUp("nope");
    expect(orderOf()).toEqual(["A", "B", SID]);
    useSessionsStore.getState().floatSessionUp(SID);
    useSessionsStore.getState().floatSessionUp(SID);
    expect(orderOf()).toEqual(["A", SID, "B"]);
  });

  test("(a) composer 直发（appendLocalUserEntry 路径）：会话行即时上浮，置顶 A 仍居首，未触发列表刷新", async () => {
    const listSpy = vi.spyOn(apiMod.api, "listSessions");
    vi.spyOn(apiMod.api, "prompt").mockResolvedValue({
      disposition: "sent",
      streaming: false,
    } as unknown as Awaited<ReturnType<typeof apiMod.api.prompt>>);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(Composer, {
            sessionId: SID,
            queueAvailable: false,
            permissionLocked: false,
            hydrationLocked: false,
            onSent: chatViewOnSent,
            onAborted: () => {},
          }),
        );
      });
      await typeAndSend(container);
      // 乐观结果：置顶 A 之下第一位即发送会话（列表首可见非置顶行）
      expect(orderOf()).toEqual(["A", SID, "B"]);
      expect(listSpy).not.toHaveBeenCalled();
      // 直发路径本地用户消息同时入列（乐观占位不丢）
      expect(useMessagesStore.getState().bySession[SID].entries.length).toBe(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  test("(a) 排队回执（disposition=queued）：经 onSent 上浮（无 appendLocalUserEntry）", async () => {
    vi.spyOn(apiMod.api, "prompt").mockResolvedValue({
      disposition: "queued",
    } as unknown as Awaited<ReturnType<typeof apiMod.api.prompt>>);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(Composer, {
            sessionId: SID,
            queueAvailable: true,
            permissionLocked: false,
            hydrationLocked: false,
            onSent: chatViewOnSent,
            onAborted: () => {},
          }),
        );
      });
      await typeAndSend(container);
      expect(orderOf()).toEqual(["A", SID, "B"]);
      // 排队路径不做本地消息占位（单显示源=排队条）
      expect(useMessagesStore.getState().bySession[SID]).toBeUndefined();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  test("(c) agent_start 帧触发 refreshSessions", async () => {
    const listSpy = vi.spyOn(apiMod.api, "listSessions").mockResolvedValue({
      project: null,
      archived: "all",
      sessions: [],
    } as unknown as Awaited<ReturnType<typeof apiMod.api.listSessions>>);
    useSessionsStore.setState({ allMode: true });
    dispatchSseEvent(
      "agent_start",
      JSON.stringify({ projectPath: PROJECT, event: { type: "agent_start", sessionId: "rpc-1" }, durableSessionId: SID }),
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  test("(d) followUp 投递（queue_update 出队宣布）触发 refreshSessions；纯入队不触发", async () => {
    const listSpy = vi.spyOn(apiMod.api, "listSessions").mockResolvedValue({
      project: null,
      archived: "all",
      sessions: [],
    } as unknown as Awaited<ReturnType<typeof apiMod.api.listSessions>>);
    useSessionsStore.setState({ allMode: true });
    useQueueStore.setState({
      bySession: { [SID]: { items: [{ text: "跟答项", mode: "followUp", enqueueOrder: 1, enqueuedAt: 1 }] } },
    });
    const frame = (ordered: unknown[], cursor: number) =>
      dispatchSseEvent(
        "queue_update",
        JSON.stringify({ projectPath: PROJECT, event: { type: "queue_update", steering: [], followUp: [], ordered, sessionId: "rpc-1" }, durableSessionId: SID }),
        cursor,
      );
    // 纯入队（新增项，旧项仍在）：不刷新
    frame([{ text: "跟答项", mode: "followUp", enqueueOrder: 1 }, { text: "新排队", mode: "followUp", enqueueOrder: 2 }], 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listSpy).not.toHaveBeenCalled();
    // 出队宣布（ordered 不再含旧项）：刷新一次
    frame([{ text: "新排队", mode: "followUp", enqueueOrder: 2 }], 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listSpy).toHaveBeenCalledTimes(1);
    // 排队条同步收敛（已投递项出列）
    expect(useQueueStore.getState().bySession[SID].items.map((i) => i.text)).toEqual(["新排队"]);
  });

  test("(e) 收敛：乐观上浮后 refreshSessions 返回服务端序 → 位置一致、无重复行、无跳变", async () => {
    useSessionsStore.getState().floatSessionUp(SID);
    expect(orderOf()).toEqual(["A", SID, "B"]);
    // 服务端真相：引擎已把 C 的 modified 落盘为最新（与乐观位一致的排序结果）
    vi.spyOn(apiMod.api, "listSessions").mockResolvedValue({
      project: null,
      archived: "all",
      sessions: [
        makeSession("A", iso(3600_000), true),
        makeSession(SID, iso(1000)),
        makeSession("B", iso(7200_000)),
      ],
    } as unknown as Awaited<ReturnType<typeof apiMod.api.listSessions>>);
    useSessionsStore.setState({ allMode: true });
    await useSessionsStore.getState().refreshSessions();
    const list = useSessionsStore.getState().byProject[PROJECT];
    expect(list.map((s) => s.id)).toEqual(["A", SID, "B"]);
    expect(new Set(list.map((s) => s.id)).size).toBe(3);
    expect(list.find((s) => s.id === SID)!.modified).toBe(iso(1000));
  });
});
