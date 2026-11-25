// 消息域：按会话的消息条目 / 分页游标 / part 级更新动作。
// applyWireEvent 是 todo 14 SSE 客户端的统一分发入口，消化引擎 wire 事件的关键几类
// （message_start/update/end、turn_end、tool_execution_start/update/end、
// agent_start/end/settled/idle），未知事件类型一律容错忽略。
// 流式 assistant 消息独立存放（streamingMessage），delta 只更新单个对象；定格时并入 entries。
// docs08-r5 任务 5（流式末段重播修复，任务 3 诊断定案）：entry_appended 消息条目消费
// 真实 id 与槽内合成孪生身份归一（诊断杠杆 1）；服务端重放窗口标记（replay_begin/done）
// 界定的单次恢复窗口内，已落库段的无 id start 重播抑制流式重建（诊断杠杆 2）。
import { create } from "zustand";
import type { MessagesPage, WireEntry, WireMessage, WirePart } from "@/lib/api";
import { isMemoryAppendedEntry } from "@/lib/memory-entries";
import { diag } from "@/lib/diag";
import { parseTaskCompletionEntry } from "@/lib/task-completion";
import {
  lastModelChangeOf,
  modelChangeBackfillOf,
  type SessionEventLine,
  type StreamErrorItem,
} from "@/components/chat/message-items";
import { advanceLeaf, lastEntryId } from "@/components/chat/branch-path-data";
import { pickActive, turnInFlightOf } from "@/components/chat/hydration-lock";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { t } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";

/** 生效模型水合（docs08 2026-10-22 批次任务 27a）：载入窗含 model_change 条目时把最后
 *  一条写会话生效模型——刷新/打开会话后 appliedModels 不再是未知态（待生效徽标误报
 *  主因，docs/08 第 17 条机制 a）。窗口内无条目不写（新会话留 null；极老切换在尾窗外
 *  由回执/回显补齐）。服务端 jsonl 为权威源，显式覆盖写（内存值只可能更旧：回执先到、
 *  历史重取后到的窗口场景）。
 *  (c) 基线对齐：仅在水合路径对齐当前查看会话的全局选中（机制 b：残留跨会话选中
 *  不再误挂待生效徽标）；回执/SSE model_changed 不对齐——发送中改选、真待生效不被
 *  冲掉。cached 会话切回的对齐在 composer 挂载 effect。不写偏好持久化（初值语义）。
 *  已知风险：水合对齐会冲掉会话打开至条目载入之间（亚秒窗）的主动改选——窗口极小
 *  （entries 首载毫秒级）且显式选择的偏好持久化不受影响，接受。 */
function hydrateAppliedModel(sessionId: string, entries: ReadonlyArray<WireEntry>): void {
  const change = lastModelChangeOf(entries);
  if (change === null) return;
  const model = `${change.provider}/${change.modelId}`;
  useSessionsStore.getState().setAppliedModel(sessionId, model);
  // 粘性手选不冲（模型粘性批 2026-11-18）：未生效的显式手选不被水合对齐洗回——粘性
  // 生效时 setAppliedModel 已同步解除，走到这里说明手选仍待下一条 prompt
  if (useSessionsStore.getState().modelStickies[sessionId] !== undefined) return;
  if (useSessionsStore.getState().selectedId === sessionId) {
    const ui = useUiStore.getState();
    if (ui.selectedModel !== model) ui.setSelectedModel(model);
  }
}

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
  /** 文件叶 id（get_entries page.leafId 落库，与 cursor 同值）：按叶路径渲染的默认
   *  起点；随各变更点推进（advanceLeaf 统一口径，session-branching todo 4） */
  leafId: string | null;
  /** 显式视图叶（session-branching todo 4 落位、todo 6 叶切换编排消费）：用户切叶
   *  的内存态视图锚点，null=跟随文件叶 leafId；setEntries 全量整替后仍在新文件中
   *  则保留、消失回落 null（F15：选中态以导航回传 leafId 为唯一真相） */
  viewLeafId: string | null;
  /** 叶导航进行中（session-branching todo 6 ⑦ navigating 互斥）：switchLeaf 出网前
   *  布防、落定/拒绝/异常即拆防；布防期间并发切换（switchLeaf 入口）与发送（api.prompt
   *  守卫同读此位）一律拒绝 */
  navigating: boolean;
  /** 叶导航落定序号（todo 6 ⑥ usage 触发点）：switchLeaf 整替落定沿自增；
   *  use-context-usage 边沿订阅触发 getUsage 重拉（F21：contextUsage 基于当前叶必变） */
  leafNavSeq: number;
  /** 是否做过全量加载（gap 全量重取的判据） */
  loaded: boolean;
  /** 任务 16：文件头方向是否还有更早条目（尾窗首载/向上翻页后由服务端 hasMore 同步） */
  hasMore: boolean;
  /** 任务 16：当前已加载窗口最旧条目 id（向上翻页 ?before= 游标；全量加载为 null） */
  oldestId: string | null;
  /** 整替换代序号（重取风暴任务 3）：setEntries 全量整替落在既有可见窗口（prev 有条目）
   *  上时自增，首载水合不计数。视图层换代检测的 store 级信号，优先于 items 长度差
   *  后备启发（GAP-3 落地滚动补偿的换代判据；亦为口径 A「稳态零整替」验收的计数器）。 */
  swapSeq: number;
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
  /** 会话级事件行（r10 todo 7）：排队交接/压缩完成/模型切换回执三类 wire 事件的流内
   *  回看行，event-dispatch 转译追加；独立于 entries（服务端真相不可写，引擎 JSONL 无
   *  客户端写入口），全量重取 setEntries 不冲掉——切页回来可见，非 toast 瞬态 UI。
   *  应用生命周期内存态：刷新后历史事件行随引擎既有条目面（model_change 条目/压缩
   *  摘要块）口径回看，事件行本身不跨刷新。 */
  sessionEvents: SessionEventLine[];
  /** 流内错误卡（发送失败常驻卡，对齐 CLI 信息流行为）：独立于 entries，全量重取
   *  不冲掉，带关闭钮手动消除；应用生命周期内存态。 */
  errors: StreamErrorItem[];
  /** 消息级模型归因表（2026-11-01 消息级模型归因补全批）：
   *  receiptModel = 最近一次直发回执 appliedModel（composer 发送成功点写入，
   *  "provider/model" 形态；气泡解析与流式态就近消费；内存态，重启/重取后由
   *  modelBackfill 水合兑底）；
   *  modelBackfill = 首载尾窗缺 model_change 时轻量回读的窗口外变更点（只取
   *  model_change 类型，不参与渲染），前插进解析时间线使归因覆盖全程；
   *  modelBackfillDone = 回读闸（每会话至多一次回读，失败也落闸防风暴）。 */
  receiptModel: string | null;
  modelBackfill: Array<WireEntry & { id: string }>;
  modelBackfillDone: boolean;
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

/** 叶导航请求载荷（api.SessionNavigateBody 同形，结构兼容；注入解耦测试免 mock api） */
export interface LeafNavigateCall {
  entryId: string;
  intent: "select" | "resume";
  /** 乐观锁（F13）：本地叶指针透传，引擎拒 stale_leaf 防跨端竞态 */
  expectedLeafId?: string;
}

/** 叶导航回执（api.SessionNavigateResult 同形）：leafId 唯一真相（F15，可能是簿记
 * 条目 id——非消息形不回退，渲染层路径过滤对未知叶平铺兑底）；editorText 由 todo 8
 * 编辑重发链消费。 */
export interface LeafNavigateReceipt {
  sessionId: string;
  leafId: string;
  editorText?: string;
}

/** switchLeaf 注入依赖（fetchEarlierPage/backfillModelTimeline 同款注入先例：测试免
 * mock api 模块；调用侧 chat-view 传 api.navigate / api.listMessages 包装） */
export interface SwitchLeafDeps {
  navigate: (body: LeafNavigateCall) => Promise<LeafNavigateReceipt>;
  fetchFull: () => Promise<MessagesPage>;
}

