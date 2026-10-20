// 登录页 /login：密码输入 → POST /api/auth/login → 成功跳 /。
// 已带有效会话访问 /login 时自动跳回 /。
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { applyInitialLocale, t } from "@/i18n/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// 首帧语言先行值（任务2）：登录页 kv 不可达，localStorage/navigator 探测即设。
// 本模块被 main.tsx 静态引入，应用启动时（含主布局）先于首帧渲染执行，无闪烁；
// 探测值不落 localStorage（不冒充显式选择），登录后 bootstrap 以 kv 校正。
applyInitialLocale();

export function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(true);

  // 已登录访问 /login 直接跳主布局
  useEffect(() => {
    let cancelled = false;
    api
      .health({ authRedirect: false })
      .then(() => {
        if (!cancelled) window.location.replace("/");
      })
      .catch(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.login(password);
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t("login.passwordError") : t("login.loginFailed"));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">ul-omo webui</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("login.subtitle")}</p>
        <div className="mt-6 space-y-3">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("login.passwordPlaceholder")}
            autoFocus
            autoComplete="current-password"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={submitting || checking || !password}>
            {submitting ? t("login.submitting") : t("login.submit")}
          </Button>
        </div>
      </form>
    </div>
  );
}
