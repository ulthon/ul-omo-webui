// @ts-nocheck（同既有挂载型测试约定：动态 import + happy-dom 环境）
// engine-open-read-batch t12 回归：打开会话的游标增量校准撞 409 cursor_invalid
// （compact 静默留旧游标 → 切回会话带旧游标被服务端拒绝）自动升级 full=1 全量重取，
// 不再落错误屏死胡同；非 cursor_invalid（500 等）保持原错误态。
// 真实表面挂载 ChatView（api 层 vi.spyOn 注入），store 断言升级重取后 cursor 已刷新
//（二次校准不再 409，stale_state 探针；错误屏文案走 zh-CN i18n 真值）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { ChatView } = await import("@/components/chat/chat-view");
const { api, ApiError } = await import("@/lib/api");
const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");

const SID = "t12-cursor-calibration";
const ERROR_TEXT = "消息加载失败，请检查服务是否可用";

function userEntry(id: string): Record<string, unknown> {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text: `msg ${id}` }] } };
}

function page(entries: Record<string, unknown>[], cursor: string) {
  return { entries, cursor, leafId: cursor, hasMore: false, oldestId: null };
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot> | null = null;

const listMessages = vi.spyOn(api, "listMessages");
const markRead = vi.spyOn(api, "markRead");
const getSettings = vi.spyOn(api, "getSettings");
const getQuestions = vi.spyOn(api, "getQuestions");
const getQueue = vi.spyOn(api, "getQueue");

async function mount(): Promise<void> {
  useSessionsStore.setState({ selectedId: SID });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ChatView));
  });
}

