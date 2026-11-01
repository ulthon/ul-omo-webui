// nav-rail 段悬停弹卡（openchamber 同款，仓库浮卡样式语言）：受控显隐由 nav-rail 持有
//（进入即显、移出 100ms 内隐藏，弹卡自身悬停续期供「加载更早」钮点按），本组件纯展示
// ——段日期标签（段落位翻页中显示「定位中」+ spinner）+ 段内用户消息行（时间 + 60 字
// 单行摘要，展示尾部 N 条，默认 3 条）+ 底部「加载更早」钮（一次 10 条；无更多时隐藏
// 钮，翻过页后显示「无更多」弱文案）。
import { Loader2 } from "lucide-react";
import { useT } from "@/i18n/i18n";
import type { NavSegmentSpec } from "./nav-rail-segments";

export function NavRailSegmentCard({
  segment,
  top,
  shown,
  canMore,
  pagedOnce,
  loadingMore,
  locating,
  onMore,
  onMouseEnter,
  onMouseLeave,
}: {
  segment: NavSegmentSpec;
  /** 卡片垂直锚点（rail 内 px，已由调用侧钳制在 rail 视口内不溢出） */
  top: number;
  /** 当前展示行数（rows 尾部） */
  shown: number;
  /** 还能加载更早（本地有余量或窗外未完） */
  canMore: boolean;
  /** 本轮悬停是否翻过页（决定「无更多」弱文案显隐） */
  pagedOnce: boolean;
  /** 「加载更早」取数中（钮禁用 + spinner） */
  loadingMore: boolean;
  /** 段落位回溯翻页进行中（头部「定位中」+ spinner） */
  locating: boolean;
  onMore: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const t = useT();
  const rows = segment.rows.slice(Math.max(0, segment.rows.length - shown));
  return (
    <div
      data-testid="nav-rail-hover-card"
      className="pointer-events-auto absolute right-full z-50 mr-2 w-64 -translate-y-1/2 rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ top }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <p
        data-testid="nav-rail-segment-label"
        className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground"
      >
        {locating ? t("chat.navRail.locating") : segment.label}
        {locating && <Loader2 aria-hidden className="size-3 shrink-0 animate-spin" />}
      </p>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.key} className="flex items-baseline gap-1.5">
            {row.time && (
              <span
                data-testid="nav-rail-hover-time"
                className="shrink-0 text-[10px] leading-snug text-muted-foreground tabular-nums"
              >
                {row.time}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-xs leading-snug">{row.summary}</span>
          </li>
        ))}
      </ul>
      {canMore ? (
        <button
          type="button"
          data-testid="nav-rail-segment-more"
          disabled={loadingMore}
          onClick={onMore}
          className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
        >
          {loadingMore && <Loader2 aria-hidden className="size-3 shrink-0 animate-spin" />}
          {t("chat.navRail.loadEarlier")}
        </button>
      ) : pagedOnce ? (
        <p className="mt-1 text-center text-[10px] text-muted-foreground">{t("chat.navRail.noMore")}</p>
      ) : null}
    </div>
  );
}
