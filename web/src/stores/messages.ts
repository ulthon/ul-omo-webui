// 消息域：按会话的消息条目 / 分页游标 / part 级更新动作。
// applyWireEvent 是 todo 14 SSE 客户端的统一分发入口，消化引擎 wire 事件的关键几类
// （message_start/update/end、turn_end、tool_execution_start/update/end、
// agent_start/end/settled/idle），未知事件类型一律容错忽略。
// 流式 assistant 消息独立存放（streamingMessage），delta 只更新单个对象；定格时并入 entries。
// docs08-r5 任务 5（流式末段重播修复，任务 3 诊断定案）：entry_appended 消息条目消费
// 真实 id 与槽内合成孪生身份归一（诊断杠杆 1）；服务端重放窗口标记（replay_begin/done）
// 界定的单次恢复窗口内，已落库段的无 id start 重播抑制流式重建（诊断杠杆 2）。
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
  /** 终帧错误标记（tool_execution_end 的 isError；子代理页签消费，任务 17） */
  isError?: boolean;
  /** 最新 LIVE 快照（tool_execution_update 的 partialResult；队列合并保最新 + ~250ms 节流
   *  的尽力而为语义，勿按帧计数/勿假设逐帧到达——任务 4 spike 留档） */
  partialResult?: unknown;
}

export interface SessionMessages {
  /** 已定格条目（wire 原样：{type:"message",id,...} 等） */
  entries: WireEntry[];
  /** 分页游标：GET messages?cursor= 传回取增量；null=已最新 */
  cursor: string | null;
  leafId: string | null;
  /** 是否做过全量加载（gap 全量重取的判据） */
  loaded: boolean;
  /** 任务 16：文件头方向是否还有更早条目（尾窗首载/向上翻页后由服务端 hasMore 同步） */
  hasMore: boolean;
  /** 任务 16：当前已加载窗口最旧条目 id（向上翻页 ?before= 游标；全量加载为 null） */
  oldestId: string | null;
  streaming: boolean;
  /** 流式中的 assistant 消息（part 级就地更新；定格时并入 entries） */
  streamingMessage: WireMessage | null;
  streamingEntryId: string | null;
  /** 工具执行生命周期（事件驱动，todo 17 卡片消费） */
  toolRuns: Record<string, ToolRun>;
  /** 压缩进行中（docs08-r6 任务 18 ①：compaction_start/progress 置位、compaction_end
   *  消除；消息流顶部进行条与水位环区消费。end 帧丢失时由 COMPACTING_FALLBACK_MS
   *  超时兑底回落，进行条不永挂） */
  compacting: boolean;
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

  /** 单次恢复窗口（docs08-r5 任务 5）：服务端 SSE 重放路径以 replay_begin/replay_done
   * 桥级帧包夹重放序列（event-dispatch 转译置位/复位；EventsClient 建连时清陈旧窗口）。
   * 窗口内对"已落库段的无 id start 重播"抑制流式重建；实时帧恒在窗口外（服务端
   * 连接路径队列顺序保证：begin/done 只包夹实际重放的帧，订阅后发布的实时帧在 done 后）。 */
  replayRecovering: boolean;

