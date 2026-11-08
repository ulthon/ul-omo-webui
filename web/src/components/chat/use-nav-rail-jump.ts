// nav-rail 定位与高亮（从 nav-rail.tsx 抽出）：scrollToOffset 到该行测量起点（测量
// 缓存 itemStart，未测量项为估值，落点随精化收敛）+ 目标行 1.5s 一次性高亮（data 属
// 性 + index.css 动画）。跳转后虚拟行由 virtualizer 异步重挂（scroll 事件不随 scrollTop
// 赋值同步），rAF 轮询至多 20 帧等目标行出现在 DOM 再点亮；连点先清上一次（不留悬挂
// 定时器）。刻度点击与段落位共用。
import { useRef } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

/** 高亮持续时长（ms；与 index.css nav-highlight-flash 动画对齐） */
const HIGHLIGHT_MS = 2500;

export function useNavRailJump(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
) {
  const highlightRef = useRef<{ el: HTMLElement; timer: number } | null>(null);
  const jumpToKey = (key: string, index: number) => {
    const m = virtualizer.measurementsCache[index];
    if (m) virtualizer.scrollToOffset(m.start, { align: "start" });
    let tries = 0;
    const tryHighlight = () => {
      tries++;
      const el = scrollRef.current?.querySelector<HTMLElement>(
        `[data-entry-key="${CSS.escape(key)}"]`,
      );
      if (el) {
        const prev = highlightRef.current;
        if (prev) {
          window.clearTimeout(prev.timer);
          delete prev.el.dataset.navHighlight;
        }
        el.dataset.navHighlight = "";
        highlightRef.current = {
          el,
          timer: window.setTimeout(() => {
            delete el.dataset.navHighlight;
            highlightRef.current = null;
          }, HIGHLIGHT_MS),
        };
        return;
      }
      if (tries < 20) requestAnimationFrame(tryHighlight);
    };
    tryHighlight();
  };
  return jumpToKey;
}
