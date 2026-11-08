// 首屏流量直做批（台账 2026-11-08 #35）：模型归因回读改轻量端点
// - backfillModelTimeline 触发条件不变（loaded + 未落闸 + 尾窗无 model_change + hasMore）
// - 注入面从 fetchPage({full:true}) 改为 fetchChanges()（服务端 /model-changes 磁盘
//   精筛只回 model_change 条目，取代 full=1 全量拉取）
// - 归因表只收窄化变更点 / 生效模型水合 / 不触发路径 / 失败落闸静默降级 / 闸幂等
// @ts-nocheck
import { describe, expect, test, beforeEach, vi } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");

function entry(id: string) {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}
function mc(id: string, modelId = "glm") {
  return { type: "model_change", id, provider: "p", modelId };
}
const SID = "bf-1";

function seedTail(hasMore = true, withMc = false) {
  const tail = withMc ? [entry("w-1"), mc("w-mc"), entry("w-2")] : [entry("w-1"), entry("w-2")];
  useMessagesStore.getState().setEntries(SID, tail, "w-2", "w-2", {
    hasMore,
    oldestId: tail[0].id,
  });
}

beforeEach(() => {
  useMessagesStore.setState({ bySession: {} });
  useSessionsStore.setState({ appliedModels: {}, selectedId: null });
});

describe("backfillModelTimeline 轻量回读", () => {
  test("尾窗无 model_change 且 hasMore：取数一次入归因表（窄化+窗口外），水合生效模型", async () => {
    seedTail();
    const fetchChanges = vi.fn(async () => [mc("m-1", "glm-4"), entry("x-1"), mc("m-2", "glm-5")]);
    await useMessagesStore.getState().backfillModelTimeline(SID, fetchChanges);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    const st = useMessagesStore.getState().bySession[SID];
    expect(st.modelBackfill.map((e) => e.id)).toEqual(["m-1", "m-2"]);
    expect(st.modelBackfillDone).toBe(true);
    expect(useSessionsStore.getState().appliedModels[SID]).toBe("p/glm-5");
  });

  test("尾窗已含变更点（时间线自足）：不取数直接落闸", async () => {
    seedTail(true, true);
    const fetchChanges = vi.fn(async () => [mc("m-1")]);
    await useMessagesStore.getState().backfillModelTimeline(SID, fetchChanges);
    expect(fetchChanges).not.toHaveBeenCalled();
    expect(useMessagesStore.getState().bySession[SID].modelBackfillDone).toBe(true);
  });

  test("hasMore=false（短会话全量在窗）：不取数直接落闸", async () => {
    seedTail(false);
    const fetchChanges = vi.fn(async () => [mc("m-1")]);
    await useMessagesStore.getState().backfillModelTimeline(SID, fetchChanges);
    expect(fetchChanges).not.toHaveBeenCalled();
    expect(useMessagesStore.getState().bySession[SID].modelBackfillDone).toBe(true);
  });

  test("取数失败：静默落闸不抛错（归因是软增强）", async () => {
    seedTail();
    const fetchChanges = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      useMessagesStore.getState().backfillModelTimeline(SID, fetchChanges),
    ).resolves.toBeUndefined();
    const st = useMessagesStore.getState().bySession[SID];
    expect(st.modelBackfill).toEqual([]);
    expect(st.modelBackfillDone).toBe(true);
  });

  test("落闸幂等：二次调用不再取数", async () => {
    seedTail();
    const fetchChanges = vi.fn(async () => [mc("m-1")]);
    await useMessagesStore.getState().backfillModelTimeline(SID, fetchChanges);
    await useMessagesStore.getState().backfillModelTimeline(SID, fetchChanges);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
  });
});
