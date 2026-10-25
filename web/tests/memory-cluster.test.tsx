// acceptedTurns 同簇聚合（docs08 2026-10-23/24 批次任务 14）单测：
// - 纯函数（mergeMemoryItems）：连续 acceptedTurns 折叠为一组「×N」（key 锚定首条
//   entryId，追加新事件 key 不变）；异类标记（sessionBinding）或消息条目隔开即分簇，
//   绝不跨语义合并；单条不折叠（保持 memoryMarker 原形态原 key）；事件零删除
//   （markers 全量携带，折叠仅呈现层）。
// - 渲染分支（AcceptedTurnsClusterBlock）：折叠态一行 ×N 角标、点击展开逐条
//  （复用 MemoryMarkerBlock）、再点收回；stale_state——新事件并入既有簇（key 不变）
//   重渲染展开态不丢。
// - 词条：zh/en 双档 acceptedTurnsCount 插值。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// bun/vitest 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");

import { mergeMemoryItems, type ChatListItem } from "@/components/chat/message-items";
import { AcceptedTurnsClusterBlock } from "@/components/chat/message-list";
import { useLocaleStore } from "@/i18n/i18n";

// ---------------------------------------------------------------- fixture

/** acceptedTurns custom 条目（spike 实拍形态：type:"custom" + omo-memory:accepted-turns） */
function at(id: string, data: Record<string, unknown> = {}) {
  return { type: "custom", id, customType: "omo-memory:accepted-turns", data };
}

/** sessionBinding custom 条目 */
function sb(id: string, identity: string) {
  return { type: "custom", id, customType: "senpi-memory.session-binding", data: { identity } };
}

/** 消息条目（可见行，打断聚合） */
function msg(id: string, role: string) {
  return { type: "message", id, message: { role, content: [{ type: "text", text: "x" }] } };
}

function entryItem(id: string): ChatListItem {
  return { key: id, kind: "entry", entryId: id, interrupted: false, model: null };
}

/** 摘要行：[kind, key/entryId, count?] */
function rows(items: ChatListItem[]): Array<[string, string, number]> {
  return items.map((i) => {
    if (i.kind === "memoryMarkerCluster") return [i.kind, i.markers[0]!.entryId, i.markers.length];
    if (i.kind === "memoryMarker") return [i.kind, i.marker.entryId, 1];
    if (i.kind === "entry") return [i.kind, i.entryId, 0];
    return [i.kind, i.key, 0];
  });
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "zh-CN" });
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------- 纯函数：聚合

describe("mergeMemoryItems acceptedTurns 同簇聚合", () => {
  test("3 连排 acceptedTurns 折叠为一组 ×3（key 锚定首条，markers 保序全量）", () => {
    const merged = mergeMemoryItems([], [at("t1"), at("t2"), at("t3")]);
    expect(rows(merged)).toEqual([["memoryMarkerCluster", "t1", 3]]);
    const cluster = merged[0];
    expect(cluster?.kind === "memoryMarkerCluster" && cluster.markers.map((m) => m.entryId)).toEqual(["t1", "t2", "t3"]);
    expect(merged[0]?.key).toBe("memory-cluster-t1");
  });

  test("异类标记隔开即分簇：acceptedTurns×2 + sessionBinding + acceptedTurns → 两簇不跨语义合并", () => {
    const merged = mergeMemoryItems([], [at("t1"), at("t2"), sb("b1", "lib-1"), at("t3")]);
    expect(rows(merged)).toEqual([
      ["memoryMarkerCluster", "t1", 2],
      ["memoryMarker", "b1", 1],
      ["memoryMarker", "t3", 1],
    ]);
  });

  test("可见消息行打断聚合：两簇各自独立", () => {
    const merged = mergeMemoryItems([entryItem("m1")], [at("t1"), at("t2"), msg("m1", "assistant"), at("t3"), at("t4")]);
    expect(rows(merged)).toEqual([
      ["memoryMarkerCluster", "t1", 2],
      ["entry", "m1", 0],
      ["memoryMarkerCluster", "t3", 2],
    ]);
  });

  test("不产生可见行的条目（toolResult）不打断视觉连排", () => {
    const merged = mergeMemoryItems([entryItem("m1")], [
      at("t1"),
      msg("r1", "toolResult"),
      at("t2"),
      msg("m1", "assistant"),
    ]);
    expect(rows(merged)).toEqual([["memoryMarkerCluster", "t1", 2], ["entry", "m1", 0]]);
  });

  test("单条 acceptedTurns 不折叠：memoryMarker 原形态原 key（渲染与聚合前一致）", () => {
    const merged = mergeMemoryItems([], [at("t1")]);
    expect(rows(merged)).toEqual([["memoryMarker", "t1", 1]]);
    expect(merged[0]?.key).toBe("memory-t1");
  });

  test("无标记时原样返回（引用不变）；sessionBinding 去重先于聚合", () => {
    const items: ChatListItem[] = [entryItem("m1")];
    expect(mergeMemoryItems(items, [msg("m1", "assistant")])).toBe(items);
    const merged = mergeMemoryItems([], [sb("b1", "lib-1"), sb("b2", "lib-1"), at("t1")]);
    expect(rows(merged)).toEqual([["memoryMarker", "b1", 1], ["memoryMarker", "t1", 1]]);
  });

  test("stale_state：新 acceptedTurns 追加进既有簇 → key 不变（组件实例复用，展开态可存活）", () => {
    const before = mergeMemoryItems([], [at("t1"), at("t2")]);
    const after = mergeMemoryItems([], [at("t1"), at("t2"), at("t3")]);
    expect(before[0]?.key).toBe(after[0]?.key);
    expect(rows(after)).toEqual([["memoryMarkerCluster", "t1", 3]]);
  });
});

