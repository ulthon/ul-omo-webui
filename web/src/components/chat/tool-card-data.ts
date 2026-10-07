// 工具卡片数据助手（todo 17）：参数/结果的摘要与文本提取，tool-card.tsx 与单测共用。
// 独立成文件是为了 react-refresh 约束（组件文件只导出组件）。
import type { WireMessage, WirePart } from "@/lib/api";

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

/** 参数/结果对象 → 展开态 pretty JSON（字符串原样；异常兜底 String） */
export function prettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
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
