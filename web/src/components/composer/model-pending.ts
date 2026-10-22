// 模型待生效徽标纯逻辑（docs08 2026-10-22 批次任务 27）：判定与基线对齐两个纯函数，
// 供 composer 挂载 effect 与单测共用。独立模块：composer.tsx 是组件文件，非组件导出
// 会触发 react(only-export-components) fast-refresh 警告（同 snippet-logic 先例）。

/** 待生效徽标判定（任务 27b）：回合进行中（queueAvailable：流式/排队期直发被禁，
 *  排队剥模型铁律在 api.ts 注入点不变）且会话生效模型已知时，选中与之不同才挂标。
 *  applied 未知（null：无水合/无回执）一律不挂——保守显示即误报（docs/08 第 17 条
 *  机制 a）。键空间已核实同源（任务 27d）：引擎 model_changed 帧与 jsonl model_change
 *  条目同一 model 对象（变体名形态，node_modules/@code-yeongyu/senpi session-worker
 *  实证），与选中 "provider/变体id"、回执 appliedModel 直接字符串比对，无需归一。 */
export function pendingModelBadgeVisible(
  queueAvailable: boolean,
  selectedModel: string | null,
  appliedModel: string | null,
): boolean {
  return queueAvailable && selectedModel !== null && appliedModel !== null && selectedModel !== appliedModel;
}

/** 会话级基线对齐（任务 27c）：切会话/水合落库时选中对齐该会话生效模型——全局选中
 *  仅作输入初值与新会话回退，不再跨会话携带残留选择（机制 b：切到生效模型不同的
 *  会话，未操作即挂标）。已对齐或 applied 未知返回 null（调用方 no-op）。 */
export function alignSelectionToApplied(
  appliedModel: string | null,
  selectedModel: string | null,
): string | null {
  if (appliedModel === null || appliedModel === selectedModel) return null;
  return appliedModel;
}
