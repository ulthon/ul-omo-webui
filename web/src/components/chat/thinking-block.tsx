// thinking part 折叠组件（todo 16）：默认折叠（可经设置 chat.thinkingDefaultExpanded
// 改默认展开，docs08-r5 任务 13）；流式中头部实时计数（"思考中… N 字"）。
// 折叠时不渲染正文，delta 只触发头部计数一次重渲染（part 级订阅由上层保证）。
// 展开态滚动跟随（docs08-r5 任务 13）：thinking 变化时正文滚至底部；用户 wheel /
// touchmove（passive 监听，不阻断手势）即停跟随，手动重新展开复位跟随。
import { useEffect, useRef, useState } from "react";
import { BrainCircuit, ChevronDown } from "lucide-react";
import { t } from "@/i18n/i18n";
import { useUiStore } from "@/stores/ui";

export function ThinkingBlock({ thinking, live }: { thinking: string; live: boolean }) {
  // 初始开合读 store 快照（useState 初始化器仅取挂载时刻值；手动开合是会话内瞬态，
  // 不回写设置，已挂载的块也不随设置变化重开）
  const [open, setOpen] = useState(() => useUiStore.getState().thinkingDefaultExpanded);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 展开态滚底跟随标记：用户手滑（wheel/touchmove）即停，手动重新展开复位
  const followRef = useRef(true);

  // 手动重新展开（或挂载即展开）复位跟随
  useEffect(() => {
    if (open) followRef.current = true;
  }, [open]);

  // 展开态 thinking 变化滚至底部；折叠态零滚动开销（不渲染正文，直接返回）
  useEffect(() => {
    const el = bodyRef.current;
    if (!open || !el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [open, thinking]);

  // 用户手滑停跟随：passive 监听不阻断滚动手势；仅展开态挂载（折叠态零监听开销）
  useEffect(() => {
    const el = bodyRef.current;
    if (!open || !el) return;
    const stop = () => {
      followRef.current = false;
    };
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchmove", stop, { passive: true });
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchmove", stop);
    };
  }, [open]);

  const count = thinking.length;

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:min-h-0 lg:px-1.5 lg:py-1"
      >
        <BrainCircuit className="size-3.5 shrink-0" data-icon="inline-start" />
        <span className="truncate">
          {live ? t("chat.thinkingBlock.live") : t("chat.thinkingBlock.title")}
          {count > 0 ? t("chat.thinkingBlock.chars", { n: count }) : t("chat.thinkingBlock.ellipsis")}
        </span>
        <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          ref={bodyRef}
          data-testid="thinking-body"
          className="mt-1 max-h-64 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground"
        >
          {thinking || t("chat.thinkingBlock.empty")}
        </div>
      )}
    </div>
  );
}
