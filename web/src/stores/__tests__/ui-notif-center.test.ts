// 通知中心 store 单测（全局错误改通知中心，方案 A）。验收：
// (a) pushGlobalError 入列不进 toast 栈；(b) 同文本去重合并计数（count 累加、ts 更新、置顶）；
// (c) 角标计数 selectGlobalNotifCount 求和；(d) 单条 dismissGlobalNotif；
// (e) clearGlobalErrors 清空；(f) 容量上限丢最旧。
import { describe, expect, test, beforeEach } from "vitest";
import { selectGlobalNotifCount, useUiStore } from "@/stores/ui";

beforeEach(() => {
  useUiStore.setState({ globalNotifs: [], notifCenterOpen: false, toasts: [] });
});

describe("通知中心 store", () => {
  test("(a) pushGlobalError 只入通知中心，不进 toast 栈", () => {
    useUiStore.getState().pushGlobalError("引擎连接失败");
    const s = useUiStore.getState();
    expect(s.globalNotifs).toHaveLength(1);
    expect(s.globalNotifs[0]).toMatchObject({ text: "引擎连接失败", count: 1 });
    expect(s.toasts).toHaveLength(0);
  });

  test("(b) 同文本去重合并计数：count 累加、ts 更新、条目置顶", () => {
    useUiStore.getState().pushGlobalError("更新检查失败");
    const first = useUiStore.getState().globalNotifs[0];
    useUiStore.getState().pushGlobalError("其他错误");
    useUiStore.getState().pushGlobalError("更新检查失败");
    const s = useUiStore.getState();
    expect(s.globalNotifs).toHaveLength(2);
    expect(s.globalNotifs[0]).toMatchObject({ text: "更新检查失败", count: 2 });
    expect(s.globalNotifs[0].ts).toBeGreaterThanOrEqual(first.ts);
  });

  test("(c) 角标计数 = 各条 count 求和", () => {
    useUiStore.getState().pushGlobalError("e1");
    useUiStore.getState().pushGlobalError("e1");
    useUiStore.getState().pushGlobalError("e2");
    expect(selectGlobalNotifCount(useUiStore.getState())).toBe(3);
  });

  test("(d) dismissGlobalNotif 只关目标条", () => {
    useUiStore.getState().pushGlobalError("e1");
    useUiStore.getState().pushGlobalError("e2");
    useUiStore.getState().dismissGlobalNotif("e1");
    const s = useUiStore.getState();
    expect(s.globalNotifs.map((n) => n.text)).toEqual(["e2"]);
  });

  test("(e) clearGlobalErrors 清空全部，角标归零", () => {
    useUiStore.getState().pushGlobalError("e1");
    useUiStore.getState().pushGlobalError("e2");
    useUiStore.getState().clearGlobalErrors();
    expect(useUiStore.getState().globalNotifs).toEqual([]);
    expect(selectGlobalNotifCount(useUiStore.getState())).toBe(0);
  });

  test("(f) 容量上限丢最旧", () => {
    for (let i = 0; i < 105; i++) useUiStore.getState().pushGlobalError(`e${i}`);
    const s = useUiStore.getState();
    expect(s.globalNotifs).toHaveLength(100);
    expect(s.globalNotifs[0].text).toBe("e104");
    expect(s.globalNotifs.at(-1)?.text).toBe("e5");
  });
});
