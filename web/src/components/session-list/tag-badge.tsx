// 行内标签徽标（todo 11；todo 20 v2 双模式）：全局展示模式 tags.displayMode 分段
// （ui store，默认 text）下行内渲染分两态——
// - text：文字徽标，最多 TAG_BADGE_LIMIT 个 + "+N"（r3 C14 形态不变）；
// - grid：色格 A 方格（size-2.5 rounded-sm CSS grid：2=左右半/3=三分/4=四象限/
//   >4 首色+计数角标），色源 = tagColor(定义)（显式色 ?? 名称 hash），孤儿灰显，
//   移动端点格 toast 显名清单。
// 标签守卫（docs08 2026-10-23/24 批次任务 10）：孤儿徽标/色格点按不再直接清理挂载
// （旧语义点按即整替删除，无确认无审计）；孤儿清理统一移入标签管理弹框带确认。
// 任一标签 display:"text" 覆盖 → 整行回退文字（rowTagDisplayMode 判定，纯函数单测锁定）。
// 孤儿判定/展示模式判定在 tag-data.ts（纯函数）；样式对齐既有行内徽标形态。
import { Tag, X } from "lucide-react";
import type { SessionListItem } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { useIsMobile } from "@/lib/use-is-mobile";
import { useT } from "@/i18n/i18n";
import {
  findTagDef,
  isOrphanTag,
  rowTagDisplayMode,
  tagColor,
  visibleTags,
  type TagDefs,
  type TagRef,
} from "./tag-data";

interface TagBadgesProps {
  session: SessionListItem;
  /** 两源定义键集；null = 定义未就绪（不渲染，防加载期全部误判灰显闪烁） */
  definedKeys: Set<string> | null;
  /** 两源定义集（v2 色源与 display 覆盖判定）；null 视为无覆盖（hash 色仍可用） */
  defs?: TagDefs | null;
}

export function TagBadges({ session, definedKeys, defs = null }: TagBadgesProps) {
  const t = useT();
  const showToast = useUiStore((s) => s.showToast);
  const isMobile = useIsMobile();
  const globalMode = useUiStore((s) => s.tagDisplayMode);
  const tags = session.tags ?? [];
  const mode = rowTagDisplayMode(tags, defs, globalMode);
  const { shown, extra } = visibleTags(session.tags);
  if (tags.length === 0 || definedKeys === null) return null;

  // 色格模式（todo 20 (d)）：A 方格，逐格一标签；title/toast 显名清单
  if (mode === "grid") {
    const cells = tags.map((tag: TagRef) => {
      const orphan = isOrphanTag(tag, definedKeys);
      const def = defs ? findTagDef(defs, tag) : null;
      return { tag, orphan, color: tagColor(def ?? tag) };
    });
    const n = cells.length;
    const names = tags.map((t) => t.name).join(", ");
    // 2=左右半 / 3=三分 / 4=四象限；>4 只渲染首色单色格（细条堆叠不可读，计数角标补全）
    const shapeClass = n === 2 ? "grid-cols-2" : n === 3 ? "grid-cols-3" : n === 4 ? "grid-cols-2 grid-rows-2" : "";
    const gridCells = n > 4 ? cells.slice(0, 1) : cells;
    return (
      <span
        data-testid="tag-color-grid"
        data-count={n}
        title={t("sessionList.tagBadge.gridTitle", { names })}
        className="relative inline-flex size-2.5 shrink-0 cursor-pointer align-middle"
        onClick={(e) => {
          e.stopPropagation();
          // 移动端点格 toast 显名（桌面悬停已有 title；点按无删除副作用）
          if (isMobile) showToast(t("sessionList.tagBadge.gridTitle", { names }));
        }}
      >
        <span className={`grid size-full gap-px overflow-hidden rounded-sm ${shapeClass}`}>
          {gridCells.map((c) => (
            <span
              key={`${c.tag.scope}:${c.tag.name}`}
              data-tag={c.tag.name}
              data-orphan={c.orphan || undefined}
              className={c.orphan ? "bg-muted-foreground/40" : undefined}
              style={c.orphan ? undefined : { backgroundColor: c.color }}
            />
          ))}
        </span>
        {n > 4 && (
          <span
            data-testid="tag-grid-count"
            className="absolute -right-1.5 -top-1.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-foreground px-0.5 text-[8px] font-medium leading-none text-background"
          >
            {n}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" data-testid="tag-badges">
      {/* 参数改名 t→tag：避免遮蔽 i18n 翻译函数 t */}
      {shown.map((tag) => {
        const orphan = isOrphanTag(tag, definedKeys);
        return (
          <span
            key={`${tag.scope}:${tag.name}`}
            data-testid="tag-badge"
            data-tag={tag.name}
            data-orphan={orphan || undefined}
            title={orphan ? t("sessionList.tagBadge.orphanTitle", { name: tag.name }) : t("sessionList.tagBadge.title", { name: tag.name })}
            className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-px text-[10px] leading-none text-muted-foreground ${
              orphan ? "border-dashed bg-transparent text-muted-foreground/50" : "bg-muted"
            }`}
          >
            <Tag className="size-2.5" />
            {tag.name}
            {orphan && <X className="size-2" />}
          </span>
        );
      })}
      {extra > 0 && (
        <span
          className="shrink-0 rounded bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground"
          title={t("sessionList.tagBadge.more", { n: extra })}
          data-testid="tag-extra"
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
