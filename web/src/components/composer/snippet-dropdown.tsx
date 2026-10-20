// 常用语锚定下拉（docs08-r3 A1）：输入区常用语按钮的非模态锚定浮层。
// 项目/全局两段、纯配置序（无最近使用小节——用户拍板禁止，也不埋使用记录）；
// 条目主体点击=插入（composer 草稿链路，光标落条目末尾）、条目箭头=直发
// （sendText clearInputs:false，不动既有草稿/图片）；底部「查看全部」打开旧
// SnippetPanelDialog 兜底（管理与导入留在弹框，不进下拉）。两动作分区复用
// SnippetEntryList，与弹框保持同款结构同款测试锚点。
// docs08-r5 任务 9：mobilePresentation 透传 AnchoredPanel——手机档改 inline
// 流内形态（挂载于胶囊上方条区，与斜杠提示同区），常用语一步直达且不遮挡输入框；
// 桌面锚定档不受影响（缺省 "sheet" 由 composer 按断点传值）。
import { useEffect, useState } from "react";
import { ChevronUp } from "lucide-react";
import { api, ApiError, type SnippetEntry } from "@/lib/api";
import { t } from "@/i18n/i18n";
import { AnchoredPanel } from "@/components/ui/anchored-panel";
import { snippetActionDisabled } from "./snippet-logic";
import { SnippetEntryList } from "./snippet-panel";

export function SnippetDropdown({
  anchor,
  onClose,
  project,
  busy,
  sending,
  onInsert,
  onSendNow,
  onViewAll,
  mobilePresentation,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  project: string | null;
  /** 与弹框同判定：sending 态条目动作禁用（busy 态 composer 整体替换本组件不可达） */
  busy: boolean;
  sending: boolean;
  onInsert: (content: string) => void;
  onSendNow: (content: string) => void;
  onViewAll: () => void;
  /** 窄视口呈现档透传（docs08-r5 任务 9）：composer 手机档传 "inline" */
  mobilePresentation?: "sheet" | "inline";
}) {
  const [data, setData] = useState<{ global: SnippetEntry[]; project: SnippetEntry[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // composer 侧条件挂载（只开态渲染本组件）= 每次打开全新初始态、开时即取；
  // effect 只发请求（同 snippet-panel 的 oxlint set-state-in-effect 消警模式）
  useEffect(() => {
    let cancelled = false;
    api
      .listSnippets(project ?? undefined)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : t("composer.snippet.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const actionDisabled = snippetActionDisabled(busy, sending);
  const empty = data !== null && data.global.length === 0 && (!project || data.project.length === 0);

  return (
    <AnchoredPanel
      anchor={anchor}
      open
      onClose={onClose}
      data-testid="snippet-dropdown"
      maxHeight={360}
      className="w-80"
      mobilePresentation={mobilePresentation}
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {!data && !loadError && <p className="px-1 py-1 text-xs text-muted-foreground/60">{t("composer.snippet.loading")}</p>}
        {loadError && (
          <p className="px-1 py-1 text-xs text-destructive" data-testid="snippet-error">
            {loadError}
          </p>
        )}
        {empty && (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground" data-testid="snippet-dropdown-empty">
            {t("composer.snippet.emptyDropdown")}
          </p>
        )}
        {data && (
          <>
            {project && (
              <SnippetEntryList
                scope="project"
                label={t("composer.snippet.projectGroup", { name: project.split("/").filter(Boolean).pop() ?? project })}
                entries={data.project}
                actionDisabled={actionDisabled}
                onInsert={onInsert}
                onSendNow={onSendNow}
              />
            )}
            <SnippetEntryList
              scope="global"
              label={t("composer.snippet.globalGroup")}
              entries={data.global}
              actionDisabled={actionDisabled}
              onInsert={onInsert}
              onSendNow={onSendNow}
            />
          </>
        )}
      </div>
      <div className="shrink-0 border-t p-1">
        <button
          type="button"
          data-testid="snippet-view-all"
          onClick={onViewAll}
          className="flex min-h-9 w-full cursor-pointer items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronUp className="size-3.5" />
          {t("composer.snippet.viewAll")}
        </button>
      </div>
    </AnchoredPanel>
  );
}