function seedStaleSession(): void {
  // 预置：会话已加载过、游标为 compact 前的旧值（compact-run.ts 静默留旧游标形态）
  useMessagesStore.getState().setEntries(SID, [userEntry("e1")] as never, "stale-cursor", "e1", {
    hasMore: false,
    oldestId: null,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  markRead.mockResolvedValue({ ok: true, sessionId: SID });
  getSettings.mockResolvedValue({ settings: {} } as never);
  getQuestions.mockResolvedValue({ questions: [] } as never);
  getQueue.mockResolvedValue({ queue: [], steering: [], followUp: [] } as never);
  useMessagesStore.setState({ bySession: {} });
  useSessionsStore.setState({ selectedId: null });
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  useMessagesStore.setState({ bySession: {} });
  useSessionsStore.setState({ selectedId: null });
});

describe("增量校准撞 cursor_invalid 自动升级全量重取（t12）", () => {
  test("409 cursor_invalid → full=1 重取成功：无错误屏，store cursor 刷新（二次校准不再 409）", async () => {
    seedStaleSession();
    listMessages
      .mockRejectedValueOnce(new ApiError(409, "cursor_invalid", "游标失效"))
      .mockResolvedValueOnce(page([userEntry("e1"), userEntry("e2")], "fresh-cursor") as never);

    await mount();
    // 升级链：先带旧游标校准 → 409 → full=1 重取
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
    expect(listMessages.mock.calls[0][1]).toEqual({ cursor: "stale-cursor" });
    expect(listMessages.mock.calls[1][1]).toEqual({ full: true });
    await vi.waitFor(() => {
      const st = useMessagesStore.getState().bySession[SID];
      // stale_state 探针：setEntries 整替写入新 cursor，二次校准不会再用旧游标 409
      expect(st.cursor).toBe("fresh-cursor");
      expect(st.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
    });
    // misleading_success_output 探针：错误屏没有出现（happy-dom 虚拟列表不落条目文本，
    // 断言错误文案缺席 + 会话主面已脱离 loading/error 态容器文本）
    expect(container.textContent).not.toContain(ERROR_TEXT);
    expect(container.textContent).not.toContain("加载失败");
  });

  test("非 cursor_invalid（500）不升级，保持错误屏", async () => {
    seedStaleSession();
    listMessages.mockRejectedValue(new ApiError(500, "internal_error", "boom"));

    await mount();
    await vi.waitFor(() => expect(container.textContent).toContain(ERROR_TEXT));
    // 只发起校准请求，无 full=1 升级重取
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(listMessages.mock.calls[0][1]).toEqual({ cursor: "stale-cursor" });
    expect(useMessagesStore.getState().bySession[SID].cursor).toBe("stale-cursor");
  });
});

describe("增量异常顶替守卫（2026-11-11 循环防护卡独占会话修复）", () => {
  test("增量窗 4 条远少于槽内既有 200 条且无 hasMore 佐证 → 强制 full=1 全量整替（不 append）", async () => {
    // 槽内 200 条已加载；引擎重启重放场景：增量只带回 4 条防护条目
    const seeded = Array.from({ length: 200 }, (_, i) => userEntry(`e${i}`));
    useMessagesStore.getState().setEntries(SID, seeded as never, "old-cursor", "e199", {
      hasMore: false,
      oldestId: null,
    });
    const fullEntries = Array.from({ length: 216 }, (_, i) => userEntry(`f${i}`));
    listMessages
      .mockResolvedValueOnce(page([userEntry("g1"), userEntry("g2"), userEntry("g3"), userEntry("g4")], "replay-cursor") as never)
      .mockResolvedValueOnce(page(fullEntries, "full-cursor") as never);

    await mount();
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
    expect(listMessages.mock.calls[0][1]).toEqual({ cursor: "old-cursor" });
    expect(listMessages.mock.calls[1][1]).toEqual({ full: true });
    await vi.waitFor(() => {
      const st = useMessagesStore.getState().bySession[SID];
      // 全量整替：不是 200+4 的 append，也不是 4 条顶替，而是服务端真值 216 条
      expect(st.entries).toHaveLength(216);
      expect(st.entries[0].id).toBe("f0");
      expect(st.cursor).toBe("full-cursor");
      expect(st.loaded).toBe(true);
    });
  });

  test("增量带回条目但 cursor 未推进（leafId 不连续）→ 强制 full=1 全量整替", async () => {
    const seeded = Array.from({ length: 50 }, (_, i) => userEntry(`e${i}`));
    useMessagesStore.getState().setEntries(SID, seeded as never, "old-cursor", "e49", {
      hasMore: false,
      oldestId: null,
    });
    const fullEntries = Array.from({ length: 60 }, (_, i) => userEntry(`f${i}`));
    listMessages
      .mockResolvedValueOnce(page([userEntry("g1")], "old-cursor") as never)
      .mockResolvedValueOnce(page(fullEntries, "full-cursor") as never);

    await mount();
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
    expect(listMessages.mock.calls[1][1]).toEqual({ full: true });
    await vi.waitFor(() => {
      const st = useMessagesStore.getState().bySession[SID];
      expect(st.entries).toHaveLength(60);
      expect(st.cursor).toBe("full-cursor");
    });
  });

  test("正常增量（新增条目数不少于既有 / 有 hasMore 佐证）不触发全量重拉", async () => {
    // 小槽场景：增量带回条目数 >= 既有数，走常规 append
    const seeded = Array.from({ length: 2 }, (_, i) => userEntry(`e${i}`));
    useMessagesStore.getState().setEntries(SID, seeded as never, "old-cursor", "e1", {
      hasMore: false,
      oldestId: null,
    });
    listMessages
      .mockResolvedValueOnce(
        page([userEntry("n1"), userEntry("n2")], "new-cursor") as never,
      );

    await mount();
    await vi.waitFor(() => {
      const st = useMessagesStore.getState().bySession[SID];
      expect(st.entries.map((e) => e.id)).toEqual(["e0", "e1", "n1", "n2"]);
      expect(st.cursor).toBe("new-cursor");
    });
    expect(listMessages).toHaveBeenCalledTimes(1);
  });
});
