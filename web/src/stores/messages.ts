// 消息域：按会话的消息条目 / 分页游标 / part 级更新动作。
// applyWireEvent 是 todo 14 SSE 客户端的统一分发入口，消化引擎 wire 事件的关键几类
// （message_start/update/end、turn_end、tool_execution_start/end、agent_start/end/settled/idle），
// 未知事件类型（omo 扩展的 setStatus/setWidget/notify、tool_hook_status 等噪音）一律容错忽略。
// 流式 assistant 消息独立存放（streamingMessage），delta 只更新单个对象；定格时并入 entries。
import { create } from "zustand";
import type { WireEntry, WireMessage, WirePart } from "@/lib/api";
import { isMemoryAppendedEntry } from "@/lib/memory-entries";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

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
   *  重取以服务端真值整替；服务端 user 事件到达时按等价吸收（防双列）。
   *  queuedMode：回合中排队发送（docs08-r4 任务 11）——占位带"排队中"标记，气泡徽标
   *  与撤销移除以此甄别；服务端真值事件吸收后标记自然消失（投递=排队结束）。 */
  appendLocalUserEntry(
    sessionId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
    queuedMode?: "steer" | "followUp",
  ): void;
  /** 撤销单条排队项后移除其本地"排队中"占位（同文本取首条，spike：引擎不去重、
   *  两条独立排队项只能撤其一） */
  removeQueuedLocalEntry(sessionId: string, text: string): void;
  /** 整队清空后移除全部"排队中"占位（撤空的消息永不会再投递，不删则成幽灵气泡） */
  removeAllQueuedLocalEntries(sessionId: string): void;
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

/** "排队中"本地占位甄别（docs08-r4 任务 11）：appendLocalUserEntry 的 queuedMode 标记 */
function isQueuedLocalEntry(entry: WireEntry): entry is WireEntry & { message: WireMessage } {
  if (typeof entry.id !== "string" || !entry.id.startsWith(LOCAL_ENTRY_PREFIX)) return false;
  const queued = entry.queued as { mode?: unknown } | undefined;
  if (queued === undefined) return false;
  const m = entry.message as WireMessage | undefined;
  return Boolean(m && m.role === "user");
}

/** 消息首个 text part 的文本（无文本 part 返回 null，如纯图消息） */
function firstTextOf(msg: WireMessage): string | null {
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") return part.text;
  }
  return null;
}

/** 服务端 user 消息事件到达时吸收等价本地乐观占位（同首文本），防双列；
 * 纯图消息（无文本锚点）不吸收，由全量重取收敛。
 * 去重键加固（docs08-r4 任务 11，spike (b)-7：引擎对同文本双条排队不去重）——
 * 每个服务端 user 事件只吸收一条匹配占位（按排队序先进的先收），绝不一次吞掉全部
 * 同文本占位，两条独立排队项各自等价吸收、互不坍缩。 */
function absorbLocalUserEntries(list: WireEntry[], serverMsg: WireMessage): WireEntry[] {
  const serverText = firstTextOf(serverMsg);
  if (serverText === null || serverText === "") return list;
  let absorbed = false;
  return list.filter((e) => {
    if (absorbed) return true;
    if (typeof e.id !== "string" || !e.id.startsWith(LOCAL_ENTRY_PREFIX)) return true;
    const m = e.message as WireMessage | undefined;
    if (!m || m.role !== "user") return true;
    if (firstTextOf(m) !== serverText) return true;
    absorbed = true;
    return false;
  });
}

/** 载荷身份收敛（docs08-r5 任务 4，任务 3 诊断定案）：无 id user 帧落合成 id 前，
 * 槽内是否已有同载荷身份的 user 条目（REST 真实 id 真相——刷新/切回后环形缓冲重放
 * 会把已落库回显重播一遍，syntheticId 与真实 id 属两个不相交 id 空间，upsertEntry
 * 无法去重 → 双列且刷新重演）。身份键 = message 全载荷指纹（syntheticId，含引擎端
 * timestamp——引擎对 user 消息恒带 timestamp: Date.now()，帧 message 与落库条目
 * message 为同一对象），同文异回合 timestamp 必异、合法各留一条：这是身份收敛，
 * 不是内容指纹跨回合去重（任务 5 铁律同源约束）。 */
