// 落地滚动补偿（webui-refetch-storm 任务 3，GAP-3/4）：换代检测（store swapSeq 信号
// 优先、items 长度差后备）与补偿链（落地前快照首个可见 virtualItem 的 key 与内容位、
// 落地后 rAF 内 scrollToIndex(align:start) 再补偏移差）。
// - happy：非跟随态投影互换（300 窗 → 3000 全量）→ swap_compensate 恰 1 次（目标 key、
//   下标、偏移差正确），scrollToIndex(index, align:start) 同步落位后偏移补滚到真实终位；
// - 后备启发端到端：store 信号缺席 + 大长度差 → 补偿照常，终位同 happy；
// - failure：跟随态整替走既有锚底路径（visibilitychange 回底 to_anchor 增长、
//   scrollToIndex align:end），零补偿（零 align:start / 零 swap_compensate）；普通小
//   增量 append 零触发；快照 key 在新投影缺席 → 放弃补偿（零滚动）。
// 环境同 session-open-locate：@happy-dom 全局注册 + 被测模块动态 import + createRoot/act
// 渲染 MessageList，行为经 diag 埋点与 spy 断言。@tanstack/react-virtual 用透传 mock
// （行为不变，仅登记 virtualizer 实例）：happy-dom 无布局、真实虚拟窗恒空，换代视口
// 快照经实例 getVirtualItems spy 注入 fixture（下标/start 与估算行高几何一致）；快照、
// 检测、补偿逻辑全为真实代码。scrollToIndex spy 携同步滚动副作用（virtual-core 3.19.11
// 同步 elementScroll 语义：behavior "auto" 即刻写 el.scrollTop = item.start），使补偿
// 二段读取真实落地后坐标系、终位断言不镜像实现公式。不以 scrollTop 数值断言布局
// （happy-dom 无布局）；假定时器仅 fake setTimeout/clearTimeout（100ms 补滚句柄），
// rAF 走 happy-dom setImmediate 通道，Date.now 保持真实（程序滚动护栏窗计时语义不变）。
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  const g = globalThis as { __vtRegistry?: unknown[] };
  g.__vtRegistry = [];
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => {
      const inst = actual.useVirtualizer(options);
      g.__vtRegistry!.push(inst);
      return inst;
    },
  };
});

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

window.matchMedia = ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MessageList } = await import("@/components/chat/message-list");
const { detectProjectionSwap, SWAP_LENGTH_DIFF_THRESHOLD } = await import("@/components/chat/message-items");
const { useMessagesStore } = await import("@/stores/messages");
const { diag } = await import("@/lib/diag");

const SID = "swap-s1";
const WINDOWED_N = 300;
const FULL_N = 3000;
/** 估算行高（无实测环境下全部行按 estimateSize 计） */
const EST_ROW_H = 120;
/** fixture 快照行：窗投影下标 248（key m498，窗 base=250）、内容位 start = 120×248 */
const SNAP_INDEX = 248;
const SNAP_START = EST_ROW_H * SNAP_INDEX;
/** 快照行在满量投影下标（250+248=498）与新坐标内容位 */
const FULL_INDEX = 498;
const FULL_START = EST_ROW_H * FULL_INDEX;
/** 落地前用户滚动位置：快照行屏位 d = SNAP_START - SCROLL_TOP_BEFORE = -140；
 * 恢复原视位终点 = FULL_START - d = 59900（锚行保持视口顶上方 140px） */
const SCROLL_TOP_BEFORE = 29900;
const EXPECTED_FINAL_TOP = FULL_START - (SNAP_START - SCROLL_TOP_BEFORE);

const stubItems = (n: number, base = 0, prefix = "m") =>
  Array.from({ length: n }, (_, i) => ({ key: `${prefix}${base + i}`, kind: "streaming" as const }));
type StreamItem = ReturnType<typeof stubItems>[number];

