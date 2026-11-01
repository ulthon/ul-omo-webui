// nav-rail 悬停弹卡受控显隐状态机（从 nav-rail.tsx 抽出）：进入即显、移出
// HOVER_HIDE_DELAY_MS 内隐藏（setTimeout 清理，连换刻度/段先清旧定时器）；弹卡自身
// 悬停续期（供「加载更早」钮点按）；卸载兜底清理不留悬挂定时器。翻页展开数随段切换
// 重置（hoverSegRef 判段变更，不依赖渲染时序）。cardTopFromEvent 供刻度/段把元素中心
// y 钳制成弹卡锚点（不溢出 rail 视口）。
import { useEffect, useRef, useState } from "react";

/** 悬停浮卡移出后的隐藏延迟（ms） */
const HOVER_HIDE_DELAY_MS = 100;

export interface NavRailHover {
  segKey: string;
  top: number;
}

export function useNavRailHover(railRef: React.RefObject<HTMLDivElement | null>) {
  const [hover, setHover] = useState<NavRailHover | null>(null);
  const [pages, setPages] = useState(0);
  const hoverSegRef = useRef<string | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    };
  }, []);
  const cardTopFromEvent = (ev: React.MouseEvent<HTMLElement>): number => {
    // 元素中心 y（相对 rail），弹卡以卡片半高钳制在 rail 视口内不溢出
    const el = ev.currentTarget;
    const rail = railRef.current;
    const half = 72; // 弹卡最大高度一半的估值，仅用于钳制，弹卡实际高度自适应内容
    const railH = rail?.clientHeight ?? 0;
    const center = el.offsetTop + el.offsetHeight / 2;
    return railH > 0 ? Math.max(half, Math.min(center, railH - half)) : center;
  };
  const clearHideTimer = () => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };
  const openCard = (segKey: string, top: number) => {
    clearHideTimer();
    if (hoverSegRef.current !== segKey) {
      hoverSegRef.current = segKey;
      setPages(0); // 换段重置翻页展开
    }
    setHover({ segKey, top });
  };
  const closeCardSoon = () => {
    if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      hoverSegRef.current = null;
      setHover(null);
    }, HOVER_HIDE_DELAY_MS);
  };
  return { hover, pages, setPages, openCard, closeCardSoon, clearHideTimer, cardTopFromEvent };
}
