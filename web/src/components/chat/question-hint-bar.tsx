// 待答提问提示条（r11 todo 6d）：QuestionQueue 常驻挂载退役后输入区上方的细提示条——
// 卡片本体渲染在消息流内锚点位置（message-list 的 mergeQuestionCards 合成层），此处
// 仅提示存在 + 点击定位（onView 回调由 chat-view 接 MessageList.scrollToQuestion）。
// 队列空不渲染（null，与 QueueBar/ActivityBar 同口径）；多 pending 显示条数。
import { CircleHelp } from "lucide-react";
import { useQuestionsStore } from "@/stores/questions";
import { useT } from "@/i18n/i18n";

export function QuestionHintBar({
  sessionId,
  onView,
}: {
  sessionId: string;
  /** 点击查看：定位到最旧（队首）pending 卡 */
  onView: (requestId: string) => void;
}) {
  const t = useT();
  const requests = useQuestionsStore((s) => s.bySession[sessionId]);
  const list = requests ?? [];
  if (list.length === 0) return null;
  return (
    <div data-testid="question-hint-bar" className="shrink-0 px-3 pb-1.5 sm:px-4">
      <button
        type="button"
        data-testid="question-hint-view"
        onClick={() => onView(list[0]!.id)}
        className="mx-auto flex min-h-9 w-full max-w-3xl items-center gap-1.5 rounded-lg border bg-muted/30 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <CircleHelp className="size-3.5 shrink-0 text-primary" aria-hidden />
        <span className="shrink-0">{t("chat.questionCard.hintPending")}</span>
        {list.length > 1 && (
          <span data-testid="question-hint-count" className="shrink-0 rounded-sm bg-muted px-1 py-px tabular-nums">
            {t("chat.questionCard.hintCount", { n: list.length })}
          </span>
        )}
        <span className="ml-auto shrink-0 font-medium text-primary">{t("chat.questionCard.hintView")}</span>
      </button>
    </div>
  );
}
