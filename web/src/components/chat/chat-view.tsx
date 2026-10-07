// 对话流主视图（todo 16）：按会话加载消息（游标增量）、虚拟列表渲染。
// 输入区为 composer/ 模块（todo 21：多行/图片/草稿/历史）。
// 并发锁：会话回合中（本地 SSE 流式态，含另一窗口驾驶的会话）输入禁用；prompt 撞上
// 409 already_processing 时给出明确提示（verification/05 P2-11：引擎无跨进程锁，webui 自律单驱动）。
// 中断定格：abort 后 settleStreaming 把半截内容定格进 entries，气泡带"已中断"标注直至下一次发送。
// todo 24：/ 命令门注册（拦截不支持命令直通模型）+ 命令按钮行 + 底部 token/费用状态条。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { api, setPromptGate } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { usePermissionsStore } from "@/stores/permissions";
import { useSessionsStore } from "@/stores/sessions";
import type { WireEntry, WireMessage } from "@/lib/api";
import { Composer } from "@/components/composer/composer";
import { CommandBar } from "./command-bar";
import { commandGate } from "./commands";
import { MessageList, type ChatListItem } from "./message-list";
import { PermissionQueue } from "./permission-queue";
import { StatusBar } from "./status-bar";

/** 无选中会话时的空态提示 */
function EmptyHint() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <MessagesSquare className="size-10 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">从左侧选择会话，或新建一个会话开始对话</p>
      </div>
    </div>
  );
}

function isMessageEntry(entry: WireEntry): entry is WireEntry & { id: string; message: WireMessage } {
  if (entry.type !== "message" || typeof entry.id !== "string") return false;
  const msg = entry.message as WireMessage | undefined;
  return Boolean(msg && typeof msg.role === "string");
}

