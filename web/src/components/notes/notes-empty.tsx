// 笔记页签空态/提示展示件（todo 15）：从 notes-view 拆出（250 LOC 上限）。
import type { ReactNode } from "react";

export function CenteredHint({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{text}</div>;
}

export function EmptyState({ icon, title, hint, children }: { icon: ReactNode; title: string; hint: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      {icon}
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </div>
  );
}