  /** 全量加载 / gap 全量重取 */
  setEntries(
    sessionId: string,
    entries: WireEntry[],
    cursor: string | null,
    leafId: string | null,
    paging?: { hasMore: boolean; oldestId: string | null },
  ): void;
  setCursor(sessionId: string, cursor: string | null): void;
  /** 增量分页（向上翻历史） */
  appendEntries(sessionId: string, entries: WireEntry[]): void;
  /** 任务 16：向上翻页头插（id 去重——重叠窗与既有条目按 id 收敛，拼缝零重复零丢失） */
  prependEntries(
    sessionId: string,
    entries: WireEntry[],
    paging: { hasMore: boolean; oldestId: string | null },
  ): void;
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
   *  docs08-r7 任务 15：排队发送不再走本函数（消息流零占位，排队条单显示源；排队
   *  投递的 user 帧按载荷身份收敛守卫直接入列），只服务直发路径。 */
  appendLocalUserEntry(
    sessionId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): void;
  /** 首条消息落盘后采用服务端回传的真实 id：迁移消息槽（目标槽已有时事件真值优先，
   *  仅补携带本地乐观条目防丢） */
  adoptDurableId(oldId: string, newId: string): void;
  /** 恢复窗口置位/复位（docs08-r5 任务 5，event-dispatch 由 replay_begin/replay_done 转译） */
  beginReplayRecovery(): void;
  endReplayRecovery(): void;
  /** 压缩进行位置位/消除（docs08-r6 任务 18 ①，event-dispatch 由 compaction_* 帧转译）；
   *  true 布防超时兑底（end 帧丢失自愈），false/会话清理拆防 */
  setCompacting(sessionId: string, compacting: boolean): void;
}

