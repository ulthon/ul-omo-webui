// 设置页「导入旧目录会话」区块（r10 todo 18 / GAP-15）：仓库目录移动后旧会话找回。
// 流程：输入旧仓库根目录（移动后原路径，可不存在的路径）→ 服务端扫描其编码会话库
// （<agentDir>/sessions/--编码目录--/）→ 预览清单勾选 → 导入重绑（引擎 --rebind 同
// 语义：header cwd 重写 + 文件移动 + sidecars 迁移）→ 刷新会话列表。
// 会话入库后即可在当前项目列表打开续聊（发现口径即目录扫描，无需额外登记）。
import { useState } from "react";
import { FolderInput } from "lucide-react";
import { api, ApiError, type RebindScanRow } from "@/lib/api";
import { apiErrorMessage } from "@/i18n/errors";
import { useT, type MessageKey } from "@/i18n/i18n";
import { useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** 扫描预览态 */
interface ScanState {
  oldPath: string;
  sessions: RebindScanRow[];
  totalFiles: number;
}

/** 导入报告态（imported 含 already_bound 幂等行；skipped 逐条带原因） */
interface ReportState {
  importedCount: number;
  skipped: Array<{ id: string; reason: string; message: string }>;
}

function skipReasonKey(reason: string): MessageKey {
  if (reason === "rebind_conflict") return "login.rebind.skipConflict";
  if (reason === "corrupt_header") return "login.rebind.skipCorrupt";
  return "login.rebind.skipNotFound";
}

export function RebindSection() {
  const t = useT();
  const currentProject = useUiStore((s) => s.currentProject);
  const [oldPath, setOldPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanState | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<ReportState | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 错误统一出口：401 静默（全局跳转接管）；其余经 apiErrorMessage 出本地化文案 */
  const showError = (err: unknown, fallbackKey: MessageKey) => {
    if (err instanceof ApiError && err.status === 401) return;
    setError(apiErrorMessage(err, fallbackKey));
  };

  const runScan = async () => {
    if (!currentProject || scanning || !oldPath.trim()) return;
    setScanning(true);
    setError(null);
    setReport(null);
    try {
      const res = await api.scanRebindSessions(currentProject, oldPath.trim());
      setScan({ oldPath: res.oldPath, sessions: res.sessions, totalFiles: res.totalFiles });
      // 默认勾选全部可导入行（alreadyBound 的重复导入无意义，默认不选）
      setChecked(new Set(res.sessions.filter((s) => !s.alreadyBound).map((s) => s.id)));
    } catch (err) {
      showError(err, "login.rebind.scanFailed");
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!currentProject || !scan || importing || checked.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await api.rebindSessions(
        currentProject,
        scan.oldPath,
        scan.sessions.filter((s) => checked.has(s.id)).map((s) => s.id),
      );
      setReport({ importedCount: res.imported.length, skipped: res.skipped });
      // 已导入会话即入当前项目列表：刷新权威口径
      await useSessionsStore.getState().refreshSessions();
      useUiStore.getState().showToast(t("login.rebind.importDone", { n: res.imported.length }), "info");
    } catch (err) {
      showError(err, "login.rebind.importFailed");
    } finally {
      setImporting(false);
    }
  };

  const toggle = (id: string, disabled: boolean) => {
    if (disabled) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const importableCount = scan ? scan.sessions.filter((s) => !s.alreadyBound).length : 0;

  return (
    <div className="border-t pt-1">
      <div className="space-y-1.5">
        <label htmlFor="rebind-old-path" className="flex items-center gap-1.5 text-sm font-medium">
          <FolderInput className="size-4" />
          {t("login.rebind.title")}
          {currentProject && (
            <span className="ml-1 font-normal text-muted-foreground" title={currentProject}>
              → {currentProject.split("/").filter(Boolean).pop()}
            </span>
          )}
        </label>
        <p className="text-xs text-muted-foreground">{t("login.rebind.description")}</p>
        {!currentProject ? (
          <p className="text-xs text-muted-foreground" data-testid="rebind-need-project">
            {t("login.rebind.needProject")}
          </p>
        ) : (
          <>
            <div className="flex gap-1.5">
              <Input
                id="rebind-old-path"
                data-testid="rebind-old-path-input"
                placeholder={t("login.rebind.pathPlaceholder")}
                value={oldPath}
                disabled={scanning || importing}
                onChange={(e) => setOldPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runScan();
                }}
                className="h-9"
              />
              <Button
                type="button"
                variant="outline"
                className="min-h-9 shrink-0 px-3"
                data-testid="rebind-scan-button"
                disabled={scanning || importing || !oldPath.trim()}
                onClick={() => void runScan()}
              >
                {scanning ? t("login.rebind.scanning") : t("login.rebind.scan")}
              </Button>
            </div>
            {error && (
              <p className="text-xs text-destructive" data-testid="rebind-error" role="alert">
                {error}
              </p>
            )}
            {scan && (
              <div className="space-y-1.5" data-testid="rebind-scan-result">
                {scan.sessions.length === 0 ? (
                  <p className="text-xs text-muted-foreground" data-testid="rebind-empty">
                    {t("login.rebind.emptyResult")}
                  </p>
                ) : (
                  <>
                    <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-1.5">
                      {scan.sessions.map((s) => {
                        const disabled = s.alreadyBound;
                        return (
                          <li key={s.id} className="flex items-start gap-2 rounded px-1 py-1">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              data-testid={`rebind-check-${s.id}`}
                              checked={checked.has(s.id)}
                              disabled={disabled}
                              onChange={() => toggle(s.id, disabled)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{s.firstMessage || s.name || s.id}</span>
                              <span className="block text-xs text-muted-foreground">
                                {t("login.rebind.rowMeta", { n: s.messageCount, date: s.modified.slice(0, 10) })}
                              </span>
                            </span>
                            {disabled && (
                              <span className="shrink-0 text-xs text-muted-foreground" data-testid={`rebound-bound-${s.id}`}>
                                {t("login.rebind.alreadyBound")}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {scan.totalFiles > scan.sessions.length && (
                      <p className="text-xs text-muted-foreground" data-testid="rebind-corrupt-hint">
                        {t("login.rebind.corruptHint", { skipped: scan.totalFiles - scan.sessions.length })}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        className="min-h-9 px-3"
                        data-testid="rebind-import-button"
                        disabled={importing || checked.size === 0}
                        onClick={() => void runImport()}
                      >
                        {importing
                          ? t("login.rebind.importing")
                          : t("login.rebind.import", { n: checked.size, total: importableCount })}
                      </Button>
                      {importableCount === 0 && scan.sessions.length > 0 && (
                        <span className="text-xs text-muted-foreground">{t("login.rebind.allBound")}</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            {report && (
              <div className="space-y-1 rounded-md border p-2 text-xs" data-testid="rebind-report">
                <p>
                  {t("login.rebind.reportImported", { n: report.importedCount })}
                  {report.skipped.length > 0 && ` · ${t("login.rebind.reportSkipped", { n: report.skipped.length })}`}
                </p>
                {report.skipped.map((s) => (
                  <p key={s.id} className="text-muted-foreground">
                    {s.id}：{t(skipReasonKey(s.reason))}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
