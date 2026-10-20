// 消息气泡（todo 16）：定格条目按 entryId 订阅（条目对象引用稳定，别的消息更新不触发本气泡）；
// 流式气泡只订阅 streamingMessage 存在性，part 级更新下沉到 parts.tsx 的单下标订阅。
// 消息级操作（todo 25）：user/assistant 定格气泡挂 MessageActions（复制原文/重试 fork）。
import { memo } from "react";
import { useMessagesStore } from "@/stores/messages";
import { messageModel, shortModelName, type WireMessage, type WireEntry } from "@/lib/api";
import { PartsView, ToolResultLine, StreamingParts } from "./parts";
import { useLocaleStore, useT } from "@/i18n/i18n";
import { ImagePart } from "./image-lightbox";
import { MessageActions } from "./message-actions";

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
}: {
  message: WireMessage;
  sessionId: string;
  live: boolean;
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
        {text ? <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">{text}</div> : null}
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
      <MessageContent message={message} sessionId={sessionId} live={false} />
    </BubbleShell>
  );
});

function isRenderableEntry(entry: WireEntry | undefined): entry is WireEntry & { id: string } {
  if (!entry || typeof entry.id !== "string") return false;
  if (entry.type !== "message") return false;
  const msg = entry.message as WireMessage | undefined;
  return Boolean(msg && typeof msg.role === "string");
}

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
