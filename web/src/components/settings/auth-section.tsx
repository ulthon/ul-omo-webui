// 设置页「认证」分区（r10 批次任务 13 + 凭证列表/删除/逐测/baseUrl 批次）：
// 凭证列表区（每行 provider 名 + type + key 掩码 + 状态灯 + 单独「测试」+「删除」行内二次确认）
// + 粘贴表单（provider 下拉 + 可选 Base URL + key 粘贴 + 测试）。
// 端点：GET /api/auth/providers（列表，key 只含掩码）、POST /api/auth/check（逐个检查）、
// DELETE /api/auth/providers/:id（删除）、POST /api/auth/credentials（写入+检查，可选 baseUrl
// 同步 models.json）。安全纪律：key 输入框 type=password 不回显；key 不落 localStorage、
// 不入前端日志；列表数据是服务端掩码（绝不出现完整 key）；失败原因（服务端 detail，不含
// 凭证材料）外显。导出供单测。
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AuthProvidersResponse, AuthStatusResponse } from "@/lib/api";
import type { MessageKey } from "@/i18n/i18n";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** provider 候选（含自定义输入档）：zai-coding-cn 为 title-gen 同源默认端点属主 */
const PROVIDER_OPTIONS = ["zai-coding-cn", "openai", "anthropic", "deepseek", "kimi"] as const;
const CUSTOM = "__custom__";

const STATUS_KEY: Record<AuthStatusResponse["status"], MessageKey> = {
  ready: "extensions.authReady",
  not_configured: "extensions.authNotConfigured",
  error: "extensions.authError",
};

/** 行状态灯：untested 灰 / ready 绿 / error 红（逐 provider 检查后更新） */
type RowState = { kind: "untested" } | { kind: "checking" } | { kind: "ready" } | { kind: "error"; detail: string | null };

