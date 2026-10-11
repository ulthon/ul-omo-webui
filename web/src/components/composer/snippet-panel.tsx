// 常用语面板（todo 14）：项目级（当前会话所属项目）+ 全局两段列表。点条目 = 插入
// 输入框（composer 侧 insertSnippet 走草稿链路）；条目右侧发送按钮 = 直发该条目文本
// （composer 侧 sendText clearInputs:false，不清既有草稿/图片/历史）。空态引导去管理；
// 「管理」在同一 Dialog 内切换到 SnippetManage。Dialog 模式沿用 FilePickerDialog：
// 移动端全屏 h-dvh、桌面 sm 居中；条件挂载即每次打开全新初始态。
import { useEffect, useState } from "react";
import { ArrowUp, MessageSquareText, Settings2 } from "lucide-react";
import { api, ApiError, type SnippetEntry } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { snippetPreview } from "./snippet-logic";
import { SnippetManage } from "./snippet-manage";

export function SnippetPanelDialog({
  open,
  onOpenChange,
  project,
  actionDisabled,
  onInsert,
  onSendNow,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string | null;
  /** true 时条目插入/直发禁用（sending 态；busy 态 composer 整体替换为本组件不可达） */
  actionDisabled: boolean;
  onInsert: (content: string) => void;
  onSendNow: (content: string) => void;
  /** radix 关闭完成焦点返回（默认回触发钮）；调用方 preventDefault 后自行接管（回输入框） */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [managing, setManaging] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          data-testid="snippet-panel"
          onCloseAutoFocus={onCloseAutoFocus}
          className="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-3 rounded-none p-3 sm:top-1/2 sm:left-1/2 sm:h-[85vh] sm:max-h-[85vh] sm:w-[calc(100%-2rem)] sm:max-w-sm sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
        >
          {/* 条件挂载：每次打开/切换视图即全新初始态（列表与管理重取随挂载自然发生） */}
          {managing ? (
            <SnippetManage project={project} onBack={() => setManaging(false)} />
          ) : (
            <SnippetList
              project={project}
              actionDisabled={actionDisabled}
              onInsert={onInsert}
              onSendNow={onSendNow}
              onManage={() => setManaging(true)}
            />
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

/** 单组条目列表（纯展示，供单测静态渲染锁定禁用属性） */
export function SnippetEntryList({
  scope,
  label,
  entries,
  actionDisabled,
  onInsert,
  onSendNow,
}: {
  scope: "project" | "global";
  label: string;
  entries: SnippetEntry[];
  actionDisabled: boolean;
  onInsert: (content: string) => void;
  onSendNow: (content: string) => void;
}) {
  return (
    <section data-testid={`snippet-group-${scope}`}>
      <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">{label}</h3>
      {entries.length === 0 ? (
        <p className="px-1 py-1 text-xs text-muted-foreground/60">暂无</p>
      ) : (
        <ul className="rounded-md border">
          {entries.map((entry, i) => (
            <li key={i} className="flex items-stretch border-b last:border-b-0">
              <button
                type="button"
                data-testid={`snippet-item-${scope}-${i}`}
                disabled={actionDisabled}
                onClick={() => onInsert(entry.content)}
                title={entry.content}
                className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center truncate px-2 py-2 text-left text-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
              >
                {snippetPreview(entry.content)}
              </button>
              <button
                type="button"
                data-testid={`snippet-send-${scope}-${i}`}
                aria-label={`直接发送：${snippetPreview(entry.content, 20)}`}
                disabled={actionDisabled}
                onClick={() => onSendNow(entry.content)}
                className="flex w-11 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <ArrowUp className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SnippetList({
  project,
  actionDisabled,
  onInsert,
  onSendNow,
  onManage,
}: {
  project: string | null;
  actionDisabled: boolean;
  onInsert: (content: string) => void;
  onSendNow: (content: string) => void;
  onManage: () => void;
}) {
  const [data, setData] = useState<{ global: SnippetEntry[]; project: SnippetEntry[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // effect 只发请求（oxlint set-state-in-effect 消警模式）；loading 用初始 state 表达
  useEffect(() => {
    let cancelled = false;
    api
      .listSnippets(project ?? undefined)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const empty = data !== null && data.global.length === 0 && (!project || data.project.length === 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <DialogTitle className="text-base font-medium">常用语</DialogTitle>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-11 gap-1 px-2 text-xs lg:h-8"
          onClick={onManage}
          data-testid="snippet-manage-open"
        >
          <Settings2 className="size-3.5" />
          管理
        </Button>
      </div>
      {!data && !loadError && <p className="text-xs text-muted-foreground/60">加载中…</p>}
      {loadError && (
        <p className="text-xs text-destructive" data-testid="snippet-error">
          {loadError}
        </p>
      )}
      {empty && (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
          data-testid="snippet-empty"
        >
          <MessageSquareText className="size-8 text-muted-foreground/40" aria-hidden />
          <p>还没有常用语，把常用指令存起来一键插入或发送</p>
          <Button type="button" variant="outline" onClick={onManage} data-testid="snippet-empty-manage">
            去管理
          </Button>
        </div>
      )}
      {data && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
          {project && (
            <SnippetEntryList
              scope="project"
              label={`项目常用语（${project.split("/").filter(Boolean).pop() ?? project}）`}
              entries={data.project}
              actionDisabled={actionDisabled}
              onInsert={onInsert}
              onSendNow={onSendNow}
            />
          )}
          <SnippetEntryList
            scope="global"
            label="全局常用语"
            entries={data.global}
            actionDisabled={actionDisabled}
            onInsert={onInsert}
            onSendNow={onSendNow}
          />
        </div>
      )}
    </div>
  );
}
