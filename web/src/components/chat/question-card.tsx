// 提问卡片（q1，docs08-r7 任务 14 重设计；r11 todo 6 控件模型重构）：
// question 型 UI 请求的结构化交互卡，渲染于消息流内锚点位置（message-list 合成层）。
// wire 契约（spike q1/任务 14 实证）：questions 数组逐问渲染（单选 radio / 多选 checkbox），
// 逐问自由文本 + 全局补充 comment；应答 POST /permission {requestId, answers, comment?}——
// 引擎侧 ConnectionQuestionBridge.respond 要求载荷含 answers 键（可为 {}）才进入
// settledQuestionStatus：非空 comment 即落定（comment-submitted），否则任一 answer 落定
// （answered），全空拒收（本地预校验拦截空提交）。取消/忽略走 {cancelled:true}。
// r11 todo 6c 控件模型：顶部条=忽略+上一题+下一题（末位页签「下一题」变「提交」）；
// 页签行=Q1..Qn/问题、补充（原 stepper 点位扩展为文字页签）；补充说明只在其页签内，
// 不再常驻卡底；提交禁用=（存在未答题且补充说明为空）或（全空），禁用时行内提示
// 「剩 N 题未答」。倒计时/过期/提交确认兜底语义全部保留。
// r11 todo 6a 草稿上提：selections/texts/comment/activeTab 镜像进 questions store——
// 卡片随虚拟化滚出/切页签卸载不丢已答，重挂以此初始化。
// 提交后不本地出队（失败不消失）：等 question_resolved 广播出队（流内卡位替换为
// 一行瞬态摘要，questions store resolveRequest）；超时未确认显重试/取消兜底。
// 倒计时：deadlineAtMs（引擎时钟）驱动；本地过期仅出队兜底（宽限见 store 常量），
// 权威落定以 question_resolved 广播为准。
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleHelp, X } from "lucide-react";
import { api } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { useUiStore } from "@/stores/ui";
import {
  QUESTION_EXPIRY_GRACE_MS,
  questionDraftKey,
  useQuestionsStore,
  type QuestionRequest,
} from "@/stores/questions";

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
}: {
  sessionId: string;
  request: QuestionRequest;
  /** 队列内序位（提示条/多卡语义用，流内卡片各自独立不再折叠收敛） */
  position: number;
  total: number;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 草稿上提（r11 todo 6a）：挂载时从 store 取既有草稿初始化（虚拟化滚出/切页签
  // 卸载再重挂已答保留，submitted 待确认态也保真防重复提交）；后续变更经镜像 effect
  // 回写。读取仅在挂载时一次。
  const initialDraft = useQuestionsStore.getState().drafts[questionDraftKey(sessionId, request.id)];
  const [selections, setSelections] = useState<Record<string, string[]>>(initialDraft?.selections ?? {});
  const [texts, setTexts] = useState<Record<string, string>>(initialDraft?.texts ?? {});
  const [comment, setComment] = useState(initialDraft?.comment ?? "");
  const [submitted, setSubmitted] = useState(initialDraft?.submitted ?? false);
  const questions = request.questions;
  // 页签：0..questions.length-1 = 各题；questions.length = 补充页签（末位）
  const [tab, setTab] = useState(() =>
    Math.min(Math.max(initialDraft?.activeTab ?? 0, 0), questions.length),
  );
  const tabIndex = Math.min(tab, questions.length);
  const onCommentTab = tabIndex >= questions.length;
  const current = questions[Math.min(tabIndex, Math.max(0, questions.length - 1))];

  // 草稿镜像：组件状态 → store（卸载不丢）。effect 覆盖全部变更路径（选项/文本/补充/页签/提交态）
  useEffect(() => {
    useQuestionsStore.getState().setDraft(sessionId, request.id, {
      selections,
      texts,
      comment,
      activeTab: tabIndex,
      submitted,
    });
  }, [sessionId, request.id, selections, texts, comment, tabIndex, submitted]);

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

  // 本地过期兜底：超时 + 宽限仍无 question_resolved（事件丢失/时钟漂移）则出队并留
  // 瞬态摘要（resolveRequest 同语义）；引擎侧同 deadline 的超时是权威，宽限防早杀
  useEffect(() => {
    if (remaining > -QUESTION_EXPIRY_GRACE_MS) return;
    useQuestionsStore.getState().resolveRequest(sessionId, request.id, "timed_out");
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

  const unansweredCount = useMemo(
    () =>
      questions.filter(
        (q) => (selections[q.id]?.length ?? 0) === 0 && (texts[q.id] ?? "").trim().length === 0,
      ).length,
    [questions, selections, texts],
  );
  const trimmedComment = comment.trim();
  // 提交禁用（IS-2）：存在未答题且补充说明为空（含全空——全空时未答数=总题数）
  const submitDisabled = unansweredCount > 0 && trimmedComment === "";

  const submit = () => {
    const answers = buildAnswers();
    // 按钮已按禁用条件收口，此为编程触发兜底（不 POST、显内联错误态）
    if (Object.keys(answers).length === 0 && !trimmedComment) {
      setInlineError(true);
      return;
    }
    setInlineError(false);
    void respond(
      trimmedComment ? { answers, comment: trimmedComment } : { answers },
    );
  };

  const toggleOption = (questionId: string, label: string, multiSelect: boolean) => {
    const currentSel = selections[questionId] ?? [];
    if (multiSelect) {
      const next = currentSel.includes(label) ? currentSel.filter((l) => l !== label) : [...currentSel, label];
      setSelections((prev) => ({ ...prev, [questionId]: next }));
      return;
    }
    // 单选互斥（r11 todo 2）：选中选项即清空该题自定义文本（取消选择则不动文本）
    const becomesSelected = !(currentSel.includes(label) && currentSel.length === 1);
    setSelections((prev) => ({ ...prev, [questionId]: becomesSelected ? [label] : [] }));
    if (becomesSelected && texts[questionId]) {
      setTexts((prev) => {
        const { [questionId]: _cleared, ...rest } = prev;
        return rest;
      });
    }
  };

  const goTo = (next: number) => {
    setTab(Math.min(Math.max(next, 0), questions.length));
    setInlineError(false);
    // 切页签滚动复位（手机档卡体可滚时归位当前题首行）
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

  const questionAnswered = (q: { id: string }) =>
    (selections[q.id]?.length ?? 0) > 0 || (texts[q.id] ?? "").trim().length > 0;

  const deadlineLabel = useMemo(() => formatRemaining(remaining), [remaining]);
  const multi = questions.length > 1;

  return (
    <div
      data-testid="question-card"
      data-question-card-id={request.id}
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

      {/* 顶部条（IS-3）：忽略 + 上一题 + 下一题；末位页签「下一题」位变「提交」 */}
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <button
          type="button"
          disabled={busy || expired || submitted}
          data-testid="question-dismiss"
          onClick={() => void respond({ cancelled: true })}
          className="flex min-h-11 items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <X className="size-3" aria-hidden />
          {t("chat.questionCard.ignore")}
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-testid="question-step-prev"
            disabled={tabIndex === 0 || busy || expired || submitted}
            onClick={() => goTo(tabIndex - 1)}
            className="flex min-h-11 items-center gap-0.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            {t("chat.questionCard.prevQuestion")}
          </button>
          {onCommentTab ? (
            <button
              type="button"
              data-testid="question-submit"
              disabled={busy || expired || submitted || submitDisabled}
              onClick={submit}
              className="min-h-11 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-50"
            >
              {t("chat.questionCard.submit")}
            </button>
          ) : (
            <button
              type="button"
              data-testid="question-step-next"
              disabled={busy || expired || submitted}
              onClick={() => goTo(tabIndex + 1)}
              className="flex min-h-11 items-center gap-0.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              {t("chat.questionCard.nextQuestion")}
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* 页签行（IS-3）：多题卡 Q1..Qn、单题卡轻量「问题」（不渲染 Q 编号 chrome），末位=补充 */}
      <div
        className="flex items-center gap-1 overflow-x-auto border-b px-3 py-1.5"
        role="tablist"
        aria-label={t("chat.questionCard.stepPosition", { step: Math.min(tabIndex + 1, questions.length), count: questions.length })}
      >
        {questions.map((q, i) => (
          <button
            key={q.id}
            type="button"
            data-testid={`question-tab-${i}`}
            data-current={i === tabIndex || undefined}
            data-answered={questionAnswered(q) || undefined}
            aria-label={t("chat.questionCard.stepJump", { step: i + 1 })}
            aria-current={i === tabIndex ? "step" : undefined}
            onClick={() => goTo(i)}
            className={`flex min-h-8 shrink-0 items-center rounded-md px-2.5 text-xs transition-colors hover:bg-muted ${
              i === tabIndex
                ? "font-medium text-foreground underline decoration-primary decoration-2 underline-offset-4"
                : questionAnswered(q)
                  ? "text-muted-foreground"
                  : "text-muted-foreground/70"
            }`}
          >
            {multi ? `Q${i + 1}` : t("chat.questionCard.questionTab")}
          </button>
        ))}
        <button
          type="button"
          data-testid="question-tab-comment"
          data-current={onCommentTab || undefined}
          aria-current={onCommentTab ? "step" : undefined}
          onClick={() => goTo(questions.length)}
          className={`flex min-h-8 shrink-0 items-center rounded-md px-2.5 text-xs transition-colors hover:bg-muted ${
            onCommentTab
              ? "font-medium text-foreground underline decoration-primary decoration-2 underline-offset-4"
              : "text-muted-foreground/70"
          }`}
        >
          {t("chat.questionCard.commentTab")}
        </button>
      </div>

      {/* 多题守卫行内提示（IS-2）：末位页签禁用提交时「剩 N 题未答」 */}
      {onCommentTab && !submitted && !expired && submitDisabled && (
        <p
          data-testid="question-remaining-hint"
          role="status"
          className="border-b px-3 py-1.5 text-xs font-medium text-destructive"
        >
          {t("chat.questionCard.remainingHint", { n: unansweredCount })}
        </p>
      )}
      {inlineError && (
        <p data-testid="question-inline-error" role="alert" className="border-b px-3 py-1.5 text-xs font-medium text-destructive">
          {t("chat.questionCard.needAnswer")}
        </p>
      )}

      <div ref={bodyRef} className="max-h-[60vh] space-y-4 overflow-y-auto px-3 py-3">
        {onCommentTab ? (
          <div data-testid="question-comment-panel">
            <p className="text-sm font-medium text-foreground">{t("chat.questionCard.commentTab")}</p>
            <textarea
              data-testid="question-comment"
              value={comment}
              rows={4}
              disabled={busy || expired || submitted}
              placeholder={t("chat.questionCard.commentPlaceholder")}
              onChange={(e) => setComment(e.target.value)}
              className="mt-2 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {request.waitForAnswer ? t("chat.questionCard.pendingHint") : t("chat.questionCard.continuedHint")}
            </p>
          </div>
        ) : (
          current && (
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
                    // 单选互斥（r11 todo 2）：输入自定义文本即清空该题已选选项（多选保留两者）
                    if (current.multiSelect === false && (selections[current.id]?.length ?? 0) > 0) {
                      setSelections((prev) => ({ ...prev, [current.id]: [] }));
                    }
                    const value = e.target.value;
                    setTexts((prev) => ({ ...prev, [current.id]: value }));
                  }}
                  className="min-h-11 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                />
              </div>
            </div>
          )
        )}
      </div>

      <div className="border-t px-3 py-1.5">
        {submitted && !showFallback && (
          <p data-testid="question-submit-pending" className="py-1 text-xs text-muted-foreground">
            {t("chat.questionCard.submitPending")}
          </p>
        )}
        {submitted && showFallback && (
          <div data-testid="question-submit-fallback" className="flex items-center gap-2 py-1">
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
    </div>
  );
}