export function AuthSection() {
  const t = useT();
  const showToast = useUiStore((s) => s.showToast);
  const pushGlobalError = useUiStore((s) => s.pushGlobalError);
  const [provider, setProvider] = useState<string>(PROVIDER_OPTIONS[0]);
  const [customProvider, setCustomProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<AuthStatusResponse | null>(null);
  const [failDetail, setFailDetail] = useState<string | null>(null);
  const [providers, setProviders] = useState<AuthProvidersResponse | null>(null);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refreshProviders = useCallback(async () => {
    try {
      const res = await api.listAuthProviders();
      setProviders(res);
      setRowStates((prev) => {
        const next: Record<string, RowState> = {};
        for (const it of res.items) next[it.name] = prev[it.name] ?? { kind: "untested" };
        return next;
      });
    } catch {
      // 列表拉取失败静默（表单主路径不受影响；无会话上下文的网络错误不上全局错误卡）
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api.getAuthStatus().then(
      (s) => {
        if (alive) setStatus(s);
      },
      () => {},
    );
    void refreshProviders();
    return () => {
      alive = false;
    };
  }, [refreshProviders]);

  const test = useCallback(async () => {
    const p = provider === CUSTOM ? customProvider.trim() : provider;
    if (p === "") {
      pushGlobalError(t("auth.providerRequired"));
      return;
    }
    if (apiKey.trim() === "") {
      pushGlobalError(t("auth.keyRequired"));
      return;
    }
    const trimmedBaseUrl = baseUrl.trim();
    if (trimmedBaseUrl !== "") {
      try {
        const u = new URL(trimmedBaseUrl);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
      } catch {
        pushGlobalError(t("auth.baseUrlInvalid"));
        return;
      }
    }
    setTesting(true);
    setFailDetail(null);
    try {
      const res = await api.saveAuthCredential(p, apiKey, trimmedBaseUrl);
      setStatus(res);
      if (res.status === "ready") {
        setApiKey("");
        showToast(t("auth.testOk"));
        await refreshProviders();
      } else {
        setFailDetail(res.detail ?? (res.status === "not_configured" ? t("auth.rejectNotConfigured") : t("auth.testFailed")));
      }
    } catch (err) {
      setFailDetail(apiErrorMessage(err, "auth.testFailed"));
    } finally {
      setTesting(false);
    }
  }, [apiKey, baseUrl, customProvider, provider, pushGlobalError, refreshProviders, showToast, t]);

  const checkRow = useCallback(
    async (name: string) => {
      setRowStates((prev) => ({ ...prev, [name]: { kind: "checking" } }));
      try {
        const res = await api.checkAuthProvider(name);
        setRowStates((prev) => ({
          ...prev,
          [name]: res.status === "ready" ? { kind: "ready" } : { kind: "error", detail: res.detail },
        }));
        setStatus(res);
      } catch (err) {
        setRowStates((prev) => ({ ...prev, [name]: { kind: "error", detail: apiErrorMessage(err, "auth.testFailed") } }));
      }
    },
    [],
  );

  const removeRow = useCallback(
    async (name: string) => {
      if (confirming !== name) {
        setConfirming(name);
        return;
      }
      setDeleting(true);
      try {
        await api.deleteAuthProvider(name);
        setConfirming(null);
        showToast(t("auth.deleteOk"));
        await refreshProviders();
      } catch (err) {
        setConfirming(null);
        pushGlobalError(`${t("auth.deleteFailed")}：${apiErrorMessage(err, "auth.deleteFailed")}`);
      } finally {
        setDeleting(false);
      }
    },
    [confirming, pushGlobalError, refreshProviders, showToast, t],
  );

  const rowBadge = (state: RowState | undefined) => {
    const cls =
      state?.kind === "ready"
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        : state?.kind === "error"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-muted text-muted-foreground";
    const label =
      state?.kind === "ready"
        ? t("auth.rowReady")
        : state?.kind === "error"
          ? t("auth.rowError")
          : state?.kind === "checking"
            ? t("auth.rowTesting")
            : t("auth.rowUntested");
    return (
      <span
        data-testid="auth-row-status"
        title={state?.kind === "error" && state.detail ? state.detail : undefined}
        className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] leading-none ${cls}`}
      >
        {label}
      </span>
    );
  };

  return (
    <div data-testid="auth-section" className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t("auth.heading")}</h3>
        {status && (
          <span
            data-testid="auth-status-badge"
            title={status.detail ?? undefined}
            className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[11px] leading-none ${
              status.status === "ready"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : status.status === "error"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border bg-muted text-muted-foreground"
            }`}
          >
            {t(STATUS_KEY[status.status])}
            {status.provider ? ` · ${status.provider}` : ""}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("auth.note")}</p>

      <div data-testid="auth-providers-list" className="space-y-1">
        {providers && providers.items.length > 0 ? (
          <>
            <p className="text-xs text-muted-foreground">{t("auth.listTitle")}</p>
            {providers.items.map((it) => {
              const isConfirming = confirming === it.name;
              return (
                <div
                  key={it.name}
                  data-testid="auth-provider-row"
                  className="flex flex-wrap items-center gap-1.5 rounded border border-border px-2 py-1"
                >
                  <span data-testid="auth-row-name" className="text-xs font-medium">
                    {it.name}
                  </span>
                  {it.type && <span className="text-[11px] text-muted-foreground">{it.type}</span>}
                  <span data-testid="auth-row-keymask" className="font-mono text-[11px] text-muted-foreground">
                    {it.keyMask}
                  </span>
                  {it.hasBaseUrl && <span className="text-[11px] text-muted-foreground">URL</span>}
                  <span className="ml-auto" />
                  {rowBadge(rowStates[it.name])}
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-7 shrink-0 px-2 text-[11px]"
                    data-testid="auth-row-test"
                    disabled={rowStates[it.name]?.kind === "checking"}
                    onClick={() => void checkRow(it.name)}
                  >
                    {rowStates[it.name]?.kind === "checking" ? t("auth.rowTesting") : t("auth.rowTest")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className={`min-h-7 shrink-0 px-2 text-[11px] ${isConfirming ? "border-destructive/50 text-destructive" : ""}`}
                    data-testid="auth-row-delete"
                    disabled={deleting}
                    onClick={() => void removeRow(it.name)}
                  >
                    {isConfirming ? t("auth.rowDeleteConfirm") : t("auth.rowDelete")}
                  </Button>
                </div>
              );
            })}
          </>
        ) : providers ? (
          <p data-testid="auth-providers-empty" className="text-xs text-muted-foreground">
            {t("auth.listEmpty")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <select
          data-testid="auth-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm lg:h-7"
          aria-label={t("auth.providerLabel")}
        >
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          <option value={CUSTOM}>{t("auth.providerCustom")}</option>
        </select>
        {provider === CUSTOM && (
          <Input
            data-testid="auth-provider-custom"
            value={customProvider}
            onChange={(e) => setCustomProvider(e.target.value)}
            placeholder={t("auth.providerCustomPlaceholder")}
            className="h-9 w-40 text-sm lg:h-7"
          />
        )}
        <Input
          data-testid="auth-api-key"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t("auth.keyPlaceholder")}
          className="h-9 min-w-0 flex-1 text-sm lg:h-7"
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-9 shrink-0 px-2.5 text-xs lg:min-h-7"
          data-testid="auth-test"
          disabled={testing}
          onClick={() => void test()}
        >
          {testing ? t("auth.testing") : t("auth.test")}
        </Button>
      </div>
      <Input
        data-testid="auth-base-url"
        type="text"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={t("auth.baseUrlPlaceholder")}
        aria-label={t("auth.baseUrlLabel")}
        className="h-9 w-full text-sm lg:h-7"
      />
      <p className="text-xs text-muted-foreground">{t("auth.baseUrlLabel")}</p>
      {failDetail && (
        <p data-testid="auth-fail-detail" className="text-xs text-destructive">
          {t("auth.testFailed")}：{failDetail}
        </p>
      )}
    </div>
  );
}
