// 消息流 items 组装纯逻辑：
// 从 message-list.tsx 拆出（组件文件只导组件，fast-refresh 约束；同 composer-logic 惯例）。
// chat-view.tsx 组装 items（chat-view.tsx:176 一带）调用；message-list.tsx 消费渲染。
// B11 模型切换点分隔线已退役（2026-10-15 可见性缺口 ② 改为气泡头部常驻模型短名，
// 消息级 model 字段同源）：连续同模型段的盲区不复存在，分隔线冗余。
// 变体名时间线对齐（docs08 2026-10-22 批次任务 18）：引擎侧 assistant 消息只记裸上游名
// （实测 3282 条 glm-5.3 vs 2 条变体 id），model_change 条目才记变体 id——本模块单遍
// 时间线重建各时段生效变体，5 级回退歧义绝不猜。
import type { WireEntry, WireMessage } from "@/lib/api";
import type { MessageKey } from "@/i18n/i18n";
import { memoryMarkerOf, type MemoryMarker } from "@/lib/memory-entries";
import type { QuestionRequest, QuestionResolvedSummary } from "@/stores/questions";

/** 压缩摘要标记（docs08-r6 任务 18 ③）：顶层 type:"compaction" 条目派生。字段形态
 *  钉死于 task-3 枚举（.omo/evidence/docs08-r6/task-3-enumeration.md §三）：summary
 *  3/3 为字符串 markdown、details 3/3 为 senpi.compaction.summary.v1 同构——但引用
 *  一律判空（同会话库内同族 custom 条目 post-compact-restoration 的 details 仅
 *  1/3 存在，形态从宽是铁律），缺失降级不臆造。 */
export interface CompactionMarker {
  /** 锚定条目 id（并入 items 时的排序锚点 + React key） */
  entryId: string;
  /** 摘要首个非空行（常显一句；超长截断） */
  summaryFirstLine: string;
  /** 展开原文：summary 全文，details 存在时追加 JSON（缺失不追加不臆造） */
  detail: string;
  /** 压缩前水位（tokensBefore；task-3 实测 3/3 数字，缺省时标记块不展示水位段） */
  tokensBefore: number | null;
}

/** 常显首行截断长度（超长摘要截断加省略号，展开可见全文） */
const COMPACTION_SUMMARY_MAX = 80;

/** 条目 → 压缩摘要标记（顶层 type:"compaction" 且有 id 才派生；summary/details/
 *  tokensBefore 全部判空降级，并常返回可用标记） */
export function compactionMarkerOf(entry: WireEntry): CompactionMarker | null {
  if (entry.type !== "compaction" || typeof entry.id !== "string" || entry.id === "") return null;
  const summary = typeof entry.summary === "string" ? entry.summary : "";
  const firstLine = summary.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  const tokensBefore = typeof entry.tokensBefore === "number" ? entry.tokensBefore : null;
  const marker: CompactionMarker = {
    entryId: entry.id,
    summaryFirstLine:
      firstLine.length > COMPACTION_SUMMARY_MAX
        ? `${firstLine.slice(0, COMPACTION_SUMMARY_MAX)}…`
        : firstLine,
    detail: summary,
    tokensBefore,
  };
  // details 判空（task-3 实证同族条目可缺失）：存在且为对象才追加 JSON 原文
  if (entry.details !== null && typeof entry.details === "object") {
    marker.detail = `${marker.detail}\n\n${JSON.stringify(entry.details, null, 2)}`.trim();
  }
  return marker;
}

/** loop-guard 三型 kind（引擎内置扩展三常量：LOOP_GUARD_NOTICE/ESCALATION/RECOVERY_
 *  CUSTOM_TYPE = loop-guard:notice/escalation/recovery，session-worker.js 实证；
 *  引擎 renderer.js 仅 notice/escalation 注册渲染器，escalation tone=error；
 *  web 侧三型色板：notice=info（sky）/escalation=error（destructive）/recovery=success（emerald）） */
export type LoopGuardKind = "notice" | "escalation" | "recovery";

const LOOP_GUARD_KIND_BY_TYPE: Record<string, LoopGuardKind> = {
  "loop-guard:notice": "notice",
  "loop-guard:escalation": "escalation",
  "loop-guard:recovery": "recovery",
};

