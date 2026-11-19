// 行内原地重命名输入框（files-ux-revamp 任务 9 / IS-6）：列表行与树行共用的最小
// 编辑件。Enter 提交、Esc 与失焦一律取消；提交值先过本地校验——trim 后为空、含
// "/"、与原名相同，三种畸形一律静默取消（不发任何请求）。纯受控于宿主的
// renamingPath 状态，组件本身不持有提交/取消外的任何副作用。
import { useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useT } from "@/i18n/i18n";
import { normalizeRenameValue } from "@/components/files/inline-rename-logic";

export function InlineRenameInput({
  initial,
  testId,
  className,
  onCommit,
  onCancel,
}: {
  /** 原条目名（输入框预填值，也是“未变化即取消”的比对基准） */
  initial: string;
  testId: string;
  /** 宿主布局差异覆盖（树行更高，列表行紧凑）；缺省用紧凑默认 */
  className?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  const commit = () => {
    const next = normalizeRenameValue(initial, value);
    if (next === null) onCancel();
    else onCommit(next);
  };
  return (
    <input
      ref={ref}
      autoFocus
      onFocus={() => { ref.current?.select(); }}
      data-testid={testId}
      aria-label={t("files.inline.renameAria")}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={onCancel}
      className={className ?? "h-7 w-full min-w-0 rounded border border-input bg-transparent px-1.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"}
    />
  );
}
