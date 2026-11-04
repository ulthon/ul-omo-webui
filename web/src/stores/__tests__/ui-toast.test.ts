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

  test("info 8s 各自自动消失（多条独立计时；2026-11-05 #10 加长）", () => {
    const s = useUiStore.getState();
    s.showToast("i1", "info");
    vi.advanceTimersByTime(1000);
    s.showToast("i2", "info");
    expect(texts()).toEqual(["i1", "i2"]);
    vi.advanceTimersByTime(7000); // i1 满 8s；i2 才 7s
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

describe("notifications 通知历史（2026-11-05 #10）", () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [], notifications: [] });
  });

  test("info 与 error 都入历史，带时间戳", () => {
    const s = useUiStore.getState();
    s.showToast("n1", "info");
    s.showToast("n2", "error");
    const ns = useUiStore.getState().notifications;
    expect(ns.map((n) => n.text)).toEqual(["n1", "n2"]);
    expect(ns[0]).toMatchObject({ kind: "info", text: "n1" });
    expect(ns[1]).toMatchObject({ kind: "error", text: "n2" });
    expect(typeof ns[0]!.ts).toBe("number");
  });

  test("toast 自动消失/手动关/超限丢最旧都不影响历史", () => {
    const s = useUiStore.getState();
    s.showToast("i1", "info");
    vi.advanceTimersByTime(9000); // 栈里已消失
    s.showToast("e1", "error");
    const id = useUiStore.getState().toasts[0]!.id;
    useUiStore.getState().dismissToast(id); // 手动关
    expect(useUiStore.getState().toasts).toEqual([]);
    expect(useUiStore.getState().notifications.map((n) => n.text)).toEqual(["i1", "e1"]);
  });

  test("环形缓冲 200 条，超出丢最旧", () => {
    const s = useUiStore.getState();
    for (let i = 1; i <= 202; i++) s.showToast(`m${i}`, "info");
    const ns = useUiStore.getState().notifications;
    expect(ns).toHaveLength(200);
    expect(ns[0]!.text).toBe("m3"); // m1/m2 被挤出
    expect(ns[199]!.text).toBe("m202");
  });

  test("clearNotifications 清空历史（不动 toast 栈）", () => {
    const s = useUiStore.getState();
    s.showToast("keep", "error");
    useUiStore.getState().clearNotifications();
    expect(useUiStore.getState().notifications).toEqual([]);
    expect(texts()).toEqual(["keep"]);
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
