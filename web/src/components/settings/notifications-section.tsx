// 通知记录区（2026-11-05 #10）：程序级 toast 的历史回看面。
// - 数据源 ui store notifications 环形缓冲（内存态 200 条，info/error 都入，刷新即清）；
// - 新事件在上（最新优先）；kind 徽标区分黑/红；行内只展示文本不截断历史（历史就是用来看全的）；
// - 清空钮一键归零。本区只读展示，不产生新 toast。
import { useUiStore } from "@/stores/ui";
import { useT } from "@/i18n/i18n";
import { Button } from "@/components/ui/button";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function NotificationsSection() {
  const t = useT();
  const notifications = useUiStore((s) => s.notifications);
  const clearNotifications = useUiStore((s) => s.clearNotifications);
  const rows = [...notifications].reverse(); // 最新在上

  return (
    <section data-testid="notifications-section" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("login.settingsPage.notificationsHeading")}</p>
        {rows.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => clearNotifications()}
            data-testid="notifications-clear"
          >
            {t("login.settingsPage.notificationsClear")}
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <p data-testid="notifications-empty" className="text-sm text-muted-foreground">
          {t("login.settingsPage.notificationsEmpty")}
        </p>
      ) : (
        <ul data-testid="notifications-list" className="max-h-72 space-y-1 overflow-y-auto">
          {rows.map((n) => (
            <li
              key={n.id}
              data-testid="notification-row"
              className="flex items-start gap-2 rounded-md px-1 py-0.5 text-sm"
            >
              <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTime(n.ts)}</span>
              <span
                data-testid={`notification-kind-${n.kind}`}
                className={
                  n.kind === "error"
                    ? "shrink-0 rounded bg-destructive/15 px-1 text-xs text-destructive"
                    : "shrink-0 rounded bg-muted px-1 text-xs text-muted-foreground"
                }
              >
                {n.kind === "error" ? t("login.settingsPage.notificationsKindError") : t("login.settingsPage.notificationsKindInfo")}
              </span>
              <span className="min-w-0 whitespace-pre-wrap break-all">{n.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
