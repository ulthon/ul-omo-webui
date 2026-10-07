// 工具卡片数据助手（todo 17）：参数/结果的摘要与文本提取，tool-card.tsx 与单测共用。
// 独立成文件是为了 react-refresh 约束（组件文件只导出组件）。
// todo 19 增补：diff 视图数据源判定 diffTextOf（details.patch 优先，文本启发式兜底）。
import type { WireMessage, WirePart } from "@/lib/api";
import { extractParseableDiff } from "@/components/diff/diff-utils";

/** 结果折叠预览长度（字符）；超出截断，"展开全部"后完整显示 */
export const RESULT_PREVIEW_CHARS = 400;
/** 头部参数摘要长度（字符） */
export const ARGS_SUMMARY_CHARS = 96;

/** 参数 → 单行摘要 JSON（缺失/空对象/空数组返回空串；循环引用等异常兜底 String） */
export function summarizeArgs(args: unknown): string {
  if (args == null) return "";
  let json: string;
  try {
    json = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    return String(args);
  }
  if (!json || json === "{}" || json === "[]") return "";
  return json.length > ARGS_SUMMARY_CHARS ? `${json.slice(0, ARGS_SUMMARY_CHARS)}…` : json;
}

/**
 * 展开态深度上限：超过以 "\"…\"" 占位，保证输出有界（工具参数/结果的 wire JSON 实测深度 ≤5）。
 * 不能用原生 JSON.stringify 兜循环引用：本运行时（bun 1.4.2 / JSC）对循环结构 stringify
 * 抛 TypeError 前有病态耗时（{self} 一层循环实测 ~16s），try/catch 捕获发生在代价之后。
 */
const MAX_DEPTH = 8;

/**
 * 与 JSON.stringify(value, null, 2) 同构的确定性序列化：
 *   WeakSet 做祖先链记忆化（DFS 回溯删除，共享非循环引用不误报），循环节点占位 "[object Object]"
 *   （与旧实现 catch 后 String(root) 的输出语义一致）；超深占位 "…"；toJSON 与原生一致展开。
 * 不可序列化节点语义与原生对齐：数组元素位/根位为 null/undefined，对象属性位剔除。
 */
function serializeNode(value: unknown, depth: number, seen: WeakSet<object>): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return String(value);
    case "bigint":
      return undefined; // 根位走 String(value) 兜底（与旧实现 catch 路径一致）；wire JSON 不会出现
    case "undefined":
    case "function":
    case "symbol":
      return undefined; // 数组元素位由调用方回落 null；属性位剔除；根位回落 String(value)
    default:
      break;
  }
  const obj = value as object;
  if (depth > MAX_DEPTH) return "\"…\"";
  if (seen.has(obj)) return "\"[object Object]\"";
  seen.add(obj);
  try {
    const toJson = (obj as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      const json = (toJson as (this: object, key: string) => unknown).call(obj, "");
      return serializeNode(json, depth, seen);
    }
    if (Array.isArray(obj)) {
      const items = (obj as unknown[]).map((item) => serializeNode(item, depth + 1, seen) ?? "null");
      return items.length === 0 ? "[]" : `[\n${items.map((t) => indentBlock(t, 2)).join(",\n")}\n]`;
    }
    const parts: string[] = [];
    for (const key of Object.keys(obj)) {
      const raw = (obj as Record<string, unknown>)[key];
      if (raw === undefined || typeof raw === "function" || typeof raw === "symbol") continue;
      parts.push(`${JSON.stringify(key)}: ${serializeNode(raw, depth + 1, seen) ?? "null"}`);
    }
    return parts.length === 0 ? "{}" : `{\n${parts.map((t) => indentBlock(t, 2)).join(",\n")}\n}`;
  } finally {
    seen.delete(obj);
  }
}

/** 每行前缀 2 空格（子结构相对缩进，父层嵌入时再统一前缀） */
function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

/** 参数/结果对象 → 展开态 pretty JSON（字符串原样；循环引用/超深/异常均有界兜底，不崩不病态耗时） */
export function prettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return serializeNode(value, 0, new WeakSet()) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 从 content[] 提取文本视图（content[].text 是给模型的文本，details 结构化数据归 todo 23） */
function textsOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    const p = part as WirePart;
    if (p && p.type === "text" && typeof p.text === "string") texts.push(p.text);
  }
  return texts.length > 0 ? texts.join("\n") : "";
}

/** 结果文本：toolResult 消息 content 优先，兜底 tool_execution_end 的 run.result（同构 content 或标量） */
export function resultTextOf(message: WireMessage | null, runResult: unknown): string {
  if (message) {
    const text = textsOfContent(message.content);
    if (text) return text;
  }
  if (typeof runResult === "string") return runResult;
  if (runResult != null) {
    const text = typeof runResult === "object" ? textsOfContent((runResult as WireMessage).content) : "";
    return text || prettyJson(runResult);
  }
  return "";
}

/** diff 视图数据源（todo 19）：返回可渲染的 unified diff 文本，无 diff 形态返回 null。
 *  优先级：1) toolResult.details.patch——引擎 edit 类工具的结构化 unified diff 字段（QA 实证）；
 *  2) 结果文本中的 diff 形态（```diff 围栏 / git diff 头 / 数字形态 @@ hunk 头启发式）。
 *  两路都经 extractParseableDiff 解析校验，误判自动回退 null（纯文本渲染）。 */
export function diffTextOf(message: WireMessage | null, resultText: string): string | null {
  if (!resultText) return null;
  const details = message?.details as { patch?: unknown } | undefined;
  if (typeof details?.patch === "string" && details.patch.trim()) {
    const fromPatch = extractParseableDiff(details.patch);
    if (fromPatch) return fromPatch;
  }
  return extractParseableDiff(resultText);
}
