// 消息气泡（todo 16）：定格条目按 entryId 订阅（条目对象引用稳定，别的消息更新不触发本气泡）；
// 流式气泡只订阅 streamingMessage 存在性，part 级更新下沉到 parts.tsx 的单下标订阅。
import { memo } from "react";
import { useMessagesStore } from "@/stores/messages";
import type { WireMessage, WireEntry } from "@/lib/api";
import { PartsView, ToolResultLine, StreamingParts } from "./parts";
import { ImagePart } from "./image-lightbox";

function formatTime(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function BubbleShell({
  role,
  timestamp,
  interrupted,
  live,
  children,
}: {
  role: "user" | "assistant";
  timestamp: string | null;
  interrupted?: boolean;
  live?: boolean;
  children: React.ReactNode;
}) {
  const time = formatTime(timestamp);
  if (role === "user") {
    return (
      <div className="flex w-full justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground">
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="w-full" data-streaming={live ? "true" : undefined}>
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{live ? "正在回复" : "助手"}</span>
        {live && <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />}
        {time && <span>{time}</span>}
        {interrupted && (
          <span className="rounded-sm bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">已中断</span>
        )}
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
  return (
    <BubbleShell
      role={role}
      timestamp={typeof entry.timestamp === "string" ? entry.timestamp : null}
      interrupted={role === "assistant" ? interrupted : undefined}
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
    <BubbleShell role="assistant" timestamp={null} live>
      <StreamingParts sessionId={sessionId} />
    </BubbleShell>
  );
}
