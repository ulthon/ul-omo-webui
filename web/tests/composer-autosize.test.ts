// Composer 多行自适应增高单测（r9 2026-10-26 批次）：
// 修复击键历史流抖动——旧实现每次渲染无条件写 height=auto 再写目标值，
// 产生 auto 塌缩中间态；新实现「同高度零写入、增长一次写入、收缩才量 auto」。
import { describe, expect, test } from "vitest";
import { resizeComposerTextarea } from "@/components/composer/composer";

// 模拟真实 textarea：scrollHeight = max(内容高, clientHeight)，height:auto 时
// clientHeight 塌缩为内容高；spy 记录 style.height 全部赋值（含 'auto' 中间态）
function makeEl(contentH: number, value: string) {
  const el = {
    value,
    scrollHeight: 0,
    clientHeight: 0,
    style: { height: "" } as CSSStyleDeclaration,
  };
  Object.defineProperty(el.style, "height", {
    configurable: true,
    get: () => h,
    set: (v: string) => {
      writes.push(v);
      h = v;
    },
  });
  let h = "";
  const writes: string[] = [];
  const client = () => parseFloat(h) || 0;
  Object.defineProperty(el, "clientHeight", { get: () => client() });
  Object.defineProperty(el, "scrollHeight", {
    get: () => Math.max(contentH, client()),
  });
  return { el: el as unknown as HTMLTextAreaElement, writes, set: (ch: number, v: string) => { contentH = ch; el.value = v; } };
}

describe("resizeComposerTextarea", () => {
  test("旧算法复现：同高度连续输入也写两次（auto + 回写），即抖动根因", () => {
    const { el, writes } = makeEl(64, "abc");
    el.style.height = "64px";
    writes.length = 0;
    // 旧实现内联逻辑：无条件 auto → 写 scrollHeight
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    expect(writes).toEqual(["auto", "64px"]);
  });

  test("同高度连续输入：style.height 零写入", () => {
    const { el, writes, set } = makeEl(64, "abc");
    resizeComposerTextarea(el);
    writes.length = 0;
    set(64, "abcd"); // 同行数继续输入，高度不变
    resizeComposerTextarea(el);
    expect(writes).toEqual([]);
    expect(el.style.height).toBe("64px");
  });

  test("高度增长：一次写入目标值，终值不为 auto", () => {
    const { el, writes, set } = makeEl(64, "a");
    resizeComposerTextarea(el);
    expect(writes).toEqual(["64px"]);
    set(96, "a\nb\nc"); // 多行增长
    resizeComposerTextarea(el);
    expect(writes).toEqual(["64px", "96px"]);
    expect(el.style.height).not.toBe("auto");
    expect(el.style.height).toBe("96px");
  });

  test("删行收缩：量 auto 后一次写回，不残留塌缩中间态", () => {
    const { el, writes, set } = makeEl(96, "a\nb\nc");
    resizeComposerTextarea(el); // 建立基线 96px
    expect(writes).toEqual(["96px"]);
    set(64, "a"); // 删行：真实内容高变 64px
    resizeComposerTextarea(el);
    expect(writes).toEqual(["96px", "auto", "64px"]);
    expect(el.style.height).toBe("64px");
  });
});
