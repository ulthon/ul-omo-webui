// 后台活动条（r10 todo 11）：会话页常驻 chrome（计划 IS 行"会话页面板常驻活动条"，
// 会话页级新表面，桌面/手机两断点同构渲染，不触碰既有桌面表面）。
// 数据源 = tasks store（omo.task.updated 全量快照，event-dispatch 分流，零轮询）。
// 有非空快照才渲染（首帧出现、后续帧推进、空快照消失，三态皆帧驱动）；
// 点标题行展开/收起任务列表（仅列运行中，限高滚动；已完成折为尾部计数行）。
// r11 todo 3：展开列表 max-h-64 仅列进行中，已完成折计数；折叠主数字为运行中数。
import { useState } from "react";
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { useTasksStore } from "@/stores/tasks";
import { useT } from "@/i18n/i18n";

export function ActivityBar({ sessionId }: { sessionId: string }) {
  const tasks = useTasksStore((s) => s.bySession[sessionId]);
  const [expanded, setExpanded] = useState(false);
  const t = useT();
  const list = tasks ?? [];
  if (list.length === 0) return null;
  const runningList = list.filter((task) => task.status === "running");
  const running = runningList.length;
  const done = list.length - running;

  return (
    <div data-testid="activity-bar" className="rounded-lg border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
      <button
        type="button"
        data-testid="activity-bar-toggle"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        )}
        <LoaderCircle
          data-testid={running > 0 ? "activity-bar-spinner" : undefined}
          className={`size-3.5 shrink-0 ${running > 0 ? "animate-spin" : "opacity-50"}`}
          aria-hidden
        />
        <span className="shrink-0 tabular-nums">{t("chat.activity.barTitle", { n: running })}</span>
        {done > 0 && (
          <span className="min-w-0 truncate opacity-70">{t("chat.activity.doneCount", { n: done })}</span>
        )}
      </button>
      {expanded && (
        <ul data-testid="activity-task-list" className="mt-0.5 max-h-64 space-y-0.5 overflow-y-auto">
          {runningList.map((task) => (
            <li key={task.id} data-testid="activity-task" className="flex items-center gap-1.5">
              <span
                data-testid="activity-task-status"
                className={`shrink-0 rounded-sm border bg-background px-1 py-px leading-4 ${
                  task.status === "running" ? "text-foreground" : ""
                }`}
              >
                {task.status === "running" ? t("chat.activity.statusRunning") : t("chat.activity.statusDone")}
              </span>
              <span className="min-w-0 flex-1 truncate" title={task.label}>
                {task.label}
              </span>
            </li>
          ))}
          {done > 0 && (
            <li data-testid="activity-done-count" className="opacity-70">
              {t("chat.activity.doneCount", { n: done })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
