// part 渲染分发（todo 16 建分发点；todo 17 起工具卡片接管）：
//   text → Markdown；thinking → ThinkingBlock；toolCall → name=todo 走 TodoList 结构化清单
//   （todo-list.tsx，details 缺失时组件内自行降级 ToolCard），其余工具 → ToolCard（tool-card.tsx，
//   含结果折叠展示，toolResult 消息经 toolCallId 关联进卡片，不再单独渲染 ToolResultLine）；
//   image → 内联缩略 + 灯箱；image_ref → 占位降级（todo 23）；error → 红色错误卡
//   （message-error-part，模型侧错误 429 限流/额度用完/上下文超限等：文本鸭子形提取
//   message/text/error.message，原文保留不翻译，retry 提示原样随文显示）。
//   未知类型 → 轻量占位 chip「未支持内容块：〈type〉」（docs08-r6 任务 10 ①；此前的
//   default null 分支是空壳气泡的候选源——task-3 枚举修正：实测 part.type 仅
//   text/toolCall/thinking/image 四种且全在渲染集合内，本分支为防御性兜底，无实证样本、
//   不猜结构）。
//   todo 25 消息级操作同挂此分发点。
// 流式期间以 part 下标为订阅粒度（StreamingPart 单独订阅 content[i]），
// 单个 part 的 delta 只重渲染该 part 的子树，不触碰兄弟 part 与列表其他气泡。
import { useMessagesStore } from "@/stores/messages";
import type { WireMessage, WirePart } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { Markdown } from "./markdown";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";
import { ImagePart, ImageRefPlaceholder } from "./image-lightbox";
import { TodoList } from "./todo-list";
import { CircleAlert } from "lucide-react";

/** part 可见性判据（PartView null 分支的同构镜像，防 drift：新增 null 分支须同步此处；
 *  模块私有——仅 PartsView 计数分支消费，导出会破 fast-refresh 纯组件约束）。
 *  未知类型经 ① 渲染占位 chip 计为可见；空 text、无 id toolCall、非对象形态不可见。 */
function isRenderablePart(part: WirePart): boolean {
  if (part === null || typeof part !== "object") return false;
  switch (part.type) {
    case "text":
      return typeof part.text === "string" && part.text !== "";
    case "toolCall":
      return typeof part.id === "string" && part.id !== "";
    default:
      // thinking / image / image_ref / 未知类型（① 占位 chip）均可见
      return true;
  }
}

/** error part 错误文本鸭子形提取：wire 透传无硬 schema，兼容
 *  {message}（引擎会话级错误帧形态）、{text}、{error: string} 与
 *  {error: {message|name}}（AI SDK 风格嵌套形态）；全缺席返回空串不渲染。
 *  原文保留不翻译（模型错误多为英文原文），retry in Xs 等提示随原文一并展示。 */
function errorPartText(part: WirePart): string {
  for (const key of ["message", "text"] as const) {
    const v = part[key];
    if (typeof v === "string" && v !== "") return v;
  }
  const err = part.error;
  if (typeof err === "string" && err !== "") return err;
  if (err !== null && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m !== "") return m;
    const n = (err as { name?: unknown }).name;
    if (typeof n === "string" && n !== "") return n;
  }
  return "";
}

/** 模型错误 part 错误卡：destructive 色系，定格与流式共用（StreamingPart 走同一
 *  PartView 分发），历史回看同路径自然覆盖。testid 可换（消息级 banner 复用同卡样式，
 *  22c1426 part 级卡与消息级 banner 两路径并存）。 */
export function ErrorPartCard({ text, testid = "message-error-part" }: { text: string; testid?: string }) {
  return (
    <div
      data-testid={testid}
      role="alert"
      className="my-1 flex max-w-full items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="whitespace-pre-wrap break-words min-w-0">{text}</span>
    </div>
  );
}

/** 未支持 part 占位 chip（docs08-r6 任务 10 ①）：常显类型名，不渲染未知载荷 */
function UnsupportedPartChip({ typeLabel }: { typeLabel: string }) {
  const t = useT();
  return (
    <div
      data-testid="unsupported-chip"
      data-unsupported-type={typeLabel}
      className="my-1 inline-flex max-w-full items-center rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
    >
      {t("chat.parts.unsupportedBlock", { type: typeLabel })}
    </div>
  );
}

/** 全空条目计数行（docs08-r6 任务 10 ②）：全部 part 渲染为空的 assistant 条目
 *  此前只剩气泡头部空壳（task-3 全库实证 18 条全空 text 条目），改渲染单行计数 */
function UnsupportedCountLine({ count }: { count: number }) {
  const t = useT();
  return (
    <div
      data-testid="unsupported-count"
      className="my-1 inline-flex max-w-full items-center rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
    >
      {t("chat.parts.unsupportedCount", { n: count })}
    </div>
  );
}

