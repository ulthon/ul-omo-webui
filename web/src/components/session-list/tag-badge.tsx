// 行内标签徽标（todo 11）：最多显示 TAG_BADGE_LIMIT 个 + "+N"；
// 孤儿挂载（挂载的 (scope,name) 不在两源定义集中，即定义已删/改名）灰样式，点击清理
//（= 该会话整替去掉全部孤儿项）。样式对齐既有行内徽标（SourceBadge）的
// border bg-muted 10px 形态。判定逻辑在 tag-data.ts（纯函数，单测锁定）。
import { Tag, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { SessionListItem } from "@/lib/api";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { isOrphanTag, orphanTags, visibleTags } from "./tag-data";

interface TagBadgesProps {
  session: SessionListItem;
  /** 两源定义键集；null = 定义未就绪（不渲染，防加载期全部误判灰显闪烁） */
  definedKeys: Set<string> | null;
}

export function TagBadges({ session, definedKeys }: TagBadgesProps) {
  const { shown, extra } = visibleTags(session.tags);
  if (shown.length === 0 || definedKeys === null) return null;

  /** 孤儿清理：整替去掉该会话全部孤儿挂载（点单个孤儿徽标一并清掉其他孤儿，语义一致） */
  const cleanOrphans = async () => {
    const stale = orphanTags(session.tags, definedKeys);
    if (stale.length === 0) return;
    const keep = (session.tags ?? []).filter((t) => !stale.some((s) => s.scope === t.scope && s.name === t.name));
    try {
      await api.setSessionTags(session.id, keep);
      useSessionsStore.getState().patchSession(session.id, { tags: keep });
      useUiStore.getState().showToast("已清理失效标签");
    } catch (err) {
      useUiStore.getState().showToast(err instanceof ApiError ? err.message : "清理失败", "error");
    }
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" data-testid="tag-badges">
      {shown.map((t) => {
        const orphan = isOrphanTag(t, definedKeys);
        return (
          <span
            key={`${t.scope}:${t.name}`}
            data-testid="tag-badge"
            data-tag={t.name}
            data-orphan={orphan || undefined}
            title={orphan ? `标签「${t.name}」定义已删除，点击清理` : `标签：${t.name}`}
            className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-px text-[10px] leading-none text-muted-foreground ${
              orphan ? "border-dashed bg-transparent text-muted-foreground/50" : "bg-muted"
            }`}
            onClick={
              orphan
                ? (e) => {
                    e.stopPropagation();
                    void cleanOrphans();
                  }
                : undefined
            }
          >
            <Tag className="size-2.5" />
            {t.name}
            {orphan && <X className="size-2" />}
          </span>
        );
      })}
      {extra > 0 && (
        <span
          className="shrink-0 rounded bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground"
          title={`还有 ${extra} 个标签`}
          data-testid="tag-extra"
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
