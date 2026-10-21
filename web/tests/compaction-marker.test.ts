/**
 * 压缩摘要标记（docs08-r6 任务 18 ③）单测：compactionMarkerOf 派生
 * （summary 首行/截断/details 判空降级）、mergeMemoryItems 流内归并、
 * CompactionMarkerBlock 渲染（常显文案 + 展开 details JSON）。
 * 条目样例取自 task-3 会话库全量枚举实证
 * （.omo/evidence/docs08-r6/task-3-enumeration.md §三，条目 id e3be398e 形态）：
 * 顶层 type:"compaction" 3/3 键集一致，summary 恒为字符串、details 为
 * senpi.compaction.summary.v1 同构；同族 custom_message
 * compaction.post-compact-restoration 的 details 仅 1/3 存在——引用判空是铁律。
 */
import { afterEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WireEntry } from "@/lib/api";
import { compactionMarkerOf, mergeMemoryItems, type ChatListItem } from "@/components/chat/message-items";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { CompactionMarkerBlock } = await import("@/components/chat/message-list");

/** task-3 枚举实证形态（e3be398e，键集 3/3 一致的代表样本） */
function compactionEntry(overrides: Record<string, unknown> = {}): WireEntry {
  return {
    type: "compaction",
    id: "e3be398e",
    parentId: "25e8885f",
    timestamp: "2026-10-12T05:16:05.655Z",
    summary: "会话前段压缩摘要：用户搭建 senpi-webui 压缩链路。\n第二行补充细节。",
    firstKeptEntryId: "entry-42",
    tokensBefore: 32881,
    details: {
      schema: "senpi.compaction.summary.v1",
      promptVariant: "turn_prefix",
      tokenEstimate: 9120,
      structuralYield: { savedTokens: 23761, savingsRatio: 0.72, tokensBefore: 32881 },
      origin: "core-route",
    },
    fromHook: true,
    ...overrides,
  };
}

/** task-3 枚举：restoration 的 details 仅 1/3 存在——缺失变体（b8277426 形态） */
function restorationEntryNoDetails(): WireEntry {
  return {
    type: "custom_message",
    id: "b8277426",
    customType: "compaction.post-compact-restoration",
    content: "压缩后恢复上下文",
    display: false,
  };
}

function messageEntry(id: string, role: "user" | "assistant"): WireEntry {
  return { type: "message", id, message: { role, content: [{ type: "text", text: `${role} ${id}` }] } };
}

describe("compactionMarkerOf 派生（③）", () => {
  test("task-3 实证形态：首行派生、tokensBefore 透传、details JSON 并入展开原文", () => {
    const m = compactionMarkerOf(compactionEntry());
    expect(m).not.toBeNull();
    expect(m!.entryId).toBe("e3be398e");
    expect(m!.summaryFirstLine).toBe("会话前段压缩摘要：用户搭建 senpi-webui 压缩链路。");
    expect(m!.tokensBefore).toBe(32881);
    expect(m!.detail).toContain("第二行补充细节。");
    expect(m!.detail).toContain('"senpi.compaction.summary.v1"');
  });

  test("summary 首行为空行时取首个非空行；超长截断加省略号", () => {
    const long = "很".repeat(100);
    const m = compactionMarkerOf(compactionEntry({ summary: `\n\n${long}\n尾行` }));
    expect(m!.summaryFirstLine).toBe(`${"很".repeat(80)}…`);
    expect(m!.detail).toContain("尾行");
  });

  test("summary_null_crash 防线：summary/details/tokensBefore 全缺（形态从宽）不崩且降级", () => {
    const m = compactionMarkerOf(compactionEntry({ summary: undefined, details: undefined, tokensBefore: undefined }));
    expect(m).not.toBeNull();
    expect(m!.summaryFirstLine).toBe("");
    expect(m!.tokensBefore).toBeNull();
    expect(m!.detail).toBe("");
  });

  test("details 为 null（restoration 同族 1/3 缺失形态引申）不追加 JSON", () => {
    const m = compactionMarkerOf(compactionEntry({ details: null }));
    expect(m!.detail).not.toContain("{");
  });

  test("非 compaction 类型 / 无 id 不派生", () => {
    expect(compactionMarkerOf(messageEntry("m1", "user"))).toBeNull();
    expect(compactionMarkerOf({ ...compactionEntry(), id: undefined })).toBeNull();
    expect(compactionMarkerOf({ ...compactionEntry(), id: "" })).toBeNull();
    // restoration 类 custom_message（display:false、details 缺失）不是压缩摘要条目，不派生不崩
    expect(compactionMarkerOf(restorationEntryNoDetails())).toBeNull();
  });
});

