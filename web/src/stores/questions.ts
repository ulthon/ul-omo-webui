// 提问卡片数据面（q1）：会话内未决 question 型 UI 请求队列。
// wire 契约（历史 q1 spike 实证（脚本已删，见 git 历史）+ 引擎 connection-question-bridge.js）：
// - method:"question" 帧：{id, waitForAnswer, questions:[{id,header,question,options,multiSelect}],
//   timeout, deadlineAtMs, remainingMs, askedAtMs}——waitForAnswer=true 阻塞回合等答案，false 跨回合存活；
// - question_updated：{id, deadlineAtMs, remainingMs} 截止刷新（progress 驱动，可无）；
// - question_resolved：{id, outcome} 终局广播（answered/timed_out/cancelled/...）→ 出队；
// - 应答与四型对话框同通道：POST /permission {requestId, answers|comment|cancelled}；
//   引擎侧 settledQuestionStatus：非空 comment 即落定（comment-submitted），否则任一
//   answer 落定（answered），全空拒收（question_incomplete）——前端同规则预校验。
// 对账：GET /api/sessions/:id/questions（打开会话拉一次，同 queue 口径）；SSE 重放
// 同 id 去重（pushRequest 惯例）。
// 队列清理：不做 agent_end 整队清空（waitForAnswer=false 跨回合存活，与 permissions
// 的"权限门阻塞回合"语义不同）；出队只由 question_resolved / 本端应答成功 / 忽略 /
// 截止超时（deadline + 宽限，引擎侧超时广播因事件丢失未达时的兜底）驱动。
// r11 todo 6 新增三面：
// - 锚点（anchorEntryId/askedAtMs）：SSE question 帧到达时刻消息流末条 entry id +
//   wire askedAtMs；渲染层据此把卡合成进消息流提问发生位置（对账重建无精确锚时按
//   askedAtMs 对 entry.timestamp 重定位，仍找不到挂消息流末尾）；
// - 草稿（drafts，复合键）：selections/texts/comment/activeTab/submitted 上提进
//   store——卡片随虚拟化/页签切换卸载不丢已答、已提交待确认态重挂保真（防重复提交）；
//   出队/落定/清会话连带清理；
// - 落定瞬态痕（resolvedSummaries）：question_resolved 时卡位替换为一行摘要的数据面，
//   锚点沿用落定前卡片的锚；内存态零持久化，刷新即无。
import { create } from "zustand";

export interface QuestionSpec {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export interface QuestionRequest {
  /** wire extension_ui_request 的 id（应答回传用） */
  id: string;
  /** true=阻塞回合等答案；false=回合继续、答案稍后以用户消息回投 */
  waitForAnswer: boolean;
  questions: QuestionSpec[];
  /** 绝对截止时刻（ms epoch，引擎时钟）；卡片倒计时与本地过期判定基准 */
  deadlineAtMs: number;
  /** 引擎侧超时毫秒（信息展示用） */
  timeout: number;
  /** wire askedAtMs（提问发生时刻，引擎时钟）；对账重建后按 entry.timestamp 重定位锚点用 */
  askedAtMs: number;
  /** 帧到达时刻消息流末条 entry id（精确锚）；提问先于任何消息为 null（渲染层挂流末兜底）。
   *  SSE 首帧锚定后不漂移（pushRequest 同 id 去重保原锚）。 */
  anchorEntryId: string | null;
}

/** 提问卡 per-request 草稿（r11 todo 6a）：组件本地应答态上提——虚拟化滚出/页签切换
 *  卸载重挂不丢已答；submitted（已提交待确认）一并上提，重挂保态防重复提交。 */
export interface QuestionDraft {
  selections: Record<string, string[]>;
  texts: Record<string, string>;
  comment: string;
  /** 当前页签下标（0..questions.length-1 = 问题页，questions.length = 补充页签） */
  activeTab: number;
  /** 已提交待确认（question_resolved 未达的等待态） */
  submitted: boolean;
}

/** question_resolved 落定瞬态摘要（r11 todo 6e）：流内卡位替换为一行摘要的数据面——
 *  仅内存（刷新即无、零持久化），锚点沿用落定前卡片的锚。 */
export interface QuestionResolvedSummary {
  /** 原请求 id（React key / 幂等去重） */
  id: string;
  /** 落定时的锚（与 pending 卡同规则插入流内） */
  anchorEntryId: string | null;
  /** wire question_resolved.outcome（answered/timed_out/cancelled/…；文案映射在渲染层） */
  outcome: string;
  /** 首题题干首行截断（摘要行提示用） */
  snippet: string;
}

/** 截止后的本地清队宽限（毫秒）：引擎超时广播 question_resolved 应已到达；
 * 时钟漂移或事件丢失时兜底出队，晚于引擎截止不早杀在途问题。 */
export const QUESTION_EXPIRY_GRACE_MS = 60_000;

/** 草稿 map 键（会话 id 与请求 id 复合，理论撞名隔离） */
export function questionDraftKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

/** 摘要行题干截断长度 */
const RESOLVED_SNIPPET_MAX = 40;

interface QuestionsState {
  /** 会话 → 未决提问（到达序） */
  bySession: Record<string, QuestionRequest[]>;
  /** 复合键 → 草稿（questionDraftKey；出队/落定/清会话连带清理） */
  drafts: Record<string, QuestionDraft>;
  /** 会话 → 落定瞬态摘要（到达序；内存态零持久化） */
  resolvedSummaries: Record<string, QuestionResolvedSummary[]>;

