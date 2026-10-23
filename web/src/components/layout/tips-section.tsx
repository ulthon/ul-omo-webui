// 设置面板「提示」分区（docs08-2026-10-22 批次任务 25）：用法提示显示开关（meta_kv
// tips.enabled，缺省开）。重新开启时清除空态卡的「本会话不再显」localStorage 记忆
// （ul-omo-webui:tips-dismissed）——否则开关开着却永远无卡，用户无法从 UI 恢复。
// 导出供单测。
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { TIPS_ENABLED_KV, useUiStore } from "@/stores/ui";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { clearTipsDismissed } from "@/components/chat/tip-card-data";

export function TipsSection() {
  const tipsEnabled = useUiStore((s) => s.tipsEnabled);
  const [saving, setSaving] = useState(false);

  const t = useT();
  const changeEnabled = async (enabled: boolean) => {
    if (enabled === tipsEnabled || saving) return;
    setSaving(true);
    try {
      await api.putSettings({ [TIPS_ENABLED_KV]: enabled ? "true" : "false" });
      if (enabled) clearTipsDismissed();
      useUiStore.getState().setTipsEnabled(enabled);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        useUiStore.getState().showToast(apiErrorMessage(err, "login.topbar.tipsSaveFailed"), "error");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t pt-1" data-testid="tips-section">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("login.topbar.tipsHeading")}</p>
        <label
          className="flex min-h-11 items-center gap-2 rounded-md px-1 text-sm hover:bg-accent/50 lg:min-h-7"
          data-testid="tips-enabled-option"
        >
          <input
            type="checkbox"
            checked={tipsEnabled}
            disabled={saving}
            onChange={(e) => void changeEnabled(e.target.checked)}
            className="size-4 accent-primary"
          />
          {t("login.topbar.tipsEnabled")}
        </label>
        <p className="text-xs text-muted-foreground">{t("login.topbar.tipsNote")}</p>
      </div>
    </div>
  );
}
