// 通知中心（全局错误改聚合呈现，方案 A）：顶栏铃铛入口 + 下拉面板。
// 数据源 ui store globalNotifs（pushGlobalError 通道，去重合并计数、最新在上、
// 不自动消失）；无通知时入口置灰（保留占位，布局稳定），有通知显示角标计数。
// 条目点按展开详情（完整文本可选中复制，另设复制钮）；单条可关，面板可全部清空。
import { useState } from "react";
import { Bell, X } from "lucide-react";
import { selectGlobalNotifCount, useUiStore } from "@/stores/ui";
import { useT } from "@/i18n/i18n";
import { copyText } from "@/lib/clipboard";

export function NotificationCenter() {
  const t = useT();
  const count = useUiStore(selectGlobalNotifCount);
  const items = useUiStore((s) => s.globalNotifs);
  const open = useUiStore((s) => s.notifCenterOpen);
  const setNotifCenterOpen = useUiStore((s) => s.setNotifCenterOpen);
  const dismissGlobalNotif = useUiStore((s) => s.dismissGlobalNotif);
  const clearGlobalErrors = useUiStore((s) => s.clearGlobalErrors);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const toggle = () => {
    if (items.length === 0) return; // 无通知置灰不可点
    setExpanded(null);
    setNotifCenterOpen(!open);
  };

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="notif-center-toggle"
        aria-label={t("login.topbar.notifCenterTitle")}
        title={t("login.topbar.notifCenterTitle")}
        disabled={items.length === 0}
        onClick={toggle}
        className={`relative flex size-9 items-center justify-center rounded-md transition-colors ${
          items.length === 0
            ? "cursor-default text-muted-foreground/40"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        }`}
      >
        <Bell className="size-4" />
        {count > 0 && (
          <span
            data-testid="notif-badge"
            className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-destructive px-1 text-[10px] font-medium leading-4 text-white"
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && (
        <div
          data-testid="notif-panel"
          className="absolute right-0 top-full z-50 mt-2 flex max-h-96 w-80 flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">{t("login.topbar.notifCenterTitle")}</span>
            <button
              type="button"
              data-testid="notif-clear"
              onClick={() => {
                clearGlobalErrors();
                setNotifCenterOpen(false);
              }}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("login.topbar.notifClear")}
            </button>
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">{t("login.topbar.notifEmpty")}</p>
          ) : (
            <ul className="max-h-72 divide-y divide-border overflow-y-auto">
              {items.map((n) => (
                <li
                  key={n.text}
                  data-testid="notif-item"
                  className="cursor-pointer px-3 py-2 hover:bg-muted/50"
                  onClick={() => setExpanded(expanded === n.text ? null : n.text)}
                >
                  <div className="flex items-start gap-1.5">
                    <span className="mt-1 size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {expanded === n.text ? (
                        <span className="block whitespace-pre-wrap break-words select-text">{n.text}</span>
                      ) : (
                        n.text
                      )}
                    </span>
                    {n.count > 1 && (
                      <span className="shrink-0 rounded bg-muted px-1.5 text-xs text-muted-foreground">
                        ×{n.count}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={t("login.topbar.notifDismiss")}
                      onClick={(e) => {
                        e.stopPropagation();
                        dismissGlobalNotif(n.text);
                      }}
                      className="shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  {expanded === n.text && (
                    <div className="mt-1.5 flex items-center justify-between gap-2 pl-3">
                      <span className="text-xs text-muted-foreground">
                        {new Date(n.ts).toLocaleString()}
                      </span>
                      <button
                        type="button"
                        data-testid="notif-item-copy"
                        onClick={(e) => {
                          e.stopPropagation();
                          void copyText(n.text).then((ok) => {
                            setCopied(ok);
                            if (ok) setTimeout(() => setCopied(false), 2000);
                          });
                        }}
                        className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {copied ? t("login.topbar.notifCopied") : t("login.topbar.notifCopy")}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
