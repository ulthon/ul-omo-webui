// 主区：对话流实体（todo 16）。真实实现见 components/chat/chat-view.tsx，
// 这里保留原挂载点让 shell.tsx 布局零改动。
import { ChatView } from "@/components/chat/chat-view";

export function ChatPlaceholder() {
  return <ChatView />;
}
