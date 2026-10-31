// 诊断区（2026-10-31 日志采集增强批）：级别切换 + 前端/服务端日志查看 + 一键导出诊断包。
// - 级别：setDiagLevel 即时生效（localStorage 持久，无需重启——直击「默认关需重启才开」痛点）；
// - 查看：前端 = diag.entries() 尾部 200 条；服务端 = GET /api/diagnostics/logs?limit=200；
// - 导出：buildDiagBundle 组装 {meta, frontend 全量, server 尾部 2000 条, serverSummary}
//   → Blob 下载 ul-omo-webui-diag-<时间戳>.json；后端不可达仍导出前端段（serverError 记明）。
// 隐私：诊断包含运行环境与日志元数据（不含消息正文/凭证——埋点层已按此设计）。
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  buildDiagBundle,
  diag,
  diagLevel,
  setDiagLevel,
  DIAG_LEVELS,
  type DiagLevel,
} from "@/lib/diag";
import { useT } from "@/i18n/i18n";
import { Button } from "@/components/ui/button";

interface DisplayRow {
  t: string;
  lvl: string;
  text: string;
}

function feRows(): DisplayRow[] {
  return diag
    .entries()
    .slice(-200)
    .map((e) => ({
      t: e.t.slice(11, 23),
      lvl: e.lvl,
      text:
        `[${e.mod}] ${e.ev}` +
        (e.f ? " " + Object.entries(e.f).map(([k, v]) => `${k}=${String(v)}`).join(" ") : ""),
    }));
}

