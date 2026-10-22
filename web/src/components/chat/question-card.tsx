// 提问卡片（q1，docs08-r7 任务 14 重设计）：question 型 UI 请求的结构化交互卡。
// wire 契约（spike q1/任务 14 实证）：questions 数组逐问渲染（单选 radio / 多选 checkbox），
// 逐问自由文本 + 全局补充 comment；应答 POST /permission {requestId, answers, comment?}——
// 引擎侧 ConnectionQuestionBridge.respond 要求载荷含 answers 键（可为 {}）才进入
// settledQuestionStatus：非空 comment 即落定（comment-submitted），否则任一 answer 落定
// （answered），全空拒收（本地预校验拦截空提交）。取消/忽略走 {cancelled:true}。
// 逐题切换（stepper）：一次只渲染当前题 + 步进指示 + 上/下一题（可来回翻、已答标记）；
// 卡体超高可滚，切题滚动复位。提交后不本地出队（失败不消失）：等 question_resolved
// 广播出队；超时未确认显重试/取消兜底（引擎拒收静默场景的兜底）。
// 倒计时：deadlineAtMs（引擎时钟）驱动；本地过期仅出队兜底（宽限见 store 常量），
// 权威落定以 question_resolved 广播为准。
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleHelp, X } from "lucide-react";
import { api } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { useUiStore } from "@/stores/ui";
import { QUESTION_EXPIRY_GRACE_MS, useQuestionsStore, type QuestionRequest } from "@/stores/questions";

/** 提交后确认兜底窗（毫秒）：POST 成功但 question_resolved 未达（事件丢失/引擎静默
 * 拒收）时显重试/取消。权威出队只认 question_resolved / 取消成功。 */
