// part 渲染分发（todo 16 建分发点；todo 17 起工具卡片接管）：
//   text → Markdown；thinking → ThinkingBlock；toolCall → name=todo 走 TodoList 结构化清单
//   （todo-list.tsx，details 缺失时组件内自行降级 ToolCard），其余工具 → ToolCard（tool-card.tsx，
//   含结果折叠展示，toolResult 消息经 toolCallId 关联进卡片，不再单独渲染 ToolResultLine）；
//   image → 内联缩略 + 灯箱；image_ref → 占位降级（todo 23）。
//   todo 25 消息级操作同挂此分发点。
// 流式期间以 part 下标为订阅粒度（StreamingPart 单独订阅 content[i]），
// 单个 part 的 delta 只重渲染该 part 的子树，不触碰兄弟 part 与列表其他气泡。
import { useMessagesStore } from "@/stores/messages";
import type { WireMessage, WirePart } from "@/lib/api";
import { Markdown } from "./markdown";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";
import { ImagePart, ImageRefPlaceholder } from "./image-lightbox";
import { TodoList } from "./todo-list";

/** 单个 part 分发；未知类型静默忽略 */
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
    case "image":
      return <ImagePart part={part} />;
    case "image_ref":
      return <ImageRefPlaceholder />;
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
        />
      );
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

/** toolResult 消息不再单独渲染：结果由 ToolCard 按 toolCallId 关联展示（todo 17）。
 *  保留导出以维持 message-bubble 的调用点结构不动；孤儿 toolResult（无配对卡片）静默不显示。 */
export function ToolResultLine({ message: _message }: { message: WireMessage }) {
  return null;
}