function emptySessionMessages(): SessionMessages {
  return {
    entries: [],
    cursor: null,
    leafId: null,
    loaded: false,
    hasMore: false,
    oldestId: null,
    streaming: false,
    streamingMessage: null,
    streamingEntryId: null,
    toolRuns: {},
    compacting: false,
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

/** 压缩进行态兑底时长（docs08-r6 任务 18 ①，stale_progress_bar 防线）：end 帧丢失
 *  （连接断后重连重放不保证回放事件、服务重启等）时进行条不永挂——置位后该时长
 *  无 end 帧即自动回落。取值需覆盖同步 RPC 期限（server COMPACT_HTTP_TIMEOUT_MS 10s）
 *  + 引擎后台压缩完成的事件延迟（一次 LLM summarization 可达分钟级），取 90s。 */
export const COMPACTING_FALLBACK_MS = 90_000;

/** 各会话压缩进行态兑底定时器（setCompacting(true) 布防，end/清理拆防） */
const compactingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function armCompactingFallback(sessionId: string): void {
  disarmCompactingFallback(sessionId);
  const timer = setTimeout(() => {
    compactingTimers.delete(sessionId);
    // 兑底回落：仅翻 false，不广播 usage（水位真相由 usage 轮询/下次事件校正）
    useMessagesStore.getState().setCompacting(sessionId, false);
  }, COMPACTING_FALLBACK_MS);
  // bun 单测环境不挂住进程退出（同 event-dispatch sweepTimer 模式）
  (timer as unknown as { unref?: () => void }).unref?.();
  compactingTimers.set(sessionId, timer);
}

function disarmCompactingFallback(sessionId: string): void {
  const timer = compactingTimers.get(sessionId);
  if (timer === undefined) return;
  clearTimeout(timer);
  compactingTimers.delete(sessionId);
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

/** 单个 content part 的流式前缀比对（docs08-r5 任务 5）：text/thinking 按字符串前缀
 * （流式截断发生在串中段），其余 part 类型字节等价才认（帧与落库条目同对象，无多余形态）。 */
function isPrefixPart(a: WirePart, b: WirePart): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "text" || a.type === "thinking") {
    const sa = a.type === "text" ? a.text : a.thinking;
    const sb = b.type === "text" ? b.text : b.thinking;
    return typeof sa === "string" && typeof sb === "string" && sb.startsWith(sa);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** start 载荷是否携带正向身份证据：至少一个非空 text/thinking 串。空载荷（content 空
 * 数组/全空串）与任何定格条目都"前缀匹配"，不构成身份证据，不得据此抑制。 */
function hasReplayPrefixEvidence(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((p) => {
    if (p === null || typeof p !== "object") return false;
    const t = (p as { text?: unknown }).text;
    const th = (p as { thinking?: unknown }).thinking;
    return (typeof t === "string" && t !== "") || (typeof th === "string" && th !== "");
  });
}

/** 恢复窗口重播判定（docs08-r5 任务 5，诊断杠杆 2）：start 载荷是槽内某定格 assistant
 * 条目 content 的逐元素前缀（末段元素按流式截断语义取字符串前缀，其余元素字节等价）。
 * 这是身份判定不是内容指纹跨回合去重：只在单次恢复窗口内使用（重放帧与 REST 真相的
 * 同段比对），且只抑制 streamingMessage 重建、永不增删条目——在途新段照常流式，
 * REST 旧快照与新帧竞态不丢消息。 */
function isReplayOfSettledAssistant(entries: WireEntry[], start: WireMessage): boolean {
  if (!hasReplayPrefixEvidence(start.content)) return false;
  const a = Array.isArray(start.content) ? start.content : [];
  return entries.some((e) => {
    const m = e.message as WireMessage | undefined;
    if (m === undefined || m.role !== "assistant") return false;
    const b = Array.isArray(m.content) ? m.content : [];
    if (a.length > b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const pa = a[i];
      const pb = b[i];
      if (pa === undefined || pb === undefined) return false;
      if (!isPrefixPart(pa, pb)) return false;
    }
    return true;
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
    replayRecovering: false,

    beginReplayRecovery: () => set({ replayRecovering: true }),

    endReplayRecovery: () => set({ replayRecovering: false }),

    setCompacting: (sessionId, compacting) => {
      // 兑底布防/拆防先于 set：false 路径下 timer 里的 setCompacting(false) 不可重入
      if (compacting) {
        armCompactingFallback(sessionId);
      } else {
        disarmCompactingFallback(sessionId);
      }
      set((s) => {
        const cur = s.bySession[sessionId] ?? emptySessionMessages();
        if (cur.compacting === compacting) return s;
        return { bySession: { ...s.bySession, [sessionId]: { ...cur, compacting } } };
      });
    },

    setEntries: (sessionId, entries, cursor, leafId, paging) =>
      set((s) => ({
        bySession: {
          ...s.bySession,
          [sessionId]: {
            ...emptySessionMessages(),
            ...s.bySession[sessionId],
            entries,
            cursor,
            leafId,
            loaded: true,
            ...(paging ?? { hasMore: false, oldestId: null }),
          },
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

    prependEntries: (sessionId, entries, paging) =>
      set((s) => {
        const cur = s.bySession[sessionId] ?? emptySessionMessages();
        // id 去重头插：新窗与既有窗口的重叠区（beforeId 锚）按 id 收敛，恰补
        // 严格更早的条目——拼缝零重复零丢失；fresh 已是文件序（旧→新），直接头插
        const known = new Set(cur.entries.map((e) => e.id));
        const fresh = entries.filter((e) => !known.has(e.id));
        const list = [...fresh, ...cur.entries];
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: { ...cur, entries: list, hasMore: paging.hasMore, oldestId: paging.oldestId },
          },
        };
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
              // docs08-r5 任务 5（恢复窗口重播抑制，诊断杠杆 2）：单次恢复窗口内的
              // 无 id assistant start，若载荷已是槽内某定格 assistant 条目的内容前缀
              //（且含非空文本/思考的正向身份证据），判定为"已落库段的整缓冲重播"，
              // no-op 吸收：不重建 streamingMessage，后续 delta 无流式消息自然 no-op，
              // message_end 定格的合成孪生由 entry_appended 真实身份归一收敛（净效果
              // 幂等单条）。窗口外/前缀不匹配（含在途新段与空载荷 start）照常重建——
              // live 流式零改动。抑制只跳过重建、永不增删条目，REST 旧快照与新帧
              // 竞态不丢消息。
              const curNow = get().bySession[sessionId] ?? emptySessionMessages();
              const suppressed =
                typeof entry.id !== "string" &&
                get().replayRecovering &&
                isReplayOfSettledAssistant(curNow.entries, msg);
              if (suppressed) break;
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

        case "tool_execution_update": {
          // LIVE 快照（docs08-r6 任务 17）：task 等嵌套执行工具经 onUpdate 回流的最新
          // partialResult（spike：~250ms 节流 + 发送队列积压合并保最新——最新快照尽力而为，
          // 快任务可能零中间帧）。只并快照与工具名，不动 status（终态以 end 帧为准，
          // 乱序迟到帧不复活运行态）；嵌套子工具的 update 帧同路入账（toolCallId 独立，
          // 消费侧按 toolName 过滤，ToolCard 按 part id 查询不受额外条目影响）。
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
                  partialResult: event.partialResult,
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
                  isError: event.isError === true,
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
          const appended = event.entry;
          if (appended === null || typeof appended !== "object") break;
          const entry = appended as WireEntry;
          // docs08-r5 任务 5（身份归一，诊断杠杆 1）：消息条目消费真实 id。引擎对每条
          // 落库条目发 entry_appended（真实 id = JSONL id = REST id，任务 3 三方一致
          // 实证）；原白名单只放行记忆标记、type:"message" 一律丢弃，message 通道的
          // 合成 id 条目因此永不与 REST 真相收敛（重播/双列根因的决定性一环）。现对
          // user/assistant 消息条目归一：移除同载荷合成孪生（syntheticId 相同；djb2
          // 合成 id 与引擎真实 id 属不相交空间，只删孪生、绝不触真实条目——两个不同
          // 回合的同文回复各有真实 id，互不坍缩，反铁律），再按引擎落库行原样 upsert
          // 真实 id 条目（已存在幂等替换，缺席补入——帧缺失场景不丢条目）。
          if (entry.type === "message" && typeof entry.id === "string" && entry.id !== "") {
            const appendedMsg = entry.message as WireMessage | undefined;
            if (appendedMsg !== undefined && (appendedMsg.role === "user" || appendedMsg.role === "assistant")) {
              set((s) => {
                const cur = s.bySession[sessionId] ?? emptySessionMessages();
                const twinId = syntheticId(appendedMsg);
                const stored: WireEntry = { ...entry, type: "message", message: appendedMsg };
                return {
                  bySession: {
                    ...s.bySession,
                    [sessionId]: { ...cur, entries: upsertEntry(cur.entries.filter((e) => e.id !== twinId), stored) },
                  },
                };
              });
            }
            break;
          }
          // 压缩摘要条目增量（docs08-r6 任务 19g）：引擎压缩完成后经 entry_appended 携
          // 顶层 type:"compaction" 条目到达（F3 实测 compaction_end 后紧跟 entry_appended，
          // 帧形态 {entry:{type:"compaction",id,summary,...}}），放行入列——渲染层
          // compactionMarkerOf 派生标记块（白名单渲染语义在派生侧），历史 GET messages
          // 同形同构；不入列则进行中页面永不出现标记块（仅刷新后才见）。
          if (entry.type === "compaction" && typeof entry.id === "string" && entry.id !== "") {
            set((s) => {
              const cur = s.bySession[sessionId] ?? emptySessionMessages();
              return {
                bySession: { ...s.bySession, [sessionId]: { ...cur, entries: upsertEntry(cur.entries, entry) } },
              };
            });
            break;
          }
          // 记忆标记条目增量（docs08-r4 任务 13）：引擎记忆相关 custom/custom_message 条目
          // 经 entry_appended 到达（隔离实例实测 wire 形态 {entry:{type,id,customType,...}}，
          // custom_message 携 id 早于同义的无 id message_start/end 帧），仅白名单 customType
          // 入列（渲染层派生标记块，历史 GET messages 同形天然同构）；其余（pi-rules.scan、
          // senpi.hooks.stop-state 等）保持不渲染（type:"message" 的消息条目已在上方
          // 按身份归一消费）。
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
        disarmCompactingFallback(sessionId);
        return { bySession };
      }),

    appendLocalUserEntry: (sessionId, text, images) =>
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