/** 单个 part 分发；未知类型渲染占位 chip（docs08-r6 任务 10 ①） */
export function PartView({
  part,
  sessionId,
  live,
  entryId,
  suppressErrorText,
}: {
  part: WirePart;
  sessionId: string;
  live: boolean;
  /** 所在条目 id（任务 7）：透传给 thinking/toolCall 行用于耗时标签 */
  entryId?: string;
  /** 消息级 errorMessage：相等的 error part 卡跳过（去重，消息级 banner 为准） */
  suppressErrorText?: string;
}) {
  switch (part.type) {
    case "text": {
      const text = typeof part.text === "string" ? part.text : "";
      if (!text) return null;
      return <Markdown text={text} live={live} />;
    }
    case "thinking": {
      const thinking = typeof part.thinking === "string" ? part.thinking : "";
      return <ThinkingBlock thinking={thinking} live={live} entryId={entryId} sessionId={sessionId} />;
    }
    case "image":
      return <ImagePart part={part} />;
    case "image_ref":
      return <ImageRefPlaceholder />;
    case "error": {
      const text = errorPartText(part);
      if (!text) return null;
      // 去重（消息级 stopReason 错误主路径）：part 文本与 errorMessage 相等时以消息级
      // banner 为准，跳过 part 卡重复。
      if (suppressErrorText !== undefined && text === suppressErrorText) return null;
      return <ErrorPartCard text={text} />;
    }
    case "toolCall": {
      const toolCallId = typeof part.id === "string" ? part.id : "";
      const name = typeof part.name === "string" ? part.name : "unknown";
      if (!toolCallId) return null;
      if (name === "todo") {
        return (
          <TodoList
            sessionId={sessionId}
            toolCallId={toolCallId}
            name={name}
            args={part.arguments}
            live={live}
          />
        );
      }
      return (
        <ToolCard
          sessionId={sessionId}
          toolCallId={toolCallId}
          name={name}
          args={part.arguments}
          live={live}
          entryId={entryId}
        />
      );
    }
    default: {
      const typeLabel = typeof part.type === "string" && part.type !== "" ? part.type : "unknown";
      return <UnsupportedPartChip typeLabel={typeLabel} />;
    }
  }
}

/** 定格消息的 part 列表（part 对象引用稳定，随气泡 memo）。
 *  空判上移为计数（docs08-r6 任务 10 ②）：全部 part 不可见时渲染单行「N 个未支持内容块」
 *  替代空壳；有任一可见 part 时逐 part 渲染（无未知类型会话零变化）。 */
export function PartsView({
  parts,
  sessionId,
  live,
  entryId,
  suppressErrorText,
}: {
  parts?: WirePart[];
  sessionId: string;
  live: boolean;
  /** 所在条目 id（任务 7）：透传给 part 分发用于耗时标签 */
  entryId?: string;
  /** 消息级 errorMessage：透传 PartView 去重 */
  suppressErrorText?: string;
}) {
  if (!parts || parts.length === 0) return null;
  if (parts.every((p) => !isRenderablePart(p))) {
    return <UnsupportedCountLine count={parts.length} />;
  }
  return (
    <>
      {parts.map((part, i) => (
        <PartView key={i} part={part} sessionId={sessionId} live={live} entryId={entryId} suppressErrorText={suppressErrorText} />
      ))}
    </>
  );
}

/** 消息级错误文本提取：stopReason==="error" 且 errorMessage 非空字符串才有效，
 *  其余（含 undefined 消息）一律空串不渲染。限流/额度类错误主路径。 */
export function messageErrorText(message?: WireMessage | null): string {
  if (!message || message.stopReason !== "error") return "";
  const m = message.errorMessage;
  return typeof m === "string" ? m : "";
}

/** 消息级错误 banner：复用 ErrorPartCard 样式，testid=message-error-banner。
 *  定格（message-bubble MessageContent）与流式（StreamingErrorBanner）共用。 */
export function MessageErrorBanner({ text }: { text: string }) {
  if (!text) return null;
  return <ErrorPartCard text={text} testid="message-error-banner" />;
}

/** 流式消息级错误 banner：单订阅 streamingMessage 的 stopReason/errorMessage，
 *  非错误态返回稳定空串不重渲。 */
export function StreamingErrorBanner({ sessionId }: { sessionId: string }) {
  const text = useMessagesStore((s) => messageErrorText(s.bySession[sessionId]?.streamingMessage));
  return <MessageErrorBanner text={text} />;
}

/** 流式 part 计数订阅：只随 content 长度变化重渲染（新 part 出现时挂载新 StreamingPart） */
export function StreamingParts({ sessionId }: { sessionId: string }) {
  const count = useMessagesStore((s) => s.bySession[sessionId]?.streamingMessage?.content?.length ?? 0);
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <StreamingPart key={i} sessionId={sessionId} index={i} />
      ))}
    </>
  );
}

/** 单下标订阅：content[i] 引用不变（其他 part delta）则不重渲染 */
function StreamingPart({ sessionId, index }: { sessionId: string; index: number }) {
  const part = useMessagesStore((s) => s.bySession[sessionId]?.streamingMessage?.content?.[index]);
  if (!part) return null;
  return <PartView part={part} sessionId={sessionId} live />;
}

/** toolResult 消息不再单独渲染：结果由 ToolCard 按 toolCallId 关联展示（todo 17）。
 *  保留导出以维持 message-bubble 的调用点结构不动；孤儿 toolResult（无配对卡片）静默不显示。 */
export function ToolResultLine({ message: _message }: { message: WireMessage }) {
  return null;
}
