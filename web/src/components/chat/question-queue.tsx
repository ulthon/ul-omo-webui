// 提问队列容器（q1）：渲染会话内未决提问（到达序），挂在输入区上方（与权限队列同位）。
// 无自动放行逻辑（提问无 auto-allow 语义）；对账拉取在 chat-view 会话打开时进行。
import { useQuestionsStore } from "@/stores/questions";
import { QuestionCard } from "./question-card";

export function QuestionQueue({ sessionId }: { sessionId: string }) {
  const requests = useQuestionsStore((s) => s.bySession[sessionId]);

  if (!requests || requests.length === 0) return null;
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
          />
        ))}
      </div>
    </div>
  );
}