  /** 入队（同 id 去重：SSE 重连/重放可能重投；去重保原请求的精确锚点） */
  pushRequest(sessionId: string, request: QuestionRequest): void;
  /** 对账重挂（r11 todo 6b）：同 id 存在时更新锚点/时刻/截止（草稿保留），不存在入队 */
  reconcileRequest(sessionId: string, request: QuestionRequest): void;
  /** question_updated 截止刷新（无该 id 时忽略） */
  updateDeadline(sessionId: string, id: string, deadlineAtMs: number): void;
  /** 应答成功（引擎回执）/ 忽略 / 本地取消后出队（不留痕、草稿一并清理） */
  removeRequest(sessionId: string, id: string): void;
  /** question_resolved / 本地过期兜底：出队 + 卡位替换为一行瞬态摘要（幂等：重复
   *  resolved 帧 / 重放窗口重播不二次报；未知 id 无卡可替 no-op） */
  resolveRequest(sessionId: string, id: string, outcome: string): void;
  /** 草稿合并写入（请求仍在队列才落——resolved 后迟到的镜像写不复活草稿） */
  setDraft(sessionId: string, requestId: string, patch: Partial<QuestionDraft>): void;
  /** 会话删除/切换清理（引擎侧重启场景由陈旧过滤兜底，此处仅本地清理） */
  clearSession(sessionId: string): void;
}

export const useQuestionsStore = create<QuestionsState>()((set) => ({
  bySession: {},
  drafts: {},
  resolvedSummaries: {},

  pushRequest: (sessionId, request) =>
    set((s) => {
      const queue = s.bySession[sessionId] ?? [];
      if (queue.some((r) => r.id === request.id)) return s;
      return { bySession: { ...s.bySession, [sessionId]: [...queue, request] } };
    }),

  reconcileRequest: (sessionId, request) =>
    set((s) => {
      const queue = s.bySession[sessionId] ?? [];
      if (!queue.some((r) => r.id === request.id)) {
        return { bySession: { ...s.bySession, [sessionId]: [...queue, request] } };
      }
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: queue.map((r) =>
            r.id === request.id
              ? { ...r, anchorEntryId: request.anchorEntryId, askedAtMs: request.askedAtMs, deadlineAtMs: request.deadlineAtMs }
              : r,
          ),
        },
      };
    }),

  updateDeadline: (sessionId, id, deadlineAtMs) =>
    set((s) => {
      const queue = s.bySession[sessionId];
      if (!queue || !queue.some((r) => r.id === id)) return s;
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: queue.map((r) => (r.id === id ? { ...r, deadlineAtMs } : r)),
        },
      };
    }),

  removeRequest: (sessionId, id) =>
    set((s) => {
      const queue = s.bySession[sessionId];
      if (!queue) return s;
      const next = queue.filter((r) => r.id !== id);
      if (next.length === queue.length) return s;
      const drafts = { ...s.drafts };
      delete drafts[questionDraftKey(sessionId, id)];
      return { bySession: { ...s.bySession, [sessionId]: next }, drafts };
    }),

  resolveRequest: (sessionId, id, outcome) =>
    set((s) => {
      const queue = s.bySession[sessionId];
      const req = queue?.find((r) => r.id === id);
      if (!req) return s; // 未知 id（异端先答后本端才见 resolved / 已出队）：无卡可替
      const lines = s.resolvedSummaries[sessionId] ?? [];
      if (lines.some((l) => l.id === id)) return s; // 幂等：重放/重复 resolved 不二次报
      const first = req.questions[0];
      const rawFirstLine =
        first?.question
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l !== "") ?? "";
      const snippet =
        rawFirstLine.length > RESOLVED_SNIPPET_MAX
          ? `${rawFirstLine.slice(0, RESOLVED_SNIPPET_MAX)}…`
          : rawFirstLine;
      const drafts = { ...s.drafts };
      delete drafts[questionDraftKey(sessionId, id)];
      return {
        bySession: { ...s.bySession, [sessionId]: queue!.filter((r) => r.id !== id) },
        resolvedSummaries: {
          ...s.resolvedSummaries,
          [sessionId]: [...lines, { id, anchorEntryId: req.anchorEntryId, outcome, snippet }],
        },
        drafts,
      };
    }),

  setDraft: (sessionId, requestId, patch) =>
    set((s) => {
      // 请求已不在队列（resolved/忽略后迟到的镜像写）不复活草稿
      const queue = s.bySession[sessionId];
      if (!queue?.some((r) => r.id === requestId)) return s;
      const key = questionDraftKey(sessionId, requestId);
      const cur = s.drafts[key];
      return {
        drafts: {
          ...s.drafts,
          [key]: {
            selections: patch.selections ?? cur?.selections ?? {},
            texts: patch.texts ?? cur?.texts ?? {},
            comment: patch.comment ?? cur?.comment ?? "",
            activeTab: patch.activeTab ?? cur?.activeTab ?? 0,
            submitted: patch.submitted ?? cur?.submitted ?? false,
          },
        },
      };
    }),

  clearSession: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession) && !(sessionId in s.resolvedSummaries)) return s;
      const bySession = { ...s.bySession };
      delete bySession[sessionId];
      const resolvedSummaries = { ...s.resolvedSummaries };
      delete resolvedSummaries[sessionId];
      const drafts = { ...s.drafts };
      const prefix = `${sessionId}\u0000`;
      for (const key of Object.keys(drafts)) {
        if (key.startsWith(prefix)) delete drafts[key];
      }
      return { bySession, resolvedSummaries, drafts };
    }),
}));
