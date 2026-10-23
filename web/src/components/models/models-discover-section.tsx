// 设置面板「发现模型」分区（docs08-2026-10-22 批次任务 23）：
// provider 选择 + 执行发现（预览不落盘）+ 结果确认/全选导入。
// 服务端契约：POST /api/models/discover 缺省仅预览；import 非空才合并写回 models.json。
// 导出供单测（web/tests/models-discover.test.tsx）。
import { useCallback, useEffect, useState } from "react";
import { api, type DiscoverProvider, type DiscoverReport } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { Button } from "@/components/ui/button";
import { isAllSelected, providerOptionLabel, summarizeImport, toggleSelected } from "./models-discover-data";

export function ModelsDiscoverSection() {
  const t = useT();
  const [providers, setProviders] = useState<DiscoverProvider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<DiscoverReport | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<{ kind: "done" | "nothing"; count: number } | null>(null);

  const applyProviders = useCallback((list: DiscoverProvider[]) => {
    setProviders(list);
    setProviderId((prev) => (prev !== "" && list.some((p) => p.id === prev) ? prev : (list[0]?.id ?? "")));
  }, []);

  const loadProviders = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      try {
        applyProviders((await api.listDiscoverProviders()).providers);
        setError(null);
      } catch (err) {
        setError(apiErrorMessage(err, "models.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [applyProviders],
  );

  // 首载：异步拉取后才 setState（react-hooks set-state-in-effect 纪律）；loading 初始即 true
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = (await api.listDiscoverProviders()).providers;
        if (!cancelled) applyProviders(list);
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err, "models.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyProviders]);

  const runDiscover = useCallback(async () => {
    if (providerId === "") return;
    setDiscovering(true);
    setError(null);
    setResult(null);
    try {
      const next = await api.discoverModels(providerId);
      setReport(next);
      setSelected(next.added);
    } catch (err) {
      setError(apiErrorMessage(err, "models.loadFailed"));
      setReport(null);
      setSelected([]);
    } finally {
      setDiscovering(false);
    }
  }, [providerId]);

  const runImport = useCallback(async () => {
    if (providerId === "" || selected.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const next = await api.importDiscoveredModels(providerId, selected);
      setReport(next);
      setResult(summarizeImport(next));
      setSelected([]);
      void loadProviders(false);
    } catch (err) {
      setError(apiErrorMessage(err, "models.loadFailed"));
    } finally {
      setImporting(false);
    }
  }, [providerId, selected, loadProviders]);

  return (
    <section data-testid="models-discover-section" className="space-y-2">
      <h3 className="text-sm font-medium">{t("models.discoverHeading")}</h3>
      <p className="text-xs text-muted-foreground">{t("models.discoverNote")}</p>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <label htmlFor="models-discover-provider" className="sr-only">
          {t("models.providerLabel")}
        </label>
        <select
          id="models-discover-provider"
          data-testid="models-discover-provider"
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            setReport(null);
            setResult(null);
          }}
          disabled={loading || providers.length === 0}
          className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 lg:w-auto lg:min-w-56"
        >
          {providers.length === 0 ? <option value="">{t("models.providerEmpty")}</option> : null}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === "" ? t("models.noBaseUrl") : `${p.id}（${providerOptionLabel(p)}）`}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          data-testid="models-discover-run"
          disabled={loading || discovering || providerId === ""}
          onClick={() => void runDiscover()}
          className="min-h-9 shrink-0 px-3 text-xs lg:min-h-7"
        >
          {discovering ? t("models.running") : t("models.run")}
        </Button>
      </div>

      {error !== null && (
        <p data-testid="models-discover-error" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {result !== null && (
        <p data-testid="models-discover-result" className="text-xs text-emerald-600 dark:text-emerald-400">
          {result.kind === "done" ? t("models.importDone", { n: result.count }) : t("models.nothingNew")}
        </p>
      )}

      {report !== null && (
        <div data-testid="models-discover-results" className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            {t("models.discovered", { n: report.discovered.length })}
            {report.unchanged.length > 0 ? ` · ${t("models.unchangedNote", { n: report.unchanged.length })}` : ""}
          </p>
          {report.added.length > 0 ? (
            <>
              <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
                {report.added.map((id) => (
                  <label key={id} data-testid={`models-discover-item-${id}`} className="flex min-h-7 cursor-pointer items-center gap-2 rounded px-1 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(id)}
                      onChange={() => setSelected((prev) => toggleSelected(prev, id))}
                      className="size-3.5 accent-current"
                    />
                    <span className="truncate">{id}</span>
                  </label>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                data-testid="models-discover-import"
                disabled={importing || selected.length === 0}
                onClick={() => void runImport()}
                className="min-h-9 shrink-0 px-3 text-xs lg:min-h-7"
              >
                {importing
                  ? t("models.importing")
                  : isAllSelected(report.added, selected)
                    ? t("models.importSelected")
                    : t("models.importSelected")}
              </Button>
            </>
          ) : (
            <p data-testid="models-discover-nothing-new" className="text-xs text-muted-foreground">
              {t("models.nothingNew")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
