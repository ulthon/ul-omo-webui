// 上下文水位分母校准（docs08-r6 任务 8 ⑥）。独立叶模块——context-ring 组件文件保持
// 仅导出组件（fast-refresh lint 口径），单测直接驱动本模块。
/** 水位环分母校准（docs08-r6 任务 8 ⑥）：引擎实测值优先——GET /api/models 所选模型的
 * contextWindow 与引擎上报分母一致（setModel 后引擎已随模型更新）或模型侧无配置时，
 * 按引擎 percent；不一致（引擎未随 setModel 更新 contextUsage.contextWindow，隔离实例
 * 实测见 .omo/evidence/docs08-r6/task-8-qa.md）时以模型侧窗口为分母用 tokens 重算。
 * 兜底分支不假装引擎值存在：tokens/模型窗口直接重算，而非沿用错误 percent。 */
export function calibrateContextPercent(
  context: { tokens: number; contextWindow: number; percent: number },
  modelContextWindow: number | null | undefined,
): number {
  const clamp = (p: number): number => Math.min(100, Math.max(0, p));
  if (typeof modelContextWindow !== "number" || !(modelContextWindow > 0)) return clamp(context.percent);
  if (modelContextWindow === context.contextWindow) return clamp(context.percent);
  return clamp((context.tokens / modelContextWindow) * 100);
}
