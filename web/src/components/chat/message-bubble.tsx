// 消息气泡（todo 16）：定格条目按 entryId 订阅（条目对象引用稳定，别的消息更新不触发本气泡）；
// 流式气泡只订阅 streamingMessage 存在性，part 级更新下沉到 parts.tsx 的单下标订阅。
// 消息级操作（todo 25）：user/assistant 定格气泡挂 MessageActions（复制原文/重试 fork）。
import { memo, useState } from "react";
import { useMessagesStore } from "@/stores/messages";
import { messageModel, shortModelName, type WireMessage, type WireEntry } from "@/lib/api";
import { PartsView, ToolResultLine, StreamingParts } from "./parts";
import { useLocaleStore, useT } from "@/i18n/i18n";
import { ImagePart } from "./image-lightbox";
import { MessageActions } from "./message-actions";
import { isLongUserText } from "./user-text-collapse";

// user 长文本折叠阈值（docs08-r6 任务 14）：仅 user 消息；assistant 回复永不折叠。
// 判定用纯字符估算而非运行时测高：气泡宽度随视口/图片混排变化，测高在 SSR/测试环境不可用，
// 字符阈值判定稳定可测；3 行视觉本身由 line-clamp-3 保证，阈值只决定是否出现展开钮。
// 估算行数：按换行分段，每段按 ~40 字/行（user 气泡 85% 宽、text-sm 下中文 3 行量级）上取整，
// 估算超过 3 行即折叠；短消息（含边界附近）不出钮，无 flicker。判定纯函数在
// ./user-text-collapse 叶模块（fast-refresh lint 口径，单测直接驱动）。

/** 展开态跨重渲染/虚拟列表重挂载保持（docs08-r6 任务 14）：以 entryId 为键的模块级记录；
 *  组件内 useState 管当次挂载，重挂载时从记录恢复，流式/兄弟更新不触碰。 */
const expandedUserTexts = new Set<string>();

/** user 长文本折叠块：默认 line-clamp-3 收缩 + 展开/收起钮；短文本不渲染钮；
 *  展开态渲染完整文本（折叠只截显示，数据始终完整在 DOM）。 */
function CollapsibleUserText({ text, entryId }: { text: string; entryId?: string }) {
  const t = useT();
  const collapsible = isLongUserText(text);
  const [expanded, setExpanded] = useState(() => collapsible && entryId !== undefined && expandedUserTexts.has(entryId));
  if (!collapsible) {
    return <div data-user-text="" className="text-sm leading-relaxed whitespace-pre-wrap break-words">{text}</div>;
  }
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (entryId !== undefined) {
      if (next) expandedUserTexts.add(entryId);
      else expandedUserTexts.delete(entryId);
    }
  };
  return (
    <div>
      <div
        data-user-text=""
        data-clamped={expanded ? undefined : ""}
        className={expanded ? "text-sm leading-relaxed whitespace-pre-wrap break-words" : "text-sm leading-relaxed whitespace-pre-wrap break-words line-clamp-3"}
      >
        {text}
      </div>
      <button
        type="button"
        data-testid="user-text-toggle"
        aria-expanded={expanded}
        onClick={toggle}
        className="mt-1 block text-xs leading-4 text-primary-foreground/70 underline underline-offset-2"
      >
        {expanded ? t("chat.messageBubble.collapse") : t("chat.messageBubble.expand")}
      </button>
    </div>
  );
}

// locale 显式传入（任务12）：避免 toLocaleTimeString([]) 依赖宿主隐式 locale
function formatTime(timestamp: string | null, locale: string): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

