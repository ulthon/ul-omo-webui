// 设置面板「流量统计」分区（docs08-2026-10-22 批次任务 28）：
// webui 请求级端点日账表格（浏览器↔webui 层）+ vnstat 系统网卡账快照。
// 服务端契约：GET /api/stats/traffic 只读查询；vnstat 缺失/失败降级 available=false。
// 导出供单测（web/tests/traffic-section.test.tsx）。
import { useCallback, useEffect, useState } from "react";
import { api, type TrafficSnapshot } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { Button } from "@/components/ui/button";
import { formatBytes, toEndpointRows } from "./traffic-data";

export function TrafficSection() {
  const t = useT();
  const [snap, setSnap] = useState<TrafficSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    try {
      const next = await api.getTraffic();
      setSnap(next);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, "stats.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  // 首载：异步拉取后才 setState（react-hooks set-state-in-effect 纪律）；loading 初始即 true
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.getTraffic();
        if (!cancelled) setSnap(next);
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err, "stats.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = snap ? toEndpointRows(snap.endpoints) : [];
  const system = snap?.system ?? null;

  return (
    <section data-testid="traffic-section" className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("stats.trafficHeading")}</h3>
        <Button type="button" variant="outline" size="sm" data-testid="traffic-refresh" disabled={loading} onClick={() => void load(true)}>
          {t("stats.refresh")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("stats.trafficNote")}</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {system && system.available && (
        <div data-testid="traffic-system" className="rounded-lg border border-border px-3 py-2 text-xs">
          <div className="font-medium">{t("stats.systemHeading")}（{system.interface}）</div>
          <div className="mt-1 text-muted-foreground">
            {t("stats.systemToday")}（{system.day.date}）：{t("stats.systemRx")} {formatBytes(system.day.rx)} · {t("stats.systemTx")} {formatBytes(system.day.tx)}
          </div>
          <div className="text-muted-foreground">
            {t("stats.systemMonth")}：{t("stats.systemRx")} {formatBytes(system.month.rx)} · {t("stats.systemTx")} {formatBytes(system.month.tx)}
          </div>
        </div>
      )}
      {system && !system.available && (
        <p data-testid="traffic-system-unavailable" className="text-xs text-muted-foreground">
          {t("stats.systemUnavailable")}（{system.reason}）
        </p>
      )}
      <div data-testid="traffic-endpoints" className="overflow-x-auto">
        <div className="text-xs font-medium text-muted-foreground">{t("stats.endpointHeading")}</div>
        {rows.length === 0 && !loading ? (
          <p className="text-xs text-muted-foreground">{t("stats.empty")}</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">{t("stats.endpointCol")}</th>
                <th className="py-1 pr-2 font-medium">{t("stats.requestsCol")}</th>
                <th className="py-1 pr-2 font-medium">{t("stats.uplinkCol")}</th>
                <th className="py-1 pr-2 font-medium">{t("stats.downlinkCol")}</th>
                <th className="py-1 font-medium">{t("stats.sseCol")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.endpoint} data-testid="traffic-endpoint-row" className="border-t border-border/60">
                  <td className="py-1 pr-2 font-mono">{r.endpoint}</td>
                  <td className="py-1 pr-2">{r.requests}</td>
                  <td className="py-1 pr-2">{r.uplink}</td>
                  <td className="py-1 pr-2">{r.downlink}</td>
                  <td className="py-1">{r.sse}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