/** customType → loop-guard kind（仅三型精确名命中；未知 loop-guard:* 后缀禁猜，
 *  返回 null 回落通用占位行，对齐 task-3 枚举纪律） */
export function loopGuardKindOf(customType: unknown): LoopGuardKind | null {
  if (typeof customType !== "string") return null;
  return LOOP_GUARD_KIND_BY_TYPE[customType] ?? null;
}

/** 模型注册表行（resolve 只需 provider/id/upstreamId 三字段；web ModelInfo 结构子集，
 *  服务端 GET /api/models 行已合并 upstreamId——非变体行缺席该字段） */
export interface ModelVariantRow {
  provider: string;
  id: string;
  upstreamId?: string;
}

/** 会话生效模型水合源（docs08 2026-10-22 批次任务 27a）：entries 中最后一条 model_change
 *  条目即当前生效模型——provider/modelId 记变体名，与选中 "provider/变体id"、prompt 回执
 *  appliedModel 同键空间（引擎 bundle 实证 model_changed 帧与 jsonl 条目同源同一 model
 *  对象，任务 27d 核实）。正序扫描保最后一条；无则 null（新会话/切换在载入窗外，此时
 *  由回执/回显补齐）。纯函数。 */
export function lastModelChangeOf(
  entries: ReadonlyArray<WireEntry>,
): { provider: string; modelId: string } | null {
  let current: { provider: string; modelId: string } | null = null;
  for (const e of entries) {
    const change = modelChangeOf(e);
    if (change !== null) current = change;
  }
  return current;
}

/** 单条 assistant 条目的模型名解析结果：name 为显示名（变体 id 优先；"provider/model"
 *  形态由渲染层 shortModelName 归一），ambiguous=true 表示只能给出裸上游名且注册表内
 *  多个变体共用该上游（title 注记，绝不猜） */
export interface ResolvedModelName {
  name: string;
  ambiguous: boolean;
}

/** 时间线 model_change 条目窄化（wire 形态从宽）：provider/modelId 非空字符串才更新
 *  时间线（实录形态：{"type":"model_change",provider:"zai-coding-cn",modelId:"glm-5.3-4k"}） */
function modelChangeOf(entry: WireEntry): { provider: string; modelId: string } | null {
  if (entry.type !== "model_change") return null;
  const provider = entry.provider;
  const modelId = entry.modelId;
  if (typeof provider !== "string" || provider === "") return null;
  if (typeof modelId !== "string" || modelId === "") return null;
  return { provider, modelId };
}

/** 单条 assistant 消息的模型名 5 级回退（docs08 2026-10-22 批次任务 18）：
 *  1 时间线+注册表确证（upstreamId===raw）→ 变体名；
 *  2 时间线命中但注册表无法确证（变体已删/基础模型无映射）且裸 id 一致 → 时间线 modelId；
 *  3 appliedModels（会话内最新生效，"provider/model" 形态）；
 *  4 注册表唯一反查（upstreamId===raw 恰一行）→ 该变体 id；
 *  5 裸名 + 歧义注记（多变体共用上游时 title 提示；零命中/唯一命中之外的歧义绝不猜）。
 *  纯函数无副作用（读 registry 不改写）。 */
export function resolveVariantName(
  raw: string,
  asOf: { provider: string; modelId: string } | null,
  registry: ReadonlyArray<ModelVariantRow>,
  appliedModel: string | null,
): ResolvedModelName {
  if (asOf !== null) {
    const row = registry.find((r) => r.provider === asOf.provider && r.id === asOf.modelId);
    if (row !== undefined && row.upstreamId === raw) {
      return { name: asOf.modelId, ambiguous: false };
    }
    // 裸 id 一致两态：时间线 modelId 即裸 id（基础模型，===raw）；或变体已从注册表
    // 删除（无行）且 raw 仍是同 provider 在册模型 id（家族成立）——历史段照实显变体名。
    if (
      asOf.modelId === raw ||
      (row === undefined && registry.some((r) => r.provider === asOf.provider && r.id === raw))
    ) {
      return { name: asOf.modelId, ambiguous: false };
    }
  }
  if (appliedModel !== null && appliedModel !== "") {
    return { name: appliedModel, ambiguous: false };
  }
  const upstreamMatches = registry.filter((r) => r.upstreamId === raw);
  if (upstreamMatches.length === 1) {
    return { name: upstreamMatches[0]!.id, ambiguous: false };
  }
  return { name: raw, ambiguous: upstreamMatches.length > 1 };
}

