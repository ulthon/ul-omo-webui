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
  getQueue.mockResolvedValue({ queue: [] } as never);
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
