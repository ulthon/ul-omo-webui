// 提问卡片数据面（q1）：会话内未决 question 型 UI 请求队列。
// wire 契约（server/spike/q1-question.ts 实证 + 引擎 connection-question-bridge.js）：
// - method:"question" 帧：{id, waitForAnswer, questions:[{id,header,question,options,multiSelect}],
//   timeout, deadlineAtMs, remainingMs}——waitForAnswer=true 阻塞回合等答案，false 跨回合存活；
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
}

/** 截止后的本地清队宽限（毫秒）：引擎超时广播 question_resolved 应已到达；
 * 时钟漂移或事件丢失时兜底出队，晚于引擎截止不早杀在途问题。 */
export const QUESTION_EXPIRY_GRACE_MS = 60_000;

interface QuestionsState {
  /** 会话 → 未决提问（到达序） */
  bySession: Record<string, QuestionRequest[]>;

  /** 入队（同 id 去重：SSE 重连/重放/对账拉取可能重投） */
  pushRequest(sessionId: string, request: QuestionRequest): void;
  /** question_updated 截止刷新（无该 id 时忽略） */
  updateDeadline(sessionId: string, id: string, deadlineAtMs: number): void;
  /** 应答成功 / question_resolved / 忽略后出队 */
  removeRequest(sessionId: string, id: string): void;
  /** 会话删除/切换清理（引擎侧重启场景由陈旧过滤兜底，此处仅本地清理） */
  clearSession(sessionId: string): void;
}

export const useQuestionsStore = create<QuestionsState>()((set) => ({
  bySession: {},

  pushRequest: (sessionId, request) =>
    set((s) => {
      const queue = s.bySession[sessionId] ?? [];
      if (queue.some((r) => r.id === request.id)) return s;
      return { bySession: { ...s.bySession, [sessionId]: [...queue, request] } };
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
      return { bySession: { ...s.bySession, [sessionId]: next } };
    }),

  clearSession: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const bySession = { ...s.bySession };
      delete bySession[sessionId];
      return { bySession };
    }),
}));
