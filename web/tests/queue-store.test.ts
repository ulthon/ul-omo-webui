// 排队 store 单测（docs08-r4 任务 11，spike 口径）：
// - addPending 乐观占位（无序号）→ applyUpdate 按 enqueueOrder/文本匹配转正式项并保留 enqueuedAt
// - 同 enqueueOrder 保留本地 enqueuedAt；出队宣布（ordered:[]）清空
// - setSnapshot 对账（steering 在前 + followUp，无序号）；clearSession 清槽
import { beforeEach, describe, expect, test } from "bun:test";
import { useQueueStore } from "@/stores/queue";

function reset(): void {
  useQueueStore.setState({ bySession: {} });
}

describe("queue store（排队列表真相维护）", () => {
  beforeEach(reset);

  test("addPending：本端乐观占位（无序号），queue_update 确认后转正式项并保留 enqueuedAt", () => {
    useQueueStore.getState().addPending("s1", "排队一", "followUp");
    let items = useQueueStore.getState().bySession["s1"].items;
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ text: "排队一", mode: "followUp", enqueueOrder: null });
    const enqueuedAt = items[0].enqueuedAt;

    // queue_update 确认：无序号占位按 text+mode 贪心匹配，enqueuedAt 保留
    useQueueStore.getState().applyUpdate("s1", [{ text: "排队一", mode: "followUp", enqueueOrder: 7 }]);
    items = useQueueStore.getState().bySession["s1"].items;
    expect(items.length).toBe(1);
    expect(items[0]).toEqual({ text: "排队一", mode: "followUp", enqueueOrder: 7, enqueuedAt });
  });

  test("addPending 近窗口去重：enqueue 帧先于回执到达时不再重复占位（QA 实测竞态）", () => {
    // 引擎 enqueue 帧先落 store（SSE 推送快于 HTTP 回执）
    useQueueStore.getState().applyUpdate("s1", [{ text: "同文", mode: "followUp", enqueueOrder: 3 }]);
    // 回执后 addPending：5s 窗口内同文同档已存在 → 不重复
    useQueueStore.getState().addPending("s1", "同文", "followUp");
    expect(useQueueStore.getState().bySession["s1"].items.length).toBe(1);

    // 窗口外（enqueuedAt 拨旧 6s）同文双条排队（引擎不去重）正常各占一条
    const slot = useQueueStore.getState().bySession["s1"];
    useQueueStore.setState({
      bySession: { s1: { items: [{ ...slot.items[0], enqueuedAt: Date.now() - 6000 }] } },
    });
    useQueueStore.getState().addPending("s1", "同文", "followUp");
    expect(useQueueStore.getState().bySession["s1"].items.length).toBe(2);
  });

  test("同 enqueueOrder 保留 enqueuedAt；出队宣布（ordered:[]）清空列表", () => {
    useQueueStore.getState().applyUpdate("s1", [
      { text: "甲", mode: "followUp", enqueueOrder: 3 },
      { text: "乙", mode: "steer", enqueueOrder: 4 },
    ]);
    const first = useQueueStore.getState().bySession["s1"].items[0].enqueuedAt;

    // 增量对账（残余乙）：甲的 enqueuedAt 不复存在（已出队），乙保留
    useQueueStore.getState().applyUpdate("s1", [{ text: "乙", mode: "steer", enqueueOrder: 4 }]);
    let items = useQueueStore.getState().bySession["s1"].items;
    expect(items.map((i) => i.text)).toEqual(["乙"]);

    // 出队宣布：清空
    useQueueStore.getState().applyUpdate("s1", []);
    items = useQueueStore.getState().bySession["s1"].items;
    expect(items.length).toBe(0);
    expect(first).toBeGreaterThan(0);
  });

  test("setSnapshot：steering 在前 followUp 在后（执行序），无序号项为 null", () => {
    useQueueStore.getState().setSnapshot("s1", { steering: ["插入项"], followUp: ["跟答一", "跟答二"] });
    const items = useQueueStore.getState().bySession["s1"].items;
    expect(items.map((i) => [i.text, i.mode, i.enqueueOrder])).toEqual([
      ["插入项", "steer", null],
      ["跟答一", "followUp", null],
      ["跟答二", "followUp", null],
    ]);
  });

  test("同文本双条排队不坍缩（spike (b)-7：引擎不去重）", () => {
    useQueueStore.getState().applyUpdate("s1", [
      { text: "同文本", mode: "followUp", enqueueOrder: 5 },
      { text: "同文本", mode: "followUp", enqueueOrder: 6 },
    ]);
    const items = useQueueStore.getState().bySession["s1"].items;
    expect(items.length).toBe(2);
    expect(items.map((i) => i.enqueueOrder)).toEqual([5, 6]);
  });

  test("clearSession：清槽；未涉及会话不受影响", () => {
    useQueueStore.getState().addPending("s1", "x", "followUp");
    useQueueStore.getState().addPending("s2", "y", "steer");
    useQueueStore.getState().clearSession("s1");
    expect(useQueueStore.getState().bySession["s1"]).toBeUndefined();
    expect(useQueueStore.getState().bySession["s2"].items.length).toBe(1);
  });
});
