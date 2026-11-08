// nav-rail 悬停面板（OpenChamber v1.24.2 同款复刻）：固定贴 gutter 左侧（right-full
// mr-3，不跟指针），内容为全部用户消息预览的迷你滚动列表（非单卡）：行高 54px 内缩
// 4px 最多可见 8 行，行 rounded-lg border /40 悬停 /60；文本 line-clamp-2
// overflow-wrap-anywhere meta 色 160 字符截断，活动行实心填充 selection 色；列表
// translateY 200ms ease-out glide（高亮行居中，translateY 与窗口高由父级计算）+
// 上下边缘 mask black 10%/90%。面板可交互：行悬停改高亮、滚轮 54px 步进（非 passive
// 监听阻断外溢滚动）、移入取消隐藏；离开 160ms 隐藏。无时间行无头像（OC 无）。
import { useEffect, useRef } from "react";

/** 面板行高（px）：滚轮步进与 glide 位移的最小单位 */
export const PANEL_ROW_PX = 54;

export interface NavRailPanelRow {
  key: string;
  summary: string;
  /** 所属段下标（活动段行实心填充判定） */
  segIdx: number;
}

export function NavRailSegmentCard({
  rows,
  hl,
  activeSegIdx,
  offsetY,
  windowH,
  onRowEnter,
  onWheelStep,
  onMouseEnter,
  onMouseLeave,
}: {
  rows: NavRailPanelRow[];
  /** 高亮行下标（glide 目标；行悬停/滚轮步进改写） */
  hl: number;
  /** 活动段下标（该段行实心填充 selection 色） */
  activeSegIdx: number;
  /** 列表 translateY（px，负值上滚；父级按高亮行居中 + 上下 2 行死区计算） */
  offsetY: number;
  /** 可视窗高（px = min(行数, 8) * PANEL_ROW_PX） */
  windowH: number;
  onRowEnter: (index: number) => void;
  onWheelStep: (dir: 1 | -1) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // 滚轮步进：React onWheel 为 passive 根委托，preventDefault 无效；非 passive 监听
  // 挂面板自身，阻断事件外溢（面板下不再触发消息列滚动），54px 一步
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const handler = (ev: WheelEvent) => {
      ev.preventDefault();
      onWheelStep(ev.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [onWheelStep]);

  return (
    <div
      data-testid="nav-rail-hover-card"
      className="pointer-events-auto absolute right-full top-1/2 z-50 mr-3 -translate-y-1/2 rounded-xl border border-border/60 bg-popover py-1 text-popover-foreground shadow-md"
      style={{ width: "min(20rem, calc(100vw - 6rem))" }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        ref={listRef}
        className="overflow-hidden"
        style={{
          height: windowH,
          maskImage:
            "linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)",
        }}
      >
        <div
          data-testid="nav-rail-panel-list"
          className="transition-transform duration-200 ease-out"
          style={{ transform: `translateY(${offsetY}px)` }}
        >
          {rows.map((row, i) => {
            const isActive = row.segIdx === activeSegIdx;
            return (
              <div
                key={row.key}
                data-testid="nav-rail-hover-row"
                data-active-row={isActive ? "true" : "false"}
                className="h-[54px] p-1"
                onMouseEnter={() => onRowEnter(i)}
              >
                <div
                  data-hl={i === hl ? "true" : "false"}
                  className={`flex h-full items-center rounded-lg border px-2 transition-colors duration-150 ${
                    isActive
                      ? "border-transparent bg-accent"
                      : i === hl
                        ? "border-border/60"
                        : "border-border/40 hover:border-border/60"
                  }`}
                >
                  <span
                    className={`line-clamp-2 text-xs leading-snug [overflow-wrap:anywhere] ${
                      isActive ? "text-accent-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {row.summary}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
