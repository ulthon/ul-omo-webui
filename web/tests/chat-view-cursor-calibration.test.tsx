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

describe("增量对账守卫（2026-11-11 立，2026-11-25 收窄为仅游标未推进）", () => {
  test("增量窗 4 条远少于槽内既有 200 条（带新消息的正常切回补漏）→ 按 id 合并，不整份重拉", async () => {
    // 槽内 200 条已加载；离开期间会话新增 4 条，切回补漏只带回这 4 条——增量条数与
    // 槽内总数无关，旧判定（条数变少即异常）把每次带新消息的切回都升级成整份重拉
    const seeded = Array.from({ length: 200 }, (_, i) => userEntry(`e${i}`));
    useMessagesStore.getState().setEntries(SID, seeded as never, "old-cursor", "e199", {
      hasMore: false,
      oldestId: null,
    });
    listMessages.mockResolvedValueOnce(
      page([userEntry("g1"), userEntry("g2"), userEntry("g3"), userEntry("g4")], "new-cursor") as never,
    );

    await mount();
    await vi.waitFor(() => {
      const st = useMessagesStore.getState().bySession[SID];
      expect(st.entries.map((e) => e.id).slice(-4)).toEqual(["g1", "g2", "g3", "g4"]);
      expect(st.cursor).toBe("new-cursor");
    });
    // 只发一次带游标的补漏请求，没有 full=1；既有 200 条原样保留
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(listMessages.mock.calls[0][1]).toEqual({ cursor: "old-cursor" });
    const st = useMessagesStore.getState().bySession[SID];
    expect(st.entries).toHaveLength(204);
    expect(st.entries[0].id).toBe("e0");
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

  test("正常增量（游标推进）不触发全量重拉", async () => {
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

describe("实时入列推进游标（2026-11-25 切回整份重拉修复）", () => {
  function liveMessage(id: string, parentId: string): Record<string, unknown> {
    return {
      type: "entry_appended",
      entry: { type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text: `msg ${id}` }] } },
    };
  }

  test("推送入列推叶时游标同步到新叶；离径条目与幂等回填叶未动，游标不动", () => {
    useMessagesStore.getState().setEntries(SID, [userEntry("e0"), userEntry("e1"), userEntry("e2")] as never, "e2", "e2", {
      hasMore: false,
      oldestId: null,
    });
    const apply = (ev: Record<string, unknown>) => useMessagesStore.getState().applyWireEvent(SID, ev as never);
    apply(liveMessage("e3", "e2"));
    apply(liveMessage("e4", "e3"));
    let st = useMessagesStore.getState().bySession[SID];
    expect(st.leafId).toBe("e4");
    expect(st.cursor).toBe("e4");
    // 离径条目（他端分支/重放）：父不是当前叶，叶与游标都不动
    apply(liveMessage("x1", "e0"));
    // 幂等回填：已在列的条目重放，叶与游标都不动
    apply(liveMessage("e2", "e1"));
    st = useMessagesStore.getState().bySession[SID];
    expect(st.leafId).toBe("e4");
    expect(st.cursor).toBe("e4");
  });

  test("首载后推送 3 条再切回：补漏请求带最新游标、回 0 条、不发 full=1", async () => {
    useMessagesStore.getState().setEntries(SID, [userEntry("e0"), userEntry("e1"), userEntry("e2")] as never, "e2", "e2", {
      hasMore: false,
      oldestId: null,
    });
    const apply = (ev: Record<string, unknown>) => useMessagesStore.getState().applyWireEvent(SID, ev as never);
    apply(liveMessage("e3", "e2"));
    apply(liveMessage("e4", "e3"));
    apply(liveMessage("e5", "e4"));
    // 切回补漏：游标已是最新，服务端游标之后 0 条
    listMessages.mockResolvedValueOnce(page([], "e5") as never);

    await mount();
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(1));
    expect(listMessages.mock.calls[0][1]).toEqual({ cursor: "e5" });
    await vi.waitFor(() => {
      const st = useMessagesStore.getState().bySession[SID];
      expect(st.entries.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3", "e4", "e5"]);
      expect(st.cursor).toBe("e5");
      expect(st.loaded).toBe(true);
    });
    expect(listMessages).toHaveBeenCalledTimes(1);
  });
});
