// 设置面板「扩展与凭证」分区（docs08-2026-10-22 批次任务 24）：
// 资源列表（extensions/skills/prompts/packages）+ 启停开关（不并发：进行中全列禁用，
// 服务端另有串行锁）+ auth 徽标与检查钮 + install/remove/update 非交互动作（进度 toast）。
// cliAvailable=false 降级：动作按钮禁用 + 「引擎 CLI 安装」提示。导出供单测。
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AuthStatusResponse, ExtensionItem } from "@/lib/api";
import type { MessageKey } from "@/i18n/i18n";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authBadge, groupByKind, isValidSource, type ExtensionKind } from "./extensions-data";

const KIND_KEY: Record<ExtensionKind, MessageKey> = {
  extension: "extensions.kindExtension",
  skill: "extensions.kindSkill",
  prompt: "extensions.kindPrompt",
  package: "extensions.kindPackage",
};

function ExtensionRow({
  item,
  busy,
  onToggle,
  onRemove,
}: {
  item: ExtensionItem;
  busy: boolean;
  onToggle: (item: ExtensionItem, enabled: boolean) => void;
  onRemove: (item: ExtensionItem) => void;
}) {
  const t = useT();
  return (
    <div data-testid={`ext-item-${item.kind}-${item.name}`} className="flex min-h-9 items-center gap-2 rounded-md border px-2 py-1">
      <span className="min-w-0 flex-1 truncate text-sm" title={item.source ?? item.name}>
        {item.name}
      </span>
      {item.kind === "package" ? (
        <span data-testid={`ext-state-${item.kind}-${item.name}`} className="shrink-0 rounded border border-border bg-muted px-1 py-px text-[11px] leading-none text-muted-foreground">
          {item.source}
        </span>
      ) : (
        <button
          type="button"
          data-testid={`ext-toggle-${item.kind}-${item.name}`}
          role="switch"
          aria-checked={item.enabled}
          disabled={busy}
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-none transition-colors disabled:opacity-50 ${
            item.enabled
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-border bg-muted text-muted-foreground"
          }`}
          onClick={() => onToggle(item, !item.enabled)}
        >
          {item.enabled ? t("extensions.enabled") : t("extensions.disabled")}
        </button>
      )}
      {item.kind === "package" && (
        <Button
          type="button"
          variant="outline"
          className="min-h-9 shrink-0 px-2.5 text-xs lg:min-h-7"
          data-testid={`ext-remove-${item.name}`}
          disabled={busy}
          onClick={() => onRemove(item)}
        >
          {t("extensions.remove")}
        </Button>
      )}
    </div>
  );
}

export function ExtensionsSection() {
  const t = useT();
  const showToast = useUiStore((s) => s.showToast);
  const [items, setItems] = useState<ExtensionItem[] | null>(null);
  const [cliAvailable, setCliAvailable] = useState(true);
  const [auth, setAuth] = useState<AuthStatusResponse | null>(null);
  const [authChecking, setAuthChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listExtensions();
      setItems(res.items);
      setCliAvailable(res.cliAvailable);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 挂载即拉清单与凭证（事件订阅式：状态在 promise 链内落地，不在 effect 体同步 setState）
  useEffect(() => {
    let alive = true;
    api.listExtensions().then(
      (res) => {
        if (!alive) return;
        setItems(res.items);
        setCliAvailable(res.cliAvailable);
        setLoadError(null);
      },
      (err: unknown) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      },
    );
    api.getAuthStatus().then(
      (s) => {
        if (alive) setAuth(s);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  // 手动检查（事件处理器内同步置 checking 态合法）
  const checkAuth = useCallback(() => {
    setAuthChecking(true);
    api.getAuthStatus()
      .then((s) => setAuth(s))
      .catch((err: unknown) => {
        showToast(apiErrorMessage(err, "extensions.loadFailed"), "error");
      })
      .finally(() => setAuthChecking(false));
  }, [showToast]);

  const toggle = useCallback(
    async (item: ExtensionItem, enabled: boolean) => {
      setBusy(true);
      try {
        await api.setExtensionEnabled(item.name, item.kind, enabled);
        await refresh();
      } catch (err) {
        showToast(apiErrorMessage(err, "extensions.toggleFailed"), "error");
      } finally {
        setBusy(false);
      }
    },
    [refresh, showToast],
  );

  const runAction = useCallback(
    async (action: "install" | "remove" | "update", src?: string) => {
      setInstalling(true);
      const progressKey: MessageKey =
        action === "update" ? "extensions.updating" : action === "install" ? "extensions.installing" : "extensions.removing";
      showToast(t(progressKey));
      try {
        const res = await api.runExtensionAction(action, src);
        if (res.ok) {
          showToast(`${t("extensions.actionOk")}\n${res.message.slice(0, 400)}`);
        } else {
          showToast(`${t("extensions.actionFailed")}\n${res.message.slice(0, 400)}`, "error");
        }
        await refresh();
      } catch (err) {
        showToast(apiErrorMessage(err, "extensions.actionFailed"), "error");
      } finally {
        setInstalling(false);
      }
    },
    [refresh, showToast, t],
  );

  const onInstall = useCallback(() => {
    if (!isValidSource(source)) {
      showToast(t("extensions.sourceInvalid"), "error");
      return;
    }
    void runAction("install", source.trim());
    setSource("");
  }, [runAction, showToast, source, t]);

  const badge = authBadge(authChecking ? null : auth);

  return (
    <div data-testid="extensions-section" className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t("extensions.heading")}</h3>
        <span
          data-testid="extensions-auth-badge"
          title={auth?.detail ?? (auth?.provider ? t("extensions.authProvider", { p: auth.provider }) : undefined)}
          className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[11px] leading-none ${badge.className}`}
        >
          {t(badge.key)}
        </span>
        <Button
          type="button"
          variant="outline"
          className="min-h-9 shrink-0 px-2.5 text-xs lg:min-h-7"
          data-testid="extensions-auth-check"
          disabled={authChecking || !cliAvailable}
          onClick={() => checkAuth()}
        >
          {authChecking ? t("extensions.authChecking") : t("extensions.checkNow")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("extensions.note")}</p>
      {!cliAvailable && <p className="text-xs text-destructive">{t("extensions.cliMissing")}</p>}
      {loadError && <p className="text-xs text-destructive">{t("extensions.loadFailed")}：{loadError}</p>}
      {items !== null && items.length === 0 && (
        <div data-testid="extensions-empty" className="rounded-md border border-dashed px-2 py-3 text-xs text-muted-foreground">
          <p>{t("extensions.empty")}</p>
          <p className="mt-0.5">{t("extensions.emptyHint")}</p>
        </div>
      )}
      {groupByKind(items ?? []).map((group) => (
        <div key={group.kind} className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t(KIND_KEY[group.kind])}</p>
          {group.items.map((item) => (
            <ExtensionRow key={`${item.kind}/${item.name}`} item={item} busy={busy || installing} onToggle={(it, e) => void toggle(it, e)} onRemove={(it) => void runAction("remove", it.source)} />
          ))}
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <Input
          data-testid="extensions-install-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={t("extensions.installPlaceholder")}
          className="h-9 min-w-0 flex-1 text-sm lg:h-7"
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-9 shrink-0 px-2.5 text-xs lg:min-h-7"
          data-testid="extensions-install"
          disabled={installing || busy}
          onClick={onInstall}
        >
          {installing ? t("extensions.installing") : t("extensions.install")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-9 shrink-0 px-2.5 text-xs lg:min-h-7"
          data-testid="extensions-update"
          disabled={installing || busy || !cliAvailable}
          onClick={() => void runAction("update")}
        >
          {installing ? t("extensions.updating") : t("extensions.update")}
        </Button>
      </div>
    </div>
  );
}
