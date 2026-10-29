// 僵尸复位对账（docs08-r6 任务 6 ②）：未决提问 + 排队快照的对账拉取（会话打开与
// 僵尸复位前共用同款代码）与复位决策。独立叶模块——chat-view 组件文件保持仅导出
// 组件（fast-refresh lint 口径），单测直接驱动本模块。
import { api, type QuestionWireFrame, type WireEntry } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { useQuestionsStore } from "@/stores/questions";
import { useQueueStore } from "@/stores/queue";

/** entry.timestamp → ms epoch（ISO 字串/毫秒数字均收；缺失/不可解析 → null 不比时间） */
function entryTimestampMs(e: WireEntry): number | null {
  const raw = (e as { timestamp?: unknown }).timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw !== "") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** 对账重挂锚点（r11 todo 6b）：①既有锚点仍在场（条目未被压缩/截断出窗）→ 保锚不漂移；
 *  ②按 askedAtMs 重定位——提问时刻（含）之前最后一条携 id 条目 = 提问发生位置；
 *  ③无可比时间戳或全部晚于提问时刻（流外提问/时钟不可比）→ 挂消息流末条；空流 null。
 *  漏写则刷新后所有 pending 卡静默走「挂消息流末尾」兜底，IS-4 降级。 */
function reanchorQuestion(sessionId: string, requestId: string, askedAtMs: number): string | null {
  const entries = useMessagesStore.getState().bySession[sessionId]?.entries ?? [];
  const existing = useQuestionsStore.getState().bySession[sessionId]?.find((r) => r.id === requestId);
  if (existing?.anchorEntryId != null && entries.some((e) => e.id === existing.anchorEntryId)) {
    return existing.anchorEntryId;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const ts = entryTimestampMs(e);
    if (ts === null || ts > askedAtMs) continue;
    if (typeof e.id === "string" && e.id !== "") return e.id;
  }
  // 无可比时间戳或全部晚于提问时刻：不猜位置，挂消息流末条；空流 null
  for (let i = entries.length - 1; i >= 0; i--) {
    const id = entries[i]!.id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

/** 未决提问 + 排队快照对账（q1 / docs08-r4 任务 11 同款；docs08-r6 任务 6 ②提为共用）：
 *  GET questions/queue 并落 store（问题帧入队、排队快照整替），任一失败不抛——对应
 *  结果返回 null（无证据，调用方按宁缺勿错处理）；cancelled 即弃置不写 store。 */
export async function reconcilePendingState(
  sessionId: string,
  isCancelled: () => boolean,
): Promise<{ questions: QuestionWireFrame[] | null; queue: { steering: string[]; followUp: string[] } | null }> {
  const [questionsRes, queueRes] = await Promise.allSettled([api.getQuestions(sessionId), api.getQueue(sessionId)]);
  if (isCancelled()) return { questions: null, queue: null };
  const questions = questionsRes.status === "fulfilled" ? questionsRes.value.questions : null;
  if (questions) {
    // 对账双向对齐（docs08-r6 任务 19d F-A）：快照为本端真相——不在快照内的滞留条目
    // 随对账复位（重放窗口截断 question_resolved / 中断后 resolved 帧丢失时，问题卡与
    // hasPendingQuestion 中断口判据随刷新/重开永久滞留的面）；快照内照常入队
    // （pushRequest 同 id 幂等）。拉取失败（null）不动本端，宁缺勿错口径不变。
    const snapshotIds = new Set(questions.map((frame) => frame.id));
    for (const stale of useQuestionsStore.getState().bySession[sessionId] ?? []) {
      if (!snapshotIds.has(stale.id)) useQuestionsStore.getState().removeRequest(sessionId, stale.id);
    }
    for (const frame of questions) {
      // r11 todo 6b：对账重建同样写入 askedAtMs + 重定位锚点（reconcileRequest 同 id
      // 更新锚点而保留草稿，重挂后卡片回到原位）
      const askedAtMs = typeof frame.askedAtMs === "number" ? frame.askedAtMs : Date.now();
      useQuestionsStore.getState().reconcileRequest(sessionId, {
        id: frame.id,
        waitForAnswer: frame.waitForAnswer === true,
        questions: frame.questions,
        deadlineAtMs: frame.deadlineAtMs,
        timeout: frame.timeout,
        askedAtMs,
        anchorEntryId: reanchorQuestion(sessionId, frame.id, askedAtMs),
      });
    }
  }
  const queueSnapshot = queueRes.status === "fulfilled" ? queueRes.value : null;
  if (queueSnapshot) useQueueStore.getState().setSnapshot(sessionId, queueSnapshot);
  const queue = queueSnapshot ? { steering: queueSnapshot.steering, followUp: queueSnapshot.followUp } : null;
  return { questions, queue };
}

/** 僵尸复位前对账决策：先拉 questions/queue 对账（同款代码复用），仍有未决（提问未决
 *  或排队非空）则维持锁定与中断口（对账入队的问题卡使 ① 的中断逃逸口可见，用户可
 *  中断脱困）；无未决或对账失败（无证据）则复位解锁——宁缺勿错：误解锁的代价只是
 *  下次发送撞 409 得提示，不得因对账不可用把输入永久锁死。返回是否执行了复位。 */
export async function zombieReconcileAndReset(sessionId: string, isCancelled: () => boolean): Promise<boolean> {
  const { questions, queue } = await reconcilePendingState(sessionId, isCancelled);
  if (isCancelled()) return false;
  const stillPending = (questions?.length ?? 0) > 0 || (queue?.steering.length ?? 0) + (queue?.followUp.length ?? 0) > 0;
  if (stillPending) return false;
  useMessagesStore.getState().setStreaming(sessionId, false);
  return true;
}
