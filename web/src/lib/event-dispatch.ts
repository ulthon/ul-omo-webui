// SSE 帧分发（计划 todo 14）：把 {projectPath, event, durableSessionId?} wire 帧按会话路由进 stores。
// 路由键优先取信封 durableSessionId（durable 会话 id，与 REST 的会话 id 一致），缺席回退
// wire sessionId（holder 别名 rpc-N，服务端映射不明时如实不注入）。主通道 messages.applyWireEvent
// （消息/流式/工具生命周期，未知类型静默忽略）；会话级运行状态（agent_start/end/settled/idle）
// 同步进 sessions store，供 todo 15 状态点消费。
// gap 帧 / 游标回退（服务端重启游标归零）→ 对已加载会话做全量 refetch（GET messages
// 先取后换，重取期间界面不清空），替代增量补发——覆盖手机杀后台数分钟的场景。
import { api } from "@/lib/api";
import { useMessagesStore, type WireEvent } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";

/** 最后见到的全局游标（SSE id 行）；null = 尚未收到任何事件。用于服务端游标归零检测。 */
let lastCursor: number | null = null;

/** 进行中的全量重取（按会话去重：gap + 游标回退连击时不重复拉取） */
const refetching = new Set<string>();

/** 当前分发游标（单测断言用） */
export function getDispatchCursor(): number | null {
  return lastCursor;
}

/** 重置分发层状态（单测隔离用） */
export function resetDispatchState(): void {
  lastCursor = null;
  refetching.clear();
}

/** 已加载 / 有过活动的会话全量重取：GET messages 后 setEntries 整替（先取后换）。
 * store 中存在的会话 = 客户端关心过的会话（打开过或流式过），gap/游标回退时全部
 * 校准；refetch 的 setEntries 会置 loaded=true，语义诚实（确实做了全量加载）。
 * 失败静默——下一次 gap / 游标回退 / 重连重放再兜底，不打断实时流。 */
export function refetchLoadedSessions(): void {
  const { bySession } = useMessagesStore.getState();
  for (const [sessionId] of Object.entries(bySession)) {
    if (refetching.has(sessionId)) continue;
    refetching.add(sessionId);
    api
      .listMessages(sessionId)
      .then((page) => {
        // 重取完成时会话可能已被 clearSession（删除/切换清理），仅在仍存在时替换
        if (useMessagesStore.getState().bySession[sessionId]) {
          useMessagesStore.getState().setEntries(sessionId, page.entries, page.cursor, page.leafId);
        }
      })
      .catch(() => {
        // 网络瞬断等；401 已由 api 层跳登录。留待下次兜底。
      })
      .finally(() => {
        refetching.delete(sessionId);
      });
  }
}

/**
 * SSE 帧统一入口（events.ts 调用）。
 * eventType = event: 行原文（wire type 或 "gap"）；data = data: 行 JSON 原文；
 * cursor = id: 行游标（缺失/非法为 null）。
 */
export function dispatchSseEvent(eventType: string, data: string, cursor: number | null): void {
  let frame: { event?: unknown; durableSessionId?: unknown };
  try {
    frame = JSON.parse(data) as { event?: unknown; durableSessionId?: unknown };
  } catch {
    return; // 非 JSON 帧容错忽略
  }

  // 游标记账 + 回退检测：新纪元 id 小于旧游标即服务端重启归零，有不可补的丢失
  if (typeof cursor === "number") {
    if (lastCursor !== null && cursor < lastCursor) refetchLoadedSessions();
    lastCursor = cursor;
  }

  if (eventType === "gap") {
    refetchLoadedSessions();
    return;
  }

  const event = frame.event;
  if (event === null || typeof event !== "object") return;
  const wire = event as WireEvent;
  // store 路由键：信封 durableSessionId 优先（与 REST 会话 id 一致），缺席回退 wire sessionId
  const durableSessionId =
    typeof frame.durableSessionId === "string" && frame.durableSessionId.length > 0 ? frame.durableSessionId : null;
  const wireSessionId = typeof wire.sessionId === "string" ? wire.sessionId : null;
  const sessionId = durableSessionId ?? wireSessionId;
  if (!sessionId) return; // 无会话路由信息的桥级事件不进 store

  // 会话级运行状态（active 语义对齐 GET /api/sessions 的引擎活跃探询）
  if (wire.type === "agent_start") {
    useSessionsStore.getState().patchSession(sessionId, { active: true });
  } else if (wire.type === "agent_end" || wire.type === "agent_settled" || wire.type === "agent_idle") {
    useSessionsStore.getState().patchSession(sessionId, { active: false });
  }

  // 消息主通道（未知类型在 store 内静默忽略）
  useMessagesStore.getState().applyWireEvent(sessionId, wire);
}
