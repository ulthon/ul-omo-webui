// 状态条纯助手（todo 24）：usage 形态容错解析、事件增量累加、显示格式化。
// 形态依据（verification/05 P1-4）：
//   会话级 get_session_stats：tokens{input,output,cacheRead,cacheWrite,total}、cost(数字)、
//   contextUsage{tokens,contextWindow,percent}
//   消息级 message.usage（message_end 落盘条目）：tokens 同名分项 + totalTokens、
//   cost 为对象 {input,output,cacheRead,cacheWrite,total}
// A5 追加：GET /api/usage 的 usage.turnSpeed = {turns:[{tokPerSec,endedAt}], averageTokPerSec}
//（服务端内存速度环快照，无回合时 turns 为空数组）

import type { TurnSpeedSample } from "@/lib/api";

export interface UsageStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  context: { tokens: number; contextWindow: number; percent: number } | null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** REST GET /api/usage 的 usage 形态 → 状态条统计（cost 为数字，容错缺字段） */
export function toUsageStats(usage: unknown): UsageStats {
  const u = (usage ?? {}) as Record<string, unknown>;
  const tokens = (u.tokens ?? {}) as Record<string, unknown>;
  const contextUsage = u.contextUsage as Record<string, unknown> | undefined;
  return {
    tokens: {
      input: num(tokens.input),
      output: num(tokens.output),
      cacheRead: num(tokens.cacheRead),
      cacheWrite: num(tokens.cacheWrite),
      total: num(tokens.total),
    },
    cost: num(u.cost),
    context:
      contextUsage && typeof contextUsage === "object" && num(contextUsage.contextWindow) > 0
        ? {
            tokens: num(contextUsage.tokens),
            contextWindow: num(contextUsage.contextWindow),
            percent: num(contextUsage.percent),
          }
        : null,
  };
}

/** A5 回合速度解析结果（averageTokPerSec 服务端缺省/异常时回退本地均值，无样本为 null） */
export interface TurnSpeedStats {
  turns: TurnSpeedSample[];
  averageTokPerSec: number | null;
}

/** REST usage.turnSpeed → 容错样本列表（非有限或 ≤0 的 tok/s、非字符串 endedAt 的样本丢弃） */
export function parseTurnSpeed(usage: unknown): TurnSpeedStats {
  const ts = ((usage ?? {}) as Record<string, unknown>).turnSpeed as Record<string, unknown> | undefined;
  const rawTurns = Array.isArray(ts?.turns) ? ts.turns : [];
  const turns: TurnSpeedSample[] = [];
  for (const item of rawTurns) {
    const t = (item ?? {}) as Record<string, unknown>;
    const tokPerSec = Number(t.tokPerSec);
    if (!Number.isFinite(tokPerSec) || tokPerSec <= 0) continue;
    if (typeof t.endedAt !== "string" || !t.endedAt) continue;
    turns.push({ tokPerSec, endedAt: t.endedAt });
  }
  const avg = Number(ts?.averageTokPerSec);
  const averageTokPerSec =
    Number.isFinite(avg) && avg > 0
      ? avg
      : turns.length > 0
        ? turns.reduce((sum, t) => sum + t.tokPerSec, 0) / turns.length
        : null;
  return { turns, averageTokPerSec };
}

/** 消息级 usage（message_end 条目的 message.usage）累加进统计；无 usage 返回 null */
export function addMessageUsage(base: UsageStats, message: unknown): UsageStats | null {
  const msg = (message ?? {}) as Record<string, unknown>;
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  const cost = (usage.cost ?? {}) as Record<string, unknown>;
  const total = num(usage.totalTokens);
  const sumParts = num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
  return {
    tokens: {
      input: base.tokens.input + num(usage.input),
      output: base.tokens.output + num(usage.output),
      cacheRead: base.tokens.cacheRead + num(usage.cacheRead),
      cacheWrite: base.tokens.cacheWrite + num(usage.cacheWrite),
      total: base.tokens.total + (total > 0 ? total : sumParts),
    },
    cost: base.cost + num(cost.total),
    // 上下文占用不可增量推算（非可加量），保持快照值，回合落定后由快照刷新收敛
    context: base.context,
  };
}

/** 1234 → "1.2k"；1234567 → "1.23M"；<1000 原样 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 费用固定 4 位小数（glm-5.3-flash 单轮在 $0.001 量级，2 位会恒显 $0.00） */
export function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
}
