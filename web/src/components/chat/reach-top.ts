// 任务 16（docs08-2026-10-22-batch）：触顶行为决策纯函数。
// hasMore（尾窗直读/翻页后仍有更早历史）时向上翻页（?before=）；
// 否则保留原游标增量同步（引擎 getEntries since 语义兜底补漏）；两者皆无则不动作。
export interface ReachTopState {
  hasMore: boolean;
  oldestId: string | null;
  cursor: string | null;
}

export type ReachTopAction = { kind: "before"; before: string } | { kind: "cursor"; cursor: string } | null;

export function resolveReachTopAction(state: ReachTopState | undefined): ReachTopAction {
  if (!state) return null;
  if (state.hasMore && state.oldestId) return { kind: "before", before: state.oldestId };
  if (state.cursor) return { kind: "cursor", cursor: state.cursor };
  return null;
}
