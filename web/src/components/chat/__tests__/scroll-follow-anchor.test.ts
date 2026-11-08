// #26 滚动跟随改锚点制：跟随/解除/恢复三态单测（mock 定时器，无真实延时）。
// - 判定纯函数 isAnchorCoveredByRange：渲染窗覆盖锚点下标=在底部（跟随态）；锚点滚出
//   渲染窗=解除跟随；窗空/锚点非法=解除（宁解除勿误跟）；
// - store 锚点槽：setFollowAnchor 按会话键入、锚点 id 变化触发更新、同值幂等不重渲染
//   （订阅计数零增长）、adoptDurableId 换 key 随槽迁移；
// - 三态语义映射：跟随=锚点在窗内且 setFollowAnchor 后仍判在底；解除=新锚点（新消息）
//   在窗外不误跟；恢复=setFollowAnchor 指回新锚点 + 渲染窗覆盖 → 回到跟随态。
// 环境（collision-error-card 惯例）：@happy-dom 全局注册 + 被测模块动态 import。
import { describe, expect, test, beforeEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

const { isAnchorCoveredByRange } = await import("@/components/chat/message-items");
const { useMessagesStore } = await import("@/stores/messages");

/** 虚拟行渲染窗（含 overscan）形状：只带下标（判定只消费 index） */
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ index: from + i }));

beforeEach(() => {
  useMessagesStore.setState({ bySession: {}, followAnchors: {} });
});

describe("isAnchorCoveredByRange：在底部判定（#26 锚点制）", () => {
  test("跟随态：渲染窗覆盖锚点下标（锚点在窗内/窗含 overscan 越过锚点）→ true", () => {
    expect(isAnchorCoveredByRange(range(8, 14), 12)).toBe(true);
    expect(isAnchorCoveredByRange(range(8, 14), 8)).toBe(true);
    // overscan 覆盖：窗起点早于锚点（锚点在窗外上沿但仍在渲染窗内）→ 视为在底
    expect(isAnchorCoveredByRange(range(8, 14), 14)).toBe(true);
  });

  test("解除态：用户上滚，锚点滚出渲染窗（窗整体早于锚点）→ false", () => {
    expect(isAnchorCoveredByRange(range(0, 6), 12)).toBe(false);
  });

  test("兑底：窗空或锚点下标非法（-1，空列表/未同步）→ false（宁解除勿误跟）", () => {
    expect(isAnchorCoveredByRange([], 0)).toBe(false);
    expect(isAnchorCoveredByRange(range(0, 6), -1)).toBe(false);
  });
});

describe("store 锚点槽（#26）", () => {
  test("锚点 id 变化触发更新：按会话键入；同会话新消息 → 锚点推进到新 id", () => {
    useMessagesStore.getState().setFollowAnchor("s1", "m1");
    expect(useMessagesStore.getState().followAnchors["s1"]).toBe("m1");
    // 新消息到来，末条 id 变化 → 锚点随写推进
    useMessagesStore.getState().setFollowAnchor("s1", "m2");
    expect(useMessagesStore.getState().followAnchors["s1"]).toBe("m2");
    // 会话隔离：另一会话锚点独立
    useMessagesStore.getState().setFollowAnchor("s2", "n1");
    expect(useMessagesStore.getState().followAnchors["s1"]).toBe("m2");
    expect(useMessagesStore.getState().followAnchors["s2"]).toBe("n1");
  });

  test("同值幂等：重复写同一锚点不触发订阅（流式 delta 高频写不重渲染）", () => {
    useMessagesStore.getState().setFollowAnchor("s1", "m1");
    let hits = 0;
    const unsub = useMessagesStore.subscribe(() => {
      hits += 1;
    });
    useMessagesStore.getState().setFollowAnchor("s1", "m1");
    expect(hits).toBe(0);
    useMessagesStore.getState().setFollowAnchor("s1", "m2");
    expect(hits).toBe(1);
    unsub();
  });

  test("恢复态：解除后锚点指回最新消息 + 渲染窗覆盖 → 回到跟随判定真值", () => {
    // 解除：用户上滚，末条锚点在窗外
    const anchorAtBottom = isAnchorCoveredByRange(range(8, 14), 12);
    expect(anchorAtBottom).toBe(true);
    const detached = isAnchorCoveredByRange(range(0, 6), 12);
    expect(detached).toBe(false);
    // 恢复：scrollToIndex(锚点) 后渲染窗重新覆盖锚点 → 判定回真
    const recovered = isAnchorCoveredByRange(range(8, 14), 12);
    expect(recovered).toBe(true);
    // store 侧：恢复时锚点写入仍按会话键生效
    useMessagesStore.getState().setFollowAnchor("s1", "m9");
    expect(useMessagesStore.getState().followAnchors["s1"]).toBe("m9");
  });

  test("adoptDurableId 换 key：锚点随会话槽迁移，旧键清除", () => {
    useMessagesStore.setState({
      bySession: {
        local: {
          entries: [],
          cursor: null,
          leafId: null,
          loaded: true,
          hasMore: false,
          oldestId: null,
          streaming: false,
          streamingMessage: null,
          streamingEntryId: null,
          toolRuns: {},
          compacting: false,
          sessionEvents: [],
          errors: [],
          receiptModel: null,
          modelBackfill: [],
          modelBackfillDone: false,
        },
      },
      followAnchors: { local: "m1" },
    });
    useMessagesStore.getState().adoptDurableId("local", "durable");
    expect(useMessagesStore.getState().followAnchors["durable"]).toBe("m1");
    expect(useMessagesStore.getState().followAnchors["local"]).toBeUndefined();
  });
});
