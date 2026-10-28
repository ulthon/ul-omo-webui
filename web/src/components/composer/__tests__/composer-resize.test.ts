// r10 任务 5：发送后输入框高度不回缩——确定性逻辑路径测试。
// happy-dom 无真实布局，故用受控 fake 元素模拟浏览器 scrollHeight 钳制语义：
//   scrollHeight = max(内容高, clientHeight)；clientHeight 由 style.height 与 CSS
//   max-h-48(192px)/min-h-9(36px) 共同决定；style.height:"auto" 时 clientHeight=内容高。
// 根因（浏览器探针实证，见 .omo/evidence/r10/task-5/）：多行增长把 style.height 写到
// 超过 max-h 钳制值后，清空时 scrollHeight 被 clientHeight 钳在 max 高，r9 分支②
// 「target≠cur 直接写目标」抢跑写回钳制高并提前返回，永不量真实单行高。
import { describe, expect, it } from "vitest";
import { resizeComposerTextarea } from "../composer";

const MIN_H = 36; // min-h-9
const MAX_H = 192; // max-h-48
const LINE_H = 20;
const PAD = 16;
const CHARS_PER_LINE = 40; // 模拟容器宽度下的软换行

/** 内容像素高（单行起，含 padding；长行按软换行折行，空文本也占一行） */
function contentH(value: string) {
  if (value === "") return PAD + LINE_H;
  const lines = value
    .split("\n")
    .reduce((n, seg) => n + Math.max(1, Math.ceil(seg.length / CHARS_PER_LINE)), 0);
  return PAD + lines * LINE_H;
}

/** 模拟浏览器布局：返回此刻 scrollHeight */
function simulateScrollHeight(el: FakeTextarea) {
  if (el.style.height === "auto") {
    // height:auto → 元素高=内容高，scrollHeight=内容高
    return contentH(el.value);
  }
  const h = parseFloat(el.style.height || "");
  const client = Math.min(MAX_H, Math.max(MIN_H, Number.isNaN(h) ? MIN_H : h));
  return Math.max(contentH(el.value), client);
}

class FakeTextarea {
  value = "";
  style: { height: string } = { height: "" };
  writes: string[] = [];
  get scrollHeight() {
    return simulateScrollHeight(this);
  }
  noteHeightWrite(v: string) {
    if (this.style.height !== v) this.writes.push(v);
    this.style.height = v;
  }
  #cachedEl: HTMLTextAreaElement | null = null;
  asEl() {
    // 稳定元素：组件每次渲染传同一个 textarea，WeakMap 键不变
    if (!this.#cachedEl) {
      const mock: Record<string, unknown> = {};
      Object.defineProperties(mock, {
        value: { get: () => this.value },
        scrollHeight: { get: () => this.scrollHeight },
      });
      const styleProxy = { height: "" };
      Object.defineProperties(styleProxy, {
        height: {
          get: () => this.style.height,
          set: (v: string) => {
            this.noteHeightWrite(v);
          },
        },
      });
      mock.style = styleProxy;
      this.#cachedEl = mock as unknown as HTMLTextAreaElement;
    }
    return this.#cachedEl;
  }
  render() {
    resizeComposerTextarea(this.asEl());
  }
}

describe("resizeComposerTextarea 发送后回缩（r10 任务 5）", () => {
  it("多行输入增长（超 max-h 钳制）后清空 → 回单行基准高", () => {
    const el = new FakeTextarea();
    for (let i = 1; i <= 15; i++) {
      el.value = Array.from({ length: i }, (_, j) => `第 ${j} 行内容`).join("\n");
      el.render();
    }
    // 增长到钳制：style.height 被写成 scrollHeight（超 192 由 CSS 截断）
    expect(parseFloat(el.style.height)).toBeGreaterThan(MAX_H);
    // 发送清空：clearDraft → 渲染 effect
    el.value = "";
    el.render();
    expect(el.style.height).toBe(`${PAD + LINE_H}px`);
  });

  it("长粘贴（内容远超 max 高）后清空 → 同样回单行基准高", () => {
    const el = new FakeTextarea();
    el.value = "超长粘贴内容".repeat(2000);
    el.render();
    expect(parseFloat(el.style.height)).toBeGreaterThan(MAX_H);
    el.value = "";
    el.render();
    expect(el.style.height).toBe(`${PAD + LINE_H}px`);
  });

  it("少量行（未超 max-h）输入后清空 → 回单行基准高（原有路径不回归）", () => {
    const el = new FakeTextarea();
    el.value = "一行\n两行\n三行";
    el.render();
    el.value = "";
    el.render();
    expect(el.style.height).toBe(`${PAD + LINE_H}px`);
  });

  it("逐键输入（增长）期间：无 auto 写入、高度不变时零写入（r9 防抖回归）", () => {
    const el = new FakeTextarea();
    el.value = "";
    el.render();
    el.writes.length = 0;
    const sentence = "逐键输入防抖观测：一个字符一个字符追加，行数不变时不得有任何写入。";
    const before = el.style.height;
    for (const ch of sentence) {
      el.value += ch;
      el.render();
      expect(el.style.height).not.toBe("auto");
    }
    // 行数始终为 1：内容高不变，整个输入过程零写入
    expect(el.style.height).toBe(before);
    expect(el.writes).toEqual([]);
  });

  it("逐键增长跨行时：只在跨行帧写入一次、无 auto 中间态（r9 回归）", () => {
    const el = new FakeTextarea();
    el.value = "";
    el.render();
    el.writes.length = 0;
    for (let i = 1; i <= 4; i++) {
      el.value = Array.from({ length: i }, (_, j) => `第 ${j} 行`).join("\n");
      el.render();
      expect(el.style.height).not.toBe("auto");
    }
    // 每跨一行恰一次写入（首行从基准起算）
    expect(el.writes).toEqual([`${PAD + 2 * LINE_H}px`, `${PAD + 3 * LINE_H}px`, `${PAD + 4 * LINE_H}px`]);
  });

  it("逐键删字（缩短）时同帧重量写回，无塌缩中间态残留（r9 ⑤语义保持）", () => {
    const el = new FakeTextarea();
    el.value = Array.from({ length: 12 }, (_, j) => `第 ${j} 行`).join("\n");
    el.render();
    for (let i = 11; i >= 1; i--) {
      el.value = Array.from({ length: i }, (_, j) => `第 ${j} 行`).join("\n");
      el.render();
      expect(el.style.height).toBe(`${PAD + i * LINE_H}px`);
    }
  });
});
