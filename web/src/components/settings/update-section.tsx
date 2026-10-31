// 更新区（2026-10-31 update-m23 批次）：检查 WebUI/引擎 新版本并一键更新。
// - 载入即 GET /api/update/check；registry 不可达时服务端降级 hasUpdate:false，前端不区分；
// - 有更新 → 琥珀横幅（当前→目标，两侧分开列）+ 确认按钮（POST install target:"webui"，
//   服务端按 docs/09 D3 合并执行，引擎随包一并升级，前端单按钮）；
// - 确认 → 「更新中」+ 5s 轮询 check：轮询成功且 current 变化（服务已重启回来）才退出
//   更新态并提示新版本；重启窗口内轮询失败静默继续；
// - 失败 → 错误文案 + 重试（重放失败的那次动作：检查失败重查、安装失败重发）。
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type UpdateCheck } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { Button } from "@/components/ui/button";

type Phase = "loading" | "idle" | "updating";

export function UpdateSection() {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("loading");
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<"check" | "install">("check");
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);
  const phaseRef = useRef<Phase>("loading");
  /** 安装前基线：轮询期间 current 越过它才算服务重启回来 */
  const baselineRef = useRef<string | null>(null);

  const runCheck = useCallback(async (): Promise<void> => {
    try {
      const r = await api.updateCheck();
      setError(null);
      // 形状防御：非预期响应（如网关占位 JSON）不进渲染态，走降级分支，不让设置页崩
      if (r?.webui?.current === undefined || r?.engine?.current === undefined) {
        throw new Error(t("update.checkFailed"));
      }
      if (phaseRef.current === "updating") {
        if (baselineRef.current !== null && r.webui.current !== baselineRef.current) {
          baselineRef.current = null;
          setCheck(r);
          setUpdatedTo(r.webui.current);
          setPhase("idle");
        }
        return;
      }
      setCheck(r);
      setPhase("idle");
    } catch (err) {
      if (phaseRef.current === "updating") return; // 重启窗口，交给下一轮轮询
      setError(err instanceof Error ? err.message : String(err));
      setErrorKind("check");
    }
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  useEffect(() => {
    if (phase !== "updating") return;
    const id = setInterval(() => void runCheck(), 5000);
    return () => clearInterval(id);
  }, [phase, runCheck]);

  const confirm = async (): Promise<void> => {
    if (check === null) return;
    setError(null);
    try {
      baselineRef.current = check.webui.current;
      await api.updateInstall({ target: "webui", version: check.webui.latest });
      setPhase("updating");
    } catch (err) {
      baselineRef.current = null;
      setError(err instanceof Error ? err.message : String(err));
      setErrorKind("install");
    }
  };

  const retry = (): void => {
    if (errorKind === "install") void confirm();
    else void runCheck();
  };

  return (
    <section aria-label={t("update.title")} className="rounded-lg border p-3" data-testid="update-section">
      <h3 className="text-sm font-semibold">{t("update.title")}</h3>
      <p className="pt-1 text-xs text-muted-foreground">{t("update.desc")}</p>

      {phase === "loading" && <p className="pt-3 text-xs text-muted-foreground">…</p>}

      {phase === "idle" && check !== null && (
        <>
          <p className="pt-3 text-xs text-muted-foreground" data-testid="update-current">
            {t("update.currentLine", { webui: check.webui.current, engine: check.engine.current })}
          </p>
          {(check.webui.hasUpdate || check.engine.hasUpdate) && (
            <div
              data-testid="update-banner"
              className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
            >
              {check.webui.hasUpdate && (
                <p>{t("update.newVersion", { current: check.webui.current, latest: check.webui.latest })}</p>
              )}
              {check.engine.hasUpdate && (
                <p>{t("update.newVersion", { current: check.engine.current, latest: check.engine.latest })}</p>
              )}
              {check.engine.hasUpdate && <p className="pt-1">{t("update.engineNote", { latest: check.engine.latest })}</p>}
              <div className="pt-2">
                <Button type="button" size="sm" data-testid="update-confirm-btn" onClick={() => void confirm()}>
                  {t("update.confirm")}
                </Button>
              </div>
            </div>
          )}
          {updatedTo !== null && (
            <p className="pt-2 text-xs text-emerald-600" data-testid="update-updated">
              {t("update.updated", { version: updatedTo })}
            </p>
          )}
        </>
      )}

      {phase === "updating" && (
        <p className="pt-3 text-xs text-muted-foreground" data-testid="update-status">
          {t("update.updating")}
        </p>
      )}

      {error !== null && (
        <div className="pt-3">
          <p className="text-xs text-red-500" data-testid="update-error">
            {errorKind === "install" ? t("update.installFailed") : t("update.checkFailed")}：{error}
          </p>
          <Button type="button" variant="outline" size="sm" className="mt-1" data-testid="update-retry-btn" onClick={retry}>
            {t("update.retry")}
          </Button>
        </div>
      )}
    </section>
  );
}
