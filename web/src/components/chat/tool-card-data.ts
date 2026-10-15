// 工具卡片数据助手（todo 17）：参数/结果的摘要与文本提取，tool-card.tsx 与单测共用。
// 独立成文件是为了 react-refresh 约束（组件文件只导出组件）。
// todo 19 增补：diff 视图数据源判定 diffTextOf（details.patch 优先，文本启发式兜底）。
// docs08-r4 任务 9 增补：summarizeToolCall 按工具语义结构化摘要（字段名经真实会话 JSONL 抽样核对：
//   eval={code,language,summary} bash={command} write/edit={path,...} read={path}
//   glob/grep={pattern} task={prompt,task_summary,category}——task_id 仅出现在结果文本 "(st_xxx, running)"）。
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

// ---- docs08-r4 任务 9：按工具语义结构化摘要（纯函数，真实 args 字段经会话 JSONL 抽样核对） ----

/** 头部主标截断长度（字符） */
export const PRIMARY_CHARS = 80;

export type ToolSummaryKind = "code" | "path" | "task" | "generic";

export interface ToolCallSummary {
  primary: string;
  secondary?: string;
  kind: ToolSummaryKind;
  /** kind=code 的头部语言/类型小标（eval→language 字段、bash→"sh"） */
  chip?: string;
}

/** args → 对象形态窄化（非普通对象一律 null，走 generic 兜底） */
function argsRecord(args: unknown): Record<string, unknown> | null {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

/** 非空字符串窄化（空串/纯空白视为缺失） */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 首行截断（多行命令/代码/提示词取首行，超长以 … 收尾） */
function firstLine(text: string, max: number): string {
  const line = (text.split("\n", 1)[0] ?? "").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** task 结果文本中的 task_id（实样形态 "Started task … (st_01a13225, running)"，老会话无结构化字段时兜底） */
const TASK_ID_RE = /\bst_[A-Za-z0-9]+\b/;

/** task_id 取值：优先 result.details.task_id（QA 实证结构化字段，值形如 "st_01a13b2f"），
 *  兜底结果文本 st_ 形态正则（老会话/流式中间态）；都无返回 undefined。 */
function taskIdOf(result?: WireMessage | null): string | undefined {
  const details = result?.details as { task_id?: unknown } | undefined;
  if (typeof details?.task_id === "string" && details.task_id.trim()) return details.task_id;
  const text = textsOfContent(result?.content);
  return TASK_ID_RE.exec(text)?.[0];
}

/** write/edit 变更概要 "+N/-M 行"：优先 result.details.patch 统计，次选结果文本 diff 启发式；
 *  无 diff 形态或增删全零（解析不出可计数行）返回 null（头部只显路径）。 */
export function changeSummaryOf(result?: WireMessage | null): string | null {
  if (!result) return null;
  const details = result.details as { patch?: unknown } | undefined;
  const patch = typeof details?.patch === "string" && details.patch.trim() ? details.patch : null;
  const diff = patch ?? extractParseableDiff(textsOfContent(result.content));
  if (!diff) return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  if (added === 0 && removed === 0) return null;
  return `+${added}/-${removed} 行`;
}

/**
 * 按工具语义结构化摘要（docs08-r4 任务 9）：
 *   task → primary=task_summary ?? prompt 首行截断、secondary=`${category} · ${task_id}`（缺者省略）、kind=task；
 *   eval → primary=code 首行截断、secondary=summary、chip=language、kind=code；
 *   bash/sh → primary=command 首行截断、chip="sh"、kind=code；
 *   write/edit/multi_edit → primary=path、secondary=+N/-M 变更概要（changeSummaryOf）、kind=path；
 *   read/ls → primary=path、glob/grep → primary=pattern、kind=path；
 *   其余（含异形 args：缺失字段/非对象/数组）→ 回落 summarizeArgs、kind=generic。
 * result（toolResult 消息）可选，仅用于 task_id 与变更概要；运行中无结果时相应 secondary 缺省。
 */
export function summarizeToolCall(name: string, args: unknown, result?: WireMessage | null): ToolCallSummary {
  const a = argsRecord(args);
  if (a != null) {
    switch (name) {
      case "task": {
        const prompt = nonEmpty(a.prompt);
        const primary = nonEmpty(a.task_summary) ?? (prompt ? firstLine(prompt, PRIMARY_CHARS) : "");
        if (!primary) break;
        const secondary = [nonEmpty(a.category), taskIdOf(result)].filter(Boolean).join(" · ") || undefined;
        return { primary, secondary, kind: "task" };
      }
      case "eval": {
        const code = nonEmpty(a.code);
        if (!code) break;
        return {
          primary: firstLine(code, PRIMARY_CHARS),
          secondary: nonEmpty(a.summary),
          kind: "code",
          chip: nonEmpty(a.language) ?? "code",
        };
      }
      case "bash":
      case "sh": {
        const command = nonEmpty(a.command);
        if (!command) break;
        return { primary: firstLine(command, PRIMARY_CHARS), kind: "code", chip: "sh" };
      }
      case "write":
      case "edit":
      case "multi_edit": {
        const path = nonEmpty(a.path);
        if (!path) break;
        return { primary: path, secondary: changeSummaryOf(result) ?? undefined, kind: "path" };
      }
      case "read":
      case "ls": {
        const path = nonEmpty(a.path);
        if (!path) break;
        return { primary: path, kind: "path" };
      }
      case "glob":
      case "grep": {
        const pattern = nonEmpty(a.pattern);
        if (!pattern) break;
        return { primary: pattern, kind: "path" };
      }
      default:
        break;
    }
  }
  return { primary: summarizeArgs(args), kind: "generic" };
}

/** 代码类工具的原始代码/命令文本（eval.code / bash.command 实样字段直读），非代码类或缺字段返回空串 */
export function codeTextOf(args: unknown): string {
  const a = argsRecord(args);
  if (!a) return "";
  if (typeof a.code === "string") return a.code;
  if (typeof a.command === "string") return a.command;
  return "";
}