/** 单遍时间线解析（docs08 2026-10-22 批次任务 18）：model_change 更新 current，
 *  assistant 记 as-of appliedAt；返回 entryId → 解析名映射（仅 assistant 条目入映射）。
 *  纯函数：不修改入参，返回新建 Map。 */
export function resolveTimelineModels(
  entries: ReadonlyArray<WireEntry & { id: string }>,
  registry: ReadonlyArray<ModelVariantRow>,
  appliedModel: string | null,
): Map<string, ResolvedModelName> {
  const out = new Map<string, ResolvedModelName>();
  let current: { provider: string; modelId: string } | null = null;
  for (const e of entries) {
    const change = modelChangeOf(e);
    if (change !== null) {
      current = change;
      continue;
    }
    const msg = e.message as WireMessage | undefined;
    if (msg === null || typeof msg !== "object" || msg.role !== "assistant") continue;
    const raw = (msg as { model?: unknown }).model;
    if (typeof raw !== "string" || raw === "") continue;
    out.set(e.id, resolveVariantName(raw, current, registry, appliedModel));
  }
  return out;
}

/** items 数组判别联合：entry=定格条目气泡；streaming=流式气泡；
 *  memoryMarker=记忆标记块（docs08-r4 任务 13，白名单 memory 条目派生）；
 *  customMessage=display=true 的 custom_message 占位行（docs08-r6 任务 10 ③，
 *  这类条目此前无渲染分支——入列却无内容可渲染即空壳路径）；
 *  loopGuardGroup=相邻同型 loop-guard 条目聚合组（docs08 2026-10-22 批次任务 2）；
 *  compactionMarker=压缩摘要标记块（docs08-r6 任务 18 ③，顶层 type:"compaction" 条目派生）；
 *  memoryMarkerCluster=相邻同簇 acceptedTurns 聚合组（docs08 2026-10-23/24 批次任务 14，
 *  「本轮已计入记忆 ×N」可展开，同 loopGuardGroup 连排语义） */
/** 记忆自动整理停驻通知（docs08 2026-10-25 用户反馈）：引擎 custom 条目
 * senpi-memory.reflection-parked（omo-memory 扩展 appendEntry 实测形态，2026-10-24
 * 真实样本）：type:"custom" + data{schemaVersion,streak,parkedAt,nextProbeAt,retryable,
 * lastReason,recommendation}。CLI 将其内联渲染为消息列表警示卡；web 侧同构——
 * 字段严格窄化（task-3 禁猜纪律），任一关键字段不合法印 null 不入列（维持旧口径）。 */
export interface ReflectionParkedNotice {
  entryId: string;
  streak: number;
  nextProbeAtMs: number | null;
  retryable: boolean;
  recommendation: string;
}

/** parked 条目窄化：仅接受 streak 正整数；nextProbeAt 合法 ISO 才转 ms，否则 null
 * （时间缺失不阻断卡片，仅少一行）；recommendation 非字符串时回落空串。 */
export function reflectionParkedOf(entry: WireEntry & { id: string }): ReflectionParkedNotice | null {
  if (entry.type !== "custom" || entry.customType !== "senpi-memory.reflection-parked") return null;
  const data = entry.data;
  if (data === null || typeof data !== "object") return null;
  const streak = (data as { streak?: unknown }).streak;
  if (typeof streak !== "number" || !Number.isFinite(streak) || streak < 1) return null;
  const rawNext = (data as { nextProbeAt?: unknown }).nextProbeAt;
  const nextProbeAtMs =
    typeof rawNext === "string" && rawNext !== "" ? Date.parse(rawNext) : NaN;
  const retryable = (data as { retryable?: unknown }).retryable === true;
  const recommendation = (data as { recommendation?: unknown }).recommendation;
  return {
    entryId: entry.id,
    streak,
    nextProbeAtMs: Number.isFinite(nextProbeAtMs) ? nextProbeAtMs : null,
    retryable,
    recommendation: typeof recommendation === "string" ? recommendation : "",
  };
}