const SUBMIT_CONFIRM_FALLBACK_MS = 5000;

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
  collapsed = false,
  onToggleCollapse,
}: {
  sessionId: string;
  request: QuestionRequest;
  position: number;
  total: number;
  /** 多卡堆叠折叠态（question-queue 逐卡收敛：默认仅最新展开） */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [comment, setComment] = useState("");
  const [inlineError, setInlineError] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const questions = request.questions;
  const stepIndex = Math.min(step, Math.max(0, questions.length - 1));
  const current = questions[stepIndex];

  // 倒计时秒级刷新（deadlineAtMs 变化——question_updated——重挂 effect 即重取）
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.deadlineAtMs]);

  // 提交后确认兜底：超时未见 question_resolved 出队则显重试/取消（不自动消失）
  useEffect(() => {
    if (!submitted) return;
    const timer = setTimeout(() => setShowFallback(true), SUBMIT_CONFIRM_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [submitted]);

  const t = useT();
  const remaining = request.deadlineAtMs - now;
  const expired = remaining <= 0;

  // 本地过期兜底：超时 + 宽限仍无 question_resolved（事件丢失/时钟漂移）则出队；
  // 引擎侧同 deadline 的超时是权威，宽限防早杀
  useEffect(() => {
    if (remaining > -QUESTION_EXPIRY_GRACE_MS) return;
    useQuestionsStore.getState().removeRequest(sessionId, request.id);
  }, [remaining, sessionId, request.id]);

  /** 组装应答 answers：有选择或有文本的问题才入（引擎对未答问题回传 unanswered）。
   *  comment-only 时返回 {}——引擎 respond 要求 answers 键在场（空对象合法）。 */
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
      if ("cancelled" in payload) {
        // 取消语义确定（引擎 cancel 恒落定 cancelled 广播），本地立即出队
        useQuestionsStore.getState().removeRequest(sessionId, request.id);
      } else {
        // 应答提交：不本地出队（失败不消失），等 question_resolved 广播；
        // 兜底窗超时显重试/取消
        setSubmitted(true);
      }
    } catch (err) {
      showToast(apiErrorMessage(err, "chat.questionCard.submitFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const answers = buildAnswers();
    const trimmedComment = comment.trim();
    if (Object.keys(answers).length === 0 && !trimmedComment) {
      // 空提交前端拦截（内联错误态）：引擎对全空恒拒收，省往返
      setInlineError(true);
      return;
    }
    setInlineError(false);
    void respond(
      trimmedComment ? { answers, comment: trimmedComment } : { answers },
    );
  };

  const toggleOption = (questionId: string, label: string, multiSelect: boolean) => {
    setInlineError(false);
    setSelections((prev) => {
      const current = prev[questionId] ?? [];
      if (multiSelect) {
        const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
        return { ...prev, [questionId]: next };
      }
      return { ...prev, [questionId]: current.includes(label) && current.length === 1 ? [] : [label] };
    });
  };

  const goTo = (next: number) => {
    setStep(next);
    setInlineError(false);
    // 切题滚动复位（手机档卡体可滚时归位当前题首行）
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

  const questionAnswered = (q: { id: string }) =>
    (selections[q.id]?.length ?? 0) > 0 || (texts[q.id] ?? "").trim().length > 0;

  const deadlineLabel = useMemo(() => formatRemaining(remaining), [remaining]);

  // 多卡堆叠折叠态：单行摘要（题干截断 + 位置），点击展开
  if (collapsed) {
    const first = questions[0];
    return (
      <div
        data-testid="question-card-collapsed"
        className="mx-auto w-full max-w-3xl rounded-xl border bg-card shadow-sm"
      >
        <button
          type="button"
          data-testid="question-collapse-toggle"
          onClick={onToggleCollapse}
          aria-expanded={false}
          className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
        >
          <CircleHelp className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="truncate text-sm">
            {first ? first.question : t("chat.questionCard.title")}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {t("chat.questionCard.position", { position, total })}
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="question-card"
      className="mx-auto flex w-full max-w-3xl flex-col rounded-xl border bg-card shadow-sm"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <CircleHelp className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="text-sm font-medium">
          {t("chat.questionCard.title")}
          {total > 1 && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {t("chat.questionCard.position", { position, total })}
            </span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {request.waitForAnswer ? (
            <span>{t("chat.questionCard.waiting")}</span>
          ) : (
            <span>{t("chat.questionCard.later")}</span>
          )}
          <span
            data-testid="question-countdown"
            className={expired ? "font-medium text-destructive" : "tabular-nums"}
          >
            {expired ? t("chat.questionCard.expired") : deadlineLabel}
          </span>
        </span>
      </div>

      {questions.length > 1 && (
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <span data-testid="question-step-indicator" className="shrink-0 text-xs font-medium text-foreground">
            {t("chat.questionCard.stepPosition", { step: stepIndex + 1, count: questions.length })}
          </span>
          <div className="flex items-center gap-1" role="tablist" aria-label={t("chat.questionCard.stepPosition", { step: stepIndex + 1, count: questions.length })}>
            {questions.map((q, i) => (
              <button
                key={q.id}
                type="button"
                data-testid={`question-step-dot-${i}`}
                data-current={i === stepIndex || undefined}
                data-answered={questionAnswered(q) || undefined}
                aria-label={t("chat.questionCard.stepJump", { step: i + 1 })}
                aria-current={i === stepIndex ? "step" : undefined}
                onClick={() => goTo(i)}
                className="flex size-6 items-center justify-center rounded-full text-[10px] leading-none transition-colors hover:bg-muted"
              >
                <span
                  className={`flex size-2.5 items-center justify-center rounded-full ${
                    i === stepIndex
                      ? "bg-primary"
                      : questionAnswered(q)
                        ? "bg-primary/40"
                        : "bg-muted-foreground/30"
                  }`}
                />
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              data-testid="question-step-prev"
              disabled={stepIndex === 0 || busy || expired}
              onClick={() => goTo(stepIndex - 1)}
              className="flex min-h-9 items-center gap-0.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <ChevronLeft className="size-3.5" aria-hidden />
              {t("chat.questionCard.prevQuestion")}
            </button>
            <button
              type="button"
              data-testid="question-step-next"
              disabled={stepIndex >= questions.length - 1 || busy || expired}
              onClick={() => goTo(stepIndex + 1)}
              className="flex min-h-9 items-center gap-0.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              {t("chat.questionCard.nextQuestion")}
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      )}

      <div ref={bodyRef} className="max-h-[60vh] space-y-4 overflow-y-auto px-3 py-3">
        {current && (
          <div data-testid={`question-item-${current.id}`}>
            <p className="text-sm font-medium text-foreground">
              {current.header ? <span className="mr-1.5 text-xs font-normal text-muted-foreground">{current.header}</span> : null}
              {current.question}
            </p>
            <div className="mt-2 flex flex-col gap-1.5">
              {current.options.map((option) => {
                const selected = (selections[current.id] ?? []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    disabled={busy || expired || submitted}
                    data-testid="question-option"
                    data-selected={selected || undefined}
                    onClick={() => toggleOption(current.id, option.label, current.multiSelect)}
                    className="min-h-11 w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50 data-[selected]:border-primary data-[selected]:bg-primary/5"
                  >
                    <span className="flex items-center gap-2">
                      {current.multiSelect ? (
                        <span
                          className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}
                          aria-hidden
                        >
                          {selected ? <span className="text-[10px] leading-none">✓</span> : null}
                        </span>
                      ) : (
                        <span
                          className={`size-4 shrink-0 rounded-full border ${selected ? "border-primary bg-primary" : "border-input"}`}
                          aria-hidden
                        >
                          {selected ? <span className="block size-1.5 translate-x-[4px] translate-y-[4px] rounded-full bg-primary-foreground" /> : null}
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
                data-testid={`question-text-${current.id}`}
                value={texts[current.id] ?? ""}
                disabled={busy || expired || submitted}
                placeholder={t("chat.questionCard.customPlaceholder")}
                onChange={(e) => {
                  setInlineError(false);
                  setTexts((prev) => ({ ...prev, [current.id]: e.target.value }));
                }}
                className="min-h-11 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              />
            </div>
          </div>
        )}
      </div>

      <div className="border-t px-3 pt-2">
        <textarea
          data-testid="question-comment"
          value={comment}
          rows={2}
          disabled={busy || expired || submitted}
          placeholder={t("chat.questionCard.commentPlaceholder")}
          onChange={(e) => setComment(e.target.value)}
          className="w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
        {inlineError && (
          <p data-testid="question-inline-error" role="alert" className="pb-1 text-xs font-medium text-destructive">
            {t("chat.questionCard.needAnswer")}
          </p>
        )}
        {submitted && !showFallback && (
          <p data-testid="question-submit-pending" className="pb-1 text-xs text-muted-foreground">
            {t("chat.questionCard.submitPending")}
          </p>
        )}
        {submitted && showFallback && (
          <div data-testid="question-submit-fallback" className="flex items-center gap-2 pb-1">
            <p className="text-xs text-destructive">{t("chat.questionCard.submitFallback")}</p>
            <button
              type="button"
              data-testid="question-submit-retry"
              disabled={busy}
              onClick={submit}
              className="min-h-9 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted disabled:opacity-50"
            >
              {t("chat.questionCard.retrySubmit")}
            </button>
            <button
              type="button"
              data-testid="question-submit-cancel"
              disabled={busy}
              onClick={() => void respond({ cancelled: true })}
              className="min-h-9 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {t("chat.questionCard.cancelSubmit")}
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">
          {request.waitForAnswer ? t("chat.questionCard.pendingHint") : t("chat.questionCard.continuedHint")}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={busy || expired || submitted}
            data-testid="question-dismiss"
            onClick={() => void respond({ cancelled: true })}
            className="flex min-h-11 items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <X className="size-3" />
            {t("chat.questionCard.ignore")}
          </button>
          <button
            type="button"
            disabled={busy || expired || submitted}
            data-testid="question-submit"
            onClick={submit}
            className="min-h-11 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-50"
          >
            {t("chat.questionCard.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
