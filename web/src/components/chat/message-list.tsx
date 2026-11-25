// 虚拟化消息列表（todo 16）：TanStack Virtual 动态测量（measureElement + ResizeObserver），
// 长会话手机端只挂载可视区。自动跟随不经 React：直接订阅 store，在底部时 rAF 跟随滚动；
// 用户上滚即暂停跟随并浮出"回到底部"。在底部判定与恢复定位均按消息锚点（#26）：锚点=
// 流内最新条目 key（存 store），渲染窗覆盖锚点即"在底部"，恢复用 scrollToIndex(锚点)；
// 不再用 scrollHeight/scrollTop 像素比较（虚拟列表测量异步下不可靠）。顶部触顶触发增量同步。
// 记忆标记（docs08-r4 任务 13）：entries 中白名单 memory 条目经 mergeMemoryItems 并入 items，
// 标记块随虚拟化正常测量渲染。
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { diag } from "@/lib/diag";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, ArrowDown, Bell, BookOpen, ChevronDown, CircleCheck, CirclePause, CircleAlert, Database, Lightbulb, BookCheck, Pin, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMessagesStore } from "@/stores/messages";
import { useQuestionsStore, type QuestionRequest, type QuestionResolvedSummary } from "@/stores/questions";
import type { MemoryMarker, MemoryMarkerKind } from "@/lib/memory-entries";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/i18n";
import { mergeMemoryItems, mergeQuestionCards, mergeSessionEventLines, mergeStreamErrors, isAnchorCoveredByRange, shouldShowStickyUser, stickyCandidateAboveViewport, ERROR_KIND_KEYS, type ChatListItem, type CompactionMarker, type ReflectionParkedNotice, type SessionEventLine, type StreamErrorItem, detectProjectionSwap } from "./message-items";
import type { SiblingPosition } from "./branch-path-data";
import { decideFollowOnScroll } from "./scroll-follow";
import { CustomMessageBubble, EntryBubble, LoopGuardGroupBubble, RestoreDigestLine, StreamingBubble } from "./message-bubble";
import { QuestionCard } from "./question-card";
import { TipCard } from "./tip-card";
import { NavRail } from "./nav-rail";

/** 记忆标记块（docs08-r4 任务 13）：图标 + 一句话摘要 + 点击展开原文；折叠时不渲染原文
 *  （惰性展开，不影响消息流渲染）。样式与 thinking 块同族更轻（无边框细行）；权重分级：
 *  weak 弱标记 / weakest 极弱（projection-pin）/ notice 提示卡（kibitzer/memorian/notice/recall）。 */
const MARKER_ICONS: Record<MemoryMarkerKind, LucideIcon> = {
  sessionBinding: Database,
  acceptedTurns: BookCheck,
  projectionPin: Pin,
  kibitzerNudged: Lightbulb,
  memorianNudged: Lightbulb,
  memoryNotice: Bell,
  memoryRecall: BookOpen,
};

const MARKER_TONE: Record<MemoryMarker["weight"], string> = {
  weak: "text-xs text-muted-foreground",
  weakest: "text-[11px] text-muted-foreground/60",
  notice: "text-xs text-foreground/80",
};

