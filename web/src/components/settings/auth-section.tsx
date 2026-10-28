// 设置页「认证」分区（r10 批次任务 13）：provider 选择 + API key 粘贴表单 + 测试按钮。
// 端到端复用既有 auth 面：POST /api/auth/credentials（服务端写入 auth.json + 检查，
// 非 ready 自动回滚）→ GET /api/auth/status 同款三态展示。安全纪律：
// key 输入框 type=password 不回显；key 不落 localStorage、不入前端日志；
// 失败原因（服务端 detail，不含凭证材料）外显。导出供单测。
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AuthStatusResponse } from "@/lib/api";
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

export function AuthSection() {
  const t = useT();
  const showToast = useUiStore((s) => s.showToast);
  const [provider, setProvider] = useState<string>(PROVIDER_OPTIONS[0]);
  const [customProvider, setCustomProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<AuthStatusResponse | null>(null);
  const [failDetail, setFailDetail] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getAuthStatus().then(
      (s) => {
        if (alive) setStatus(s);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  const test = useCallback(async () => {
    const p = provider === CUSTOM ? customProvider.trim() : provider;
    if (p === "") {
      showToast(t("auth.providerRequired"), "error");
      return;
    }
    if (apiKey.trim() === "") {
      showToast(t("auth.keyRequired"), "error");
      return;
    }
    setTesting(true);
    setFailDetail(null);
    try {
      const res = await api.saveAuthCredential(p, apiKey);
      setStatus(res);
      if (res.status === "ready") {
        setApiKey("");
        showToast(t("auth.testOk"));
      } else {
        setFailDetail(res.detail ?? (res.status === "not_configured" ? t("auth.rejectNotConfigured") : t("auth.testFailed")));
      }
    } catch (err) {
      setFailDetail(apiErrorMessage(err, "auth.testFailed"));
    } finally {
      setTesting(false);
    }
  }, [apiKey, customProvider, provider, showToast, t]);

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
      {failDetail && (
        <p data-testid="auth-fail-detail" className="text-xs text-destructive">
          {t("auth.testFailed")}：{failDetail}
        </p>
      )}
    </div>
  );
}