const wireEntries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    type: "message",
    id: `e${i}`,
    parentId: i === 0 ? null : `e${i - 1}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `e${i}` }] },
  }));

/** 兼容派发：happy-dom 无 WheelEvent 构造器时用普通 Event 携带 deltaY */
function fireWheel(el: HTMLElement, deltaY: number): void {
  let ev: Event;
  try {
    ev = new WheelEvent("wheel", { bubbles: true, deltaY });
  } catch {
    ev = new Event("wheel", { bubbles: true });
    Object.defineProperty(ev, "deltaY", { value: deltaY });
  }
  el.dispatchEvent(ev);
}

interface VtInstance {
  getVirtualItems: () => unknown[];
  scrollToIndex: (index: number, opts?: { align?: string; behavior?: string }) => void;
}

/** 向最近挂载的 virtualizer 实例注入虚拟窗 fixture 并 spy 滚动指令；el 为被测滚动容器 */
function installFixture(index: number, start: number, el: HTMLElement) {
  const inst = (globalThis as { __vtRegistry?: unknown[] }).__vtRegistry!.at(-1) as VtInstance;
  const getSpy = vi.spyOn(inst, "getVirtualItems").mockReturnValue([
    { index, start, size: EST_ROW_H, end: start + EST_ROW_H, lane: 0, key: `fx${index}` },
  ]);
  // scrollToIndex 携同步滚动副作用（virtual-core 3.19.11 同步 elementScroll 语义：
  // behavior "auto" 即刻写 el.scrollTop = item.start，估算行高）；align:end 调用
  // （锚底路径）在该模型下取 start 近似——用例不断言锚底 scrollTop 数值，无碍。
  const scrollSpy = vi.spyOn(inst, "scrollToIndex").mockImplementation((idx: number) => {
    el.scrollTop = EST_ROW_H * idx;
  });
  return { getSpy, scrollSpy };
}

describe("detectProjectionSwap 换代检测纯函数", () => {
  test("store 信号优先：swapSeq 增长即换代，长度差再小也算", () => {
    expect(detectProjectionSwap({ swapSeq: 5, items: 300 }, { swapSeq: 6, items: 301 })).toBe(true);
  });

  test("中体型会话：长度差低于阈值（后备启发漏检）由 store 信号补位检出", () => {
    // 窗 300 → 全量 316：净增 16 ≤ 阈值，长度启发漏检；整替计数增长命中
    expect(316 - 300).toBeLessThanOrEqual(SWAP_LENGTH_DIFF_THRESHOLD);
    expect(detectProjectionSwap({ swapSeq: 2, items: 300 }, { swapSeq: 3, items: 316 })).toBe(true);
  });

  test("后备启发：信号缺席 + 大长度差（尾窗→全量）仍触发", () => {
    expect(detectProjectionSwap({ swapSeq: 5, items: 300 }, { swapSeq: 5, items: 3000 })).toBe(true);
  });

  test("普通小增量 append：无信号且长度差低于阈值 → 非换代", () => {
    expect(detectProjectionSwap({ swapSeq: 3, items: 300 }, { swapSeq: 3, items: 301 })).toBe(false);
    expect(detectProjectionSwap({ swapSeq: 3, items: 300 }, { swapSeq: 3, items: 302 })).toBe(false);
  });

  test("整替收缩（全量→窗）：长度差为负不触发后备，真收缩换代由信号负责", () => {
    expect(detectProjectionSwap({ swapSeq: 3, items: 3000 }, { swapSeq: 3, items: 300 })).toBe(false);
    expect(detectProjectionSwap({ swapSeq: 3, items: 3000 }, { swapSeq: 4, items: 300 })).toBe(true);
  });
});

describe("落地滚动补偿（webui-refetch-storm 任务 3，GAP-3/4）", () => {
  let host: HTMLElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  let diagSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scrollEl: HTMLElement | null = null;
  let scrollToSpy: ReturnType<typeof vi.fn> | null = null;

  const evCount = (ev: string): number =>
    ((diagSpy?.mock.calls ?? []) as unknown as Array<Array<unknown>>).filter((c) => c[1] === ev).length;
  const evPayloads = (ev: string): unknown[] =>
    ((diagSpy?.mock.calls ?? []) as unknown as Array<Array<unknown>>)
      .filter((c) => c[1] === ev)
      .map((c) => c[2]);

  /** 等一帧 rAF（happy-dom 走 setImmediate 通道） */
  async function flushFrame(): Promise<void> {
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
  }

  async function renderAt(items: StreamItem[]): Promise<void> {
    const r = root!;
    await act(async () => {
      r.render(createElement(MessageList, { items, sessionId: SID, syncing: false, onReachTop: () => {} }));
    });
  }

  /**
   * 基线装配：mount 空（换代检测武装）→ 注入 fixture → 窗投影提交（快照记录 + 首载
   * 定位噪声就此定格）→ 拉开滚动位置模拟用户回看。返回 spy 句柄。
   */
  async function setupWindowed(scrollTop = SCROLL_TOP_BEFORE) {
    const fixture = installFixture(SNAP_INDEX, SNAP_START, scrollEl!);
    useMessagesStore.getState().setEntries(SID, wireEntries(WINDOWED_N), `e${WINDOWED_N - 1}`, `e${WINDOWED_N - 1}`, {
      hasMore: false,
      oldestId: null,
    });
    await renderAt(stubItems(WINDOWED_N, 250));
    await flushFrame();
    scrollEl!.scrollTop = scrollTop;
    return fixture;
  }

  /** 整替落地：store 换代（seq 0→1）+ 全量投影提交 + 补偿 rAF 两帧冲刷 */
  async function landFullSwap(items: StreamItem[]): Promise<void> {
    useMessagesStore.getState().setEntries(SID, wireEntries(FULL_N), `e${FULL_N - 1}`, `e${FULL_N - 1}`, {
      hasMore: false,
      oldestId: null,
    });
    await renderAt(items);
    await flushFrame();
    await flushFrame();
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    diagSpy = vi.spyOn(diag, "info");
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await renderAt([]);
    scrollEl = host.querySelector<HTMLElement>('[data-testid="chat-scroll"]')!;
    scrollToSpy = vi.fn();
    scrollEl.scrollTo = scrollToSpy as unknown as typeof scrollEl.scrollTo;
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    vi.restoreAllMocks();
    diagSpy = null;
    scrollToSpy = null;
    scrollEl = null;
    vi.useRealTimers();
    useMessagesStore.setState({ bySession: {}, followAnchors: {} });
  });

  test("happy：非跟随态整替落地 → 对位补偿（目标 key/下标、align:start、真实终位）", async () => {
    const { scrollSpy } = await setupWindowed();
    // wheel 向上解除跟随（快照已在上次提交记录；content 位 start 与实时 scrollTop 得偏移）
    fireWheel(scrollEl!, -120);
    await flushFrame();
    scrollSpy.mockClear();
    scrollToSpy!.mockClear();
    expect(evCount("swap_compensate")).toBe(0);
    const toAnchorBase = evCount("to_anchor");

    await landFullSwap(stubItems(FULL_N, 0));

    // 补偿恰一次：快照 key m498（窗下标 248）在满量投影下标 498，偏移差 d = -140
    const payloads = evPayloads("swap_compensate");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ key: "m498", index: FULL_INDEX, offset: SNAP_START - SCROLL_TOP_BEFORE, items: FULL_N });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith(FULL_INDEX, { align: "start", behavior: "auto" });
    // scrollToIndex 同步滚动副作用落地：scrollTop 已推至锚行新坐标 start 59760
    expect(scrollEl!.scrollTop).toBe(FULL_START);
    // 恢复原视位：锚行保持原屏位 d（视口顶上方 140px）⇒ 终位 = S_new - d = 59900
    expect(scrollToSpy).toHaveBeenCalledWith({ top: EXPECTED_FINAL_TOP, behavior: "auto" });
    // 非跟随态不触发锚底路径
    expect(evCount("to_anchor")).toBe(toAnchorBase);
  });

  test("failure：跟随态整替仍走既有锚底路径，零补偿（零 align:start）", async () => {
    // scrollTop 保持 0（不模拟回看）：跟随态成立；快照经 fixture 注入非空，
    // 证明零补偿源于跟随态门而非无快照
    const { scrollSpy } = await setupWindowed(0);

    await landFullSwap(stubItems(FULL_N, 0));

    expect(evCount("swap_compensate")).toBe(0);
    const alignStarts = scrollSpy.mock.calls.filter(([, opts]) => (opts as { align?: string } | undefined)?.align === "start");
    expect(alignStarts).toHaveLength(0);
    // 既有锚底路径在换代后照旧可用（确定性入口 visibilitychange 回底；act 环境下
    // 自动跟随 rAF 会被提交期 effect 重跑取消——生产浏览器帧序相反，非本测对象）
    const toAnchorBase = evCount("to_anchor");
    document.dispatchEvent(new Event("visibilitychange"));
    await flushFrame();
    expect(evCount("to_anchor")).toBeGreaterThan(toAnchorBase);
    const alignEnds = scrollSpy.mock.calls.filter(([, opts]) => (opts as { align?: string } | undefined)?.align === "end");
    expect(alignEnds.length).toBeGreaterThan(0);
  });

  test("后备启发端到端：store 信号缺席 + 大长度差 → 补偿照常触发", async () => {
    await setupWindowed();
    fireWheel(scrollEl!, -120);
    await flushFrame();

    // 仅投影切换（不写 store → swapSeq 不变），窗 300 → 全量 3000 长度差 2700 > 阈值
    await renderAt(stubItems(FULL_N, 0));
    await flushFrame();
    await flushFrame();

    const payloads = evPayloads("swap_compensate");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ key: "m498", index: FULL_INDEX, offset: SNAP_START - SCROLL_TOP_BEFORE });
    // 终位同 happy（镜像消解覆盖后备启发路径）：恢复 = S_new - d = 59900
    expect(scrollToSpy).toHaveBeenCalledWith({ top: EXPECTED_FINAL_TOP, behavior: "auto" });
  });

  test("failure：普通小增量 append 不触发快照/补偿（零滚动）", async () => {
    const { scrollSpy } = await setupWindowed();
    fireWheel(scrollEl!, -120);
    await flushFrame();
    scrollSpy.mockClear();
    scrollToSpy!.mockClear();

    // 追加一条（长度差 1 < 阈值，swapSeq 不变）
    await renderAt([...stubItems(WINDOWED_N, 250), { key: "m550", kind: "streaming" as const }]);
    await flushFrame();
    await flushFrame();

    expect(evCount("swap_compensate")).toBe(0);
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  test("failure：快照 key 在新投影缺席（整替剔除）→ 放弃补偿（零滚动）", async () => {
    const { scrollSpy } = await setupWindowed();
    fireWheel(scrollEl!, -120);
    await flushFrame();
    scrollSpy.mockClear();
    scrollToSpy!.mockClear();

    // 整替落地但满量投影用不同 key 前缀：快照 key m498 无从对齐
    await landFullSwap(stubItems(FULL_N, 0, "f"));

    expect(evCount("swap_compensate")).toBe(0);
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(scrollToSpy).not.toHaveBeenCalled();
  });
});
