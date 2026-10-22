// part 渲染分发（todo 16 建分发点；todo 17 起工具卡片接管）：
//   text → Markdown；thinking → ThinkingBlock；toolCall → name=todo 走 TodoList 结构化清单
//   （todo-list.tsx，details 缺失时组件内自行降级 ToolCard），其余工具 → ToolCard（tool-card.tsx，
//   含结果折叠展示，toolResult 消息经 toolCallId 关联进卡片，不再单独渲染 ToolResultLine）；
//   image → 内联缩略 + 灯箱；image_ref → 占位降级（todo 23）。
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
}: {
  part: WirePart;
  sessionId: string;
  live: boolean;
  /** 所在条目 id（任务 7）：透传给 thinking/toolCall 行用于耗时标签 */
  entryId?: string;
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
}: {
  parts?: WirePart[];
  sessionId: string;
  live: boolean;
  /** 所在条目 id（任务 7）：透传给 part 分发用于耗时标签 */
  entryId?: string;
}) {
  if (!parts || parts.length === 0) return null;
  if (parts.every((p) => !isRenderablePart(p))) {
    return <UnsupportedCountLine count={parts.length} />;
  }
  return (
    <>
      {parts.map((part, i) => (
        <PartView key={i} part={part} sessionId={sessionId} live={live} entryId={entryId} />
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
