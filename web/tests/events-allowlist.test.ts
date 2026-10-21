// 白名单对账守卫（docs08-r6 任务 16）：HANDLED_EVENT_TYPES（events.ts）必须覆盖
// 分发层实际处理的全部 wire type 字面量——漏列的类型在 EventSource 模式下浏览器不派发
// （fetch 模式全量派发），造成"分发层写了 ≠ 浏览器派发了"的静默缺口（q1 提问卡片、
// 任务 8 模型切换均实证过此类漏列）。反向断言则保证白名单不注册无消费点的死类型。
// 机制：静态扫描源文件正则抽取 type 字面量（不依赖运行时导入白名单内部符号，白名单
// 非导出常量；源码路径相对本测试文件解析，vitest 在 web/ 目录下运行）。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "../src");
const eventsSrc = readFileSync(resolve(srcRoot, "lib/events.ts"), "utf8");
const dispatchSrc = readFileSync(resolve(srcRoot, "lib/event-dispatch.ts"), "utf8");
const messagesSrc = readFileSync(resolve(srcRoot, "stores/messages.ts"), "utf8");

/** events.ts 中 HANDLED_EVENT_TYPES 数组体（const 声明到闭括号） */
function extractAllowlist(): string[] {
  const start = eventsSrc.indexOf("HANDLED_EVENT_TYPES");
  if (start === -1) throw new Error("events.ts 未找到 HANDLED_EVENT_TYPES");
  const open = eventsSrc.indexOf("[", start);
  const close = eventsSrc.indexOf("];", open);
  const body = eventsSrc.slice(open, close);
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** event-dispatch.ts 分发层字面量：eventType === "x" 与 wire.type === "x" */
function extractDispatchHandled(): string[] {
  const out = new Set<string>();
  for (const m of dispatchSrc.matchAll(/(?:eventType|wire\.type)\s*===\s*"([a-z_]+)"/g)) out.add(m[1]);
  return [...out];
}

/** messages.ts applyWireEvent switch 消费的 case 字面量（仅主入口 switch 体，
 *  不含内嵌 applyAssistantMessageEvent 的 assistantMessageEvent 子类 case——那是
  * message_update 载荷内的 kind，非 wire type，EventSource 白名单不涉及） */
function extractStoreCases(): string[] {
  const start = messagesSrc.indexOf("applyWireEvent: (sessionId, event)");
  if (start === -1) throw new Error("messages.ts 未找到 applyWireEvent");
  const end = messagesSrc.indexOf("appendDelta:", start);
  const body = messagesSrc.slice(start, end);
  const out = new Set<string>();
  for (const m of body.matchAll(/case\s+"([a-z_]+)"\s*:/g)) out.add(m[1]);
  return [...out];
}

/** 主通道直通类型：注册保证派发进 applyWireEvent，主通道按未知类型容错忽略或由
 * 后续任务消费（hb 由 events.ts 看门狗自身消费；engine_event 为服务端无 type 帧
 * 的兜底 event 行名；compaction_* 为引擎压缩帧，docs08-r6 任务 16 预留主通道通路）。 */
const PASS_THROUGH: ReadonlySet<string> = new Set([
  "hb",
  "engine_event",
  "compaction_start",
  "compaction_progress",
  "compaction_end",
]);

describe("SSE 白名单对账守卫", () => {
  const allowlist = extractAllowlist();
  const dispatchHandled = extractDispatchHandled();
  const storeCases = extractStoreCases();

  it("对账抽到的分发层处理集非空（守卫自检：源码漂移不致空集假绿）", () => {
    expect(dispatchHandled.length).toBeGreaterThan(10);
    expect(storeCases.length).toBeGreaterThan(10);
    expect(allowlist.length).toBeGreaterThan(20);
  });

  it("分发层处理的全部 wire type 均在白名单（漏列即红）", () => {
    const missing = dispatchHandled.filter((t) => !allowlist.includes(t));
    expect(missing, `分发层处理但白名单缺列: ${missing.join(", ")}`).toEqual([]);
    // store 消费的类型同样必须过白名单才能到达 applyWireEvent（EventSource 模式）
    const storeMissing = storeCases.filter((t) => !allowlist.includes(t));
    expect(storeMissing, `store 消费但白名单缺列: ${storeMissing.join(", ")}`).toEqual([]);
  });

  it("白名单无死注册：每项都有分发层/store 消费点或属主通道直通", () => {
    const dead = allowlist.filter(
      (t) => !dispatchHandled.includes(t) && !storeCases.includes(t) && !PASS_THROUGH.has(t),
    );
    expect(dead, `白名单注册但无消费点: ${dead.join(", ")}`).toEqual([]);
  });
});
