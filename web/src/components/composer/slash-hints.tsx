// 斜杠输入提示下拉（docs08-r3 任务 19）：复用 AnchoredPanel 锚定 composer textarea
// （bottom-start、非模态不抢焦点）。纯渲染件：三段列表（引擎命令/技能/用户提示，
// 空段不渲染）+ 受控高亮；键盘导航（上下/回车）在宿主 composer keystroke 域实现，
// Esc 的关闭走 AnchoredPanel 截停（onClose），输入回退由宿主 document 段监听补做。
// 数据由宿主取数过滤后传入（扁平序 = 渲染序，键盘导航两域共享同一下标）。
// 移动端（docs08-r5 任务 7）：消费 AnchoredPanel inline 档——流内渲染，挂载点由
// 宿主置于 composer 胶囊上方条区，输入框与已输入筛选词保持可见可编辑；桌面
// 锚定档不变。
import { Fragment } from "react";
import { AnchoredPanel } from "@/components/ui/anchored-panel";
import { flattenSlashItems, type SlashItem, type SlashSection } from "./composer-logic";

const SECTION_LABELS: Record<SlashSection, string> = {
  extension: "引擎命令",
  skill: "技能",
  prompt: "用户提示",
};

const SECTION_ORDER: readonly SlashSection[] = ["extension", "skill", "prompt"];

export function SlashHints({
  anchor,
  groups,
  highlight,
  onSelect,
  onClose,
}: {
  anchor: HTMLElement | null;
  groups: Record<SlashSection, SlashItem[]>;
  /** 扁平序高亮下标（宿主键盘域持有） */
  highlight: number;
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
}) {
  const total = flattenSlashItems(groups).length;
  const rows: Array<{ section: SlashSection; item: SlashItem; index: number }> = [];
  let index = 0;
  for (const section of SECTION_ORDER) {
    for (const item of groups[section]) rows.push({ section, item, index: index++ });
  }
  return (
    <AnchoredPanel
      anchor={anchor}
      open
      onClose={onClose}
      className="w-80"
      maxHeight={320}
      mobilePresentation="inline"
      data-testid="slash-hints"
    >
      <div className="overflow-y-auto p-1.5" role="listbox" aria-label="斜杠命令提示">
        {total === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground" data-testid="slash-empty">无匹配命令</p>
        ) : (
          rows.map((row, i) => {
            const showHeader = i === 0 || rows[i - 1]!.section !== row.section;
            return (
              <Fragment key={row.item.name}>
                {showHeader && (
                  <p className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {SECTION_LABELS[row.section]}
                  </p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={row.index === highlight}
                  data-testid={`slash-item-${row.item.name}`}
                  data-highlighted={row.index === highlight || undefined}
                  ref={row.index === highlight ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  // mousedown 不转移焦点（textarea 焦点保留），click 即选择
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onSelect(row.item)}
                  className={`flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors ${
                    row.index === highlight ? "bg-muted" : "hover:bg-muted/60"
                  }`}
                >
                  <span className="w-full truncate font-mono text-xs text-foreground">/{row.item.name}</span>
                  {row.item.description && (
                    <span className="w-full truncate text-xs text-muted-foreground">{row.item.description}</span>
                  )}
                </button>
              </Fragment>
            );
          })
        )}
      </div>
    </AnchoredPanel>
  );
}