/** 409 stale_leaf 拒绝识别（session-branching task-10 缺陷 C）：web ApiError 鸭子
 *  形状（status 409 + code stale_leaf；不 import lib/api，保持本模块注入解耦纪律）。
 *  命中时附带回传引擎当前叶（error.data.leafId，服务端路由层透传，可能缺席——
 *  服务端已从引擎 errorData/原文消息归一，缺席即引擎未给）。 */
export function staleLeafOf(err: unknown): { stale: boolean; leafId: string | null } {
  const e = err as { status?: unknown; code?: unknown; data?: { leafId?: unknown } | undefined } | null | undefined;
  if (!e || typeof e !== "object" || e.status !== 409 || e.code !== "stale_leaf") {
    return { stale: false, leafId: null };
  }
  const leafId = e.data?.leafId;
  return { stale: true, leafId: typeof leafId === "string" && leafId !== "" ? leafId : null };
}

export interface SwitchLeafResult {
  ok: boolean;
  /** busy=导航已在途（⑦互斥）；blocked=前置门拒绝（真忙碌并集）；rejected=引擎/网络拒绝（409 等） */
  reason?: "busy" | "blocked" | "rejected";
  /** true=store 已推过常驻错误卡（二次 stale 路径，task-10 缺陷 C）：调用方
   *（message-actions-data pushIfRejected）不得再推，防双卡 */
  errorCarded?: boolean;
  /** ok=true 时回传导航落定叶（回执 leafId，唯一真相） */
  leafId?: string;
  /** ok=true 且 select 命中 user 消息时的编辑回填文本（todo 8 从此此处分支/编辑重发
   * 消费——CLI 同款：select 后编辑器携带原文，改后发送长新分支） */
  editorText?: string;
}

interface MessagesState {
  bySession: Record<string, SessionMessages>;

  /** 滚动跟随锚点（#26）：每会话最新流内条目 key，由 MessageList 在 mergedItems 变化时
   *  写入；跟随判定（渲染窗覆盖锚点）与恢复定位（scrollToIndex 锚点）的单一真相源，
   *  应用生命周期内存态。 */
  followAnchors: Record<string, string>;

  /** 滚动跟随锚点写入（#26）：同值幂等 no-op（流式 delta 高频触发不重渲染） */
  setFollowAnchor(sessionId: string, anchorId: string): void;

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
  /** 会话级事件行追加（r10 todo 7，event-dispatch 由三类 wire 事件转译）：锚点入列
   *  （事件行锚点化批：记当时消息流末条 entry id，渲染层插在锚后随流上移），重放窗口
   *  重复帧由调用侧守卫（与 autoStarted toast 同守卫） */
  appendSessionEvent(
    sessionId: string,
    summary: SessionEventLine["summary"],
  ): void;
  /** 排队事件行按送达片段移除（2026-10-31 对齐 CLI 瞬态）：引擎队列消化后排队提示
   *  不再常驻消息流底部，按已送达条目首行片段精确匹配移除 */
  dismissQueuedEvents(sessionId: string, snippets: ReadonlySet<string>): void;
  /** 流内错误卡追加（发送/建会话失败入流，对齐 CLI）：尾部入列；同刻同 text 未消
   *  去重不堆叠；id 单调递增作流内 key */
  pushError(sessionId: string, text: string): void;
  /** 错误卡关闭钮：按 id 移除单条 */
  dismissError(sessionId: string, id: string): void;
  /** 直发回执 appliedModel 落归因表（2026-11-01 归因补全批，composer 发送成功点
   *  调用；会话槽缺席不建槽——发送必在查看态，槽已由首载建立） */
  markReceiptModel(sessionId: string, model: string): void;
  /** 水合回读（2026-11-01 归因补全批；首屏流量直做批改轻量取数）：首载尾窗不含任何
   *  model_change 且还有更早历史（hasMore）时，经注入取数只拉 model_change 条目
   *  （服务端 /model-changes 磁盘精筛 KB 级，取代原 full=1 全量拉取——长会话单开
   *  流量 95% 曾来自彼处），挑出窗口外变更点入归因表并复用水合口径写会话生效模型；
   *  fetchChanges 注入（测试免 mock api 模块）。每会话至多一次，失败落闸静默降级
   *  （归因是软增强）。 */
  backfillModelTimeline(
    sessionId: string,
    fetchChanges: () => Promise<WireEntry[]>,
  ): Promise<void>;
  /** 段回溯取数（nav-rail 分段指示器）：按 before 游标拉一窗更早条目并头插合并（同
   *  触顶翻页通道 prependEntries，id 去重拼缝零重复零丢失；fetchPage 注入同
   *  backfillModelTimeline，测试免 mock api 模块）。 */
  fetchEarlierPage(
    sessionId: string,
    before: string,
    fetchPage: (opts: { before?: string; full?: boolean }) => Promise<MessagesPage>,
  ): Promise<void>;
  /** 清本会话流式态（session-branching todo 6 ③，导航成功即调，F19：防迟到
   * message_end 把半截内容定格进旧视图）；丢弃半截内容——与 settleStreaming 的定格
   * 并入语义相反，导航后真相以整替页为准。迟到帧随后按幂等 upsert 无害吸收。 */
  clearStreamingForNavigation(sessionId: string): void;
  /** 叶切换编排（session-branching todo 6，F19 顺序契约定死）：①前置门（Composer
   * queueAvailable 同口径并集禁入口）→ ②POST navigate（expectedLeafId 透传）→
   * ③清流式态 → ④full=1 全量整替（refetchSession 通道，replay 窗口内推迟到窗口
   * 关闭后落地）→ ⑤回传 leafId 更新 viewLeafId → ⑥leafNavSeq 自增（usage 触发）→
   * ⑦navigating 互斥拒并发切换与发送。拒绝路径（前置门/409）状态保持：不整替、
   * 不清流式态、viewLeafId 不动。 */
  /** 叶切换编排（session-branching todo 6，F19 顺序契约定死）：①前置门（真忙碌
   * 并集禁入口：streaming + 回合在途 turnInFlightOf——task-10 缺陷 D 收窄，waiting
   * 不再入锁；拒绝出轻提示 toast 不再静默）→ ②POST navigate（expectedLeafId 透传；
   * 409 stale_leaf 先全量整替校准再带新叶自动重试恰一次——task-10 缺陷 C，二次
   * stale 交常驻错误卡；校准+重试链有界兜底 STALE_RETRY_FLOOR_MS，悬挂超时同
   * errors.staleLeaf 卡收口——task-10 缺陷 F）→ ③清流式态 → ④full=1 全量整替
   * （refetchSession 通道，replay 窗口内推迟到窗口关闭后落地，推迟上限
   * REPLAY_DEFER_MAX_MS 残窗强制收口——缺陷 F）→ ⑤回传 leafId 更新 viewLeafId →
   * ⑥leafNavSeq 自增（usage 触发）→ ⑦navigating 互斥拒并发切换与发送。其余拒绝
   * 路径（前置门外的 409/网络）状态保持：不整替、不清流式态、viewLeafId 不动。 */
  switchLeaf(
    sessionId: string,
    entryId: string,
    deps: SwitchLeafDeps,
    /** 导航意图（task-10 缺陷 E-1）：select（缺省）= 编辑位语义链（从此处分支/
     *  编辑重发/重试——引擎 select(user) 叶移父位并回 editorText）；resume = 切视图
 *  （叶=目标条目本身，与角色无关——pager/树点击解析目标分支叶后传入）。 */
    intent?: "select" | "resume",
  ): Promise<SwitchLeafResult>;
  /** 发送即回跟活回合（task-10 attempt-7 缺陷 H）：任何视图位（含编辑重发/从此处
   *  分支后钉在编辑位簿记叶的 viewLeafId）上的 prompt 发送成功即解除显式视图叶——
   *  回合条目沿 SSE advanceLeaf 推进 leafId，新分支即时可见；保持钉住会把新回合锁
   *  在视野外（发送后视图停空编辑位、pager 缺席，刷新才见 ‹n/m›，QA attempt-7 实录）。
   *  与 refreshAfterContinue 的⑤回跟活叶同语义，但不整替不推序号（发送链自有
   * 乐观入列与 SSE 增量）。仅本端发送解钉（用户意图=跟随自己发出的回合）；他端/
   *  引擎侧推进不拽视图（todo 4「离径不拽视图」契约不变）。直发与排队两态同解
   *  （排队投递落在引擎活跃叶下，钉住同样不可见）。 */
  followLiveTurn(sessionId: string): void;
  /** 409 stale_leaf 校准（session-branching task-10 缺陷 C，F19「全量整替校准」落位）：
   *  full=1 全量整替把本地叶指针重置到文件/引擎当前真值（冷引擎挂接簿记漂移叶后
   *  的一切 CAS 后续以新叶续）。视图叶不动（setEntries keepView 语义天然成立：漂移
   *  只追加簿记条目，用户所在分支仍在树中）。返回新叶 id；取数失败/槽拆/空叶返回
   *  null（调用方按拒绝路径收口）。switchLeaf 的 stale 重试与 editAssistantMessage
   *  CAS 跳（message-actions-data runEditReply）共用本编排。 */
  recalibrateAfterStale(
    sessionId: string,
    deps: Pick<SwitchLeafDeps, "fetchFull">,
  ): Promise<string | null>;
  /** entries 图谱修复（task-10 缺陷 I，fix7）：活回合增量携带悬空 parentId（父链条目
   *  不在本地图谱——引擎在嫁接位与 user 消息之间插入的回合簿记链 oauth/env/custom
   *  永不经 SSE 白名单入列，QA attempt-8 实证）时，全量重取重建图谱并锚定到当前
   *  活叶。与 refreshAfterContinue 的「旧视图残留丢弃」相反，本动作是**并集合并**：
   *  页只补缺（祖先链/簿记），SSE 已入列的活条目一条不丢——修复页是落地时新取的
   *  快照（非被门放弃的过期页），不存在回滚 SSE 增量的问题，与 fix4 落地守卫/
   * fix6 双门语义正交组合（门拦过期投影，修复只落新鲜页）。viewLeafId 不动
   *  （keepView 语义）、leafNavSeq 不涨（无导航发生）、流式态不清（活回合合法）。
   *  在途按会话去重；fetch 失败静默（下次悬空增量再兜底）。 */
  repairEntriesGraph(
    sessionId: string,
    deps: Pick<SwitchLeafDeps, "fetchFull">,
  ): Promise<void>;
  /** assistant 编辑续跑后的刷新编排（session-branching todo 9）：edit 已把引擎叶换到
   *  副本、continue 已开启真实回合（F12 两段链），故不设前置门/不出 navigate/不清
   *  流式态（迟到流式帧是合法的活回合，非旧叶残像）——只做 F19 链的④⑤⑥子集：
   *  full=1 全量整替（fetch 快照与落地间到达的 entry_appended 帧按 id upsert 回
   *  新页不丢列，与 SSE 同口径）→ viewLeafId=null 回跟活叶（活叶沿 SSE advanceLeaf
   *  续推，流式回合自然可见）→ leafNavSeq 自增（usage 触发沿）。fetch 失败状态
   *  保持不动，仅返回 ok:false 由调用方处置。 */
  refreshAfterContinue(
    sessionId: string,
    deps: Pick<SwitchLeafDeps, "fetchFull">,
  ): Promise<{ ok: boolean }>;
}

