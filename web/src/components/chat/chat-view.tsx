// 对话流主视图（todo 16）：按会话加载消息（游标增量）、虚拟列表渲染。
// 输入区为 composer/ 模块（todo 21：多行/图片/草稿/历史）。
// 并发锁：会话回合中（本地 SSE 流式态，含另一窗口驾驶的会话）输入禁用；prompt 撞上
// 409 already_processing 时给出明确提示（verification/05 P2-11：引擎无跨进程锁，webui 自律单驱动）。
// 中断定格：abort 后 settleStreaming 把半截内容定格进 entries，气泡带"已中断"标注直至下一次发送。
// todo 24：/ 命令门注册（拦截不支持命令直通模型）+ 底部 token/费用状态条；
// docs08-r6 任务 13：命令按钮行（command-bar）整文件退役，命令门链（commands.ts →
// api.prompt）与 /compact 斜杠下拉静态段保留，按钮显隐不再参与功能面。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { api, setPromptGate } from "@/lib/api";
import { readSessionUrl } from "@/lib/session-url";
import { perfMark, perfMeasure, webPerfEnabled } from "@/lib/perf";
import { useIsMobile } from "@/lib/use-is-mobile";
import { useMessagesStore } from "@/stores/messages";
import { resolveReachTopAction } from "./reach-top";
import { usePermissionsStore } from "@/stores/permissions";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import type { WireEntry, WireMessage } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { Composer } from "@/components/composer/composer";
import { useHydrationRunLock } from "./hydration-lock";
import { commandGate } from "./commands";
import { MessageList } from "./message-list";
import { buildMessageItems, type ChatListItem } from "./message-items";
import { PermissionQueue } from "./permission-queue";
import { QuestionQueue } from "./question-queue";
import { QueueBar } from "./queue-bar";
import { StatusBar } from "./status-bar";
import { reconcilePendingState, zombieReconcileAndReset } from "./zombie-reset";

/** 无选中会话时的空态提示 */
function EmptyHint() {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <MessagesSquare className="size-10 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{t("chat.chatView.emptyHint")}</p>
      </div>
    </div>
  );
}

/** 首载骨架（docs08-r7 任务 13，对标 OC：切会话/首载先渲染 logo 占位骨架替代纯文字，
 *  无白屏闪跳）：项目 logo 呼吸（busy-pulse）+ 三点追逐（busy-dots）+ 静态骨架条；
 *  reduced-motion 降为静态可辨（logo 常态、点=中灰省略号）；role=status + 既有
 *  loading 键保读屏可达，无新增 i18n 键 */
export function ChatLoadSkeleton() {
  const t = useT();
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-5"
      role="status"
      aria-label={t("chat.chatView.loading")}
    >
      <img src="/favicon.svg" alt="" aria-hidden className="size-12 animate-busy-pulse" />
      <div className="flex items-center gap-1.5" aria-hidden>
        <span className="busy-dot size-1.5 rounded-full bg-muted-foreground/60" />
        <span className="busy-dot size-1.5 rounded-full bg-muted-foreground/60" />
        <span className="busy-dot size-1.5 rounded-full bg-muted-foreground/60" />
      </div>
      <div className="flex w-44 flex-col gap-2" aria-hidden>
        <div className="h-2.5 w-full rounded-full bg-muted" />
        <div className="h-2.5 w-2/3 rounded-full bg-muted" />
        <div className="h-2.5 w-1/2 rounded-full bg-muted" />
      </div>
    </div>
  );
}

function isMessageEntry(entry: WireEntry): entry is WireEntry & { id: string; message: WireMessage } {
  if (entry.type !== "message" || typeof entry.id !== "string") return false;
  const msg = entry.message as WireMessage | undefined;
  return Boolean(msg && typeof msg.role === "string");
}

/** custom_message 历史条目（docs08-r6 任务 10 ③）：携 id 即过本门入分类；可见性
 *  （display）由 buildMessageItems 判定——display=false 引擎明示不展示，不入列。 */
function isCustomMessageEntry(entry: WireEntry): entry is WireEntry & { id: string } {
  return entry.type === "custom_message" && typeof entry.id === "string";
}