export type ChatListItem =
  | {
      key: string;
      kind: "entry";
      entryId: string;
      interrupted: boolean;
      /** 变体名解析结果（任务 18）：assistant 条目携 resolved 名（null = 未解析/
       *  无模型字段，渲染层回落裸 message.model） */
      model: ResolvedModelName | null;
    }
  | { key: string; kind: "streaming" }
  | { key: string; kind: "memoryMarker"; marker: MemoryMarker }
  | { key: string; kind: "customMessage"; entryId: string }
  | { key: string; kind: "loopGuardGroup"; loopGuardKind: LoopGuardKind; entryIds: string[] }
  | { key: string; kind: "compactionMarker"; marker: CompactionMarker }
  | { key: string; kind: "memoryMarkerCluster"; markers: MemoryMarker[] }
  | { key: string; kind: "noticeCard"; notice: ReflectionParkedNotice }
  | { key: string; kind: "sessionEvent"; line: SessionEventLine }
  | { key: string; kind: "questionCard"; request: QuestionRequest; position: number; total: number }
  | { key: string; kind: "questionResolved"; summary: QuestionResolvedSummary };

/** 会话级事件行（r10 todo 7）：纯数据形态，messages store 持有（定义在此、store 以
 *  type 引用，防 store→组件纯逻辑模块的反向值依赖）。渲染由 message-list 的
 *  SessionEventLineBlock 承担。 */
export interface SessionEventLine {
  id: string;
  summary: { key: MessageKey; vars?: Record<string, unknown> };
}

/** 事件行并入 items（r10 todo 7）：尾部追加（事件行 = 最新发生的事实，接在全部已
 *  落库条目与流式气泡之后，按到达序即时间序）。无事件行时原样返回（引用不变，
 *  订阅方不重算），同 mergeMemoryItems 口径。纯函数。 */
export function mergeSessionEventLines(
  items: ChatListItem[],
  lines: readonly SessionEventLine[],
): ChatListItem[] {
  if (lines.length === 0) return items;
  return [...items, ...lines.map((line) => ({ key: `session-event-${line.id}`, kind: "sessionEvent", line }) as const)];
}

/** 提问卡合成层（r11 todo 6d）：每张 pending 卡各自渲染于各自锚点 entry 之后（不做
 *  多卡折叠收敛）；锚点解析不出（提问先于任何消息/锚条目被压缩出窗/显式 null）时挂
 *  消息流末尾（流式气泡之前——提问先于其后的流式输出发生）。落定瞬态摘要行
 *  （r11 todo 6e）同规则插在同一锚点位。纯函数：不改入参，无重复列（卡片只来源于
 *  questions store，帧重投由 pushRequest 同 id 去重兑底）。 */
export function mergeQuestionCards(
  items: ChatListItem[],
  entries: readonly WireEntry[],
  requests: ReadonlyArray<QuestionRequest>,
  resolvedSummaries: ReadonlyArray<QuestionResolvedSummary> = [],
): ChatListItem[] {
  if (requests.length === 0 && resolvedSummaries.length === 0) return items;
  const ordOf = new Map<string, number>();
  entries.forEach((e, i) => {
    if (typeof e.id === "string" && e.id !== "" && !ordOf.has(e.id)) ordOf.set(e.id, i);
  });
  // 已插入卡/摘要行的锚序（后续同锚插入保持到达序，不反序）
  const cardOrd = new Map<ChatListItem, number>();
  const ordOfItem = (it: ChatListItem): number | null => {
    if (cardOrd.has(it)) return cardOrd.get(it)!;
    let id: string | null = null;
    if (it.kind === "entry" || it.kind === "customMessage") id = it.entryId;
    else if (it.kind === "memoryMarker") id = it.marker.entryId;
    else if (it.kind === "compactionMarker") id = it.marker.entryId;
    else if (it.kind === "noticeCard") id = it.notice.entryId;
    else if (it.kind === "loopGuardGroup") id = it.entryIds[0] ?? null;
    else if (it.kind === "memoryMarkerCluster") id = it.markers[0]?.entryId ?? null;
    if (id === null) return null;
    return ordOf.get(id) ?? null;
  };
  let out = items.slice();
  const insertAtAnchor = (anchorEntryId: string | null, make: () => ChatListItem): void => {
    const anchorOrd = anchorEntryId !== null ? ordOf.get(anchorEntryId) : undefined;
    let at: number;
    if (anchorOrd !== undefined) {
      // 自尾向前找最后一个锚序 ≤ 锚点的可见行，插其后（锚条目本身不可见时落到其后
      // 首个可见行之前；全部晚于锚点时插首位）
      at = 0;
      for (let i = out.length - 1; i >= 0; i--) {
        const o = ordOfItem(out[i]!);
        if (o !== null && o <= anchorOrd) {
          at = i + 1;
          break;
        }
      }
      const item = make();
      cardOrd.set(item, anchorOrd);
      out.splice(at, 0, item);
    } else {
      // 兑底挂流末：流式气泡之前，无流式则末尾
      at = out.length;
      for (let i = 0; i < out.length; i++) {
        if (out[i]!.kind === "streaming") {
          at = i;
          break;
        }
      }
      const item = make();
      cardOrd.set(item, Number.MAX_SAFE_INTEGER);
      out.splice(at, 0, item);
    }
  };
  requests.forEach((r, i) =>
    insertAtAnchor(r.anchorEntryId, () => ({
      key: `question-${r.id}`,
      kind: "questionCard",
      request: r,
      position: i + 1,
      total: requests.length,
    })),
  );
  resolvedSummaries.forEach((summary) =>
    insertAtAnchor(summary.anchorEntryId, () => ({
      key: `question-resolved-${summary.id}`,
      kind: "questionResolved",
      summary,
    })),
  );
  return out;
}

