// chat 空态用法提示卡（docs08-2026-10-22 批次任务 25）：数据源 GET /api/tips（服务端
// 缓存 omo --list-tips；失败降级空表）。「换一条」本地轮换不重发请求；「关闭」写
// localStorage（键见 tip-card-data.ts），设置「显示用法提示」重新开启时由 TipsSection
// 清除记忆。设置开关关闭、接口失败或清单为空时整卡不渲染（无 tip 区、无报错）；
// 不做全局弹窗。
import { useEffect, useMemo, useState } from "react";
import { Lightbulb } from "lucide-react";
import { api, type TipItem } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { dismissTips, nextTipIndex, readTipsDismissed } from "./tip-card-data";

export function TipCard() {
  const t = useT();
  const tipsEnabled = useUiStore((s) => s.tipsEnabled);
  const [dismissTick, setDismissTick] = useState(0);
  // 关闭态实时从存储派生（无 effect 级联）：tipsEnabled 翻真时 TipsSection 已清记忆，
  // 派生即复原已挂载卡；dismissTick 驱动本组件「关闭」点击后的重派生。开关关时不显。
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- dismissTick 是有意的重派生触发（点击「关闭」后重读存储，非数据依赖）
  const dismissed = useMemo(() => (tipsEnabled ? readTipsDismissed() : false), [tipsEnabled, dismissTick]);
  const [tips, setTips] = useState<TipItem[] | null>(null);
  const [index, setIndex] = useState(0);

  // 拉取（.then 形态与 ScheduleSection 同款：setState 全在微任务回调内）；失败降级
  // 空清单（不 toast 不报错——提示卡是锦上添花，失败必须无痕）。开关关闭/已关闭态
  // 早退不请求。
  useEffect(() => {
    if (!tipsEnabled || dismissed) return;
    let alive = true;
    api.listTips().then(
      (res) => {
        if (alive) setTips(res.tips);
      },
      () => {
        if (alive) setTips([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [tipsEnabled, dismissed]);

  // 设置开关翻真（false→true）时 TipsSection 已清除关闭记忆；已挂载卡经 useMemo 重派生
  // （dismissed 依赖 tipsEnabled）自动复原，无需额外 effect。

  if (!tipsEnabled || dismissed || tips === null || tips.length === 0) return null;
  const tip = tips[index % tips.length] ?? tips[0];
  return (
    <div
      data-testid="tip-card"
      className="mx-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-card p-4 text-left shadow-sm"
    >
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t("chat.tipCard.label")}</p>
        <p data-testid="tip-card-text" className="text-sm text-foreground">{tip.text}</p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="tip-card-next"
            disabled={tips.length < 2}
            onClick={() => setIndex(nextTipIndex(index, tips.length))}
          >
            {t("chat.tipCard.next")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="tip-card-dismiss"
            onClick={() => {
              dismissTips();
              setDismissTick((n) => n + 1);
            }}
          >
            {t("chat.tipCard.dismiss")}
          </Button>
        </div>
      </div>
    </div>
  );
}
