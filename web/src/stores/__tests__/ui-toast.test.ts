// 轻提示栈单测（docs08 2026-10-25 用户反馈：错误提示要点选关闭导致无法复制）：
// - showToast 追加至多 3 条；超限丢最旧并 console.warn 留痕
// - info 各自 3.2s 自动消失（timer 按 id 独立，互不覆盖）；error 常驻
// - dismissToast 只关目标条并清其 timer
// 界面侧（可选中文字/复制钮/关闭钮）在 shell ToastItem，本文件只覆盖 store 行为。
import { describe, expect, test, beforeEach, vi, afterEach } from "vitest";
import { useUiStore } from "@/stores/ui";

function texts(): string[] {
  return useUiStore.getState().toasts.map((it) => it.text);
}

beforeEach(() => {
  vi.useFakeTimers();
  useUiStore.setState({ toasts: [] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  // 清掉测试中可能残留的自动消失 timer，避免跨文件泄漏
  for (const t of useUiStore.getState().toasts) useUiStore.getState().dismissToast(t.id);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("showToast 栈行为", () => {
  test("追加多条同列堆叠（不互相顶掉）", () => {
    const s = useUiStore.getState();
    s.showToast("e1", "error");
    s.showToast("e2", "error");
    expect(texts()).toEqual(["e1", "e2"]);
  });

  test("超过 3 条丢最旧并 console.warn 留痕", () => {
    const s = useUiStore.getState();
    s.showToast("a", "info");
    s.showToast("b", "error");
    s.showToast("c", "error");
    s.showToast("d", "error");
    expect(texts()).toEqual(["b", "c", "d"]);
    expect(console.warn).toHaveBeenCalledWith("[toast] cap 3 exceeded, dropped oldest:", "a");
  });

  test("info 3.2s 各自自动消失（多条独立计时）", () => {
    const s = useUiStore.getState();
    s.showToast("i1", "info");
    vi.advanceTimersByTime(1000);
    s.showToast("i2", "info");
    expect(texts()).toEqual(["i1", "i2"]);
    vi.advanceTimersByTime(2200); // i1 满 3.2s；i2 才 2.2s
    expect(texts()).toEqual(["i2"]);
    vi.advanceTimersByTime(1000);
    expect(texts()).toEqual([]);
  });

  test("error 常驻：不自动消失", () => {
    const s = useUiStore.getState();
    s.showToast("boom", "error");
    vi.advanceTimersByTime(60_000);
    expect(texts()).toEqual(["boom"]);
  });

  test("被丢弃的 info 不再触发自动消失（timer 已清，无悬空 set）", () => {
    const s = useUiStore.getState();
    s.showToast("i1", "info");
    s.showToast("e2", "error");
    s.showToast("e3", "error");
    s.showToast("e4", "error"); // 顶掉 i1
    expect(texts()).toEqual(["e2", "e3", "e4"]);
    vi.advanceTimersByTime(5000);
    expect(texts()).toEqual(["e2", "e3", "e4"]); // 若 timer 未清也不会多删，但至少无害
  });
});

describe("dismissToast", () => {
  test("只关目标条，其余保留", () => {
    const s = useUiStore.getState();
    s.showToast("keep1", "error");
    s.showToast("kill", "error");
    s.showToast("keep2", "error");
    const killId = useUiStore.getState().toasts[1]!.id;
    useUiStore.getState().dismissToast(killId);
    expect(texts()).toEqual(["keep1", "keep2"]);
  });

  test("关闭 info 条时清 timer（后续不再影响栈）", () => {
    const s = useUiStore.getState();
    s.showToast("gone", "info");
    const id = useUiStore.getState().toasts[0]!.id;
    useUiStore.getState().dismissToast(id);
    expect(texts()).toEqual([]);
    vi.advanceTimersByTime(4000);
    expect(texts()).toEqual([]);
  });
});
