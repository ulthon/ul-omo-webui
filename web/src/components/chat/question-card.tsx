// 提问卡片（q1）：question 型 UI 请求的结构化交互卡。
// wire 契约（spike q1 实证）：questions 数组逐问渲染（单选 radio / 多选 checkbox），
// 逐问自由文本 + 全局补充 comment；应答 POST /permission {requestId, answers, comment?}——
// 引擎侧 settledQuestionStatus：非空 comment 即落定，否则任一 answer 落定，全空拒收
// （本地同规则预校验省往返）。取消/忽略走 {cancelled:true}（引擎对未知 id 不报错）。
// 倒计时：deadlineAtMs（引擎时钟）驱动；本地过期仅出队兜底（宽限见 store 常量），
// 权威落定以 question_resolved 广播为准。
import { useEffect, useMemo, useState } from "react";
import { CircleHelp, X } from "lucide-react";
import { api } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { QUESTION_EXPIRY_GRACE_MS, useQuestionsStore, type QuestionRequest } from "@/stores/questions";

/** 剩余时间格式化：>1h 显 h:mm:ss，否则 mm:ss；负值（超时宽限窗）显 0:00 */
function formatRemaining(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function QuestionCard({
  sessionId,
  request,
  position,
  total,
}: {
  sessionId: string;
  request: QuestionRequest;
  position: number;
  total: number;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [comment, setComment] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // 倒计时秒级刷新（deadlineAtMs 变化——question_updated——重挂 effect 即重取）
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.deadlineAtMs]);

  const remaining = request.deadlineAtMs - now;
  const expired = remaining <= 0;

  // 本地过期兜底：超时 + 宽限仍无 question_resolved（事件丢失/时钟漂移）则出队；
  // 引擎侧同 deadline 的超时是权威，宽限防早杀
  useEffect(() => {
    if (remaining > -QUESTION_EXPIRY_GRACE_MS) return;
    useQuestionsStore.getState().removeRequest(sessionId, request.id);
  }, [remaining, sessionId, request.id]);

  /** 组装应答 answers：有选择或有文本的问题才入（引擎对未答问题回传 unanswered） */
  const buildAnswers = () => {
    const answers: Record<string, { selected: string[]; text?: string }> = {};
    for (const q of request.questions) {
      const selected = selections[q.id] ?? [];
      const text = (texts[q.id] ?? "").trim();
      if (selected.length === 0 && !text) continue;
      answers[q.id] = text ? { selected, text } : { selected };
    }
    return answers;
  };

  const respond = async (payload: { answers?: Record<string, { selected: string[]; text?: string }>; comment?: string } | { cancelled: true }) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.respondPermission(sessionId, { requestId: request.id, ...payload });
      useQuestionsStore.getState().removeRequest(sessionId, request.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "应答失败，请重试", "error");
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const answers = buildAnswers();
    const trimmedComment = comment.trim();
    if (Object.keys(answers).length === 0 && !trimmedComment) {
      showToast("请至少回答一个问题或填写补充说明", "error");
      return;
    }
    void respond(
      trimmedComment ? { answers, comment: trimmedComment } : { answers },
    );
  };

  const toggleOption = (questionId: string, label: string, multiSelect: boolean) => {
    setSelections((prev) => {
      const current = prev[questionId] ?? [];
      if (multiSelect) {
        const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
        return { ...prev, [questionId]: next };
      }
      return { ...prev, [questionId]: current.includes(label) && current.length === 1 ? [] : [label] };
    });
  };

  const deadlineLabel = useMemo(() => formatRemaining(remaining), [remaining]);

  return (
    <div
      data-testid="question-card"
      className="mx-auto w-full max-w-3xl rounded-xl border bg-card shadow-sm"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <CircleHelp className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="text-sm font-medium">
          助手提问
          {total > 1 && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              第 {position}/{total} 个待处理
            </span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {request.waitForAnswer ? (
            <span>等待回答</span>
          ) : (
            <span>可稍后回答</span>
          )}
          <span
            data-testid="question-countdown"
            className={expired ? "font-medium text-destructive" : "tabular-nums"}
          >
            {expired ? "已超时" : deadlineLabel}
          </span>
        </span>
      </div>

      <div className="space-y-4 px-3 py-3">
        {request.questions.map((q) => {
          const selected = selections[q.id] ?? [];
          return (
            <div key={q.id} data-testid={`question-item-${q.id}`}>
              <p className="text-sm font-medium text-foreground">
                {q.header ? <span className="mr-1.5 text-xs font-normal text-muted-foreground">{q.header}</span> : null}
                {q.question}
              </p>
              <div className="mt-2 flex flex-col gap-1.5">
                {q.options.map((option) => {
                  const isSelected = selected.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      disabled={busy || expired}
                      data-testid="question-option"
                      data-selected={isSelected || undefined}
                      onClick={() => toggleOption(q.id, option.label, q.multiSelect)}
                      className="min-h-11 w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50 data-[selected]:border-primary data-[selected]:bg-primary/5"
                    >
                      <span className="flex items-center gap-2">
                        {q.multiSelect ? (
                          <span
                            className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] border ${isSelected ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}
                            aria-hidden
                          >
                            {isSelected ? <span className="text-[10px] leading-none">✓</span> : null}
                          </span>
                        ) : (
                          <span
                            className={`size-4 shrink-0 rounded-full border ${isSelected ? "border-primary bg-primary" : "border-input"}`}
                            aria-hidden
                          >
                            {isSelected ? <span className="block size-1.5 translate-x-[4px] translate-y-[4px] rounded-full bg-primary-foreground" /> : null}
                          </span>
                        )}
                        <span>
                          {option.label}
                          {option.description ? (
                            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{option.description}</span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  );
                })}
                <input
                  data-testid={`question-text-${q.id}`}
                  value={texts[q.id] ?? ""}
                  disabled={busy || expired}
                  placeholder="或输入自定义答案（可选）"
                  onChange={(e) => setTexts((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  className="min-h-11 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                />
              </div>
            </div>
          );
        })}

        <div>
          <textarea
            data-testid="question-comment"
            value={comment}
            rows={2}
            disabled={busy || expired}
            placeholder="还有什么要补充的？（可选，提交给助手）"
            onChange={(e) => setComment(e.target.value)}
            className="w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">
          {request.waitForAnswer ? "不应答将挂起当前回合（超时自动继续）" : "回合已继续，回答将作为新消息送达"}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={busy || expired}
            data-testid="question-dismiss"
            onClick={() => void respond({ cancelled: true })}
            className="flex min-h-11 items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <X className="size-3" />
            忽略
          </button>
          <button
            type="button"
            disabled={busy || expired}
            data-testid="question-submit"
            onClick={submit}
            className="min-h-11 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-50"
          >
            提交回答
          </button>
        </div>
      </div>
    </div>
  );
}