/** message 载荷窄化（wire 形态从宽）：role 非字符串视为不可渲染条目跳过 */
function messageOf(entry: WireEntry & { id: string }): WireMessage | null {
  const msg = (entry as { message?: unknown }).message;
  if (msg === null || typeof msg !== "object") return null;
  return typeof (msg as WireMessage).role === "string" ? (msg as WireMessage) : null;
}

/** 粘性用户候选（r9 wave1 改视口锚定，替代旧 docs08-r7 恒取尾部的 stickyUserOf）：
 *  视口上缘对应首个未完整滚出条目（end > scrollTop）起向上反查最近 kind==="entry"
 *  且 role==="user" 且含非空 text 的条目。scrollTop 为视口上缘在 measurements 坐标系
 *  （内容区，调用方扣除容器顶垫）的位置；上滚早期历史时候选随视口走，不再恒取尾部
 *  最新提问——下滚读长回答时上缘落在长答内，向上最近 user 条即最新提问，新语义自然
 *  覆盖旧行为。纯图/空文本/非 entry 项跳过；无候选（上方无 user 文本条目）返回 null。
 *  measurements 为 TanStack measurementsCache：virtual-core 3.14 单车道 dense 覆盖全量
 *  下标，未测条目落 estimateSize 估算值（源码实证），窗上历史同样可判；测量缺失或与
 *  items 未同步（未挂载/count 变更瞬间）返回 null（渲染层不钉，同旧 m 判空口径）；
 *  上缘落在首行 start 之前（容器顶垫空区）返回 null——顶部空区无行压边、无锚可反查
 *  （任务断言 2：顶部空区候选 = null）。
 *  纯函数：无时序、不改入参。 */
export function stickyCandidateAboveViewport(
  items: ChatListItem[],
  entries: readonly WireEntry[],
  measurements: ReadonlyArray<{ start: number; size: number } | undefined> | undefined,
  scrollTop: number,
): { index: number; key: string; text: string } | null {
  if (items.length === 0 || !measurements) return null;
  const head = measurements[0];
  if (head === undefined || head.start > scrollTop) return null; // 顶部空区：上缘在首行之前
  const byId = new Map<string, WireMessage>();
  for (const e of entries) {
    if (typeof e.id !== "string") continue;
    const msg = messageOf(e as WireEntry & { id: string });
    if (msg) byId.set(e.id, msg);
  }
  let first = -1;
  for (let i = 0; i < items.length; i++) {
    const m = measurements[i];
    if (m && m.start + m.size > scrollTop) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  for (let i = first; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "entry") continue;
    const msg = byId.get(item.entryId);
    if (!msg || msg.role !== "user") continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const part of content) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
        return { index: i, key: item.key, text: part.text.trim() };
      }
    }
  }
  return null;
}

/** 粘性条可见性二值判定（docs08-r7 任务 11）：未在底部（回底即消失）且最近 user 气泡
 *  完整滚出视口（上缘滚出顶部＝下滚读长回答，或下缘滚出底部＝上滚浏览历史）时显示；
 *  气泡仍在视口内（含跨越边缘）不钉。 */