describe("mergeMemoryItems 归并（③）", () => {
  test("压缩 marker 插在 compaction 条目自身的流内位置之后", () => {
    const entries = [messageEntry("u1", "user"), compactionEntry(), messageEntry("a1", "assistant")];
    const items: ChatListItem[] = [
      { key: "u1", kind: "entry", entryId: "u1", interrupted: false },
      { key: "a1", kind: "entry", entryId: "a1", interrupted: false },
    ];
    const merged = mergeMemoryItems(items, entries);
    expect(merged.map((i) => i.key)).toEqual(["u1", "compaction-e3be398e", "a1"]);
    expect(merged[1].kind).toBe("compactionMarker");
  });

  test("无 compaction 条目时原样返回（引用不变，订阅方不重算）", () => {
    const entries = [messageEntry("u1", "user"), restorationEntryNoDetails()];
    const items: ChatListItem[] = [{ key: "u1", kind: "entry", entryId: "u1", interrupted: false }];
    expect(mergeMemoryItems(items, entries)).toBe(items);
  });

  test("restoration 类 custom_message 混入不产生任何 marker（判空路径不崩）", () => {
    const entries = [restorationEntryNoDetails(), compactionEntry({ id: "m2" })];
    const items: ChatListItem[] = [];
    const merged = mergeMemoryItems(items, entries);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe("compactionMarker");
  });
});

describe("CompactionMarkerBlock 渲染（③）", () => {
  let mounted: { unmount(): void } | null = null;

  afterEach(async () => {
    const root = mounted;
    mounted = null;
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    document.body.innerHTML = "";
  });

  async function mountBlock(marker: NonNullable<ReturnType<typeof compactionMarkerOf>>): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CompactionMarkerBlock, { marker }));
    });
    mounted = root;
    return container;
  }

  test("常显「上下文已压缩：〈摘要首行〉」，details 折叠不渲染", async () => {
    const container = await mountBlock(compactionMarkerOf(compactionEntry())!);
    const block = container.querySelector('[data-testid="compaction-marker"]');
    expect(block).not.toBeNull();
    expect(block!.textContent).toContain("上下文已压缩：会话前段压缩摘要：用户搭建 senpi-webui 压缩链路。");
    expect(block!.textContent).not.toContain("senpi.compaction.summary.v1");
  });

  test("点击展开：summary 全文与 details JSON 可见", async () => {
    const container = await mountBlock(compactionMarkerOf(compactionEntry())!);
    const btn = container.querySelector("button")!;
    await act(async () => {
      btn.click();
    });
    const block = container.querySelector('[data-testid="compaction-marker"]')!;
    expect(block.textContent).toContain("第二行补充细节。");
    expect(block.textContent).toContain("senpi.compaction.summary.v1");
  });

  test("details 缺失但 summary 存在：展开仅 summary 全文，无 JSON 段", async () => {
    const container = await mountBlock(
      compactionMarkerOf(compactionEntry({ details: undefined, summary: "只有一行摘要" }))!,
    );
    const block = container.querySelector('[data-testid="compaction-marker"]')!;
    expect(block.textContent).toContain("上下文已压缩：只有一行摘要");
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(block.textContent).toContain("只有一行摘要");
    expect(block.textContent).not.toContain("{");
  });

  test("summary/details 双缺（形态从宽极限）：无展开箭头、点击不渲染空面板", async () => {
    const container = await mountBlock(compactionMarkerOf(compactionEntry({ summary: undefined, details: undefined }))!);
    const block = container.querySelector('[data-testid="compaction-marker"]')!;
    expect(block.textContent).toContain("上下文已压缩：");
    expect(container.querySelector("button")!.querySelector("svg.lucide-chevron-down")).toBeNull();
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(container.querySelectorAll("button")).toHaveLength(1); // 无展开面板渲染
  });
});