// ---------------------------------------------------------------- 渲染分支

describe("AcceptedTurnsClusterBlock 渲染", () => {
  function markersOf(ids: string[]) {
    return mergeMemoryItems([], ids.map((id) => at(id))).flatMap((i) =>
      i.kind === "memoryMarkerCluster" ? i.markers : [],
    );
  }

  test("折叠态一行 ×N；点击展开逐条；再点收回", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const markers = markersOf(["t1", "t2", "t3"]);
    await act(async () => {
      root.render(createElement(AcceptedTurnsClusterBlock, { markers }));
    });
    const block = host.firstElementChild as HTMLElement;
    expect(block.dataset.count).toBe("3");
    expect(block.textContent).toContain("本轮已计入记忆 ×3");
    expect(block.textContent).toContain("×3");
    // 折叠态：无逐条行
    expect(block.querySelectorAll('[data-testid="memory-marker"]').length).toBe(0);
    // 展开：3 条逐行可见（每条各自「本轮已计入记忆」）
    await act(async () => {
      (block.querySelector("button") as HTMLButtonElement).click();
    });
    expect(block.querySelectorAll('[data-testid="memory-marker"]').length).toBe(3);
    expect(block.textContent).toContain("本轮已计入记忆 ×3");
    // 收回
    await act(async () => {
      (block.querySelector("button") as HTMLButtonElement).click();
    });
    expect(block.querySelectorAll('[data-testid="memory-marker"]').length).toBe(0);
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  test("stale_state：簇尾追加新事件（key 不变）重渲染后展开态存活", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const m3 = markersOf(["t1", "t2", "t3"]);
    await act(async () => {
      root.render(createElement(AcceptedTurnsClusterBlock, { markers: m3 }));
    });
    const block = host.firstElementChild as HTMLElement;
    await act(async () => {
      (block.querySelector("button") as HTMLButtonElement).click();
    });
    expect(block.querySelectorAll('[data-testid="memory-marker"]').length).toBe(3);
    // 新事件并入同簇（mergeMemoryItems 保证 key 不变 → 同一组件实例）
    const m4 = markersOf(["t1", "t2", "t3", "t4"]);
    await act(async () => {
      root.render(createElement(AcceptedTurnsClusterBlock, { markers: m4 }));
    });
    expect(block.dataset.count).toBe("4");
    expect(block.querySelectorAll('[data-testid="memory-marker"]').length).toBe(4); // 仍展开
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  test("词条：zh/en 双档 acceptedTurnsCount 插值", async () => {
    const { t } = await import("@/i18n/i18n");
    useLocaleStore.setState({ locale: "zh-CN" });
    expect(t("chat.memoryMarkers.acceptedTurnsCount", { count: 3 })).toBe("本轮已计入记忆 ×3");
    useLocaleStore.setState({ locale: "en" });
    expect(t("chat.memoryMarkers.acceptedTurnsCount", { count: 3 })).toBe("Counted into memory this turn ×3");
    useLocaleStore.setState({ locale: "zh-CN" });
  });
});