export function shouldShowStickyUser(
  atBottom: boolean,
  rowTop: number,
  rowBottom: number,
  viewportTop: number,
  viewportBottom: number,
): boolean {
  if (atBottom) return false;
  return rowBottom <= viewportTop || rowTop >= viewportBottom;
}

/** items 组装：toolResult 不单独入列（结果由 ToolCard 按 toolCallId 关联展示）；
 *  custom_message 条目按 display 分类（docs08-r6 任务 10 ③）；
 *  interrupted 标记挂最后一个 assistant 条目。
 *  变体名解析（任务 18）：opts.modelRegistry 传入时单遍时间线解析，entry 项携 model；
 *  不传（旧调用方/单测）恒 null，渲染层回落裸 message.model。 */
export function buildMessageItems(
  entries: ReadonlyArray<WireEntry & { id: string }>,
  opts: {
    hasStreamingMessage: boolean;
    interrupted: boolean;
    modelRegistry?: ReadonlyArray<ModelVariantRow>;
    appliedModel?: string | null;
  },
): ChatListItem[] {
  let lastAssistantId: string | null = null;
  for (const e of entries) {
    if (messageOf(e)?.role === "assistant") lastAssistantId = e.id;
  }
  const modelNames =
    opts.modelRegistry !== undefined
      ? resolveTimelineModels(entries, opts.modelRegistry, opts.appliedModel ?? null)
      : null;
  const list: ChatListItem[] = [];
  for (const e of entries) {
    // custom 型条目（非 custom_message）：仅记忆停驻通知有已知结构（docs08 2026-10-25），
    // 窄化命中入列为警示卡；其余 custom 条目维持不入列旧口径（未来按 customType 逐个注册，
    // 不猜测未知结构）。
    if (e.type === "custom") {
      const parked = reflectionParkedOf(e);
      if (parked !== null) list.push({ key: `notice-${e.id}`, kind: "noticeCard", notice: parked });
      continue;
    }
    // custom_message 分支（docs08-r6 任务 10 ③）：仅 display=true 入列渲染占位行
    // （task-3 枚举：18 种 customType 均无实物结构样本，禁猜字段，组件层只读 customType）；
    // display=false 引擎明示不展示，一律跳过——这类条目（库内 998 条）不得产生零内容
    // 气泡（空壳防线）；记忆标记条目已由 marker 通道渲染，此处跳过防双列。
    if (e.type === "custom_message") {
      if (e.display === true && memoryMarkerOf(e) === null) {
        // loop-guard 三型（docs08 2026-10-22 批次任务 2）：渲染流相邻同型连排聚合为一组。
        // 「连排」= 用户所见相邻：toolResult 等不入列的不可见条目不产生可见行，不阻断
        // 聚合；任何产生可见行的条目（普通 message、非三型 custom_message）打断聚合
        // （非相邻同型不聚合；kind 边界重置）。
        // 非三型 customType 回落通用占位行（r6 任务 10 ③ 兜底不动）；display=false
        // 仍按既有口径一律不入列（引擎明示不展示，聚合组亦不得绕过）。
        const kind = loopGuardKindOf(e.customType);
        const last = list[list.length - 1];
        if (kind !== null) {
          if (last !== undefined && last.kind === "loopGuardGroup" && last.loopGuardKind === kind) {
            last.entryIds.push(e.id);
          } else {
            list.push({
              key: `loop-guard-${e.id}`,
              kind: "loopGuardGroup",
              loopGuardKind: kind,
              entryIds: [e.id],
            });
          }
        } else {
          list.push({ key: e.id, kind: "customMessage", entryId: e.id });
        }
      }
      continue;
    }
    const msg = messageOf(e);
    if (!msg) continue;
    // toolResult 不单独入列：结果已由 ToolCard 按 toolCallId 关联展示（parts.tsx 同口径，
    // ToolResultLine 恒空）；入列只会渲染出带"助手+时间"头部的空壳行，每个工具调用
    // 多占一行死空间（任务 10 走查发现，390/1920 同样存在）。
    if (msg.role === "toolResult") continue;
    list.push({
      key: e.id,
      kind: "entry",
      entryId: e.id,
      interrupted: opts.interrupted && e.id === lastAssistantId,
      model: modelNames?.get(e.id) ?? null,
    });
  }
    if (opts.hasStreamingMessage) list.push({ key: "__streaming", kind: "streaming" });
  return list;
}