export const MemoryMarkerBlock = memo(function MemoryMarkerBlock({ marker }: { marker: MemoryMarker }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const Icon = MARKER_ICONS[marker.kind];
  return (
    <div data-testid="memory-marker" data-kind={marker.kind} data-weight={marker.weight} className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-muted lg:min-h-0 ${MARKER_TONE[marker.weight]}`}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t(marker.summary.key, marker.summary.vars)}</span>
        {marker.detail !== "" && (
          <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        )}
      </button>
      {open && marker.detail !== "" && (
        <div className="mt-0.5 max-h-48 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
          {marker.detail}
        </div>
      )}
    </div>
  );
});

/** 压缩摘要标记块（docs08-r6 任务 18 ③）：Archive 图标 +「上下文已压缩：摘要首行」
 *  常显，点击展开原文（summary 全文 + details JSON，details 缺失时仅全文）；
 *  tokensBefore 存在时尾部带压缩前水位。样式与记忆标记同族（weak 弱标记）。 */
export const CompactionMarkerBlock = memo(function CompactionMarkerBlock({ marker }: { marker: CompactionMarker }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <div data-testid="compaction-marker" className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-muted lg:min-h-0 text-xs text-muted-foreground"
      >
        <Archive className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t("chat.compact.marker", { summary: marker.summaryFirstLine })}</span>
        {marker.detail !== "" && (
          <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        )}
      </button>
      {open && marker.detail !== "" && (
        <div className="mt-0.5 max-h-48 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
          {marker.detail}
        </div>
      )}
    </div>
  );
});

/** acceptedTurns 同簇聚合块（docs08 2026-10-23/24 批次任务 14）：折叠态一行「本轮已计入
 *  记忆 ×N」；点击展开逐条渲染（复用 MemoryMarkerBlock，逐条自身仍可展开原文）。
 *  样式与记忆标记同族（weak 弱标记）；不删任何事件——折叠仅呈现层，全量 markers 携带。 */
export const AcceptedTurnsClusterBlock = memo(function AcceptedTurnsClusterBlock({
  markers,
}: {
  markers: MemoryMarker[];
}) {
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <div data-testid="memory-cluster" data-count={markers.length} className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-muted lg:min-h-0 text-xs text-muted-foreground"
      >
        <BookCheck className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t("chat.memoryMarkers.acceptedTurnsCount", { count: markers.length })}</span>
        <span className="shrink-0 rounded-sm bg-muted px-1 py-px">×{markers.length}</span>
        <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 pl-2">
          {markers.map((m) => (
            <MemoryMarkerBlock key={m.entryId} marker={m} />
          ))}
        </div>
      )}
    </div>
  );
});

/** 记忆停驻警示卡（docs08 2026-10-25 用户反馈）：CLI 内联同构——amber 警示色、
 * 图标 + 标题（连续失败次数）+ 建议行（检查路径 / 下次探针时刻 / /reflect 重试）。
 * 时间缺失仅少一行；retryable=false 时不提 /reflect。 */
const NoticeCardBlock = memo(function NoticeCardBlock({ notice }: { notice: ReflectionParkedNotice }) {
  const t = useT();
  const time = notice.nextProbeAtMs !== null ? new Date(notice.nextProbeAtMs).toLocaleTimeString() : null;
  return (
    <div
      data-testid="notice-card"
      className="my-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
    >
      <div className="flex items-center gap-2 font-medium">
        <CirclePause className="size-4 shrink-0" aria-hidden />
        <span>{t("chat.notice.memoryReflectionPausedTitle", { n: notice.streak })}</span>
      </div>
      <div className="mt-1 space-y-0.5 pl-6 text-xs opacity-90">
        {notice.recommendation !== "" && (
          <div className="break-all">{t("chat.notice.memoryReflectionPausedWhy", { path: notice.recommendation })}</div>
        )}
        {time !== null && (
          <div>{t("chat.notice.memoryReflectionPausedProbe", { time })}</div>
        )}
        {notice.retryable && <div>{t("chat.notice.memoryReflectionPausedRetry")}</div>}
      </div>
    </div>
  );
});

/** 会话级事件行块（r10 todo 7）：排队交接/压缩完成/模型切换回执三类事件的流内系统行，
 *  哑色细行非交互（与记忆标记块同族更轻，无可展开原文）。事件行是回执而非内容，
 *  不设 data-kind 细分，断言以文案 key 为主。 */
export const SessionEventLineBlock = memo(function SessionEventLineBlock({ line }: { line: SessionEventLine }) {
  const t = useT();
  return (
    <div data-testid="session-event-line" className="my-0.5 flex min-h-7 items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground">
      <span aria-hidden className="size-1 shrink-0 rounded-full bg-muted-foreground/50" />
      <span className="min-w-0 break-words">{t(line.summary.key, line.summary.vars)}</span>
    </div>
  );
});

/** 落定提问摘要行（r11 todo 6e）：question_resolved 后流内卡位替换的一行瞬态痕——
 *  仅内存（questions store resolvedSummaries，刷新即无）；outcome→文案映射在此（数据面不携 i18n）。 */
export const QuestionResolvedLineBlock = memo(function QuestionResolvedLineBlock({ summary }: { summary: QuestionResolvedSummary }) {
  const t = useT();
  const key =
    summary.outcome === "answered"
      ? "chat.questionCard.resolvedAnswered"
      : summary.outcome === "timed_out"
        ? "chat.questionCard.resolvedTimedOut"
        : summary.outcome === "cancelled"
          ? "chat.questionCard.resolvedCancelled"
          : "chat.questionCard.resolvedGeneric";
  return (
    <div
      data-testid="question-resolved-line"
      data-outcome={summary.outcome}
      className="my-0.5 flex min-h-7 items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground"
    >
      <CircleCheck className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
      <span className="min-w-0 break-words">
        {t(key)}
        {summary.snippet !== "" ? `：${summary.snippet}` : ""}
      </span>
    </div>
  );
});

/** 流内错误卡（发送/建会话失败入流，对齐 CLI）：红系警示卡（同 notice-card 警示形，
 *  destructive 语义 token），常驻不自动消失，text + 小字时间 + 关闭钮。 */
export const StreamErrorCardBlock = memo(function StreamErrorCardBlock({ sessionId, error }: { sessionId: string; error: StreamErrorItem }) {
  const t = useT();
  return (
    <div
      data-testid="stream-error-card"
      className="my-1 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="break-words">{error.text}</div>
          <div className="mt-0.5 text-xs opacity-70 tabular-nums">
            {/* 罗列收敛批 2026-11-21：同文重复计数（×N · 最近一次时间） */}
            {error.count > 1 ? `×${error.count} · ` : ""}
            {new Date(error.ts).toLocaleTimeString()}
          </div>
        </div>
        <button
          type="button"
          data-testid="stream-error-dismiss"
          aria-label={t("chat.streamError.dismiss")}
          onClick={() => useMessagesStore.getState().dismissError(sessionId, error.id)}
          className="shrink-0 rounded-sm p-0.5 opacity-70 transition-opacity hover:opacity-100"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
});

/** 连续纯错误消息折叠卡（罗列收敛批 2026-11-21）：引擎连续落库的同文失败回合
 *  （限流连发等）在 items 层折叠为单卡 ×N（message-items errorRun），对齐 CLI 不
 *  罗列的观感；归类标签读引擎现成结构化字段（errorCategoryOf），识别不出不贴。 */
export const ErrorRunCardBlock = memo(function ErrorRunCardBlock({
  item,
}: {
  item: Extract<ChatListItem, { kind: "errorRun" }>;
}) {
  const t = useT();
  return (
    <div
      data-testid="error-run-card"
      className="my-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="whitespace-pre-wrap break-words">
            {item.category !== null ? <span className="font-medium">{t(ERROR_KIND_KEYS[item.category])} · </span> : null}
            {item.text}
            {item.count > 1 ? <span className="ml-1.5 font-medium tabular-nums">×{item.count}</span> : null}
          </div>
          {item.lastTs !== null && (
            <div className="mt-0.5 text-xs opacity-70 tabular-nums">{new Date(item.lastTs).toLocaleTimeString()}</div>
          )}
        </div>
      </div>
    </div>
  );
});

const Row = memo(function Row({
  item,
  sessionId,
  siblings,
  onSwitchSibling,
  switchDisabled,
}: {
  item: ChatListItem;
  sessionId: string;
  /** 分支切换器（session-branching todo 5）：兄弟序位 chat-view 全量派生后下传 */
  siblings?: Map<string, SiblingPosition>;
  /** 叶切换回调（todo 6 接线位，本层透传） */
  onSwitchSibling?: (entryId: string) => void;
  /** 切换禁用（与 Composer queueAvailable 同口径） */
  switchDisabled?: boolean;
}) {
  if (item.kind === "streaming") return <StreamingBubble sessionId={sessionId} />;
  if (item.kind === "memoryMarker") return <MemoryMarkerBlock marker={item.marker} />;
  if (item.kind === "customMessage") return <CustomMessageBubble sessionId={sessionId} entryId={item.entryId} />;
  if (item.kind === "restoreDigest") return <RestoreDigestLine digest={item.digest} />;
  if (item.kind === "loopGuardGroup")
    return <LoopGuardGroupBubble sessionId={sessionId} loopGuardKind={item.loopGuardKind} entryIds={item.entryIds} />;
  if (item.kind === "compactionMarker") return <CompactionMarkerBlock marker={item.marker} />;
  if (item.kind === "memoryMarkerCluster") return <AcceptedTurnsClusterBlock markers={item.markers} />;
  if (item.kind === "noticeCard") return <NoticeCardBlock notice={item.notice} />;
  if (item.kind === "sessionEvent") return <SessionEventLineBlock line={item.line} />;
  if (item.kind === "questionCard")
    return (
      <QuestionCard sessionId={sessionId} request={item.request} position={item.position} total={item.total} />
    );
  if (item.kind === "questionResolved") return <QuestionResolvedLineBlock summary={item.summary} />;
  if (item.kind === "streamError") return <StreamErrorCardBlock sessionId={sessionId} error={item.error} />;
  if (item.kind === "errorRun") return <ErrorRunCardBlock item={item} />;
  return (
    <EntryBubble
      sessionId={sessionId}
      entryId={item.entryId}
      interrupted={item.interrupted}
      model={item.model}
      sibling={siblings?.get(item.entryId) ?? null}
      onSwitchSibling={onSwitchSibling}
      switchDisabled={switchDisabled}
    />
  );
});

/** 触顶增量同步阈值（scrollTop 小于该值触发向上翻页） */
const BOTTOM_THRESHOLD = 80;

/** 滚动容器 py-4 顶垫（粘性判定把测量缓存偏移换算到视口坐标用） */
const STICKY_TOP_PAD = 16;

/** 空队列引用稳定值（订阅 selector 兑底，避免 memo 重算） */
const NO_QUESTIONS: QuestionRequest[] = [];
const NO_SUMMARIES: QuestionResolvedSummary[] = [];

/** 用户输入解除跟随的触发键（PageUp/Home/ArrowUp：都是往回看的滚动键） */
const USER_DISENGAGE_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);

/**
 * 用户输入直接解除流式跟随（fix 2026-11-11）：输出中/思考中用户向上滚动被程序滚动
 * 护栏拽回的修复。根因：scrollToAnchor 自触发的 scroll 事件在护栏窗内被忽略防误翻，
 * 用户恰在窗内上滚时其 scroll 事件同样被忽略，跟随态保持 true，下次流式变化再拽底。
 * 修法：用户输入信号（wheel 向上 / 触摸向下拖 / 回看键）绕过程序护栏直接解除跟随；
 * 滚回底部仍由既有 scroll 判定重新置 true。返回清理函数。
 */
export function attachUserScrollDisengage(
  el: HTMLElement,
  onDisengage: (src: "user-wheel" | "user-touch" | "user-key") => void,
): () => void {
  // wheel：仅向上（deltaY<0）解除；向下不拦，滚回底部由 scroll 判定恢复跟随
  const onWheel = (e: WheelEvent): void => {
    if (e.deltaY < 0) onDisengage("user-wheel");
  };
  let touchStartY: number | null = null;
  let touchStartX: number | null = null;
  const onTouchStart = (e: TouchEvent): void => {
    const t = e.touches[0];
    touchStartY = t ? t.clientY : null;
    touchStartX = t ? t.clientX : null;
  };
  // 触摸：手指向下拖（clientY 增大，内容上滚=往回看）且主纵向位移超阈值才解除——
  // 与下拉刷新（手指向上）/横向轮播区分：以纵向为主轴且 |dy|>8px
  const onTouchMove = (e: TouchEvent): void => {
    if (touchStartY === null || touchStartX === null) return;
    const t = e.touches[0];
    if (!t) return;
    const dy = t.clientY - touchStartY;
    const dx = touchStartX - t.clientX;
    if (dy > 8 && dy > Math.abs(dx)) {
      onDisengage("user-touch");
      touchStartY = null;
      touchStartX = null;
    }
  };
  const onTouchEnd = (): void => {
    touchStartY = null;
    touchStartX = null;
  };
  // 键盘（全局回看键）：输入法/编辑场景（input/textarea/contenteditable）不解除，
  // 避免输入框里按 ArrowUp 编辑文本误关跟随
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!USER_DISENGAGE_KEYS.has(e.key)) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    onDisengage("user-key");
  };
  el.addEventListener("wheel", onWheel, { passive: true });
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: true });
  el.addEventListener("touchend", onTouchEnd, { passive: true });
  window.addEventListener("keydown", onKeyDown);
  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    window.removeEventListener("keydown", onKeyDown);
  };
}

/** MessageList 命令句柄（r11 todo 6d）：待答提问提示条点击定位流内卡用 */
export interface MessageListHandle {
  /** 滚动定位流内提问卡；虚拟化窗外时先 scrollToIndex 挂载该行再定位 */
  scrollToQuestion(requestId: string): void;
}

export function MessageList({
  ref,
  items,
  sessionId,
  syncing,
  onReachTop,
  /** 分支切换器数据（session-branching todo 5）：entryId → 兄弟序位，chat-view 派生 */
  siblings,
  /** 叶切换回调（todo 6 接线位，本层透传） */
  onSwitchSibling,
  /** 切换禁用（与 Composer queueAvailable 同口径） */
  switchDisabled,
}: {
  /** React 19 ref-as-prop：命令句柄（scrollToQuestion，提示条点击定位用） */
  ref?: React.Ref<MessageListHandle>;
  items: ChatListItem[];
  sessionId: string;
  syncing: boolean;
  onReachTop: () => void;
  siblings?: Map<string, SiblingPosition>;
  onSwitchSibling?: (entryId: string) => void;
  switchDisabled?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  // 程序滚动护栏（#26，职责收窄 fix 2026-11-11）：只护置 true 方向——程序滚锚自触发的
  // scroll 事件不把跟随态提前翻回跟随（锚点暂不在渲染窗属正常）；解除方向改由用户输入
  // 监听（wheel/touch/key，见 attachUserScrollDisengage）直接负责，不受护栏影响。
  const programmaticUntilRef = useRef(0);
  // 上一滚动事件的 scrollTop（2026-11-25）：判定位置是否真的往上走（用户回看）的依据
  // ——内容变高不改它、锚定补位只让它增大；切会话清空，首个事件不判方向
  const lastScrollTopRef = useRef<number | null>(null);
  // 落地滚动补偿（重取风暴任务 3，GAP-3）状态：首个可见 virtualItem 快照（key+内容位
  // start）、换代检测基线（store 整替序号 + 提交时条目数）、武装标志与未决补偿 rAF 句柄
  const swapFirstVisibleRef = useRef<{ key: string; start: number } | null>(null);
  const swapSeqRef = useRef(0);
  const swapItemsLenRef = useRef(0);
  const swapArmedRef = useRef(false);
  const swapRafRef = useRef(0);
  // 初始值空数组：真实值由检测 effect 每次提交顶部写入（rAF 读取前必有写入）
  const mergedItemsRef = useRef<ChatListItem[]>([]);
  const [showJump, setShowJump] = useState(false);

  // 白名单 memory 条目与 compaction 条目并入 items（docs08-r4 任务 13 / 任务 18 ③）：
  // entries 引用不变（流式 delta 只动 streamingMessage）时 memo 不重算，无标记会话
  // mergeMemoryItems 原样返回不建数组
  const entries = useMessagesStore((s) => s.bySession[sessionId]?.entries);
  // 会话级事件行（r10 todo 7）：store 每会话事件行尾部并入（切页可见、重取不冲），
  // 无事件行时 mergeSessionEventLines 原样返回不建数组
  const sessionEvents = useMessagesStore((s) => s.bySession[sessionId]?.sessionEvents);
  // 待答提问卡与落定摘要（r11 todo 6d/e）：questions store → 合成层在锚点 entry 后
  // 插入流内（每张 pending 卡各自渲染于各自锚点，不折叠收敛）；resolved 后原卡位替换
  // 为一行瞬态摘要。空队列引用稳定（NO_* 兑底），memo 不重算。
  const pendingQuestions = useQuestionsStore((s) => s.bySession[sessionId] ?? NO_QUESTIONS);
  const resolvedSummaries = useQuestionsStore((s) => s.resolvedSummaries[sessionId] ?? NO_SUMMARIES);
  // 流内错误卡（发送失败入流）：store 每会话错误尾部并入（重取不冲、带关闭钮），
  // 无错误时原样返回不建数组（mergeStreamErrors 内部口径）
  const streamErrors = useMessagesStore((s) => s.bySession[sessionId]?.errors);
  const mergedItems = useMemo(
    () =>
      mergeStreamErrors(
        mergeSessionEventLines(
          mergeQuestionCards(mergeMemoryItems(items, entries ?? []), entries ?? [], pendingQuestions, resolvedSummaries),
          sessionEvents ?? [],
          entries ?? [],
        ),
        streamErrors ?? [],
      ),
    [items, entries, sessionEvents, pendingQuestions, resolvedSummaries, streamErrors],
  );
  // 压缩进行态（docs08-r6 任务 18 ①）：compaction_start/progress 置位、end 消除
  // （帧丢失由 store 兑底回落），消息流顶部浮条呈现
  const compacting = useMessagesStore((s) => s.bySession[sessionId]?.compacting ?? false);

  // 粘性用户条（docs08-r7 任务 11 建；r9 wave1 改视口锚定）：虚拟化行绝对定位，纯 CSS
  // sticky 不可行；判定复用既有 scroll 通道（不新增监听），几何用 TanStack 测量缓存
  // （窗外行可判，同 NavRail；未测行落估算值）。候选随滚动实时反查（见 handleScroll）；
  // 回底消失：atBottom 恒隐藏，回底钮滚底后随之消失。
  const [stickyUser, setStickyUser] = useState<{ key: string; text: string } | null>(null);

  const virtualizer = useVirtualizer({
    count: mergedItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 6,
    getItemKey: (index) => mergedItems[index].key,
  });

  // 滚动跟随锚点（#26）：跟随态锚定到流内最新一条条目（key 存 store 每会话槽）。
  // 在底部判定 = 渲染窗覆盖锚点下标（isAnchorCoveredByRange），不再用像素高度比较；
  // 恢复/切会话/回前台用 scrollToIndex(锚点) 对齐。锚点随 mergedItems 尾部变化同步写入。
  const anchorId = useMessagesStore((s) => s.followAnchors[sessionId] ?? null);
  const setFollowAnchor = useMessagesStore((s) => s.setFollowAnchor);
  const lastItemKey = mergedItems.length > 0 ? mergedItems[mergedItems.length - 1].key : null;
  useEffect(() => {
    if (lastItemKey !== null && lastItemKey !== anchorId) setFollowAnchor(sessionId, lastItemKey);
  }, [lastItemKey, anchorId, sessionId, setFollowAnchor]);
  const anchorIndex = useMemo(() => {
    if (lastItemKey === null) return -1;
    if (anchorId === null) return mergedItems.length - 1;
    const idx = mergedItems.findIndex((it) => it.key === anchorId);
    return idx >= 0 ? idx : mergedItems.length - 1;
  }, [mergedItems, anchorId, lastItemKey]);

  // 用户输入解除跟随（fix 2026-11-11）：用户 wheel 向上/触摸向下拖/回看键直接解除，
  // 不受程序滚动护栏影响——护栏只防程序滚动自身的 scroll 误判，不该吞掉用户输入。
  const disengageFollow = useCallback(
    (src: "user-wheel" | "user-touch" | "user-key") => {
      if (!followRef.current) return;
      diag.info("scroll", "follow_flip", { from: true, to: false, src, anchorIndex, items: mergedItems.length });
      followRef.current = false;
      setShowJump(true);
    },
    [anchorIndex, mergedItems.length],
  );
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return attachUserScrollDisengage(el, disengageFollow);
  }, [disengageFollow]);

  // 待答提问卡定位（r11 todo 6d）：提示条点击 → 流内卡 scrollIntoView；虚拟化窗外
  // （未挂载）先 scrollToIndex 挂载该行，下一帧再定位
  const scrollToQuestion = useCallback(
    (requestId: string) => {
      const selector = `[data-question-card-id="${requestId}"]`;
      const el = scrollRef.current?.querySelector(selector);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const idx = mergedItems.findIndex((it) => it.kind === "questionCard" && it.request.id === requestId);
      if (idx < 0) return;
      virtualizer.scrollToIndex(idx, { align: "center" });
      requestAnimationFrame(() => {
        scrollRef.current?.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    },
    [mergedItems, virtualizer],
  );
  useImperativeHandle(ref, () => ({ scrollToQuestion }), [scrollToQuestion]);

  // 滚动对齐锚点（#26）：跟随/恢复/回底统一走 scrollToIndex(锚点, align:end)，不再
  // scrollTo(scrollHeight)——虚拟列表测量异步完成时 scrollHeight 是旧值，#26 停在旧
  // 位置的直接根因。锚点缺席（空列表/未同步）兑底直接滚底。smooth 路径保留落点校验环
  //（手机档测量涨高补滚，docs08-r7 任务 11）：校验判据同锚点覆盖，用户上滚即退出。
  const scrollToAnchor = useCallback(
    (smooth = false) => {
      const el = scrollRef.current;
      if (!el) return;
      // 滚动跟随域埋点（速清批 26d，第五域）：每次程序滚锚执行即记起点，校验器退出时记落点
      diag.info("scroll", "to_anchor", { src: smooth ? "smooth" : "auto", anchorIndex, items: mergedItems.length, distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) });
      programmaticUntilRef.current = Date.now() + (smooth ? 2500 : 600);
      if (anchorIndex >= 0) {
        virtualizer.scrollToIndex(anchorIndex, { align: "end", behavior: smooth ? "smooth" : "auto" });
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      }
      if (!smooth) return;
      // 平滑滚动途中与落底后,虚拟化行测量都可能增长总高使点击时目标失效,落点未到底
      // (docs08-r7 任务 11 回底打磨;手机档实测涨约 239px):2s 窗口内每 300ms 校验,
      // 锚点仍未入渲染窗则补瞬时对锚;用户主动上滚(位置回退>50px)即退出不抢滚动。
      let lastTop = -1;
      const started = Date.now();
      const timer = window.setInterval(() => {
        const el2 = scrollRef.current;
        if (!el2 || Date.now() - started > 2000) {
          window.clearInterval(timer);
          if (el2) diag.info("scroll", "to_anchor_settled", { ended: "timeout", distance: Math.round(el2.scrollHeight - el2.scrollTop - el2.clientHeight) });
          return;
        }
        const top = el2.scrollTop;
        if (lastTop >= 0 && top < lastTop - 50) {
          window.clearInterval(timer);
          diag.info("scroll", "to_anchor_settled", { ended: "user_scroll_back", distance: Math.round(el2.scrollHeight - el2.scrollTop - el2.clientHeight) });
          return;
        }
        lastTop = top;
        if (!isAnchorCoveredByRange(virtualizer.getVirtualItems(), anchorIndex)) {
          virtualizer.scrollToIndex(anchorIndex, { align: "end", behavior: "auto" });
        } else {
          window.clearInterval(timer);
          diag.info("scroll", "to_anchor_settled", { ended: "settled", distance: Math.round(el2.scrollHeight - el2.scrollTop - el2.clientHeight) });
        }
      }, 300);
    },
    [virtualizer, anchorIndex, mergedItems.length],
  );

  // scrollToAnchor 引用化（重取风暴 GAP-2/4 fix 2026-11-23）：identity 随条目增长高频
  // 变化，经 ref 消费使定位 effect 无需把它入 deps——deps 污染正是旧实现随 items
  // 增长重跑 session_open 定位的根因。
  const scrollToAnchorRef = useRef(scrollToAnchor);
  useEffect(() => {
    scrollToAnchorRef.current = scrollToAnchor;
  });
  // 自动跟随：store 任意变化（delta/新条目）且用户在底部 → rAF 滚锚，不经 React 渲染路径。
  // 2026-11-25：rAF 槽共享给内容尺寸监听与 scroll 事件回底判定（同帧多次触发只滚一次）；
  // scrollToAnchor 经 ref 消费（identity 随条目增长漂移），调度器自身引用稳定
  const followRafRef = useRef(0);
  const scheduleFollowScroll = useCallback(() => {
    if (!followRef.current || followRafRef.current) return;
    followRafRef.current = requestAnimationFrame(() => {
      followRafRef.current = 0;
      if (followRef.current) scrollToAnchorRef.current();
    });
  }, []);


  // 换代落地检测与滚动补偿（重取风暴任务 3，GAP-3/4）：mergedItems 每次提交后运行——
  // 上一提交记录的首个可见 virtualItem（key+内容位 start）即本次落地前的视口快照
  // （相对容器顶偏移 = start - 落地时实时 scrollTop，用户提交间滚动也计入）。换代检测
  // store 级信号优先（swapSeq）、items 长度差后备（detectProjectionSwap）；仅非跟随态
  // 补偿，rAF 内 scrollToIndex(key, align:start) 再补偏移差，纳入程序滚动护栏窗。
  useEffect(() => {
    mergedItemsRef.current = mergedItems;
    const seq = useMessagesStore.getState().bySession[sessionId]?.swapSeq ?? 0;
    // 记录首个可见 virtualItem（本次提交后的布局=下一次落地的“落地前”快照；无布局/
    // 虚拟窗为空时为 null，补偿随之跳过）
    const first = virtualizer.getVirtualItems()[0];
    const firstVisible =
      first !== undefined ? { key: mergedItems[first.index].key, start: first.start } : null;
    if (!swapArmedRef.current) {
      // 首次提交只建基线（武装），不检测不补偿：挂载首载定位归 session_open 通道管
      swapArmedRef.current = true;
      swapSeqRef.current = seq;
      swapItemsLenRef.current = mergedItems.length;
      swapFirstVisibleRef.current = firstVisible;
      return;
    }
    const swapped = detectProjectionSwap(
      { swapSeq: swapSeqRef.current, items: swapItemsLenRef.current },
      { swapSeq: seq, items: mergedItems.length },
    );
    swapSeqRef.current = seq;
    swapItemsLenRef.current = mergedItems.length;
    const preLanding = swapFirstVisibleRef.current;
    swapFirstVisibleRef.current = firstVisible;
    if (!swapped || followRef.current || preLanding === null) return;
    // 最新换代取代未决补偿（连发换代只补最后一次）；rAF 不入 effect cleanup——
    // 落地后流式增量继续提交时不至取消刚排程的补偿，卸载由专项 cleanup 收
    if (swapRafRef.current) cancelAnimationFrame(swapRafRef.current);
    swapRafRef.current = requestAnimationFrame(() => {
      swapRafRef.current = 0;
      const el = scrollRef.current;
      // 执行时复核跟随态：快照与执行间用户已回底则交还既有锚底路径
      if (!el || followRef.current) return;
      const index = mergedItemsRef.current.findIndex((it) => it.key === preLanding.key);
      // key 在新投影缺席（窗口外裁剪/整替剔除）：无从对齐，放弃本次补偿
      if (index < 0) return;
      const offset = preLanding.start - el.scrollTop;
      diag.info("scroll", "swap_compensate", {
        key: preLanding.key,
        index,
        offset,
        items: mergedItemsRef.current.length,
      });
      programmaticUntilRef.current = Date.now() + 600;
      virtualizer.scrollToIndex(index, { align: "start", behavior: "auto" });
      // 补偏移差：scrollToIndex(align:start) 同步把 scrollTop 推到锚行新坐标 start（
      // virtual-core 同步 elementScroll 语义），恢复原视位 = S_new − d（d = 快照 start −
      // 落地前 scrollTop，锚行屏位），落在 el.scrollTop − offset
      if (offset !== 0) el.scrollTo({ top: el.scrollTop - offset, behavior: "auto" });
    });
  }, [mergedItems, sessionId, virtualizer]);

  // 补偿 rAF 专项卸载清理：不挂在检测 effect 上（见上，落地后增量提交不可取消补偿）
  useEffect(
    () => () => {
      if (swapRafRef.current) cancelAnimationFrame(swapRafRef.current);
    },
    [],
  );

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 在底部判定（02a629e 回归收紧）：渲染窗覆盖锚点下标仅是必要条件——末条为长消息
    // 时视口落在其中段也覆盖渲染窗；须再要求锚点条目末端贴容器底：滚动容器剩余距离
    // scrollHeight - scrollTop - clientHeight < 8px（等价于锚点末端 getBoundingClientRect
    // .bottom 距容器底在容器垫距容差内：末条即内容末端，剩余距离即两者间距减下垫）。
    // scrollTop 钳到 maxScroll：真实滚动不会越界，mock/惯性越界时仍按贴底算；越界时
    // 虚拟窗可能整窗卸载（覆盖判定不可用），此时剩余距离<8 即视为在底。
    const virtualItems = virtualizer.getVirtualItems();
    const covered = isAnchorCoveredByRange(virtualItems, anchorIndex);
    const maxScroll = Math.max(el.scrollHeight - el.clientHeight, 0);
    const remaining = el.scrollHeight - Math.min(el.scrollTop, maxScroll) - el.clientHeight;
    const atBottom = remaining < 8 && (covered || virtualItems.length === 0);
    const programmatic = Date.now() < programmaticUntilRef.current;
    // followRef 决策（2026-11-25 收窄，纯函数 decideFollowOnScroll）：scroll 事件本身不再
    // 解除跟随——离底只剩两类：位置真的往上走（用户滚轮/触摸/回看键/拖滚动条；前三者
    // 另有直接解除通道，此处兜底同口径）解除；内容变高把视角顶离底部（位置不动、
    // scrollHeight 涨）或浏览器滚动锚定补位（scrollTop 增大）保持跟随并回底。此前
    // 「离底即解除」把行高晚到都当成用户上滚，打开会话后视角停在旧位置。程序护栏
    // 窗口内不改跟随态（程序滚锚途中锚点暂未入渲染窗属正常）；埋点只在翻转那一刻记。
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    if (!programmatic) {
      const movedUp = prevTop !== null && el.scrollTop < prevTop - 1;
      const decision = decideFollowOnScroll({ follow: followRef.current, atBottom, movedUp });
      if (decision.changed) {
        diag.info("scroll", "follow_flip", {
          from: !decision.follow,
          to: decision.follow,
          src: "scroll",
          movedUp,
          anchorIndex,
          items: mergedItems.length,
          scrollTop: Math.round(el.scrollTop),
        });
      }
      followRef.current = decision.follow;
      if (decision.repin) scheduleFollowScroll();
    }
    // 回底钮可见性不受程序化护栏拦截（护栏只护 followRef 不被中途解除）：用户在程序
    // 滚动途中上滚时回底钮必须即时出现，否则 600ms 窗口内滚动状态不可见（02a629e
    // 回归症状之一）。
    setShowJump(!atBottom);
    // 粘性用户条（r9 wave1 视口锚定）：候选=视口上缘上方最近含文本 user 气泡，随滚动
    // 实时反查（不再恒取尾部）；回底消失判据不变。测量缺失（未挂载/计数未同步）不钉。
    const measurements = virtualizer.measurementsCache;
    const cand = stickyCandidateAboveViewport(
      mergedItems,
      entries ?? [],
      measurements,
      el.scrollTop - STICKY_TOP_PAD,
    );
    const m = cand ? measurements[cand.index] : undefined;
    if (cand && m) {
      const rowTop = STICKY_TOP_PAD + m.start - el.scrollTop;
      const rowBottom = rowTop + m.size;
      setStickyUser(shouldShowStickyUser(atBottom, rowTop, rowBottom, 0, el.clientHeight) ? cand : null);
    } else {
      setStickyUser(null);
    }
    if (el.scrollTop < BOTTOM_THRESHOLD) onReachTop();
  }, [onReachTop, mergedItems, entries, virtualizer, anchorIndex, scheduleFollowScroll]);

  // store 任意变化（delta/新条目）且用户在底部 → 共享 rAF 槽滚锚，不经 React 渲染路径。
  // deps 沿用 scrollToAnchor（identity 随条目增长漂移）保持与改动前相同的重订阅时机：
  // 条目增长的提交里跟随锚点槽的写入落在重订阅间隙，不另起一次滚锚（首开定位归
  // session_open 通道，两段式计数不变）。
  useEffect(() => {
    const unsub = useMessagesStore.subscribe(scheduleFollowScroll);
    return () => {
      unsub();
      if (followRafRef.current) cancelAnimationFrame(followRafRef.current);
      followRafRef.current = 0;
    };
  }, [scrollToAnchor, scheduleFollowScroll]);
  // 内容尺寸兜底（2026-11-25）：行高晚到不一定伴随 scroll 事件（锚节点在变化行之上时
  // 浏览器滚动锚定补位，其余情形只涨 scrollHeight）。跟随态下内容尺寸一变即走共享 rAF
  // 回底，非跟随态零动作；observe 起始的那次通知不是尺寸变化（首开定位归 session_open
  // 通道），跳过。回调引用稳定（不随条目增长重挂监听）。
  const contentResizeObserverRef = useRef<ResizeObserver | null>(null);
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    contentResizeObserverRef.current?.disconnect();
    contentResizeObserverRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      scheduleFollowScroll();
    });
    ro.observe(node);
    contentResizeObserverRef.current = ro;
  }, [scheduleFollowScroll]);

  // 切会话恢复跟随（#26）：跟随标志不跨会话携带——上一会话上滚解除的跟随态不得压住
  // 新会话的回底定位；回底钮随之复位。组件未按 sessionId 重挂，必须显式复位。
  useEffect(() => {
    followRef.current = true;
    lastScrollTopRef.current = null;
    setShowJump(false);
    // 换代补偿状态不跨会话携带（任务 3）：重武装（下一提交重建基线）并撤销未决补偿
    swapArmedRef.current = false;
    if (swapRafRef.current) {
      cancelAnimationFrame(swapRafRef.current);
      swapRafRef.current = 0;
    }
  }, [sessionId]);

  // 打开会话 / 从空到有内容：定位到底部（测量异步完成，两段式补齐）
  const t = useT();
  const hasItems = mergedItems.length > 0;
  // 已定位会话标记（重取风暴 GAP-2/4 fix 2026-11-23）：定位只在 hasItems 首真或
  // sessionId 变化时执行一次；旧实现 deps 带 scrollToAnchor（identity 随条目增长
  // 漂移），items 每次增长都重发 session_open 定位、在非跟随态把用户强拉回底部。
  // StrictMode 双跑（dev effect→cleanup→effect）安全：stage1 未执行前的 cleanup
  // 回滚标记，紧随的二次执行重新定位；生产单跑无回滚路径。
  const locatedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hasItems || locatedSessionRef.current === sessionId) return;
    const prevLocated = locatedSessionRef.current;
    locatedSessionRef.current = sessionId;
    // 会话打开快照（26d）：follow 标志与条目数（定位一次性：首条到达/会话切换各记一次）
    diag.info("scroll", "session_open", { follow: followRef.current, items: mergedItems.length, sessionId: sessionId.slice(0, 8) });
    let raf = 0;
    let tid = 0;
    let stage1Done = false;
    raf = requestAnimationFrame(() => {
      raf = 0;
      stage1Done = true;
      // 两段式程序滚动前均尊重跟随态：非跟随（用户已上滚）不执行定位滚动
      if (followRef.current) scrollToAnchorRef.current();
      tid = window.setTimeout(() => {
        tid = 0;
        if (followRef.current) scrollToAnchorRef.current();
      }, 100);
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      // 旧实现只清 rAF：100ms 补滚句柄脱离清理，卸载/切会话后仍迟到滚底
      if (tid) window.clearTimeout(tid);
      if (!stage1Done && locatedSessionRef.current === sessionId) locatedSessionRef.current = prevLocated;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mergedItems.length 仅为快照读取，入 deps 会把定位变成随条目增长重跑（GAP-2 旧根因）
  }, [hasItems, sessionId]);

  // 页面重新可见（手机切出再切回）：原本贴底则回底——防止系统滚动恢复/SSE 重连重排后停在旧位置
  useEffect(() => {
    const onVisible = (): void => {
      // 可见性切换快照（26d）：回前台时标志真伪与是否触发回底——#26 路径③取证
      if (document.visibilityState === "visible") {
        diag.info("scroll", "visibility", { follow: followRef.current, scrolled: followRef.current });
      }
      if (document.visibilityState === "visible" && followRef.current) scrollToAnchor();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [scrollToAnchor]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="chat-scroll"
        className="h-full overflow-y-auto overscroll-contain px-3 py-4 sm:px-4"
      >
        {mergedItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-sm text-muted-foreground">
            <p>{t("chat.messageList.empty")}</p>
            {/* 空态用法提示卡（docs08 2026-10-22 批次任务 25）：开关关/已关/无数据时自隐藏 */}
            <TipCard />
          </div>
        ) : (
          <div
            ref={contentRef}
            data-testid="chat-scroll-content"
            className="relative mx-auto max-w-3xl"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((vi) => (
              <div
                key={vi.key}
                data-index={vi.index}
                data-entry-key={mergedItems[vi.index].key}
                ref={virtualizer.measureElement}
                className="w-full pb-3"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <Row
                  item={mergedItems[vi.index]}
                  sessionId={sessionId}
                  siblings={siblings}
                  onSwitchSibling={onSwitchSibling}
                  switchDisabled={switchDisabled}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <NavRail
        items={mergedItems}
        sessionId={sessionId}
        scrollRef={scrollRef}
        virtualizer={virtualizer}
        fetchPage={(opts) => api.listMessages(sessionId, opts)}
      />

      {(syncing || compacting) && (
        <div className={`pointer-events-none absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-1 ${stickyUser ? "top-10" : "top-2"}`}>
          {compacting && (
            <div
              data-testid="compacting-banner"
              className="rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm"
            >
              {t("chat.compact.ongoing")}
            </div>
          )}
          {syncing && (
            <div className="rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm">
              {t("chat.messageList.syncing")}
            </div>
          )}
        </div>
      )}

      {stickyUser && (
        <div
          data-testid="sticky-user-message"
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 flex justify-center px-3 pt-2"
        >
          <div className="max-w-full truncate rounded-full bg-primary px-3.5 py-1.5 text-xs text-primary-foreground shadow-md">
            {stickyUser.text}
          </div>
        </div>
      )}

      {showJump && mergedItems.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          data-testid="jump-bottom"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          onClick={() => {
            followRef.current = true;
            setShowJump(false);
            scrollToAnchor(true);
          }}
        >
          <ArrowDown className="size-3.5" />
          {t("chat.messageList.jumpToBottom")}
        </Button>
      )}
    </div>
  );
}
