// 消息域：按会话的消息条目 / 分页游标 / part 级更新动作。
// applyWireEvent 是 todo 14 SSE 客户端的统一分发入口，消化引擎 wire 事件的关键几类
// （message_start/update/end、turn_end、tool_execution_start/end、agent_start/end/settled/idle），
// 未知事件类型（omo 扩展的 setStatus/setWidget/notify、tool_hook_status 等噪音）一律容错忽略。
// 流式 assistant 消息独立存放（streamingMessage），delta 只更新单个对象；定格时并入 entries。
import { create } from "zustand";
import type { WireEntry, WireMessage, WirePart } from "@/lib/api";

export interface ToolRun {
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: "running" | "done";
  result?: unknown;
}

export interface SessionMessages {
  /** 已定格条目（wire 原样：{type:"message",id,...} 等） */
  entries: WireEntry[];
  /** 分页游标：GET messages?cursor= 传回取增量；null=已最新 */
  cursor: string | null;
  leafId: string | null;
  /** 是否做过全量加载（gap 全量重取的判据） */
  loaded: boolean;
  streaming: boolean;
  /** 流式中的 assistant 消息（part 级就地更新；定格时并入 entries） */
  streamingMessage: WireMessage | null;
  streamingEntryId: string | null;
  /** 工具执行生命周期（事件驱动，todo 17 卡片消费） */
  toolRuns: Record<string, ToolRun>;
}

/** SSE wire 事件（{projectPath, event} 的 event 部分），结构从宽、按 type 甄别 */
export interface WireEvent {
  type: string;
  [key: string]: unknown;
}

export interface DeltaPatch {
  contentIndex: number;
  kind: "text" | "thinking";
  text: string;
}

interface MessagesState {
  bySession: Record<string, SessionMessages>;

  /** 全量加载 / gap 全量重取 */
  setEntries(sessionId: string, entries: WireEntry[], cursor: string | null, leafId: string | null): void;
  setCursor(sessionId: string, cursor: string | null): void;
  /** 增量分页（向上翻历史） */
  appendEntries(sessionId: string, entries: WireEntry[]): void;
  /** SSE wire 事件统一入口（todo 14 调用）；未知类型静默忽略 */
  applyWireEvent(sessionId: string, event: WireEvent): void;
  /** part 级流式增量（作用于当前流式 assistant 消息） */
  appendDelta(sessionId: string, patch: DeltaPatch): void;
  /** part 替换 / 建立（定格某 part 或工具卡片占位） */
  upsertPart(sessionId: string, contentIndex: number, part: WirePart): void;
  /** 定格流式 assistant 消息并并入 entries（turn_end/message_end 全量或 abort 半截） */
  settleStreaming(sessionId: string, finalMessage?: WireMessage): void;
  setStreaming(sessionId: string, streaming: boolean): void;
  clearSession(sessionId: string): void;
  /** 发送成功后的本地乐观用户条目（缺陷修复：新会话首条用户消息的服务端事件以路由
   *  句柄寻址、handle→durable 映射回填前不入列）——先本地占位，后续 setEntries 全量
   *  重取以服务端真值整替；服务端 user 事件到达时按等价吸收（防双列） */
  appendLocalUserEntry(sessionId: string, text: string, images?: Array<{ data: string; mimeType: string }>): void;
  /** 首条消息落盘后采用服务端回传的真实 id：迁移消息槽（目标槽已有时事件真值优先，
   *  仅补携带本地乐观条目防丢） */
  adoptDurableId(oldId: string, newId: string): void;
}

function emptySessionMessages(): SessionMessages {
  return {
    entries: [],
    cursor: null,
    leafId: null,
    loaded: false,
    streaming: false,
    streamingMessage: null,
    streamingEntryId: null,
    toolRuns: {},
  };
}

/** wire entry 按 id upsert（无 id 则追加） */
function upsertEntry(list: WireEntry[], entry: WireEntry): WireEntry[] {
  const id = typeof entry.id === "string" ? entry.id : null;
  if (id) {
    const idx = list.findIndex((e) => e.id === id);
    if (idx >= 0) {
      const next = list.slice();
      next[idx] = entry;
      return next;
    }
  }
  return [...list, entry];
}