export function BubbleShell({
  role,
  timestamp,
  model,
  interrupted,
  live,
  queued,
  actions,
  children,
}: {
  role: "user" | "assistant";
  timestamp: string | null;
  /** assistant 消息的模型名（消息级 model 字段，B11 同源）；头部行常驻短名显示 */
  model?: string | null;
  interrupted?: boolean;
  live?: boolean;
  queued?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const time = formatTime(timestamp, locale);
  if (role === "user") {
    return (
      <div className="group flex w-full items-center justify-end gap-1">
        {actions}
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground">
          {/* 排队中徽标（docs08-r4 任务 11）：本地排队占位专属；服务端真值事件吸收占位后消失 */}
          {queued && (
            <span
              data-testid="queued-badge"
              className="mb-1 block w-fit rounded-sm bg-primary-foreground/20 px-1.5 py-px text-[11px] leading-4"
            >
              {t("chat.messageBubble.queued")}
            </span>
          )}
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="group w-full" data-streaming={live ? "true" : undefined}>
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{live ? t("chat.messageBubble.live") : t("chat.messageBubble.assistant")}</span>
        {/* 模型短名常驻（2026-10-15 可见性缺口 ②；docs08-r5 任务 12 放宽到 live 态）：逐条可知
            由哪只模型作答，替代 B11 切换点分隔线（连续同模型段零标记的盲区）；流式态与
            "正在回复"并存，settle 态不变；无 model 字段（老数据/裸流）不渲染不误报 */}
        {model && <span className="max-w-[40vw] truncate opacity-70">{shortModelName(model)}</span>}
        {live && <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />}
        {time && <span>{time}</span>}
        {interrupted && (
          <span className="rounded-sm bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">{t("chat.messageBubble.interrupted")}</span>
        )}
        {actions}
      </div>
      <div className="pl-0.5">{children}</div>
    </div>
  );
}

/** 定格消息渲染（user 右侧纯文本气泡 / assistant 左侧 markdown / toolResult 最小行） */
function MessageContent({
  message,
  sessionId,
  live,
  entryId,
}: {
  message: WireMessage;
  sessionId: string;
  live: boolean;
  /** user 长文本折叠展开态的持久化键（docs08-r6 任务 14） */
  entryId?: string;
}) {
  if (message.role === "user") {
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n");
    // 用户上传图内联 base64 image part（P1-3 实证）：文本 + 图片同气泡渲染（todo 23）
    const images = parts.filter((p) => p.type === "image");
    return (
      <div className="space-y-2">
        {text ? <CollapsibleUserText text={text} entryId={entryId} /> : null}
        {images.map((p, i) => (
          <ImagePart key={i} part={p} />
        ))}
      </div>
    );
  }
  if (message.role === "toolResult") {
    return <ToolResultLine message={message} />;
  }
  return <PartsView parts={message.content} sessionId={sessionId} live={live} />;
}

/** 定格条目气泡：以 entryId 订阅单条 entry（upsertEntry 只替换被改条目的对象引用） */
export const EntryBubble = memo(function EntryBubble({
  sessionId,
  entryId,
  interrupted,
}: {
  sessionId: string;
  entryId: string;
  interrupted: boolean;
}) {
  const entry = useMessagesStore((s) => {
    const entries = s.bySession[sessionId]?.entries;
    if (!entries) return null;
    const found = entries.find((e) => e.id === entryId);
    return isRenderableEntry(found) ? found : null;
  });
  if (!entry) return null;
  const message = entry.message as WireMessage;
  const role = message.role === "user" ? "user" : "assistant";
  // 排队中标记（docs08-r4 任务 11）：本地排队占位条目带 queued 字段（消息 store 写入）
  const queued = role === "user" && entry.queued !== undefined;
  // 消息级操作仅挂 user/assistant 定格气泡（toolResult 走 ToolCard 关联展示，无气泡菜单）
  const showActions = message.role === "user" || message.role === "assistant";
  return (
    <BubbleShell
      role={role}
      timestamp={typeof entry.timestamp === "string" ? entry.timestamp : null}
      model={role === "assistant" ? messageModel(entry) : undefined}
      interrupted={role === "assistant" ? interrupted : undefined}
      queued={queued}
      actions={showActions ? <MessageActions sessionId={sessionId} entryId={entry.id} align={role === "user" ? "end" : "start"} /> : undefined}
    >
      <MessageContent message={message} sessionId={sessionId} live={false} entryId={entry.id} />
    </BubbleShell>
  );
});

function isRenderableEntry(entry: WireEntry | undefined): entry is WireEntry & { id: string } {
  if (!entry || typeof entry.id !== "string") return false;
  if (entry.type !== "message") return false;
  const msg = entry.message as WireMessage | undefined;
  return Boolean(msg && typeof msg.role === "string");
}

/** custom_message 占位行（docs08-r6 任务 10 ③）：display=true 且非记忆标记的
 *  custom_message 历史条目此前无渲染分支（task-3 枚举：18 种 customType 均无实物
 *  结构样本，禁猜字段），以轻量占位行兜底消解空壳路径；只读 customType
 *  （task-3 实测键集 {type, customType, content, display, id, parentId, timestamp} 内字段）。
 *  渲染门与 buildMessageItems 分类门同判 display === true（防直接挂载绕过分类门）。 */
export const CustomMessageBubble = memo(function CustomMessageBubble({
  sessionId,
  entryId,
}: {
  sessionId: string;
  entryId: string;
}) {
  const entry = useMessagesStore((s) => {
    const entries = s.bySession[sessionId]?.entries;
    const found = entries?.find((e) => e.id === entryId);
    return found !== undefined && found.type === "custom_message" ? found : null;
  });
  const t = useT();
  if (!entry || entry.display !== true) return null;
  const customType = typeof entry.customType === "string" ? entry.customType : "unknown";
  return (
    <div
      data-testid="custom-message-chip"
      data-custom-type={customType}
      className="my-0.5 inline-flex max-w-full items-center rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
    >
      {t("chat.customMessage.unsupported", { customType })}
    </div>
  );
});

/** 流式 assistant 气泡：本层只订阅"存在性"，delta 由 StreamingParts 按下标消化 */
export function StreamingBubble({ sessionId }: { sessionId: string }) {
  const present = useMessagesStore((s) => s.bySession[sessionId]?.streamingMessage != null);
  if (!present) return null;
  return (
    <BubbleShell role="assistant" timestamp={null} model={streamingModelOf(sessionId)} live>
      <StreamingParts sessionId={sessionId} />
    </BubbleShell>
  );
}

/** 流式消息的模型字段（message_start 载荷透传；无则 null——老数据/裸流不显示短名，头部不误报） */
function streamingModelOf(sessionId: string): string | null {
  const msg = useMessagesStore.getState().bySession[sessionId]?.streamingMessage;
  if (!msg) return null;
  const model = (msg as { model?: unknown }).model;
  return typeof model === "string" && model !== "" ? model : null;
}