/** 单会话视图：sessionId 变化时整体重挂载（key 保证滚动/状态干净） */
function ChatSession({ sessionId }: { sessionId: string }) {
  const [loadState, setLoadState] = useState<"loading" | "done" | "error">("loading");
  const [retrySeq, setRetrySeq] = useState(0);
  const [interrupted, setInterrupted] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncingUntilRef = useRef(0);
  const syncInFlightRef = useRef(false);

  const entries = useMessagesStore((s) => s.bySession[sessionId]?.entries);
  const streaming = useMessagesStore((s) => s.bySession[sessionId]?.streaming ?? false);
  const hasStreamingMessage = useMessagesStore((s) => s.bySession[sessionId]?.streamingMessage != null);
  const hasPendingPermission = usePermissionsStore((s) => (s.bySession[sessionId]?.length ?? 0) > 0);
  const runState = useSessionsStore((s) => s.runStates[sessionId]);

  // 输入锁：流式中或权限未决都阻塞回合（P0-2 实证：挂起权限回合不结束）。
  // 权限锁不依赖 agent_start 时序（个别回合该帧缺失，todo 16 QA 第 3 轮实证）。
  const composerLocked = streaming || hasPendingPermission;

  // / 命令门（todo 24）：注册到 api.prompt 链路，输入以 / 开头且命中不支持命令时
  // 抛 ApiError（composer 行内明示），阻止引擎把命令当普通消息交给模型（模型会伪造已执行）。
  useEffect(() => {
    setPromptGate(commandGate);
    return () => setPromptGate(null);
  }, []);

  // 僵尸流式兜底：agent_start 已置流式，但 assistant 流式始终未开始（实测引擎个别回合
  // 收尾事件缺席——message_start/end、turn_end、agent_end 全缺，QA 第 2 轮实证），
  // 超过宽限仍无流式消息则复位，避免输入区被永久锁死。
  // 误解锁的代价只是 prompt 撞 409 得到提示（安全侧）；真实慢启动回合在 assistant
  // message_start 到达时本 effect 自动撤销定时。
  useEffect(() => {
    if (!(streaming && !hasStreamingMessage)) return;
    const timer = setTimeout(() => {
      const st = useMessagesStore.getState().bySession[sessionId];
      if (st?.streaming && !st.streamingMessage && !st.streamingEntryId) {
        useMessagesStore.getState().setStreaming(sessionId, false);
      }
    }, 10_000);
    return () => clearTimeout(timer);
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
    api
      .listMessages(sessionId, cursor)
      .then((page) => {
        if (cancelled) return;
        const store = useMessagesStore.getState();
        if (cursor) {
          store.appendEntries(sessionId, page.entries);
          store.setCursor(sessionId, page.cursor);
        } else {
          store.setEntries(sessionId, page.entries, page.cursor, page.leafId);
        }
        setLoadState("done");
        // 打开即已读（服务端 unread 清零语义：任一设备查看即清零）
        void api.markRead(sessionId).catch(() => {});
        // 预取前端 auto-allow 列表（kv，命中时权限 select 自动放行不弹卡）
        usePermissionsStore.getState().refreshAutoAllow(sessionId);
      })
      .catch(() => {
        if (!cancelled) setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, retrySeq]);

  // 顶部触顶：游标增量同步（引擎 getEntries 为 since 语义，首载即全量，此钩子兜底补漏；
  // 10s 冷却防贴顶滚动反复请求）
  const onReachTop = useCallback(() => {
    if (syncInFlightRef.current) return;
    if (Date.now() < syncingUntilRef.current) return;
    const cursor = useMessagesStore.getState().bySession[sessionId]?.cursor;
    if (!cursor) return;
    syncInFlightRef.current = true;
    setSyncing(true);
    api
      .listMessages(sessionId, cursor)
      .then((page) => {
        const store = useMessagesStore.getState();
        store.appendEntries(sessionId, page.entries);
        store.setCursor(sessionId, page.cursor);
      })
      .catch(() => {})
      .finally(() => {
        syncInFlightRef.current = false;
        syncingUntilRef.current = Date.now() + 10_000;
        setSyncing(false);
      });
  }, [sessionId]);

  const messageEntries = useMemo(
    () => (entries ?? []).filter(isMessageEntry),
    [entries],
  );

  const items = useMemo<ChatListItem[]>(() => {
    let lastAssistantId: string | null = null;
    for (const e of messageEntries) {
      if ((e.message as WireMessage).role === "assistant") lastAssistantId = e.id;
    }
    const list: ChatListItem[] = messageEntries.map((e) => ({
      key: e.id,
      kind: "entry" as const,
      entryId: e.id,
      interrupted: interrupted && e.id === lastAssistantId,
    }));
    if (hasStreamingMessage) list.push({ key: "__streaming", kind: "streaming" });
    return list;
  }, [messageEntries, hasStreamingMessage, interrupted]);

  if (loadState === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">加载消息…</div>
    );
  }
  if (loadState === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">消息加载失败，请检查服务是否可用</p>
        <button
          type="button"
          onClick={() => setRetrySeq((n) => n + 1)}
          className="rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <MessageList items={items} sessionId={sessionId} syncing={syncing} onReachTop={onReachTop} />
      <PermissionQueue sessionId={sessionId} />
      <div className="shrink-0 border-t p-3">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          <CommandBar sessionId={sessionId} busy={composerLocked} />
          <Composer
            sessionId={sessionId}
            busy={composerLocked}
            onSent={() => setInterrupted(false)}
            onAborted={() => setInterrupted(true)}
          />
        </div>
      </div>
      <StatusBar sessionId={sessionId} />
    </div>
  );
}

/** ChatView 入口：选中会话（store）优先，?session= 参数兜底（深链 / QA 用） */
export function ChatView() {
  const selectedId = useSessionsStore((s) => s.selectedId);
  const urlSession = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("session");
  }, []);
  const sessionId = selectedId ?? urlSession;
  if (!sessionId) return <EmptyHint />;
  return <ChatSession key={sessionId} sessionId={sessionId} />;
}
