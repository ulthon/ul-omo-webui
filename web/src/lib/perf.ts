// 性能观测（docs08-2026-10-22-batch 任务 1 / Fix0）：会话首载耗时 mark/measure。
// 门控 localStorage「ulomo_perf=1」，默认关——关闭时零输出、零额外计时；
// 开启后 DevTools Performance 面板可见 ulomo:messages:* 埋点，控制台同步一行摘要。

export const PERF_FLAG_KEY = "ulomo_perf";

/** localStorage 调试开关（store 参数供单测注入；存储不可用环境一律 false） */
export function webPerfEnabled(store?: { getItem(key: string): string | null }): boolean {
  try {
    return (store ?? globalThis.localStorage).getItem(PERF_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

/** 起点打点（仅开关打开时落 mark） */
export function perfMark(name: string): void {
  if (webPerfEnabled()) performance.mark(name);
}

/** 终点打点+测距（返回毫秒；起点 mark 缺失等 DOM 异常一律吞掉返回 undefined） */
export function perfMeasure(name: string, startMark: string, endMark: string): number | undefined {
  if (!webPerfEnabled()) return undefined;
  try {
    performance.mark(endMark);
    return performance.measure(name, startMark, endMark).duration;
  } catch {
    return undefined;
  }
}
