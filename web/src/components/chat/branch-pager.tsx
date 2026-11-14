// 消息流内 ‹n/m› 分支切换器（session-branching todo 5，IS-3）：路径上有多条兄弟的
// 条目在气泡下缘显示 ‹k/n›，左右箭头切到前/后一个兄弟。数据（SiblingPosition）由
// chat-view 从全量 entries 一次派生（deriveSiblingPositions）后逐层下传，本组件
// 不读 store、不发网络——切换动作只经 onSwitchSibling 回调交叶切换编排（todo 6
// 的 switchLeaf/navigateAndRefresh 接线位）。
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "@/i18n/i18n";
import type { SiblingPosition } from "./branch-path-data";

/** 分支切换器。position 缺席或兄弟数 <2 时不渲染（单条消息无分支可切）。
 *  disabled 口径由调用方传入（chat-view 与 Composer queueAvailable 同一表达式，
 *  流式/运行/等待中禁用，导航中禁用由 todo 6 并入同一变量）；箭头到头（无前/后
 *  兄弟 id）也置灰。触控目标 44px（h-11 w-11，仓库移动档纪律）。 */
export function BranchPager({
  position,
  disabled,
  onSwitchSibling,
}: {
  position: SiblingPosition | null;
  disabled?: boolean;
  onSwitchSibling?: (entryId: string) => void;
}) {
  const t = useT();
  if (!position || position.count < 2) return null;
  const { index, count, prevId, nextId } = position;
  return (
    <div
      data-testid="branch-pager"
      role="group"
      aria-label={t("chat.branch.switchToSibling")}
      className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/40 px-1 py-0.5 text-xs text-muted-foreground"
    >
      <button
        type="button"
        data-testid="branch-pager-prev"
        aria-label={t("chat.branch.prevSibling")}
        title={t("chat.branch.prevSibling")}
        disabled={disabled === true || prevId === null}
        onClick={() => {
          if (prevId !== null && disabled !== true) onSwitchSibling?.(prevId);
        }}
        className="flex h-11 w-11 items-center justify-center rounded-md transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <span data-testid="branch-pager-position" aria-live="polite" className="min-w-8 select-none text-center tabular-nums">
        {index + 1}/{count}
      </span>
      <button
        type="button"
        data-testid="branch-pager-next"
        aria-label={t("chat.branch.nextSibling")}
        title={t("chat.branch.nextSibling")}
        disabled={disabled === true || nextId === null}
        onClick={() => {
          if (nextId !== null && disabled !== true) onSwitchSibling?.(nextId);
        }}
        className="flex h-11 w-11 items-center justify-center rounded-md transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </div>
  );
}
