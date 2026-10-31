// 日志级别定义与解析（2026-10-31 日志采集增强批）。
// 五级 trace < debug < info < warn < error；env UL_OMO_WEBUI_LOG_LEVEL 缺省 info。
// 独立小模块零依赖：logger 单例与单测共用，不引 config 防环。

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 级别数值序（供比较；调用方自行保证入参合法） */
export function levelValue(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/** 解析 env 值为合法级别；缺失/非法返回 null（调用方回落默认 info） */
export function parseLevel(raw: string | undefined): LogLevel | null {
  const v = (raw ?? "").trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : null;
}
