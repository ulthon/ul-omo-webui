// 排队条单项操作（docs08-r7 任务 15）：立即发送 / 单条撤销共用"重排"协议——
// 引擎只有整队 clearQueue 协议面，单项操作 = 整队清空 → 目标条（立即发送时转
// steer 注入）与保留项按原序重新入队 → 快照对账。清空→重入队窗口期用户新排队
// 条目（GET queue 快照可见）先合并按序、绝不丢失（agent_settled 竞态同守卫）。
import { ApiError, api, type QueueItem } from "@/lib/api";
import { useQueueStore } from "@/stores/queue";

/** 重入队单条（排队请求只带 streamingBehavior，spike 铁律；api.prompt 自动剥模型/
 *  思考档）。回合落定瞬间竞态（服务端单驱动守卫尚未清位）409 重试一次，语义同
 *  composer 直发路径：排队是 already processing 的正确动作。 */
async function requeuePrompt(sessionId: string, item: QueueItem): Promise<void> {
  try {
    await api.prompt(sessionId, { text: item.text, streamingBehavior: item.mode });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 409)) throw err;
    await api.prompt(sessionId, { text: item.text, streamingBehavior: item.mode });
  }
}

/** 窗口期新增条目合并：快照项与重入队清单按 text+mode 去重（引擎不去重同文条目，
 *  但同一入队动作只做一次——快照项若与重入队清单同文同档视为同一条，不重复入队） */
function mergeWindowItems(requeue: QueueItem[], snapshot: { steering: string[]; followUp: string[] }): QueueItem[] {
  const window: QueueItem[] = [
    ...snapshot.steering.map((text) => ({ text, mode: "steer" as const, enqueueOrder: null as number | null, enqueuedAt: Date.now() })),
    ...snapshot.followUp.map((text) => ({ text, mode: "followUp" as const, enqueueOrder: null as number | null, enqueuedAt: Date.now() })),
  ];
  const known = new Set(requeue.map((i) => `${i.mode}\u0000${i.text}`));
  return [...requeue, ...window.filter((i) => !known.has(`${i.mode}\u0000${i.text}`))];
}

/**
 * 单项重排入口：promote 为 true 时目标条转 steer 排首位（立即发送，下一循环边界
 * 即被读取）；false 为单条撤销（保留项按原序）。全程结束后 GET queue 快照对账，
 * 引擎真相（含竞态期出入队）统一收敛进 store。
 */
export async function restructureQueue(
  sessionId: string,
  items: QueueItem[],
  target: QueueItem,
  promote: boolean,
): Promise<void> {
  const retained = items.filter((item) => item !== target);
  const head: QueueItem[] = promote ? [{ ...target, mode: "steer", enqueueOrder: null, enqueuedAt: Date.now() }] : [];
  await api.clearQueue(sessionId);
  // 重入队前先取清空后快照：窗口期用户/事件新排队条目合并在保留项之后，不丢不重
  const windowSnapshot = await api.getQueue(sessionId);
  const ordered = mergeWindowItems([...head, ...retained], windowSnapshot);
  for (const item of ordered) {
    await requeuePrompt(sessionId, item);
  }
  const final = await api.getQueue(sessionId);
  useQueueStore.getState().setSnapshot(sessionId, final);
}