/** 记忆标记与压缩摘要标记归并 items（docs08-r4 任务 13 建；docs08-r6 任务 18 ③
 *  并入 compaction marker 同一归并）：白名单 memory 条目与顶层 compaction 条目在各自
 *  条目的流内位置（之后）插入 marker 项。items 顺序即 messageEntries 的顺序
 *  （buildMessageItems 保序），按 entries 下标归并即可；divider 锚点从 key 前缀还原，
 *  streaming 项无锚点恒最后。sessionBinding 按 identity 渲染去重（引擎每回合重写
 *  binding 条目，同一 identity 只显示首次绑定）。无标记时原样返回（引用不变，
 *  订阅方不重算）。锚点不在 entries 的项（理论不发生）排最后、保序，防错位插队。 */
export function mergeMemoryItems(items: ChatListItem[], entries: readonly WireEntry[]): ChatListItem[] {
  const ordOf = new Map<string, number>();
  entries.forEach((e, i) => {
    if (typeof e.id === "string") ordOf.set(e.id, i);
  });
  const LAST = Number.MAX_SAFE_INTEGER;
  const seenBindings = new Set<string>();
  const markers: Array<{ ord: number; seq: number; item: ChatListItem }> = [];
  let seq = 0;
  for (const e of entries) {
    // 压缩摘要 marker（任务 18 ③）：顶层 type:"compaction" 条目，逐条忠实渲染（无去重）
    const compaction = compactionMarkerOf(e);
    if (compaction !== null) {
      markers.push({
        ord: ordOf.get(compaction.entryId) ?? LAST,
        seq: seq++,
        item: { key: `compaction-${compaction.entryId}`, kind: "compactionMarker", marker: compaction },
      });
      continue;
    }
    const marker = memoryMarkerOf(e);
    if (marker === null) continue;
    if (marker.dedupeKey !== undefined) {
      if (seenBindings.has(marker.dedupeKey)) continue;
      seenBindings.add(marker.dedupeKey);
    }
    markers.push({
      ord: ordOf.get(marker.entryId) ?? LAST,
      seq: seq++,
      item: { key: `memory-${marker.entryId}`, kind: "memoryMarker", marker },
    });
  }
  if (markers.length === 0) return items;
  const scored = markers.slice();
  for (const item of items) {
    const anchor = item.kind === "entry" ? item.entryId : null;
    const ord = anchor !== null ? (ordOf.get(anchor) ?? LAST) : LAST;
    scored.push({ ord, seq: seq++, item });
  }
  scored.sort((a, b) => a.ord - b.ord || a.seq - b.seq);
  // acceptedTurns 同簇连排聚合（docs08 2026-10-23/24 批次任务 14）：排序后的最终渲染流里
  // 用户所见相邻的 acceptedTurns 标记折叠为一组「×N」。「连排」同 loopGuardGroup 语义 =
  // 渲染流相邻（不产生可见行的条目如 toolResult 不打断）；其他任何可见项（消息、
  // sessionBinding / memoryRecall 等异类标记）打断——绝不跨语义合并。单条不折叠
  // （保持 memoryMarker 原形态，渲染与既有完全一致）；组 key 锚定首条 entryId，
  // 新事件追加进既有簇时 key 不变，虚拟化行复用、展开态不丢（stale_state 防线）。
  const folded: ChatListItem[] = [];
  for (const s of scored) {
    const item = s.item;
    if (item.kind === "memoryMarker" && item.marker.kind === "acceptedTurns") {
      const last = folded[folded.length - 1];
      if (last !== undefined && last.kind === "memoryMarkerCluster") {
        last.markers.push(item.marker);
        continue;
      }
      folded.push({ key: `memory-cluster-${item.marker.entryId}`, kind: "memoryMarkerCluster", markers: [item.marker] });
      continue;
    }
    folded.push(item);
  }
  return foldSingletonClusters(folded);
}

/** 单元素簇还原为普通 memoryMarker（渲染与聚合前完全一致，×1 不产生 ×N 角标语义） */
function foldSingletonClusters(items: ChatListItem[]): ChatListItem[] {
  return items.map((i) =>
    i.kind === "memoryMarkerCluster" && i.markers.length === 1
      ? { key: `memory-${i.markers[0]!.entryId}`, kind: "memoryMarker", marker: i.markers[0]! }
      : i,
  );
}