function hasSamePayloadUserEntry(list: WireEntry[], msg: WireMessage): boolean {
  const fp = syntheticId(msg);
  return list.some((e) => {
    const m = e.message as WireMessage | undefined;
    return m !== undefined && m.role === "user" && syntheticId(m) === fp;
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
            // 仅 user 消息走归一入列（2026-10-15 缺陷修复的收窄）。非 assistant 的
            // 其他角色（custom / toolResult 等）不入列：首回合引导 custom 消息的
            // content 是字符串（senpi-task.usage / environment-context 等，
            // 2026-10-16 帧级实测），入列会在渲染层 PartsView(message.content) 上崩
            // （e.map is not a function 白屏，首条消息必现）；白名单记忆标记另经
            // entry_appended 携真 id 入列，message 通道的 role:"custom" 帧是同义的
            // 无 id 帧，双通道入列会双列；toolResult 的可见呈现由 ToolCard 按
            // toolCallId 关联承担，消息帧本身无需入列。
            if (msg.role !== "user") break;
            // user：先吸收等价的本地乐观占位（发送成功后即时入列的 local-* 条目）
            // ——以服务端真值替换，防双列。入列归一为 {type:"message", id, message}
            // （settle 定格同构）：事件对象本身（type:"message_start"/"message_end"）
            // 不是可渲染条目——渲染层 isMessageEntry 只认 type:"message"，按事件原样
            // 入列会被过滤成不可见，而本地占位已被吸收，净效果 = 用户消息闪现即消失
            // （2026-10-15 实测复现；真条目的 entry_appended 帧另被记忆白名单丢弃，
            // message 通道是 user 消息唯一可见入列路径）。
            // id 缺失回落确定性合成 id：start/end 双帧同消息按 id 幂等去重；end 帧
            // 携真 id 而 start 帧无 id 的混合形态下，入列真 id 条目前先移除 start 帧
            // 落下的合成 id 孪生，防同一条消息双列（2026-10-16 实测用户消息双列）。
            set((s) => {
              const cur = s.bySession[sessionId] ?? emptySessionMessages();
              const base = absorbLocalUserEntries(cur.entries, msg);
              const sid = syntheticId(msg);
              const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : sid;
              const list = id === sid ? base : base.filter((e) => e.id !== sid);
              // docs08-r5 任务 4：无 id 帧落合成 id 前，先按载荷身份与槽内 REST 真实 id
              // 真相收敛（双列根因修复，见 hasSamePayloadUserEntry）；守卫仅在身份信号
              // （timestamp）完整时启用，缺失不冒进去重、保持既有入列路径由 setEntries
              // 全量重取兜底。携真 id 帧无需守卫（upsertEntry 按 id 收敛）。占位吸收
              // 照常生效：守卫跳过入列时净效果 = 槽内真相条目保持唯一。
              if (id === sid && typeof msg.timestamp === "number" && hasSamePayloadUserEntry(list, msg)) {
                return { bySession: { ...s.bySession, [sessionId]: { ...cur, entries: list } } };
              }
              const stored: WireEntry = { ...entry, type: "message", id };
              return {
                bySession: { ...s.bySession, [sessionId]: { ...cur, entries: upsertEntry(list, stored) } },
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

        case "thinking_level_changed": {
          // W2 todo 8：引擎会话实际落定的思考档回显（wire 形态 {level, thinkingSelection:{...}}）。
          // SSE 全局多路复用：仅前台选中会话的事件允许同步 chip——后台会话不得篡改前台
          // 选择、也不得污染下一条 prompt 的档位注入。applyWireEvent 的 sessionId 已由
          // 分发层解析为信封 durableSessionId（缺席回退 wire 句柄）；句柄与 durable 选中
          // id 不等时按"非本会话"静默忽略（宁漏勿错）。显示层同步：不落偏好、不触发防抖 PATCH。
          const level = typeof event.level === "string" ? event.level : null;
          if (level === null) break;
          if (useSessionsStore.getState().selectedId !== sessionId) break;
          useUiStore.getState().setSelectedThinkingLevel(level);
          break;
        }

        case "entry_appended": {
          // 记忆标记条目增量（docs08-r4 任务 13）：引擎记忆相关 custom/custom_message 条目
          // 经 entry_appended 到达（隔离实例实测 wire 形态 {entry:{type,id,customType,...}}，
          // custom_message 携 id 早于同义的无 id message_start/end 帧），仅白名单 customType
          // 入列（渲染层派生标记块，历史 GET messages 同形天然同构）；其余（pi-rules.scan、
          // senpi.hooks.stop-state、type:"message" 的消息条目等）保持不渲染。
          const appended = event.entry;
          if (appended === null || typeof appended !== "object") break;
          const entry = appended as WireEntry;
          if (!isMemoryAppendedEntry(entry)) break;
          set((s) => {
            const cur = s.bySession[sessionId] ?? emptySessionMessages();
            return {
              bySession: { ...s.bySession, [sessionId]: { ...cur, entries: upsertEntry(cur.entries, entry) } },
            };
          });
          break;
        }

        // 未知 / 噪音事件（tool_hook_status、extension_ui_request、
        // settings_source_selected、loaded_surfaces_changed、session_closed...）：
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

    appendLocalUserEntry: (sessionId, text, images, queuedMode) =>
      set((s) => {
        const cur = s.bySession[sessionId] ?? emptySessionMessages();
        const content: WirePart[] = [];
        if (text) content.push({ type: "text", text });
        for (const img of images ?? []) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        // [2026-10-16 双列修复] 直发的服务端 user echo 帧可能先于 POST 回执到达（本机
        // 实测 SSE 先至）——彼时等价用户消息已按合成 id 入列，回执后再补乐观占位已无
        // 后续帧可吸收，成永久双列。入列前等价甄别：槽内已存在同首文本的**服务端**
        // 用户消息则跳过占位（local 占位不触发——同文本排队项各自独立、互不坍缩，
        // spike (b)-7；与 absorbLocalUserEntries 口径一致，纯图消息无文本锚点不甄别）。
        if (text) {
          const dup = cur.entries.some((e) => {
            if (typeof e.id === "string" && e.id.startsWith(LOCAL_ENTRY_PREFIX)) return false;
            const m = e.message as WireMessage | undefined;
            return Boolean(m && m.role === "user" && firstTextOf(m) === text);
          });
          if (dup) return s;
        }
        const entry: WireEntry = {
          type: "message",
          id: `${LOCAL_ENTRY_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          message: { role: "user", content },
          ...(queuedMode ? { queued: { mode: queuedMode } } : {}),
        };
        return {
          bySession: { ...s.bySession, [sessionId]: { ...cur, entries: upsertEntry(cur.entries, entry) } },
        };
      }),

    removeQueuedLocalEntry: (sessionId, text) =>
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur) return s;
        let removed = false;
        const entries = cur.entries.filter((e) => {
          if (removed) return true;
          if (!isQueuedLocalEntry(e) || firstTextOf(e.message as WireMessage) !== text) return true;
          removed = true;
          return false;
        });
        if (!removed) return s;
        return { bySession: { ...s.bySession, [sessionId]: { ...cur, entries } } };
      }),

    removeAllQueuedLocalEntries: (sessionId) =>
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur) return s;
        const entries = cur.entries.filter((e) => !isQueuedLocalEntry(e));
        if (entries.length === cur.entries.length) return s;
        return { bySession: { ...s.bySession, [sessionId]: { ...cur, entries } } };
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
