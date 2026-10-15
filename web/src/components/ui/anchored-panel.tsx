// 通用非模态锚定浮层（docs08-r3 A1）：锚定触发元素 bottom-start 对齐、视口边缘
// 翻转（下方放不下且上方更大时翻上）、外点/Esc 关闭（Esc 捕获段截停不透传给宿主）、
// 无遮罩层、不抢焦点（不设 tabindex/autofocus，宿主输入框焦点可保留）。
// 复用方契约：SnippetDropdown（A1）、TagDropdown 多选列表（任务 13）、SlashHints
// 键盘导航列表（任务 19）——内容形态由 children 自带，本件只负责定位与开合语义；
// 键盘导航由宿主组件在自身 keystroke 域内实现，不经本件。
// 定位手写（不引浮层库）：fixed + 锚元素 getBoundingClientRect，open/resize/滚动
// （capture，覆盖内部滚动容器）/内容尺寸变化（ResizeObserver）时重算。
// 移动端档（docs08-r4 任务 8）：视口 <640px 时改渲染 bottom sheet——不走锚定定位
// （锚元素仅保留外点豁免职责），底缘贴 --app-height 根容器（fixed + bottom:
// calc(100vh - var(--app-height))：键盘只缩 visualViewport 不缩布局视口，根容器随
// vv 收缩，calc 让 sheet 底缘恒在根容器底 = 键盘上方；fixed 保证脱离窄父容器）。
// 开合语义两档一致：外点关（触发钮豁免，toggle 自管）、Esc 捕获段截停。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import { useIsMobile } from "@/lib/use-is-mobile";

/** 面板距视口边缘的最小安全边距（px），翻转与钳制共用 */
const VIEWPORT_MARGIN = 8;
/** bottom-start 之下锚元素与面板的间隙（px） */
const ANCHOR_GAP = 4;
/** 移动端 bottom sheet 档断点（<sm，与 composer 手机胶囊档一致） */
const SHEET_QUERY = "(max-width: 639.98px)";

export interface AnchoredPanelProps {
  /** 锚定参照元素（触发按钮或输入框）；null 时整件不渲染 */
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 内容形态类（宽度/内边距/滚动区由复用方给）；定位样式本件持有，勿覆盖 position */
  className?: string;
  /** 面板最大高度（px），视口空间不足时进一步收缩；缺省 320 */
  maxHeight?: number;
  "data-testid"?: string;
}

interface Placement {
  top: number;
  left: number;
  maxHeight: number;
}

export function AnchoredPanel({
  anchor,
  open,
  onClose,
  children,
  className,
  maxHeight = 320,
  "data-testid": testId,
}: AnchoredPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const isSheet = useIsMobile(SHEET_QUERY);

  // bottom-start 定位：面板左上角对齐锚元素左下角；右溢出向视口内钳制；
  // 下方放不下且上方空间更大时翻转到锚元素上方（保持左对齐）。高度按所在侧
  // 剩余空间收缩（inline maxHeight），双向都挤时钳 80px 下限保证可用。
  const place = useCallback(() => {
    const el = panelRef.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const spaceBelow = vh - a.bottom - VIEWPORT_MARGIN;
    const spaceAbove = a.top - VIEWPORT_MARGIN;
    const flip = spaceBelow < Math.min(h, maxHeight) && spaceAbove > spaceBelow;
    const room = Math.max(flip ? spaceAbove : spaceBelow, 0);
    const settledMaxHeight = Math.max(Math.min(maxHeight, room), 80);
    let left = a.left;
    if (left + w > vw - VIEWPORT_MARGIN) left = vw - w - VIEWPORT_MARGIN;
    left = Math.max(VIEWPORT_MARGIN, left);
    const top = flip
      ? Math.max(VIEWPORT_MARGIN, a.top - settledMaxHeight)
      : Math.min(a.bottom + ANCHOR_GAP, vh - VIEWPORT_MARGIN - settledMaxHeight);
    setPlacement((prev) =>
      prev && prev.top === top && prev.left === left && prev.maxHeight === settledMaxHeight ? prev : { top, left, maxHeight: settledMaxHeight },
    );
  }, [anchor, maxHeight]);

  // open 翻真后先量后画（layout effect 在首帧绘制前落位，无闪跳）；sheet 档定位与
  // 锚元素无关，跳过量算
  useLayoutEffect(() => {
    if (open && anchor && !isSheet) place();
  }, [open, anchor, isSheet, place]);

  // 开启期间挂外点/Esc 监听（两档共用）；Esc 在 document 捕获段截停（stopPropagation），
  // 宿主（如 composer textarea 的历史 Esc）不再响应同一次按键
  useEffect(() => {
    if (!open || !anchor) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (panelRef.current?.contains(target)) return;
      // 触发元素自身不视为外点：开合 toggle 由其 onClick 自管，避免关了又开
      if (anchor.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, anchor, onClose]);

  // 锚定档重算：open/resize/滚动（capture，覆盖内部滚动容器）/内容尺寸变化
  // （ResizeObserver）时重算定位；sheet 档底缘贴根容器由 CSS 变量随动，无需监听
  useEffect(() => {
    if (!open || !anchor || isSheet) return;
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    const ro = new ResizeObserver(onResize);
    if (panelRef.current) ro.observe(panelRef.current);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      ro.disconnect();
    };
  }, [open, anchor, isSheet, place]);

  if (!open || !anchor) return null;

  // 移动端 bottom sheet 档（<640px）：全宽贴 --app-height 根容器底、顶部圆角、
  // 最大高 60vh（再与复用方 maxHeight 取小）、顶部细拖拽条（纯视觉）、上滑入场。
  // className 仍参与合并（复用方 w-80 被后面的 w-full 覆盖），inline width/left/right
  // 兜底保证全宽不受复用方宽度类影响。
  if (isSheet) {
    return (
      <div
        ref={panelRef}
        data-slot="anchored-panel"
        data-presentation="sheet"
        data-testid={testId}
        className={cn(
          "z-50 flex flex-col overflow-hidden rounded-b-none rounded-t-xl bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 animate-in fade-in-0 slide-in-from-bottom-4",
          className,
          "inset-x-0 bottom-0 w-full",
        )}
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          width: "100%",
          bottom: "calc(100vh - var(--app-height, 100vh))",
          maxHeight: `min(60vh, ${maxHeight}px)`,
        }}
      >
        <div aria-hidden className="mx-auto mt-1.5 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/25" />
        {children}
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      data-slot="anchored-panel"
      data-testid={testId}
      className={cn(
        "z-50 flex flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 animate-in fade-in-0 zoom-in-95",
        className,
      )}
      style={{ position: "fixed", top: placement?.top, left: placement?.left, maxHeight: placement?.maxHeight }}
    >
      {children}
    </div>
  );
}