async function serverRows(): Promise<{ rows: DisplayRow[]; error?: string }> {
  try {
    const r = await api.diagnosticsLogs({ limit: 200 });
    const entries = r.entries as Array<{ t?: string; lvl?: string; line?: string }>;
    return {
      rows: entries.map((e) => ({
        t: (e.t ?? "").slice(11, 23),
        lvl: e.lvl ?? "?",
        text: e.line ?? "",
      })),
    };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function levelBadgeClass(lvl: string): string {
  switch (lvl) {
    case "error":
      return "text-red-500";
    case "warn":
      return "text-amber-500";
    case "info":
      return "text-emerald-600";
    default:
      return "text-muted-foreground";
  }
}

/** 诊断开关生效值（null = 载入中/不可达） */
type DiagFlags = { perf: boolean; sse: boolean };

export function DiagnosticsSection() {
  const t = useT();
  const [level, setLevelState] = useState<DiagLevel>(diagLevel());
  const [source, setSource] = useState<"frontend" | "server">("frontend");
  const [rows, setRows] = useState<DisplayRow[] | null>(null);
  const [auto, setAuto] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [flags, setFlags] = useState<DiagFlags | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 开关载入与写入（2026-10-31 面板化）：写入即生效免重启；返回生效值回显（env 项不可关）
  const flipFlag = async (key: "perf" | "sse", on: boolean): Promise<void> => {
    try {
      setFlags(await api.setDiagnosticsFlags({ [key]: on }));
    } catch {
      setNotice(t("diagnostics.flagToggleFailed"));
    }
  };

  useEffect(() => {
    api
      .diagnosticsFlags()
      .then((f) => setFlags(f))
      .catch(() => setFlags(null));
  }, []);

  const refresh = async (): Promise<void> => {
    if (source === "frontend") {
      setRows(feRows());
      return;
    }
    const r = await serverRows();
    setRows(r.rows);
    setNotice(r.error !== undefined ? t("diagnostics.serverUnavailable") : null);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (auto) timerRef.current = setInterval(() => void refresh(), 2000);
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, source]);

  const changeLevel = (next: string): void => {
    const parsed = DIAG_LEVELS.find((l) => l === next);
    if (!parsed) return;
    setDiagLevel(parsed);
    setLevelState(parsed);
    diag.info("ui", "diag.level", { level: parsed });
    void refresh();
  };

  const doExport = async (): Promise<void> => {
    setExporting(true);
    try {
      let server: unknown = null;
      let summary: unknown = null;
      let serverError: string | undefined;
      try {
        [server, summary] = await Promise.all([
          api.diagnosticsLogs({ limit: 2000 }),
          api.diagnosticsSummary(),
        ]);
      } catch (err) {
        serverError = err instanceof Error ? err.message : String(err);
      }
      const bundle = buildDiagBundle(diag.entries(), server, summary, serverError);
      const blob = new Blob([JSON.stringify(bundle, null, 1)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const now = new Date();
      const pad = (n: number): string => String(n).padStart(2, "0");
      a.href = url;
      a.download = `ul-omo-webui-diag-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(t("diagnostics.exportDone"));
    } catch (err) {
      setNotice(`${t("diagnostics.exportFailed")}${err instanceof Error ? `: ${err.message}` : ""}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <section aria-label={t("diagnostics.title")} className="rounded-lg border p-3">
      <h3 className="text-sm font-semibold">{t("diagnostics.title")}</h3>
      <p className="pt-1 text-xs text-muted-foreground">{t("diagnostics.desc")}</p>

      {/* 诊断开关（2026-10-31 面板化）：写入即生效免重启；env 为真项不可关（服务端返回生效值回显） */}
      <div className="flex flex-wrap items-center gap-4 pt-3" data-testid="diag-flags">
        <label className="flex items-center gap-1.5 text-xs" data-testid="diag-flag-perf-label">
          <input
            type="checkbox"
            data-testid="diag-flag-perf"
            checked={flags?.perf ?? false}
            onChange={(e) => void flipFlag("perf", e.target.checked)}
            className="size-3.5"
          />
          {t("diagnostics.flagPerf")}
        </label>
        <label className="flex items-center gap-1.5 text-xs" data-testid="diag-flag-sse-label">
          <input
            type="checkbox"
            data-testid="diag-flag-sse"
            checked={flags?.sse ?? false}
            onChange={(e) => void flipFlag("sse", e.target.checked)}
            className="size-3.5"
          />
          {t("diagnostics.flagSse")}
        </label>
        {flags === null && <span className="text-xs text-muted-foreground">…</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-3">
        <label className="text-xs text-muted-foreground" htmlFor="diag-level">
          {t("diagnostics.level")}
        </label>
        <select
          id="diag-level"
          data-testid="diag-level-select"
          className="h-8 rounded border bg-background px-2 text-xs"
          value={level}
          onChange={(e) => changeLevel(e.target.value)}
        >
          {DIAG_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{t("diagnostics.levelHint")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-3">
        <Button
          type="button"
          variant={source === "frontend" ? "default" : "outline"}
          size="sm"
          data-testid="diag-source-frontend"
          onClick={() => setSource("frontend")}
        >
          {t("diagnostics.sourceFrontend")}
        </Button>
        <Button
          type="button"
          variant={source === "server" ? "default" : "outline"}
          size="sm"
          data-testid="diag-source-server"
          onClick={() => setSource("server")}
        >
          {t("diagnostics.sourceServer")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
          {t("diagnostics.refresh")}
        </Button>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          {t("diagnostics.autoRefresh")}
        </label>
        <Button
          type="button"
          size="sm"
          data-testid="diag-export"
          disabled={exporting}
          onClick={() => void doExport()}
        >
          {exporting ? t("diagnostics.exporting") : t("diagnostics.export")}
        </Button>
      </div>

      {notice !== null && <p className="pt-2 text-xs text-muted-foreground">{notice}</p>}

      <div
        data-testid="diag-log-list"
        className="mt-3 max-h-64 overflow-y-auto rounded border bg-muted/30 p-2 font-mono text-[11px] leading-5"
      >
        {rows === null || rows.length === 0 ? (
          <p className="text-muted-foreground">{t("diagnostics.empty")}</p>
        ) : (
          rows.map((r, i) => (
            <div key={i} className="whitespace-nowrap">
              <span className="text-muted-foreground">{r.t} </span>
              <span className={levelBadgeClass(r.lvl)}>{r.lvl.toUpperCase().padEnd(5, " ")}</span>
              <span> {r.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
