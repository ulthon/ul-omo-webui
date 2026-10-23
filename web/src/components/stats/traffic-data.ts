// 「流量统计」分区纯函数（docs08-2026-10-22 批次任务 28）：
// 字节人性化格式化（大数值不炸行）与端点行派生。导出供单测（web/tests/traffic-section.test.tsx）。

/** 字节人性化：B/KB/MB/GB/TB，1024 进制，一位小数（<10 时两位）；
 * 非有限/负数回退 "0 B"。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export interface EndpointRow {
  endpoint: string;
  requests: number;
  uplink: string;
  downlink: string;
  sse: string;
}

/** 端点快照 → 表格行（SSE 单列：连接数/事件数/事件字节 + 连接时长） */
export function toEndpointRows(
  endpoints: Array<{
    endpoint: string;
    requests: number;
    reqBytes: number;
    resBytes: number;
    sseConnections: number;
    sseEvents: number;
    sseBytes: number;
  }>,
): EndpointRow[] {
  return endpoints.map((e) => ({
    endpoint: e.endpoint,
    requests: e.requests,
    uplink: formatBytes(e.reqBytes),
    downlink: formatBytes(e.resBytes),
    sse: formatSseCell(e),
  }));
}

function formatSseCell(e: {
  sseConnections: number;
  sseEvents: number;
  sseBytes: number;
}): string {
  if (e.sseConnections === 0) return "—";
  return `${e.sseConnections} / ${e.sseEvents} / ${formatBytes(e.sseBytes)}`;
}