/** 会话级事件行 id 序列（r10 todo 7）：模块级单调递增，仅作流内 React key */
let sessionEventSeq = 0;

/** 流内错误卡 id 序列：模块级单调递增，仅作流内 React key */
let streamErrorSeq = 0;

/** 重放窗口 delta 快进缓冲（r10 todo 14）：切页回来重连时服务端以 replay_begin/done
 *  包夹补发积压帧，逐帧 appendDelta 会从旧位置逐帧回放（渲染滞后根因）。窗口内的
 *  流式 delta 不逐帧 set，按会话缓冲；replay_done（或建连清残窗）时一次性快进 flush
 *  ——合并语义与逐帧应用等价，渲染只落最新一拍。前台流式（窗口外）零改动。 */
const replayDeltaBuffer = new Map<string, DeltaPatch[]>();

/** 进行中的图谱修复（task-10 缺陷 I，按会话去重：悬空增量连击时不重复拉取） */
const graphRepairInFlight = new Set<string>();

function emptySessionMessages(): SessionMessages {
  return {
    entries: [],
    cursor: null,
    leafId: null,
    viewLeafId: null,
    navigating: false,
    leafNavSeq: 0,
    loaded: false,
    hasMore: false,
    oldestId: null,
    swapSeq: 0,
    streaming: false,
    streamingMessage: null,
    streamingEntryId: null,
    toolRuns: {},
    compacting: false,
    sessionEvents: [],
    errors: [],
    receiptModel: null,
    modelBackfill: [],
    modelBackfillDone: false,
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

/** 409 校准重试链兜底时长（task-10 缺陷 F）：recalibrate 取数与重试 navigate 的有界
 *  等待下限；超时（取数悬挂/引擎无响应等）拆防 + errors.staleLeaf 常驻错误卡——切换
 *  链永不静默悬挂。取值覆盖引擎冷启挂起（QA 实测 19-27s），不误杀慢而合法的重试。 */
export const STALE_RETRY_FLOOR_MS = 30_000;

/** 切换整替的重放窗口推迟上限（task-10 缺陷 F）：honest 重放窗口亚秒收口（服务端
 *  建连同步写完 replay_begin..done 桥帧）；超此限即残窗（连接死于重放中途且重连未
 *  成），强制收口（endReplayRecovery，与 EventsClient 建连清残窗同口径）后整替照常
 *  落地——用户驱动的导航不因残窗无限推迟（navigating 永久布防=切换面静默锁死）。 */
export const REPLAY_DEFER_MAX_MS = 8_000;

/** withStaleFloor 超时哨兵（task-10 缺陷 F）：区别于底层动作自身的错误 */
const STALE_FLOOR_EXPIRED = Symbol("stale-retry-floor-expired");

/** 有界等待（task-10 缺陷 F 兜底）：ms 内未落定即以哨兵拒绝（不中断底层动作，迟到
 *  结果由 Promise 已定语义自然丢弃）；落定则透传结果/错误。 */
function withStaleFloor<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(STALE_FLOOR_EXPIRED), ms);
    // bun 单测环境不挂住进程退出（同 armCompactingFallback 模式）
    (timer as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

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

/** 追加路径标识对账防线（r10 todo 15，对照 b6d3df4 不变量）：REST 追加路径
 * （gap 小缺口 ?before= 增量补齐/游标校准窗，dad6d24 引入）入列真实 id 消息条目前，
 * 按待入列消息载荷指纹移除槽内同载荷合成孪生。b6d3df4 的收敛不变量“每条定格合成
 * 孪生由 entry_appended 真实 id 身份归一收敛”只在 SSE 通道成立：该消息的
 * entry_appended 帧落在 gap 内丢失时（切页/隐藏页停摆丢帧），message_end 定格的
 * 孪生无人收敛，REST 真实 id 条目追加后即双列（6875933 越窗截断发 gap 使对账补齐
 * 成常态，复发概率大增）。与 entry_appended 归一同口径：syntheticId（djb2，h 前缀
 * 合成形态）与引擎真实 id 属不相交空间，只删孪生、绝不触真实条目——两个不同回合的
 * 同文回复各有真实 id，互不坍缩（反铁律，docs/08:83）；同真实 id 回填帧由 upsertEntry
 * 按 id 幂等 no-op。 */
function stripSyntheticTwins(list: WireEntry[], incoming: ReadonlyArray<WireEntry>): WireEntry[] {
  let out = list;
  for (const entry of incoming) {
    if (entry.type !== "message" || typeof entry.id !== "string" || entry.id === "") continue;
    const m = entry.message as WireMessage | undefined;
    if (m === undefined || (m.role !== "user" && m.role !== "assistant")) continue;
    const twinId = syntheticId(m);
    out = out.filter((e) => e.id !== twinId);
  }
  return out;
}

/** entry_appended 通用入列 + 叶推进（session-branching todo 4）：真实条目原样入列
 *  （parentId 引擎真相）；延伸当前路径或替换当前叶引用（listAfterRemovals 为孪生/
 *  占位收敛后的列表）时推叶，重放幂等回填（已在列）不推。调用面全部是活回合 SSE
 *  增量（entry_appended 全族）与其并集重放（图谱修复/续跑刷新）。任务 7（F3 实锤）：
 *  新到条目 wire 载荷缺 parentId（载荷截断形态，F3 实测零修复请求反推）时挂当前尾条
 *  ——追加式文件语义下新条目必续在尾条之后，与消息通道 lastEntryId 同口径；磁盘非
 *  首条必有父，null 不再表达「根声明」而是链路缺失。已在列的幂等回填携无父载荷时保
 *  持既有条目原样（REST/先到帧的父链接更完整，不被截断载荷整替洗掉），叶也不拽。
 *  悬空父重链开启（准入缺口不冻叶，见 advanceLeaf 注）。游标随叶（2026-11-25 切回整份
 *  重拉修复）：推叶即入列条目成为文件最新一条，cursor 同步到新叶；叶未动（重放回填/
 *  离径）游标不动——切回补漏只取其后真漏的条目。 */
function appendEntryWithLeaf(
  cur: SessionMessages,
  stored: WireEntry,
  listAfterRemovals: WireEntry[],
): { entries: WireEntry[]; leafId: string | null; cursor: string | null } {
  const id = typeof stored.id === "string" && stored.id !== "" ? stored.id : null;
  if (id === null) return { entries: upsertEntry(listAfterRemovals, stored), leafId: cur.leafId, cursor: cur.cursor };
  const wireParentId = typeof stored.parentId === "string" && stored.parentId !== "" ? stored.parentId : null;
  const existed = listAfterRemovals.some((e) => e.id === id);
  let entryToStore = stored;
  if (wireParentId === null && existed) {
    // 幂等回填携无父载荷：保持既有条目原样（REST/先到帧的父链接更完整，不被截断载荷洗掉）
    entryToStore = listAfterRemovals.find((e) => e.id === id) ?? stored;
  } else if (wireParentId === null) {
    // 新到条目 wire 缺父：挂当前尾条（追加式文件语义，磁盘非首条必有父；与消息通道同口径）
    const tailId = lastEntryId(listAfterRemovals, id);
    if (tailId !== null) entryToStore = { ...stored, parentId: tailId };
  }
  const parentId =
    typeof entryToStore.parentId === "string" && entryToStore.parentId !== "" ? entryToStore.parentId : null;
  const leafId = advanceLeaf(cur.leafId, listAfterRemovals, id, parentId, existed, true);
  return {
    entries: upsertEntry(listAfterRemovals, entryToStore),
    leafId,
    cursor: leafId !== cur.leafId ? leafId : cur.cursor,
  };
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
      // 合成孪生 parentId 注入 + 叶推进（session-branching todo 4，F5 关键坑：不挂
      // parentId 的合成条目会掉出路径=消息消失）。仅 live 定格（有流式态）挂当前尾
      // 条并推进叶；重放窗内无流式态的 end 帧回放是旧消息的孪生伪影——不挂路径不推
      // 叶（entry_appended 真值收敛后自然消失）。
      const live = cur.streamingMessage != null || cur.streamingEntryId != null;
      const tailId = live ? lastEntryId(cur.entries, id) : null;
      const entry: WireEntry = {
        type: "message",
        id,
        ...(tailId !== null ? { parentId: tailId } : {}),
        message: msg,
      };
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: {
            ...cur,
            entries: upsertEntry(cur.entries, entry),
            leafId: live
              ? advanceLeaf(cur.leafId, cur.entries, id, tailId, cur.entries.some((e) => e.id === id))
              : cur.leafId,
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
        const patch: DeltaPatch = {
          contentIndex,
          kind: type === "text_delta" ? "text" : "thinking",
          text: delta,
        };
        // 重放窗口内积压快进（r10 todo 14）：不逐帧 set，缓冲待 replay_done 合并 flush
        if (get().replayRecovering) {
          const buf = replayDeltaBuffer.get(sessionId);
          if (buf) buf.push(patch);
          else replayDeltaBuffer.set(sessionId, [patch]);
          break;
        }
        get().appendDelta(sessionId, patch);
        break;
      }
      // *_end / toolcall_*（执行事实以 tool_execution_start 为准）/ 未知类型：忽略
      default:
        break;
    }
  };

  /** 重放窗口 delta 快进 flush（r10 todo 14）：按 (contentIndex,kind) 保序合并缓冲的
   *  delta，每会话一次 set 应用全部积压——最终内容与逐帧应用完全一致，无逐帧回放。
   *  flush 在窗口标记复位前执行，flush 后到达的实时帧照常逐帧。 */
  const flushReplayDeltas = () => {
    if (replayDeltaBuffer.size === 0) return;
    const batches = [...replayDeltaBuffer.entries()];
    replayDeltaBuffer.clear();
    set((s) => {
      const bySession = { ...s.bySession };
      for (const [sessionId, patches] of batches) {
        const cur = bySession[sessionId];
        if (!cur?.streamingMessage) continue; // 定格/清理后 flush：与逐帧路径同义 no-op
        const msg = cur.streamingMessage;
        const content = msg.content ? msg.content.slice() : [];
        const order: string[] = [];
        const byKey = new Map<string, DeltaPatch>();
        for (const p of patches) {
          const key = `${p.contentIndex}\u0000${p.kind}`;
          const prev = byKey.get(key);
          if (prev) prev.text += p.text;
          else {
            byKey.set(key, { ...p });
            order.push(key);
          }
        }
        for (const key of order) {
          const p = byKey.get(key)!;
          const idx = p.contentIndex;
          const existing = content[idx];
          if (existing === undefined) {
            content[idx] =
              p.kind === "text" ? { type: "text", text: p.text } : { type: "thinking", thinking: p.text };
          } else if (existing.type !== p.kind) {
            continue; // 类型不匹配且已存在：容错忽略（同逐帧路径）
          } else if (p.kind === "text") {
            content[idx] = { ...existing, text: (typeof existing.text === "string" ? existing.text : "") + p.text };
          } else {
            content[idx] = {
              ...existing,
              thinking: (typeof existing.thinking === "string" ? existing.thinking : "") + p.text,
            };
          }
        }
        bySession[sessionId] = { ...cur, streamingMessage: { ...msg, content } };
      }
      return { bySession };
    });
  };

  return {
    bySession: {},
    followAnchors: {},
    replayRecovering: false,

    setFollowAnchor: (sessionId, anchorId) =>
      set((s) => {
        if (s.followAnchors[sessionId] === anchorId) return s;
        return { followAnchors: { ...s.followAnchors, [sessionId]: anchorId } };
      }),

    beginReplayRecovery: () => set({ replayRecovering: true }),

    endReplayRecovery: () => {
      // r10 todo 14：窗口关闭即快进 flush（replay_done / 建连清残窗两路都收敛于此），
      // 先应用积压再复位标记——flush 后到达的实时帧照常逐帧
      flushReplayDeltas();
      set({ replayRecovering: false });
    },

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

    appendSessionEvent: (sessionId, summary) => {
      // 锚点入列（事件行锚点化批 2026-11-18）：事件发生时刻的消息流末条 entry id 记为
      // 锚（与提问卡 lastStreamEntryId 同口径）——渲染层插在锚条目后随消息流上移，不再
      // 恒钉列表底部（用户反馈：模型已切换提示应像 CLI 一样随消息上移）；id 单调递增
      // 作流内 key。重放窗口重复帧由调用侧守卫（与 autoStarted toast 同守卫），此处
      // 不再按内容去重。
      const entries = useMessagesStore.getState().bySession[sessionId]?.entries ?? [];
      let anchorEntryId: string | null = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        const eid = entries[i]!.id;
        if (typeof eid === "string" && eid !== "") {
          anchorEntryId = eid;
          break;
        }
      }
      const id = `ev-${++sessionEventSeq}`;
      set((s) => {
        const cur = s.bySession[sessionId] ?? emptySessionMessages();
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: { ...cur, sessionEvents: [...cur.sessionEvents, { id, summary, anchorEntryId }] },
          },
        };
      });
    },

    pushError: (sessionId, text) => {
      const id = `err-${++streamErrorSeq}`;
      set((s) => {
        const cur = s.bySession[sessionId] ?? emptySessionMessages();
        // 同文计数（罗列收敛批 2026-11-21）：相同 text 的错误卡未消时不重复加卡，
        // 计数 +1 并刷新时间戳（渲染 ×N 徽标 + 最近一次时间）；不同文本仍各自成卡
        const existing = cur.errors.find((e) => e.text === text);
        if (existing !== undefined) {
          return {
            bySession: {
              ...s.bySession,
              [sessionId]: {
                ...cur,
                errors: cur.errors.map((e) =>
                  e.id === existing.id ? { ...e, count: e.count + 1, ts: Date.now() } : e,
                ),
              },
            },
          };
        }
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: { ...cur, errors: [...cur.errors, { id, text, ts: Date.now(), count: 1 }] },
          },
        };
      });
    },

    dismissError: (sessionId, id) => {
      set((s) => {
        const cur = s.bySession[sessionId];
        if (cur === undefined || cur.errors.length === 0) return s;
        const kept = cur.errors.filter((e) => e.id !== id);
        if (kept.length === cur.errors.length) return s;
        return { bySession: { ...s.bySession, [sessionId]: { ...cur, errors: kept } } };
      });
    },

    dismissQueuedEvents: (sessionId, snippets) => {
      // 送达即撤（2026-10-31）：仅移除排队类事件行且片段命中已送达项，其余事件行不动；
      // 无命中返回原引用不触发重渲染
      set((s) => {
        const cur = s.bySession[sessionId];
        if (cur === undefined || cur.sessionEvents.length === 0) return s;
        const kept = cur.sessionEvents.filter(
          (l) =>
            l.summary.key !== "chat.sessionEvents.queued" ||
            typeof l.summary.vars?.text !== "string" ||
            !snippets.has(l.summary.vars.text),
        );
        if (kept.length === cur.sessionEvents.length) return s;
        return {
          bySession: { ...s.bySession, [sessionId]: { ...cur, sessionEvents: kept } },
        };
      });
    },

    setEntries: (sessionId, entries, cursor, leafId, paging) => {
      // 打开会话/刷新/_gap 重取的水合点（任务 27a）：先落生效模型再入消息槽
      hydrateAppliedModel(sessionId, entries);
      set((s) => {
        const prev = s.bySession[sessionId];
        // viewLeafId 生命周期（todo 6 契约提前落位）：全量整替后显式视图叶仍在新文件
        // 中则保留，消失回落 null=跟随文件叶 leafId
        const keepView = prev?.viewLeafId ?? null;
        const viewLeafId =
          keepView !== null && entries.some((e) => e.id === keepView) ? keepView : null;
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: {
              ...emptySessionMessages(),
              ...prev,
              viewLeafId,
              entries,
              cursor,
              leafId,
              loaded: true,
              // 换代序号（任务 3）：落在既有可见窗口上自增，首载水合归零
              swapSeq: prev?.entries.length ? (prev.swapSeq ?? 0) + 1 : 0,
              ...(paging ?? { hasMore: false, oldestId: null }),
            },
          },
        };
      });
    },

    setCursor: (sessionId, cursor) =>
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur) return s;
        return { bySession: { ...s.bySession, [sessionId]: { ...cur, cursor } } };
      }),

    appendEntries: (sessionId, entries) => {
      // 游标增量校准窗（切回会话/触顶同步）同水合（任务 27a）：增量内含切换才写，
      // 与 setEntries 同一权威源口径；prependEntries 是更早窗（不可能含最新切换）不扫
      hydrateAppliedModel(sessionId, entries);
      set((s) => {
        const cur = s.bySession[sessionId] ?? emptySessionMessages();
        // 追加前标识对账（r10 todo 15）：先收敛待入列真实 id 条目的同载荷合成孪生，
        // 再逐条按 id upsert（重放/回填帧幂等 no-op）——gap 丢失 entry_appended 的
        // 消息经 REST 补齐后不再双列（根因与口径见 stripSyntheticTwins）。
        let list = stripSyntheticTwins(cur.entries, entries);
        for (const entry of entries) list = upsertEntry(list, entry);
        // 叶推进（session-branching todo 4）：REST 增量窗带回的新尾按文件序逐条延伸
        // ——延伸当前路径或收敛掉当前叶引用（孪生被真值整替）时推进，离径（他端分
        // 支操作）不拽视图；重放幂等回填（此前已在列）不推。
        const known = new Set<string>();
        for (const e of cur.entries) if (typeof e.id === "string") known.add(e.id);
        let leafId = cur.leafId;
        for (const entry of entries) {
          const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : null;
          if (id === null) continue;
          const parentId =
            typeof entry.parentId === "string" && entry.parentId !== "" ? entry.parentId : null;
          leafId = advanceLeaf(leafId, list, id, parentId, known.has(id));
        }
        return { bySession: { ...s.bySession, [sessionId]: { ...cur, entries: list, leafId } } };
      });
    },

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

    markReceiptModel: (sessionId, model) =>
      set((s) => {
        const cur = s.bySession[sessionId];
        if (cur === undefined || cur.receiptModel === model) return s;
        return { bySession: { ...s.bySession, [sessionId]: { ...cur, receiptModel: model } } };
      }),

    fetchEarlierPage: async (sessionId, before, fetchPage) => {
      const page = await fetchPage({ before });
      get().prependEntries(sessionId, page.entries, {
        hasMore: page.hasMore ?? false,
        oldestId: page.oldestId ?? null,
      });
    },

    backfillModelTimeline: async (sessionId, fetchChanges) => {
      const cur = get().bySession[sessionId];
      if (!cur?.loaded || cur.modelBackfillDone) return;
      // 时间线自足（尾窗已含变更点）或已是全量（无窗外可补）：只落闸，不拉
      if (lastModelChangeOf(cur.entries) !== null || !cur.hasMore) {
        set((s) => {
          const st = s.bySession[sessionId];
          return st ? { bySession: { ...s.bySession, [sessionId]: { ...st, modelBackfillDone: true } } } : s;
        });
        return;
      }
      try {
        // 首屏流量直做批（台账 11-08 #35）：轻量端点只回 model_change 条目（KB 级），
        // 取代原 full=1 全量拉取（长会话单开 95% 流量来自彼处）
        const source = await fetchChanges();
        const now = get().bySession[sessionId];
        if (now === undefined) return; // 等待期间会话清理：放弃本轮
        const changes = modelChangeBackfillOf(source, now.entries);
        set((s) => ({
          bySession: {
            ...s.bySession,
            [sessionId]: { ...now, modelBackfill: changes, modelBackfillDone: true },
          },
        }));
        // 窗口外最末变更点即当前生效模型：复用水合写入口径（appliedModels + 选中对齐）
        if (changes.length > 0) hydrateAppliedModel(sessionId, changes);
      } catch {
        // 回读失败静默降级（归因是软增强，不报错不重试风暴）：落闸
        set((s) => {
          const st = s.bySession[sessionId];
          return st ? { bySession: { ...s.bySession, [sessionId]: { ...st, modelBackfillDone: true } } } : s;
        });
      }
    },

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
              // parentId 注入 + 叶推进（session-branching todo 4）：事件携 parentId
              //（引擎真相）保留，缺席（message 通道帧常态）挂当前尾条；吸收/孪生收敛
              // 移除当前叶引用（乐观占位被吸收）时叶随真值推进；重放幂等回填不推。
              // 活回合消息通道开启悬空父重链（任务 7）：帧父链接落在 store 永不准入的
              // 簿记节点（session-lifecycle 等）时不冻叶——echo 孪生即时可见，entry_
              // appended 真值收敛沿移除叶规则续推，投影不回退。
              const parentId =
                typeof entry.parentId === "string" && entry.parentId !== ""
                  ? entry.parentId
                  : lastEntryId(list, id);
              const stored: WireEntry = { ...entry, type: "message", id, parentId };
              return {
                bySession: {
                  ...s.bySession,
                  [sessionId]: {
                    ...cur,
                    entries: upsertEntry(list, stored),
                    leafId: advanceLeaf(cur.leafId, list, id, parentId, list.some((e) => e.id === id), true),
                  },
                },
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
          // 思考档三链 B：用户显式手选过的档位不被引擎回显覆盖（引擎自身 settings.json
          // 默认 high 会把手选 max 打回）；未手选（回退链/程序化链）照常同步。
          const ui = useUiStore.getState();
          if (!ui.userPickedThinking) {
            // 来源分级日志（2026-11-10 思考档排查）：引擎推送变化——同值不重复记，值变化才记一行
            if (ui.selectedThinkingLevel !== level) {
              const sel = event.thinkingSelection;
              diag.info("thinking-level", "engine_change", {
                to: level,
                session: sessionId,
                source:
                  sel === undefined || sel === null ? undefined : JSON.stringify(sel).slice(0, 120),
              });
            }
            ui.setSelectedThinkingLevel(level);
          }
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
                const kept = cur.entries.filter((e) => e.id !== twinId);
                const stored: WireEntry = { ...entry, type: "message", message: appendedMsg };
                // 叶推进（session-branching todo 4）：真实条目原样入列（parentId 引擎
                // 真相）；孪生收敛移除当前叶引用时随真值推进，重放幂等回填不推
                const merged = appendEntryWithLeaf(cur, stored, kept);
                return {
                  bySession: {
                    ...s.bySession,
                    [sessionId]: { ...cur, entries: merged.entries, leafId: merged.leafId, cursor: merged.cursor },
                  },
                };
              });
              break;
            }
            // 内层 role 非 user/assistant（多腿回合 toolResult 等簿记内层）：不再就地
            // 丢弃，落到下方准入兜底同治——入列为不可见图节点，子消息 parentId 链不断。
          }
          // 压缩摘要条目增量（docs08-r6 任务 19g）：引擎压缩完成后经 entry_appended 携
          // 顶层 type:"compaction" 条目到达（F3 实测 compaction_end 后紧跟 entry_appended，
          // 帧形态 {entry:{type:"compaction",id,summary,...}}），放行入列——渲染层
          // compactionMarkerOf 派生标记块（白名单渲染语义在派生侧），历史 GET messages
          // 同形同构；不入列则进行中页面永不出现标记块（仅刷新后才见）。
          if (entry.type === "compaction" && typeof entry.id === "string" && entry.id !== "") {
            set((s) => {
              const cur = s.bySession[sessionId] ?? emptySessionMessages();
              // 叶推进（todo 4）：压缩摘要条目在文件尾延伸当前路径时推叶（标记块在
              // 当前路径可见）；重放幂等回填不推
              const merged = appendEntryWithLeaf(cur, entry, cur.entries);
              return {
                bySession: { ...s.bySession, [sessionId]: { ...cur, entries: merged.entries, leafId: merged.leafId, cursor: merged.cursor } },
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
          // 子代理后台完成通知入列（docs08-2026-10-22 批次任务 26，GAP-16）：后台 task
          // 真正完成时引擎经 entry_appended 携 customType "omo-senpi:wake" 的
          // task completion 条目（JSONL 顶层 type:"custom_message" 携 id，历史 GET
          // messages 同形同构）——此前不消费，页签卡永停 spawn 回执。放行入列供
          // subagent-data 按 taskId 配对转真终态；其余 wake 载荷（ulw 续跑引导等）
          // 不按完成通知消费（宁漏勿错，判定单一真相源 lib/task-completion.ts），
          // 携有效 id 时照下方准入兜底入列为不可见图节点。
          if (parseTaskCompletionEntry(entry) !== null) {
            set((s) => {
              const cur = s.bySession[sessionId] ?? emptySessionMessages();
              // 叶推进（todo 4）：同口径入列推叶（延伸当前路径时推，重放回填不推）
              const merged = appendEntryWithLeaf(cur, entry, cur.entries);
              return {
                bySession: { ...s.bySession, [sessionId]: { ...cur, entries: merged.entries, leafId: merged.leafId, cursor: merged.cursor } },
              };
            });
            break;
          }
          if (isMemoryAppendedEntry(entry)) {
            set((s) => {
              const cur = s.bySession[sessionId] ?? emptySessionMessages();
              // 叶推进（todo 4）：同口径入列推叶（延伸当前路径时推，重放回填不推）
              const merged = appendEntryWithLeaf(cur, entry, cur.entries);
              return {
                bySession: { ...s.bySession, [sessionId]: { ...cur, entries: merged.entries, leafId: merged.leafId, cursor: merged.cursor } },
              };
            });
            break;
          }
          // 准入兜底（webui-refetch-storm 任务 1，GAP-1 主/GAP-2 半）：白名单外的簿记
          // 条目（custom/custom_message/其他顶层类型，含上方改道的非 user/assistant
          // message 内层）携有效字符串 id 一律入列为不可见图节点——引擎在嫁接位/多腿
          // 回合插入的簿记链（graft/turn-context/oauth 等）此前被丢弃，后续消息
          // parentId 悬空：advanceLeaf「延伸当前路径」永不命中 + 修复全量重取风暴。
          // 可见性口径（决策 D7）不变：渲染分类门在 message-items 收紧（未知 custom、
          // display!=true 的 custom_message、toolResult 内层一律零渲染行），REST 全量
          // 态本就不筛 store 入列，窗口态与全量态可见集不发散。只动图节点与叶推进，
          // 不写 runState 等任何运行态；repairEntriesGraph 修复面与孪生收敛不动。
          if (typeof entry.id === "string" && entry.id !== "") {
            set((s) => {
              const cur = s.bySession[sessionId] ?? emptySessionMessages();
              // 叶推进（todo 4）：同口径入列推叶（延伸当前路径时推，重放回填不推）
              const merged = appendEntryWithLeaf(cur, entry, cur.entries);
              return {
                bySession: { ...s.bySession, [sessionId]: { ...cur, entries: merged.entries, leafId: merged.leafId, cursor: merged.cursor } },
              };
            });
          }
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

    clearStreamingForNavigation: (sessionId) =>
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur) return s;
        if (!cur.streaming && cur.streamingMessage === null && cur.streamingEntryId === null) return s;
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: { ...cur, streaming: false, streamingMessage: null, streamingEntryId: null },
          },
        };
      }),

    followLiveTurn: (sessionId) =>
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur || cur.viewLeafId === null) return s;
        return { bySession: { ...s.bySession, [sessionId]: { ...cur, viewLeafId: null } } };
      }),

    switchLeaf: async (sessionId, entryId, deps, intent = "select") => {
      const cur = get().bySession[sessionId];
      // ⑦ navigating 互斥：并发切换即拒（UI 禁用之外的状态机兑底）；拒绝出轻提示
      //（task-10 缺陷 D：前置门拒绝不再静默 no-op；toast 先例 event-dispatch notify）
      if (cur?.navigating) {
        useUiStore.getState().showToast(t("chat.tree.switchBusy"));
        return { ok: false, reason: "busy" };
      }
      // ① 前置门（F19 + task-10 缺陷 D 收窄）：真忙碌才拒——streaming 或回合在途
      //（turnInFlightOf：SSE 权威 running 或探询 active 兑底）。waiting（引擎挂接
      // 待输入稳态/提问待答）不再入锁：挂接稳态即 waiting，入锁会永久禁用切换面；
      // 提问/权限等待期间导航的真实互斥由引擎 409 already_processing 兑底。拒绝出
      // 轻提示（勿依赖引擎报错做 UX）。
      const sessions = useSessionsStore.getState();
      if (
        !cur ||
        cur.streaming ||
        turnInFlightOf(sessions.runStates[sessionId], pickActive(sessions, sessionId))
      ) {
        useUiStore.getState().showToast(t("chat.tree.switchBlocked"));
        return { ok: false, reason: "blocked" };
      }
      // 布防先于出网：导航在途即拒并发发送（api.prompt 同读此位）与二次切换
      set((s) => {
        const slot = s.bySession[sessionId];
        if (!slot) return s;
        return { bySession: { ...s.bySession, [sessionId]: { ...slot, navigating: true } } };
      });
      // 二次 stale 已推错误卡的标记（拒绝回执携带，防调用方双推）
      let errorCarded = false;
      // 缺陷 H 门 (ii) 锚点：编排起点的显式视图叶——迟到落地时若它已被移动（发送即
      // followLiveTurn 解钉等更新近的视图意图），⑤ 的显式重钉即过期，整替一并放弃
      const viewAnchorAtStart = get().bySession[sessionId]?.viewLeafId ?? null;
      try {
        // ② POST navigate（意图由调用方分流，task-10 缺陷 E-1：select=编辑位链（缺省）、
        // resume=切视图（叶=目标本身）；F13：本地叶指针透传为 expectedLeafId 乐观锁，引擎拒
        // stale_leaf；task-10 缺陷 C：冷引擎挂接簿记漂移叶首切必 stale——409 时
        // 全量整替校准后带新叶自动重试恰一次，二次 stale 交常驻错误卡收口）
        let receipt: LeafNavigateReceipt;
        try {
          receipt = await deps.navigate({
            entryId,
            intent,
            expectedLeafId: cur.leafId ?? undefined,
          });
        } catch (err) {
          const stale = staleLeafOf(err);
          if (!stale.stale) throw err;
          // 校准（F19 全量整替）：重置本地叶指针（viewLeafId 不动——漂移只追加簿记
          // 条目，用户所在分支仍在树中）；缺陷 D 修复后 waiting 不再锁切换面，
          // 挂接稳态的 runState 无需在此对冲。缺陷 F 兜底：校准取数有界
          // （STALE_RETRY_FLOOR_MS）——悬挂（磁盘读悬挂等）超时即 errors.staleLeaf
          // 常驻错误卡 + 拒绝收口，静默悬挂不可达；迟到结果由 Promise 已定语义丢弃。
          const pageLeaf = await withStaleFloor(
            get().recalibrateAfterStale(sessionId, { fetchFull: deps.fetchFull }),
            STALE_RETRY_FLOOR_MS,
          ).catch((floorErr: unknown) => {
            if (floorErr !== STALE_FLOOR_EXPIRED) throw floorErr; // 校准自身异常：原拒绝路径
            get().pushError(sessionId, t("errors.staleLeaf"));
            errorCarded = true;
            throw err; // 以首拒错误收口（同源归因）
          });
          if (pageLeaf === null) throw err; // 取数失败/槽拆：按拒绝路径收口
          try {
            receipt = await withStaleFloor(
              deps.navigate({
                entryId,
                intent,
                // CAS 首选引擎拒答自带的新叶（error.data.leafId，与引擎在记忆真叶同拍）
                expectedLeafId: stale.leafId ?? pageLeaf,
              }),
              STALE_RETRY_FLOOR_MS,
            );
          } catch (retryErr) {
            // 二次 stale（他端持续推进/校准后仍漂移）：常驻错误卡（对齐 CLI 可回看）；
            // 重试悬挂超时：errors.staleLeaf 常驻错误卡（同悬挂纪律）；errorCarded
            // 标记防调用方双推
            get().pushError(
              sessionId,
              retryErr === STALE_FLOOR_EXPIRED
                ? t("errors.staleLeaf")
                : apiErrorMessage(retryErr, "chat.messageActions.branchNavigateFailed"),
            );
            errorCarded = true;
            if (retryErr === STALE_FLOOR_EXPIRED) throw err; // 以首拒错误收口（同源归因）
            throw retryErr;
          }
        }
        // ③ 清本会话流式态（防迟到 message_end 把半截内容定格进旧视图）
        get().clearStreamingForNavigation(sessionId);
        // ④ full=1 全量整替（refetchSession 通道同款：full 拉取 + setEntries + 槽在位
        // 检查；勿 cursor 增量——引擎叶已换，本地游标增量窗语义失效）
        const page = await deps.fetchFull();
        const apply = () => {
          const st = get().bySession[sessionId];
          if (!st) return; // 中途清理（clearSession）：槽已拆即放弃，不复活槽（迟到页丢弃）
          // 缺陷 H 双门（task-10 attempt-7）：迟到/在途整替不得回旧叶路径。命任一门
          // 即放弃本次整替（④ 页快照已过期），仅拆防收口，视图交活回合，条目真相由
          // 回合内 SSE 与其后全量重取收敛：
          // (i) 落地时点回合在途（SSE 权威 running / 探询 active 兑底）——页快照取自回
          //     合开始前，整替会把 SSE 已入列的新分支条目整页打回旧集合并清流式（QA
          //     attempt-7 缺陷 H 的 items 4↔3 振荡写者，estep4 回合内零 REST 帧实证）；
          //     replay 窗内重放重建的幻影流式态不在此门（runState 无权威 running，
          //     turnInFlightOf=false），仍由下方③重申清理——todo 6 测试 (7) 契约不变。
          // (ii) 视图锚自编排起点已被移动（发送即 followLiveTurn 解钉）——⑤ 的显式重
          //     钉会覆盖更新近的用户视图意图，把发送后的视图锁回发送前旧叶。
          const sess = useSessionsStore.getState();
          if (
            turnInFlightOf(sess.runStates[sessionId], pickActive(sess, sessionId)) ||
            st.viewLeafId !== viewAnchorAtStart
          ) {
            set((s2) => {
              const slot = s2.bySession[sessionId];
              if (!slot) return s2;
              return { bySession: { ...s2.bySession, [sessionId]: { ...slot, navigating: false } } };
            });
            diag.info("messages", "switch-leaf-apply-superseded", {
              sessionId: sessionId.slice(0, 8),
              turnInFlight: turnInFlightOf(sess.runStates[sessionId], pickActive(sess, sessionId)),
              viewMoved: st.viewLeafId !== viewAnchorAtStart,
            });
            return;
          }
          // ③不变量在落地沿重申：推迟窗内旧分支流的重放帧可能重建流式态（前缀抑制
          // 不命中时），整替时点统一再清一次，半截内容不落新视图
          get().clearStreamingForNavigation(sessionId);
          // ⑤（契约「整替后清 replay 缓冲」支）：缓冲的是旧叶的流式 delta，整替重写
          // entries 后不得再落新视图
          replayDeltaBuffer.delete(sessionId);
          get().setEntries(sessionId, page.entries, page.cursor, page.leafId, {
            hasMore: page.hasMore ?? false,
            oldestId: page.oldestId ?? null,
          });
          // ⑤ 用回传 leafId 更新视图叶（F15：导航回传为唯一真相；可能是簿记条目 id，
          // 不假设消息形）。显式覆盖 setEntries 的 keepView 结果（保留/回落均不适用
          // 导航场景——本次整替的起点就是切换意图本身）。
          // ⑥ leafNavSeq 自增即「叶导航落定」沿（use-context-usage 边沿触发 getUsage）。
          // navigating 同步拆防：整个编排（含推迟落地）就此收口。
          set((s) => {
            const slot = s.bySession[sessionId];
            if (!slot) return s;
            return {
              bySession: {
                ...s.bySession,
                [sessionId]: {
                  ...slot,
                  viewLeafId: receipt.leafId,
                  navigating: false,
                  leafNavSeq: slot.leafNavSeq + 1,
                },
              },
            };
          });
        };
        if (get().replayRecovering) {
          // 重放窗口内不整替（F19 ⑤「整替排在 replay_done 后」支）：订阅先行，窗口
          // 关闭（replay_done / 建连清残窗）后一次性落地；窗口期内会话被拆则放弃。
          // navigating 保持布防至落地——整替未发生前视图仍在旧叶，放行切换会撕裂。
          // 缺陷 F：推迟有界（REPLAY_DEFER_MAX_MS）——honest 窗口亚秒收口，超限即
          // 残窗（连接死于重放中途且重连未成），强制收口（与建连清残窗同口径）后由
          // 订阅照常落地；navigating 不因残窗永久布防（切换面静默锁死）。
          let landed = false;
          const unsub = useMessagesStore.subscribe((s) => {
            if (!s.bySession[sessionId]) {
              landed = true;
              unsub();
              return;
            }
            if (!s.replayRecovering) {
              landed = true;
              unsub();
              apply();
            }
          });
          const deferTimer = setTimeout(() => {
            if (landed) return; // 已落地/已放弃：不误伤其后新开的合法窗口
            useMessagesStore.getState().endReplayRecovery(); // 残窗强制收口 → 订阅即触发落地
          }, REPLAY_DEFER_MAX_MS);
          // bun 单测环境不挂住进程退出（同 armCompactingFallback 模式）
          (deferTimer as unknown as { unref?: () => void }).unref?.();
        } else {
          apply();
        }
        return { ok: true, leafId: receipt.leafId, editorText: receipt.editorText };
      } catch (err) {
        // 拒绝路径（前置门已前置出网拦；此为引擎/网络拒绝：409 already_processing /
        // stale 二次重试失败 / 网络等）：状态保持——不整替、不清流式态、viewLeafId
        // 不动（stale 首拒的校准整替已在重试前落地，属 F19 校准而非本路径），仅拆防
        // 回到可切换态
        set((s) => {
          const slot = s.bySession[sessionId];
          if (!slot) return s;
          return { bySession: { ...s.bySession, [sessionId]: { ...slot, navigating: false } } };
        });
        diag.warn("messages", "switch-leaf-rejected", {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, reason: "rejected", ...(errorCarded ? { errorCarded: true } : {}) };
      }
    },

    recalibrateAfterStale: async (sessionId, deps) => {
      // 409 stale_leaf 校准（task-10 缺陷 C，F19 全量整替）：取数失败/槽拆/空叶
      // 一律 null（调用方按拒绝路径收口，不在此推错误面——反馈由上层编排统一）
      let page: MessagesPage;
      try {
        page = await deps.fetchFull();
      } catch {
        return null;
      }
      const fresh = typeof page.leafId === "string" && page.leafId !== "" ? page.leafId : null;
      if (fresh === null) return null;
      if (!get().bySession[sessionId]) return null; // 中途拆会话：不复活槽
      // 整替落位（setEntries keepView 语义：显式视图叶仍在树中则保留——漂移只追加
      // 簿记条目，用户所在分支不动；CAS 指针 leafId 随页重置到当前真值）
      get().setEntries(sessionId, page.entries, page.cursor, fresh, {
        hasMore: page.hasMore ?? false,
        oldestId: page.oldestId ?? null,
      });
      return fresh;
    },

    /** 缺陷 I 图谱修复（fix7）：并集合并实现——页补缺不丢活，叶锚定新页文件叶后沿
     *  本地活增量（页取数期间经 SSE 到达的条目）按 appendEntryWithLeaf 同口径推进。
     *  语义依据见接口注释；不触 viewLeafId/navigating/leafNavSeq/流式态。 */
    repairEntriesGraph: async (sessionId, deps) => {
      if (graphRepairInFlight.has(sessionId)) return;
      if (!get().bySession[sessionId]) return;
      graphRepairInFlight.add(sessionId);
      try {
        let page: MessagesPage;
        try {
          page = await deps.fetchFull();
        } catch (err) {
          // 取数失败静默（同 refetchSession 兜底哲学）：下次悬空增量 / 全量重取再收敛
          diag.warn("messages", "graph-repair-failed", {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        const cur = get().bySession[sessionId];
        if (!cur) return; // 中途拆会话（clearSession）：槽已拆即放弃，不复活槽
        const pageIds = new Set(
          page.entries
            .filter((e) => typeof e.id === "string" && e.id !== "")
            .map((e) => e.id as string),
        );
        let entries = page.entries;
        let leafId = page.leafId;
        for (const arrival of cur.entries) {
          if (typeof arrival.id !== "string" || arrival.id === "" || pageIds.has(arrival.id)) continue;
          const merged = appendEntryWithLeaf({ ...cur, entries, leafId }, arrival, entries);
          entries = merged.entries;
          leafId = merged.leafId;
        }
        get().setEntries(sessionId, entries, page.cursor, leafId, {
          hasMore: page.hasMore ?? false,
          oldestId: page.oldestId ?? null,
        });
        diag.info("messages", "graph-repair", {
          sessionId: sessionId.slice(0, 8),
          pageEntries: page.entries.length,
          liveArrivals: entries.length - page.entries.length,
        });
      } finally {
        graphRepairInFlight.delete(sessionId);
      }
    },

    refreshAfterContinue: async (sessionId, deps) => {
      // T0 快照：fetch 出网前的槽内条目 id 集——整替后不在页内的旧条目按「旧视图
      // 残留」丢弃（与 switchLeaf ④ 同语义），仅快照之后新到（SSE 抢先推进的续跑
      // 条目）按竞态增量回填不丢列
      const before = get().bySession[sessionId];
      const beforeIds = new Set(
        (before?.entries ?? []).filter((e) => typeof e.id === "string" && e.id !== "").map((e) => e.id),
      );
      let page: Awaited<ReturnType<SwitchLeafDeps["fetchFull"]>>;
      try {
        page = await deps.fetchFull();
      } catch (err) {
        // fetch 失败状态保持不动（不整替不推叶），仅返回 ok:false 由调用方错误卡处置
        diag.warn("messages", "refresh-after-continue-failed", {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
        return { ok: false };
      }
      const cur = get().bySession[sessionId];
      if (!cur) return { ok: false }; // 中途拆会话（clearSession）：槽已拆即放弃，不复活槽
      // T0 之后经 SSE entry_appended 到达的新条目（竞态窗口）：按 id upsert 回新页并
      // 推叶（appendEntryWithLeaf 与 SSE 入列同口径，含合成孪生收敛语义）
      const pageIds = new Set(
        page.entries.filter((e) => typeof e.id === "string" && e.id !== "").map((e) => e.id),
      );
      const arrivals = cur.entries.filter(
        (e) => typeof e.id === "string" && !pageIds.has(e.id) && !beforeIds.has(e.id),
      );
      let entries = page.entries;
      let leafId = page.leafId;
      for (const arrival of arrivals) {
        const merged = appendEntryWithLeaf({ ...cur, entries, leafId }, arrival, entries);
        entries = merged.entries;
        leafId = merged.leafId;
      }
      // ④ 全量整替（setEntries 通道：水合/keepView 等语义与 refetchSession 同源）
      get().setEntries(sessionId, entries, page.cursor, leafId, {
        hasMore: page.hasMore ?? false,
        oldestId: page.oldestId ?? null,
      });
      // ⑤⑥ viewLeafId=null 回跟活叶（F15：活叶沿 SSE advanceLeaf 续推，续跑回合的
      // 流式条目自然可见；旧显式叶是编辑前分支的锚，保留会把新回合锁在视野外）
      // + leafNavSeq 自增（usage 触发沿，IS-9 导航后刷新）
      set((s) => {
        const slot = s.bySession[sessionId];
        if (!slot) return s;
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: { ...slot, viewLeafId: null, leafNavSeq: slot.leafNavSeq + 1 },
          },
        };
      });
      return { ok: true };
    },

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
        replayDeltaBuffer.delete(sessionId); // 重放缓冲随会话清理拆除
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
        // parentId 注入 + 叶推进（session-branching todo 4，F5 关键坑）：乐观占位挂
        // 当前尾条（空会话首条无尾=根）并即时成为当前叶——否则按叶路径过滤启动后
        // 占位掉出路径=消息消失；服务端真值到达由既有 absorb/adopt 收敛链收敛（链
        // 路不动），叶随真值推进。
        const tailId = lastEntryId(cur.entries);
        // 合成 id 本地生成必为 string；独立成 const 让类型跟上事实（WireEntry.id 宽
        // 形态 string|undefined，entry.id 直接喂 advanceLeaf 过不了类型）。
        const entryId = `${LOCAL_ENTRY_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const entry: WireEntry = {
          type: "message",
          id: entryId,
          parentId: tailId,
          message: { role: "user", content },
        };
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: {
              ...cur,
              entries: upsertEntry(cur.entries, entry),
              leafId: advanceLeaf(cur.leafId, cur.entries, entryId, tailId, false),
            },
          },
        };
      }),

    adoptDurableId: (oldId, newId) =>
      set((s) => {
        if (oldId === newId) return s;
        const oldSlot = s.bySession[oldId];
        if (!oldSlot) return s;
        const newSlot = s.bySession[newId];
        const bySession = { ...s.bySession };
        // 满足锚点随槽迁移（#26）：换 key 后恢复定位仍指向同一会话的最新条目
        const followAnchors = { ...s.followAnchors };
        if (followAnchors[oldId] !== undefined) {
          followAnchors[newId] = followAnchors[oldId];
          delete followAnchors[oldId];
        }
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
        return { bySession, followAnchors };
      }),
  };
});