/** 确定性合成 id：同一消息被 turn_end + message_end 先后定格时按 id 去重（djb2） */
function syntheticId(msg: WireMessage): string {
  const text = JSON.stringify(msg);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}-${text.length}`;
}

/** 本地乐观用户条目 id 前缀（appendLocalUserEntry 生成） */
const LOCAL_ENTRY_PREFIX = "local-";

/** 消息首个 text part 的文本（无文本 part 返回 null，如纯图消息） */
function firstTextOf(msg: WireMessage): string | null {
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") return part.text;
  }
  return null;
}

/** 服务端 user 消息事件到达时吸收等价本地乐观占位（同首文本），防双列；
 * 纯图消息（无文本锚点）不吸收，由全量重取收敛 */
function absorbLocalUserEntries(list: WireEntry[], serverMsg: WireMessage): WireEntry[] {
  const serverText = firstTextOf(serverMsg);
  if (serverText === null || serverText === "") return list;
  return list.filter((e) => {
    if (typeof e.id !== "string" || !e.id.startsWith(LOCAL_ENTRY_PREFIX)) return true;
    const m = e.message as WireMessage | undefined;
    if (!m || m.role !== "user") return true;
    return firstTextOf(m) !== serverText;
  });
}

function upsertToolRun(
  session: SessionMessages,
  toolCallId: string,
  patch: Partial<ToolRun> & { toolCallId: string },
): SessionMessages {
  const prev = session.toolRuns[toolCallId];
  const base: ToolRun = prev ?? { toolCallId, toolName: "unknown", args: null, status: "running" };
  return {
    ...session,
    toolRuns: { ...session.toolRuns, [toolCallId]: { ...base, ...patch } },
  };
}

export const useMessagesStore = create<MessagesState>()((set, get) => {
  /** 定格动作（settleStreaming 的实现体，复用于事件分支） */
  const settle = (sessionId: string, finalMessage?: WireMessage) =>
    set((s) => {
      const cur = s.bySession[sessionId];
      if (!cur) return s;
      const msg = finalMessage ?? cur.streamingMessage;
      if (!msg) {
        return cur.streaming ? { bySession: { ...s.bySession, [sessionId]: { ...cur, streaming: false } } } : s;
      }
      const id = cur.streamingEntryId ?? syntheticId(msg);
      const entry: WireEntry = { type: "message", id, message: msg };
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: {
            ...cur,
            entries: upsertEntry(cur.entries, entry),
            streamingMessage: null,
            streamingEntryId: null,
            streaming: false,
          },
        },
      };
    });

  const applyAssistantMessageEvent = (sessionId: string, ev: Record<string, unknown>) => {
    const type = typeof ev.type === "string" ? ev.type : "";
    const contentIndex = typeof ev.contentIndex === "number" ? ev.contentIndex : 0;
    switch (type) {
      case "text_start":
        get().upsertPart(sessionId, contentIndex, { type: "text", text: "" });
        break;
      case "thinking_start":
        get().upsertPart(sessionId, contentIndex, { type: "thinking", thinking: "" });
        break;
      case "text_delta":
      case "thinking_delta": {
        const delta = typeof ev.delta === "string" ? ev.delta : typeof ev.text === "string" ? ev.text : null;
        if (delta === null) break;
        get().appendDelta(sessionId, {
          contentIndex,
          kind: type === "text_delta" ? "text" : "thinking",
          text: delta,
        });
        break;
      }
      // *_end / toolcall_*（执行事实以 tool_execution_start 为准）/ 未知类型：忽略
      default:
        break;
    }
  };

  return {
    bySession: {},

    setEntries: (sessionId, entries, cursor, leafId) =>
      set((s) => ({
        bySession: {
          ...s.bySession,
          [sessionId]: { ...emptySessionMessages(), ...s.bySession[sessionId], entries, cursor, leafId, loaded: true },
        },
      })),

    setCursor: (sessionId, cursor) =>
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur) return s;
        return { bySession: { ...s.bySession, [sessionId]: { ...cur, cursor } } };
      }),

    appendEntries: (sessionId, entries) =>
      set((s) => {
        const cur = s.bySession[sessionId] ?? emptySessionMessages();
        let list = cur.entries;
        for (const entry of entries) list = upsertEntry(list, entry);
        return { bySession: { ...s.bySession, [sessionId]: { ...cur, entries: list } } };
      }),

    applyWireEvent: (sessionId, event) => {
      switch (event.type) {
        case "message_start":
        case "message_end": {
          const entry = event as WireEntry;
          const msg = entry.message as WireMessage | undefined;
          if (!msg || typeof msg.role !== "string") break;
          if (msg.role === "assistant") {
            if (event.type === "message_start") {
              // 进入流式：暂存 streamingMessage（定格时并入 entries）
              set((s) => {
                const cur = s.bySession[sessionId] ?? emptySessionMessages();
                return {
                  bySession: {
                    ...s.bySession,
                    [sessionId]: {
                      ...cur,
                      streaming: true,
                      streamingMessage: msg,
                      streamingEntryId: typeof entry.id === "string" ? entry.id : null,
                    },
                  },
                };
              });
            } else {
              settle(sessionId, msg);
            }
          } else {
            // user / toolResult 等直接入列（wire 原样）。user 消息先吸收等价的本地
            // 乐观占位（发送成功后即时入列的 local-* 条目）——以服务端真值替换，防双列
            set((s) => {
              const cur = s.bySession[sessionId] ?? emptySessionMessages();
              const base = msg.role === "user" ? absorbLocalUserEntries(cur.entries, msg) : cur.entries;
              return {
                bySession: { ...s.bySession, [sessionId]: { ...cur, entries: upsertEntry(base, entry) } },
              };
            });
          }
          break;
        }

        case "message_update": {
          const ev = event.assistantMessageEvent;
          if (ev !== null && typeof ev === "object") {
            applyAssistantMessageEvent(sessionId, ev as Record<string, unknown>);
          }
          break;
        }

        case "turn_end": {
          const msg = event.message as WireMessage | undefined;
          if (!msg || typeof msg.role !== "string") break;
          // 全量定格；无在途流式消息时忽略（消息由 message_start/end 或全量重取覆盖，防重复入列）
          const cur = get().bySession[sessionId];
          if (cur?.streamingMessage || cur?.streamingEntryId) settle(sessionId, msg);
          break;
        }

        case "tool_execution_start": {
          const toolCallId = event.toolCallId;
          if (typeof toolCallId !== "string") break;
          set((s) => {
            const cur = s.bySession[sessionId] ?? emptySessionMessages();
            return {
              bySession: {
                ...s.bySession,
                [sessionId]: upsertToolRun(cur, toolCallId, {
                  toolCallId,
                  toolName: typeof event.toolName === "string" ? event.toolName : "unknown",
                  args: event.args,
                  status: "running",
                }),
              },
            };
          });
          break;
        }

        case "tool_execution_end": {
          const toolCallId = event.toolCallId;
          if (typeof toolCallId !== "string") break;
          set((s) => {
            const cur = s.bySession[sessionId] ?? emptySessionMessages();
            return {
              bySession: {
                ...s.bySession,
                [sessionId]: upsertToolRun(cur, toolCallId, {
                  toolCallId,
                  status: "done",
                  result: event.result,
                }),
              },
            };
          });
          break;
        }

        case "agent_start":
          get().setStreaming(sessionId, true);
          break;

        case "agent_end":
        case "agent_settled":
          // 定格任何在途内容（abort 场景：无 turn_end，半截输出定格为已收内容）
          settle(sessionId);
          break;

        case "agent_idle":
          get().setStreaming(sessionId, false);
          break;

        // 未知 / 噪音事件（tool_hook_status、extension_ui_request、entry_appended、
        // settings_source_selected、loaded_surfaces_changed、thinking_level_changed、session_closed...）：
        // 容错忽略，不崩。
        default:
          break;
      }
    },

    appendDelta: (sessionId, patch) =>
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur?.streamingMessage) return s;
        const msg = cur.streamingMessage;
        const content = msg.content ? msg.content.slice() : [];
        const idx = patch.contentIndex;
        const existing = content[idx];
        if (existing === undefined) {
          content[idx] =
            patch.kind === "text" ? { type: "text", text: patch.text } : { type: "thinking", thinking: patch.text };
        } else if (existing.type !== patch.kind) {
          return s; // 类型不匹配且已存在：容错忽略
        } else if (patch.kind === "text") {
          content[idx] = { ...existing, text: (typeof existing.text === "string" ? existing.text : "") + patch.text };
        } else {
          content[idx] = {
            ...existing,
            thinking: (typeof existing.thinking === "string" ? existing.thinking : "") + patch.text,
          };
        }
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: { ...cur, streamingMessage: { ...msg, content } },
          },
        };
      }),

    upsertPart: (sessionId, contentIndex, part) =>
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur?.streamingMessage) return s;
        const msg = cur.streamingMessage;
        const content = msg.content ? msg.content.slice() : [];
        content[contentIndex] = part;
        return {
          bySession: { ...s.bySession, [sessionId]: { ...cur, streamingMessage: { ...msg, content } } },
        };
      }),

    settleStreaming: (sessionId, finalMessage) => settle(sessionId, finalMessage),

    setStreaming: (sessionId, streaming) =>
      set((s) => {
        const cur = s.bySession[sessionId] ?? emptySessionMessages();
        if (cur.streaming === streaming) return s;
        return { bySession: { ...s.bySession, [sessionId]: { ...cur, streaming } } };
      }),

    clearSession: (sessionId) =>
      set((s) => {
        if (!(sessionId in s.bySession)) return s;
        const bySession = { ...s.bySession };
        delete bySession[sessionId];
        return { bySession };
      }),

    appendLocalUserEntry: (sessionId, text, images) =>
      set((s) => {
        const cur = s.bySession[sessionId] ?? emptySessionMessages();
        const content: WirePart[] = [];
        if (text) content.push({ type: "text", text });
        for (const img of images ?? []) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        const entry: WireEntry = {
          type: "message",
          id: `${LOCAL_ENTRY_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          message: { role: "user", content },
        };
        return {
          bySession: { ...s.bySession, [sessionId]: { ...cur, entries: upsertEntry(cur.entries, entry) } },
        };
      }),

    adoptDurableId: (oldId, newId) =>
      set((s) => {
        if (oldId === newId) return s;
        const oldSlot = s.bySession[oldId];
        if (!oldSlot) return s;
        const newSlot = s.bySession[newId];
        const bySession = { ...s.bySession };
        if (!newSlot) {
          // 直接搬家（常见路径：换 key 先于任何真实 id 事件到达）
          bySession[newId] = oldSlot;
        } else if (newSlot.entries.length === 0 && !newSlot.streamingMessage) {
          // 目标槽存在但为空壳（事件刚建槽未写内容）：旧槽整体迁入，保留新游标
          bySession[newId] = { ...oldSlot, cursor: newSlot.cursor ?? oldSlot.cursor };
        } else {
          // 竞态：换 key 前已有事件在真实 id 槽落下（事件先于回执到达）。事件真值
          // 优先；目标槽尚无用户消息时把本地乐观条目补进头部防丢（全量重取后整替）
          const hasUser = newSlot.entries.some(
            (e) => (e as { message?: { role?: string } }).message?.role === "user",
          );
          const carry = hasUser
            ? []
            : oldSlot.entries.filter((e) => (e as { message?: { role?: string } }).message?.role === "user");
          bySession[newId] = {
            ...newSlot,
            entries: [...carry, ...newSlot.entries],
            streaming: newSlot.streaming || oldSlot.streaming,
          };
        }
        delete bySession[oldId];
        return { bySession };
      }),
  };
});