/** custom 历史条目（docs08 2026-10-25 用户反馈）：记忆停驻通知（reflection-parked）
 *  的承载型。携 id 即过本门（结构窄化在 buildMessageItems 的 reflectionParkedOf，
 *  未知 customType 仍不入列——渲染层旧口径不变）。 */
function isCustomEntry(entry: WireEntry): entry is WireEntry & { id: string } {
  return entry.type === "custom" && typeof entry.id === "string";
}

/** model_change 时间线条目（docs08 2026-10-22 批次任务 18）：变体名单遍时间线的
 *  数据源——不入列渲染（buildMessageItems 无 message 载荷自然跳过），仅供解析。
 *  实测 jsonl 形态：{"type":"model_change",id,provider,modelId,...}。 */
function isModelChangeEntry(entry: WireEntry): entry is WireEntry & { id: string } {
  return entry.type === "model_change" && typeof entry.id === "string";
}

/** 单会话视图：sessionId 变化时整体重挂载（key 保证滚动/状态干净） */
function ChatSession({ sessionId }: { sessionId: string }) {
  const [loadState, setLoadState] = useState<"loading" | "done" | "error">("loading");
  const [retrySeq, setRetrySeq] = useState(0);
  const [autoRetried, setAutoRetried] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncingUntilRef = useRef(0);
  const syncInFlightRef = useRef(false);

  const entries = useMessagesStore((s) => s.bySession[sessionId]?.entries);
  const streaming = useMessagesStore((s) => s.bySession[sessionId]?.streaming ?? false);
  const hasStreamingMessage = useMessagesStore((s) => s.bySession[sessionId]?.streamingMessage != null);
  const hasPendingPermission = usePermissionsStore((s) => (s.bySession[sessionId]?.length ?? 0) > 0);
  const runState = useSessionsStore((s) => s.runStates[sessionId]);
  // A6（docs08-r4 任务 6）：手机档 StatusBar 退役（信息上收顶栏水位环），条件渲染——
  // DOM 不存在（非 CSS 隐藏）；桌面（lg+）现状保留。
  const isMobile = useIsMobile();

  // 输入锁拆解（docs08-r4 任务 11）：权限锁（hasPendingPermission）与流式态分离——
  // 权限锁禁一切输入动作（P0-2 实证：挂起权限回合不结束）；流式态输入可用、发送变
  // 排队（Composer 双信号下传）。
  const t = useT();

  // 运行态水合锁（docs08-r5 任务 6）：刷新/会话打开起默认按「进行中」阻塞，首个权威
  // 运行态信号（runStates 写入 / 探询 active / 探询完成仍 unknown）解锁，不回锁。
  // 已知 running 解锁后照常排队（r4 语义不回退）：queueAvailable 并入 knownRunning。
  const { hydrationLocked, knownRunning } = useHydrationRunLock(sessionId);

  // / 命令门（todo 24）：注册到 api.prompt 链路，输入以 / 开头且命中不支持命令时
  // 抛 ApiError（composer 行内明示），阻止引擎把命令当普通消息交给模型（模型会伪造已执行）。
  useEffect(() => {
    setPromptGate(commandGate);
    return () => setPromptGate(null);
  }, []);

  // 僵尸流式兜底：agent_start 已置流式，但 assistant 流式始终未开始（实测引擎个别回合
  // 收尾事件缺席——message_start/end、turn_end、agent_end 全缺，QA 第 2 轮实证），
  // 超过宽限仍无流式消息则复位，避免输入区被永久锁死。
  // docs08-r6 任务 6 ②：复位前先对账（GET questions/queue 同款代码）——仍有未决提问
  // 或排队项则维持锁定与中断口（对账入队的问题卡使中断逃逸口可见）；对账失败
  // 宁缺勿错解锁。误解锁的代价只是 prompt 撞 409 得到提示（安全侧）；真实慢启动回合
  // 在 assistant message_start 到达时本 effect 自动撤销定时。
  useEffect(() => {
    if (!(streaming && !hasStreamingMessage)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const st = useMessagesStore.getState().bySession[sessionId];
      if (!(st?.streaming && !st.streamingMessage && !st.streamingEntryId)) return;
      void zombieReconcileAndReset(sessionId, () => cancelled);
    }, 10_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [streaming, hasStreamingMessage, sessionId]);

  // 回合落定（agent_settled → runState=idle）且页面可见时补发一次已读上报：
  // 服务端对非查看态会话递增未读（entry_appended 接线），落定补读把"看过这轮"落库。
  const prevRunStateRef = useRef(runState);
  useEffect(() => {
    const prev = prevRunStateRef.current;
    prevRunStateRef.current = runState;
    if (runState !== "idle" || prev === "idle") return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    void api.markRead(sessionId).catch(() => {});
  }, [runState, sessionId]);

  // 打开会话：全量加载；已加载过（本页会话切换回来）则按游标增量校准。
  // loading 初值即 "loading"（会话切换经 key 重挂载），重试按钮在事件里显式置 loading。
  useEffect(() => {
    let cancelled = false;
    const existing = useMessagesStore.getState().bySession[sessionId];
    const cursor = existing?.loaded ? (existing.cursor ?? undefined) : undefined;
    // Fix0 前端埋点（docs08 任务 1；localStorage ulomo_perf=1 门控，默认零输出）：
    // 首载耗时 mark/measure（DevTools Performance 面板可见）+ 控制台一行摘要
    const perfOn = webPerfEnabled();
    const loadMark = `ulomo:messages-start:${sessionId}`;
    if (perfOn) perfMark(loadMark);
    api
      .listMessages(sessionId, cursor ? { cursor } : undefined)
      .then((page) => {
        if (cancelled) return;
        const store = useMessagesStore.getState();
        if (cursor) {
          store.appendEntries(sessionId, page.entries);
          store.setCursor(sessionId, page.cursor);
        } else {
          // 任务 16：首载尾窗直读——携带 hasMore/oldestId 供触顶向上翻页；
          // cursor 仍为文件 leafId（切回会话的前向增量校准不变）
          store.setEntries(sessionId, page.entries, page.cursor, page.leafId, {
            hasMore: page.hasMore ?? false,
            oldestId: page.oldestId ?? null,
          });
        }
        setLoadState("done");
        if (perfOn) {
          const ms = perfMeasure(`ulomo:messages:${sessionId}`, loadMark, `ulomo:messages-end:${sessionId}`);
          if (ms !== undefined) {
            console.log(
              `[perf] web op=messages session=${sessionId.slice(0, 8)} ms=${ms.toFixed(1)} entries=${page.entries.length}${cursor ? " incr=1" : ""}`,
            );
          }
        }
        // 打开即已读（服务端 unread 清零语义：任一设备查看即清零）
        void api.markRead(sessionId).catch(() => {});
        // 预取前端 auto-allow 列表（kv，命中时权限 select 自动放行不弹卡）
        usePermissionsStore.getState().refreshAutoAllow(sessionId);
        // 未决提问 + 排队快照对账（q1 / docs08-r4 任务 11 同款；docs08-r6 任务 6 ②提为
        // 共用：增量走 SSE question / queue_update 帧，此处覆盖服务端重启/环形缓冲淘汰）
        void reconcilePendingState(sessionId, () => cancelled);
      })
      .catch(() => {
        if (!cancelled) setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, retrySeq]);

  // todo 26 走查修复：首次加载失败自动重试一次（手机弱网/引擎冷启动窗口常见 503；
  // 引擎 restart 后打开会话实测撞 engine_not_ready 停错误态）。只自动试一次，避免死循环。
  useEffect(() => {
    if (loadState !== "error" || autoRetried) return;
    const timer = setTimeout(() => {
      setAutoRetried(true);
      setLoadState("loading");
      setRetrySeq((n) => n + 1);
    }, 2500);
    return () => clearTimeout(timer);
  }, [loadState, autoRetried]);

  // 顶部触顶：任务 16——hasMore 时向上翻页（?before= 后向拉更早窗，id 去重头插，
  // 拼缝零重复零丢失）；否则原游标增量同步（引擎 getEntries since 语义兜底补漏；
  // 10s 冷却防贴顶滚动反复请求）
  const onReachTop = useCallback(() => {
    if (syncInFlightRef.current) return;
    if (Date.now() < syncingUntilRef.current) return;
    const state = useMessagesStore.getState().bySession[sessionId];
    const action = resolveReachTopAction(state);
    if (!action) return;
    syncInFlightRef.current = true;
    setSyncing(true);
    api
      .listMessages(sessionId, action.kind === "before" ? { before: action.before } : { cursor: action.cursor })
      .then((page) => {
        const store = useMessagesStore.getState();
        if (action.kind === "before") {
          store.prependEntries(sessionId, page.entries, {
            hasMore: page.hasMore ?? false,
            oldestId: page.oldestId ?? null,
          });
        } else {
          store.appendEntries(sessionId, page.entries);
          store.setCursor(sessionId, page.cursor);
        }
      })
      .catch(() => {})
      .finally(() => {
        syncInFlightRef.current = false;
        syncingUntilRef.current = Date.now() + 10_000;
        setSyncing(false);
      });
  }, [sessionId]);

  const messageEntries = useMemo(
    () => (entries ?? []).filter((e) => isMessageEntry(e) || isCustomMessageEntry(e) || isCustomEntry(e) || isModelChangeEntry(e)),
    [entries],
  );

  // 变体名解析数据源（docs08 2026-10-22 批次任务 18）：注册表 = GET /api/models 行
  // （服务端已合并 upstreamId）；appliedModel = 会话内最新生效（内存态，刷新后空）。
  const models = useUiStore((s) => s.models);
  const appliedModel = useSessionsStore((s) => s.appliedModels[sessionId] ?? null);

  const items = useMemo<ChatListItem[]>(
    () =>
      buildMessageItems(messageEntries, {
        hasStreamingMessage,
        interrupted,
        modelRegistry: models,
        appliedModel,
      }),
    [messageEntries, hasStreamingMessage, interrupted, models, appliedModel],
  );

  if (loadState === "loading") {
    return <ChatLoadSkeleton />;
  }
  if (loadState === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">{t("chat.chatView.loadFailed")}</p>
        <button
          type="button"
          onClick={() => setRetrySeq((n) => n + 1)}
          className="rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
        >
          {t("chat.chatView.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <MessageList items={items} sessionId={sessionId} syncing={syncing} onReachTop={onReachTop} />
      <PermissionQueue sessionId={sessionId} />
      <QuestionQueue sessionId={sessionId} />
      {/* docs08-r4 任务 7：手机档容器贴边（左右 12px，底部安全区由 Composer 自带 pb 承担），
          桌面档 sm+ 保持 p-3 原样 */}
      <div className="shrink-0 border-t px-3 pb-0 pt-3 sm:p-3">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {/* 排队条（docs08-r4 任务 11）：输入区上方细条，空列表不渲染 */}
          <QueueBar sessionId={sessionId} />
          {/* 中断逃逸口（docs08-r6 任务 6 ①）：queueAvailable 传入处并入 runState
              running/waiting 显式并集（knownRunning 虽已含，此处按计划定死保守并集，
              中断口宁多勿少，防 hydration-lock 口径演进回归） */}
          {/* 发消息即上浮（docs08 2026-10-23/24 批次任务 13 ①）：回执时刻本地乐观上浮
              （排队/直发两路回执都走 onSent）。取值从 store 现读 selectedId 兑底
              props sessionId——直发首条消息 adopt 换 key 后闭包里的旧 id 已不在
              byProject，浮到新 id 才不落空 */}
          <Composer
            sessionId={sessionId}
            queueAvailable={streaming || knownRunning || runState === "running" || runState === "waiting"}
            permissionLocked={hasPendingPermission}
            hydrationLocked={hydrationLocked}
            onSent={() => {
              setInterrupted(false);
              const cur = useSessionsStore.getState();
              cur.floatSessionUp(cur.selectedId ?? sessionId);
            }}
            onAborted={() => setInterrupted(true)}
          />
        </div>
      </div>
      {!isMobile && <StatusBar sessionId={sessionId} />}
    </div>
  );
}

/** ChatView 入口：选中会话（store）优先，?session= 参数兜底（深链 / QA 用）。
 * B1：读取统一走 lib/session-url 助手（shell.tsx 同源收敛）；AppShell 引导完成后已按
 * URL 参数显式 select，此兜底仅覆盖引导完成前的窗口，保持原安全链不删。 */
export function ChatView() {
  const selectedId = useSessionsStore((s) => s.selectedId);
  const urlSession = useMemo(() => readSessionUrl(), []);
  const sessionId = selectedId ?? urlSession;
  if (!sessionId) return <EmptyHint />;
  return <ChatSession key={sessionId} sessionId={sessionId} />;
}
