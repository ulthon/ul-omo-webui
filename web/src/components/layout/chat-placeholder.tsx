// 主区占位：对话流实体由 todo 16 填充（流式渲染/markdown/工具卡片）。
import { MessagesSquare } from "lucide-react";

export function ChatPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <MessagesSquare className="size-10 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">从左侧选择会话，或新建一个会话开始对话</p>
      </div>
    </div>
  );
}
