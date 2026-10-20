// 常用语导入子面板（todo 14）：列出当前项目输入历史（新在前），超 4KB 条目禁选并
// 标注「超限」——服务端对含超限条目的整批 PUT 返回 400，前端禁选保证一次导入不因
// 单条超限失败。勾选若干 → 导入为项目级常用语（父级经 putScope 整替 project scope）。
import { useEffect, useState } from "react";
import { ArrowLeft, Loader2, Plus } from "lucide-react";
import { api, ApiError, type InputHistoryItem } from "@/lib/api";
// tSnap：异步续体（promise 回调）取词用快照态；渲染期文本走 useT 响应式
import { t as tSnap, useT } from "@/i18n/i18n";
import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { isSnippetOverLimit, partitionImportable, snippetPreview } from "./snippet-logic";

export function SnippetImport({
  project,
  busy,
  onBack,
  onImport,
}: {
  project: string;
  /** 父级 PUT 进行中：勾选与导入禁用 */
  busy: boolean;
  onBack: () => void;
  /** 提交所选内容（父级负责拼入项目级条目并整替 PUT） */
  onImport: (contents: string[]) => void;
}) {
  const [items, setItems] = useState<InputHistoryItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  // effect 只发请求（oxlint set-state-in-effect 消警模式）；每次进入子面板全新挂载重取
  useEffect(() => {
    let cancelled = false;
    api
      .listInputHistory(project, 200)
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : tSnap("composer.snippet.importLoadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const t = useT();
  const parts = items ? partitionImportable(items) : null;
  const toggle = (index: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const doImport = () => {
    if (!items || checked.size === 0) return;
    // checked 下标对应 items 全量列表（超限条目 checkbox disabled 勾不上，无需再过滤）
    onImport(items.filter((_, i) => checked.has(i)).map((item) => item.content));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label={t("composer.snippet.backToManage")}
          data-testid="snippet-import-back"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <DialogTitle className="text-base font-medium">{t("composer.snippet.importTitle")}</DialogTitle>
      </div>
      <p className="text-xs text-muted-foreground">{t("composer.snippet.importIntro")}</p>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border" data-testid="snippet-import-list">
        {!parts && <p className="p-3 text-xs text-muted-foreground/60">{t("composer.snippet.loading")}</p>}
        {parts && parts.importable.length === 0 && parts.oversized.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground/60">{t("composer.snippet.importEmptyHistory")}</p>
        )}
        {parts && items && (
          <ul>
            {items.map((item, i) => {
              const over = isSnippetOverLimit(item.content);
              return (
                <li key={item.id} className="border-b px-2 last:border-b-0">
                  {/* label 包整行：移动端触控点不限于 checkbox 本身；超限行 disabled 原生失效 */}
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 py-2">
                    <input
                      type="checkbox"
                      data-testid={`snippet-import-check-${i}`}
                      aria-label={t("composer.snippet.select", { preview: snippetPreview(item.content, 20) })}
                      disabled={over || busy}
                      checked={checked.has(i)}
                      onChange={() => toggle(i)}
                      className="size-4 shrink-0 accent-primary"
                    />
                    <span
                      className={`min-w-0 flex-1 truncate text-sm ${over ? "text-muted-foreground/50" : ""}`}
                      title={item.content}
                    >
                      {snippetPreview(item.content)}
                    </span>
                    {over && (
                      <span
                        className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-destructive"
                        data-testid={`snippet-import-over-${i}`}
                      >
                        {t("composer.snippet.overLimit")}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground" data-testid="snippet-import-count">
          {parts ? t("composer.snippet.selectedCount", { n: checked.size }) : ""}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 shrink-0 gap-1 px-3 text-xs lg:h-8"
          disabled={busy || !parts || checked.size === 0}
          onClick={doImport}
          data-testid="snippet-import-confirm"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          {t("composer.snippet.importSelected")}
        </Button>
      </div>
      {loadError && (
        <p className="text-xs text-destructive" data-testid="snippet-import-error">
          {loadError}
        </p>
      )}
    </div>
  );
}
