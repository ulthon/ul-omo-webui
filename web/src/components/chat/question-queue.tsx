// 提问队列容器（q1，docs08-r7 任务 14）：渲染会话内未决提问（到达序），挂在输入区上方
// （与权限队列同位）。多卡堆叠逐卡收敛：默认仅最新一张展开，其余折叠为单行摘要可展开；
// 无自动放行逻辑（提问无 auto-allow 语义）；对账拉取在 chat-view 会话打开时进行。
import { useState } from "react";
import { useQuestionsStore } from "@/stores/questions";
import { QuestionCard } from "./question-card";

export function QuestionQueue({ sessionId }: { sessionId: string }) {
  const requests = useQuestionsStore((s) => s.bySession[sessionId]);
  // 用户手动展开/折叠覆盖（按请求 id）；无覆盖时默认仅最新（末位）展开
  const [userExpanded, setUserExpanded] = useState<ReadonlySet<string>>(new Set());
  const [userCollapsed, setUserCollapsed] = useState<ReadonlySet<string>>(new Set());

  if (!requests || requests.length === 0) return null;

  const latestId = requests[requests.length - 1]?.id;
  const isCollapsed = (id: string) =>
    userExpanded.has(id) ? false : userCollapsed.has(id) ? true : id !== latestId;
  const toggle = (id: string, collapsed: boolean) => {
    if (collapsed) {
      setUserExpanded((prev) => new Set(prev).add(id));
      setUserCollapsed((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } else {
      setUserCollapsed((prev) => new Set(prev).add(id));
      setUserExpanded((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="shrink-0 px-3 pb-1.5 sm:px-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {requests.map((request, i) => (
          <QuestionCard
            key={request.id}
            sessionId={sessionId}
            request={request}
            position={i + 1}
            total={requests.length}
            collapsed={isCollapsed(request.id)}
            onToggleCollapse={() => toggle(request.id, isCollapsed(request.id))}
          />
        ))}
      </div>
    </div>
  );
}
