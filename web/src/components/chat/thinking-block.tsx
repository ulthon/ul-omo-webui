// thinking part 折叠组件（todo 16）：默认折叠；流式中头部实时计数（"思考中… N 字"）。
// 折叠时不渲染正文，delta 只触发头部计数一次重渲染（part 级订阅由上层保证）。
import { useState } from "react";
import { BrainCircuit, ChevronDown } from "lucide-react";

export function ThinkingBlock({ thinking, live }: { thinking: string; live: boolean }) {
  const [open, setOpen] = useState(false);
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
          {live ? "思考中" : "思考过程"}
          {count > 0 ? ` … ${count} 字` : "…"}
        </span>
        <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-1 max-h-64 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {thinking || "（暂无内容）"}
        </div>
      )}
    </div>
  );
}
