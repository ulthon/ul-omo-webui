// 手机档上下文水位细条（r10 todo 6，闭合 GAP-6）：水位环自手机顶栏退役，改为输入
// 框下方 h-1 细条（chat-view Composer 之下、仅 isMobile 渲染，桌面 StatusBar 语义
// 不动）。数据与刷新时机经 use-context-usage.ts 与水位环同源同沿，数值永远一致；
// 颜色沿用环三态：后台紫 / 运行琥珀 / 常态 primary。无 contextUsage 数据（接口失败/
// 无上下文窗口）整条隐藏不占位。桌面 lg+ 不渲染，顶栏与输入区零变化。
import { calibrateContextPercent } from "./context-percent";
import { useContextUsage } from "./use-context-usage";
import { useT } from "@/i18n/i18n";

export function ContextUsageBar({ sessionId }: { sessionId: string }) {
  const { stats, running, background, appliedModel, models } = useContextUsage(sessionId);
  const t = useT();

  // 无数据整条隐藏（接口失败 / 无 contextUsage），与环同口径
  if (!stats || !stats.context) return null;
  const appliedModelWindow = appliedModel
    ? (models.find((m) => `${m.provider}/${m.id}` === appliedModel)?.contextWindow ?? null)
    : null;
  const pct = calibrateContextPercent(stats.context, appliedModelWindow);
  const pctRounded = Math.round(pct);

  return (
    <div
      data-testid="context-usage-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pctRounded}
      aria-label={t("login.contextRing.ringLabel", { pct: pctRounded })}
      title={t("login.contextRing.ringLabel", { pct: pctRounded })}
      className="h-1 w-full shrink-0 overflow-hidden rounded-full bg-muted"
    >
      <div
        data-testid="context-usage-bar-fill"
        data-percent={pctRounded}
        className={`h-full rounded-full ${background ? "bg-violet-500" : running ? "bg-amber-500" : "bg-primary"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
