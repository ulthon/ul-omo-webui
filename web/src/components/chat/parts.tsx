// part 渲染分发（todo 16，todo 17/23/25 的挂载面）：
//   text → Markdown；thinking → ThinkingBlock；toolCall → ToolLine 最小占位行
//   （todo 17 工具卡片在此接管；todo 23 todo 渲染、todo 25 消息级操作同挂此分发点）。
// 流式期间以 part 下标为订阅粒度（StreamingPart 单独订阅 content[i]），
// 单个 part 的 delta 只重渲染该 part 的子树，不触碰兄弟 part 与列表其他气泡。
import { useMessagesStore } from "@/stores/messages";
import type { WireMessage, WirePart } from "@/lib/api";
import { Markdown } from "./markdown";
import { ThinkingBlock } from "./thinking-block";
import { CircleDashed, CircleCheck, Wrench } from "lucide-react";

/** 工具调用最小占位行：toolName + 运行状态；todo 17 工具卡片替换此组件 */
export function ToolLine({
  sessionId,
  toolCallId,
  name,
  live,
}: {
  sessionId: string;
  toolCallId: string;
  name: string;
  live: boolean;
}) {
  const status = useMessagesStore((s) => s.bySession[sessionId]?.toolRuns[toolCallId]?.status);
  const running = status ? status === "running" : live;
  return (
    <div
      data-tool-call={toolCallId}
      className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
    >
      <Wrench className="size-3 shrink-0" />
      <span className="truncate font-mono">{name}</span>
      {running ? (
        <span className="flex shrink-0 items-center gap-1 animate-pulse">
          <CircleDashed className="size-3" /> 运行中
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          <CircleCheck className="size-3" /> 完成
        </span>
      )}
    </div>
  );
}

/** 单个 part 分发；未知类型静默忽略（图片等后续 todo 再补） */
export function PartView({ part, sessionId, live }: { part: WirePart; sessionId: string; live: boolean }) {
  switch (part.type) {
    case "text": {
      const text = typeof part.text === "string" ? part.text : "";
      if (!text) return null;
      return <Markdown text={text} live={live} />;
    }
    case "thinking": {
      const thinking = typeof part.thinking === "string" ? part.thinking : "";
      return <ThinkingBlock thinking={thinking} live={live} />;
    }
    case "toolCall": {
      const toolCallId = typeof part.id === "string" ? part.id : "";
      const name = typeof part.name === "string" ? part.name : "unknown";
      if (!toolCallId) return null;
      return <ToolLine sessionId={sessionId} toolCallId={toolCallId} name={name} live={live} />;
    }
    default:
      return null;
  }
}

/** 定格消息的 part 列表（part 对象引用稳定，随气泡 memo） */
export function PartsView({ parts, sessionId, live }: { parts?: WirePart[]; sessionId: string; live: boolean }) {
  if (!parts || parts.length === 0) return null;
  return (
    <>
      {parts.map((part, i) => (
        <PartView key={i} part={part} sessionId={sessionId} live={live} />
      ))}
    </>
  );
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

/** toolResult 消息最小行（完整工具结果展示归 todo 17 工具卡片） */
export function ToolResultLine({ message }: { message: WireMessage }) {
  const name = typeof message.toolName === "string" ? message.toolName : "tool";
  const content = Array.isArray(message.content) ? message.content : [];
  const firstText = content.find((p) => p.type === "text" && typeof p.text === "string");
  const preview = firstText ? (firstText.text as string).slice(0, 160) : "";
  return (
    <div className="my-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">
      <span className="font-mono">「{name}」</span>返回结果
      {preview ? <span className="ml-1 opacity-80">：{preview}{preview.length >= 160 ? "…" : ""}</span> : null}
    </div>
  );
}
