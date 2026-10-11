// 会话列表行（计划 todo 15）：状态点（运行中/等待权限/空闲/出错，SSE runStates 优先、
// 引擎探询 active 兜底）+ 标题 + 来源标识（人工/agent 创建——引擎无 agent 协议面，
// agent 名徽标以通用 "agent" 标记呈现，字段就绪后在此接入）+ 标签徽标（todo 11，最多 3 + N、
// 孤儿灰显可清理）+ 未读徽标 + 相对时间
// + 子会话钻取（knownChildren 已带则免请求，否则懒加载 view=all 按血缘过滤）
// + 元数据操作菜单（置顶/重命名/归档/标签/删除——重命名与删除弹窗由父级单例托管，标签走选择器）。
import { useState } from "react";
import { Bot, ChevronRight, Download, Loader2, MoreVertical, Pin, Sparkles, SquarePen, SquareCheckBig, Square, Tag, Trash2, User, Archive, ArchiveRestore, PinOff } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { SessionListItem } from "@/lib/api";
import { useSessionsStore, type SessionRunState } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TagBadges } from "./tag-badge";

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString();
}

function StatusDot({ runState, active }: { runState: SessionRunState | null; active: boolean | null }) {
  // runStates 一旦有值即权威（SSE 见过事件）；null 才回落引擎探询的 active（不回落，仅初始参考）
  let cls = "bg-muted-foreground/30";
  let title = "空闲";
  if (runState === "waiting") {
    cls = "bg-amber-500 animate-pulse";
    title = "等待权限";
  } else if (runState === "error") {
    cls = "bg-destructive";
    title = "出错";
  } else if (runState === "running" || (runState === null && active === true)) {
    cls = "bg-sky-500 animate-pulse";
    title = "运行中";
  }
  return <span className={`size-1.5 shrink-0 rounded-full ${cls}`} title={title} />;
}

/** 来源标识：人工/agent 创建（docs/01 会话来源标识）。仅钻取展开与"全部活动"/搜索视图显示。 */
function SourceBadge({ session }: { session: SessionListItem }) {
  if (session.parentSessionPath) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-0.5 rounded border bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground"
        title={`agent 创建的子会话（fork 自 ${session.parentSessionPath}）`}
      >
        <Bot className="size-2.5" />
        agent
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 rounded border bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground"
      title="人工创建"
    >
      <User className="size-2.5" />
      人工
    </span>
  );
}

export interface SessionItemProps {
  session: SessionListItem;
  /** 来源标识可见性：human 视图顶层不显示（全是人工，冗余） */
  showSource: boolean;
  /** 搜索模式下显示来源项目名（basename） */
  projectLabel?: string;
  /** all 视图下已随列表带出的子会话（省一次懒加载请求）；human 视图缺省走懒加载 */
  knownChildren?: SessionListItem[];
  /** 是否可钻取子会话（顶层会话 true，子会话行 false） */
  expandable: boolean;
  /** "全部活动"视图：子会话随血缘直接平铺显示（免点击展开） */
  childrenOpen?: boolean;
  /** 打开重命名/删除弹窗（父级单例托管）；"标签" 打开选择器（父级接线，todo 11） */
  onDialog: (kind: "rename" | "delete" | "tags", session: SessionListItem) => void;
  /** 两源定义键集（todo 11 徽标孤儿判定；null = 定义未就绪不渲染徽标） */
  definedKeys?: Set<string> | null;
  /** 选中行为覆盖（todo 10 跨项目统一 handler）：缺省仅 select + 收抽屉；
   * 全局视图下由 session-list 传入共享 handler（跨项目轻量切换 currentProject + 应用偏好） */
  onSelect?: (session: SessionListItem) => void;
  /** 元数据/删除成功后回调（父级刷新列表与搜索结果） */
  onChanged: () => void;
  /** 批量模式（todo 25）：行首渲染选择框，勾选集合提升到 session-list 容器 */
  selectable?: boolean;
  checked?: boolean;
  onToggleCheck?: (session: SessionListItem) => void;
}

export function SessionItem({ session, showSource, projectLabel, knownChildren, expandable, childrenOpen, onDialog, onSelect, onChanged, selectable, checked, onToggleCheck, definedKeys }: SessionItemProps) {
  const runState = useSessionsStore((s) => s.runStates[session.id] ?? null);
  const selected = useSessionsStore((s) => s.selectedId === session.id);
  const select = useSessionsStore((s) => s.select);
  const showToast = useUiStore((s) => s.showToast);

  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<SessionListItem[] | null>(null);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [generatingTitle, setGeneratingTitle] = useState(false);
  // 展示用子会话：懒加载结果优先，否则用 all 视图已带的 knownChildren（视图切换后 props 会变，
  // 不能在 useState 初始值里固化——那会让 all 视图拿不到 human 期之后才出现的数据）
  const childRows = children ?? knownChildren ?? [];

  const toggle = async () => {
    if (!expanded && children === null) {
      setLoadingChildren(true);
      try {
        const res = await api.listSessions({ project: session.project, view: "all", archived: "all" });
        setChildren(res.sessions.filter((s) => s.parentSessionPath === session.path));
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) {
          showToast("子会话加载失败", "error");
        }
      } finally {
        setLoadingChildren(false);
      }
    }
    setExpanded((v) => !v);
  };

  const patch = async (p: { pinned?: boolean; archived?: boolean }) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.patchSessionMeta(session.id, p);
      useSessionsStore.getState().patchSession(session.id, {
        ...(p.pinned !== undefined ? { pinned: p.pinned } : {}),
        ...(p.archived !== undefined ? { archivedAt: p.archived ? new Date().toISOString() : null } : {}),
      });
      onChanged();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "操作失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleSelect = () => {
    if (onSelect) {
      onSelect(session);
      return;
    }
    select(session.id);
    // todo 26 走查修复：抽屉态（lg 以下）选中会话后自动收起——390 宽下 w-72 抽屉遮住主区，
    // 不收起时用户看到的还是抽屉；桌面抽屉常驻此调用无视觉效果。
    useUiStore.getState().setDrawerOpen(false);
  };

  /** 单会话导出 HTML（todo 25）：GET /:id/export attachment 下载，文件名由服务端给出 */
  const exportHtml = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await api.exportSession(session.id, session.title);
      showToast("已导出 HTML");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "导出失败", "error");
    } finally {
      setExporting(false);
    }
  };

  /** 手动生成标题（W3 todo 12）：成功写 renamedTitle 并同步 patch 行 title（title 是服务端
   * 合并值 renamedTitle ?? name ?? firstMessage，只 patch renamedTitle 行显示会滞留旧值）；
   * 失败 toast 原因（502 message）。菜单项 onSelect preventDefault 保持打开以显示请求中
   * Loader 态，完成后 toast 反馈、点外关闭。 */
  const generateTitle = async () => {
    if (generatingTitle) return;
    setGeneratingTitle(true);
    try {
      const { title } = await api.generateTitle(session.id);
      useSessionsStore.getState().patchSession(session.id, { title, renamedTitle: title });
      showToast("标题已生成");
      onChanged();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "标题生成失败", "error");
    } finally {
      setGeneratingTitle(false);
    }
  };

  const hasKnownChildren = knownChildren !== undefined && knownChildren.length > 0;

  return (
    <div>
      <div
        className={`group flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm ${
          selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
        }`}
      >
        {/* 批量选择框（行首；勾选集合提升到 session-list） */}
        {selectable && (
          <button
            type="button"
            role="checkbox"
            aria-checked={!!checked}
            aria-label={`选择会话：${session.title}`}
            className="flex size-11 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground lg:size-5"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCheck?.(session);
            }}
          >
            {checked ? <SquareCheckBig className="size-3.5 text-primary" /> : <Square className="size-3.5" />}
          </button>
        )}
        {expandable ? (
          <button
            type="button"
            aria-label={expanded ? "收起子会话" : "展开子会话"}
            className={`flex size-11 shrink-0 items-center justify-center rounded hover:bg-muted lg:size-4 ${
              hasKnownChildren ? "text-muted-foreground" : "text-muted-foreground/40"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              void toggle();
            }}
          >
            {loadingChildren ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
            )}
          </button>
        ) : (
          <span className="size-11 shrink-0 lg:size-4" />
        )}
        <StatusDot runState={runState} active={session.active} />

        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={handleSelect}>
          <span className={`truncate ${session.archivedAt ? "text-muted-foreground" : ""}`} title={session.title}>
            {session.pinned && <Pin className="mr-1 inline size-3 shrink-0 align-[-1px] text-muted-foreground" />}
            {session.title}
          </span>
          {showSource && <SourceBadge session={session} />}
          <TagBadges session={session} definedKeys={definedKeys ?? null} />
          {session.archivedAt && (
            <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground">已归档</span>
          )}
          {projectLabel && (
            <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground" title={session.project}>
              {projectLabel}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/70">{formatRelative(session.modified)}</span>
          {session.unreadCount > 0 && (
            <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground">
              {session.unreadCount > 99 ? "99+" : session.unreadCount}
            </span>
          )}
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* todo 26 走查修复：手机无 hover，opacity-0 使操作菜单不可达——lg 以下常显；
                触控目标 44px（lg 保持桌面紧凑 32px） */}
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 opacity-100 transition-opacity data-[state=open]:opacity-100 lg:size-8 lg:opacity-0 lg:group-hover:opacity-100"
              aria-label="会话操作"
            >
              <MoreVertical className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem disabled={busy} onSelect={() => void patch({ pinned: !session.pinned })}>
              {session.pinned ? <PinOff className="mr-2 size-4" /> : <Pin className="mr-2 size-4" />}
              {session.pinned ? "取消置顶" : "置顶"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => onDialog("rename", session)}>
              <SquarePen className="mr-2 size-4" />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={generatingTitle}
              data-testid="item-generate-title"
              onSelect={(e) => {
                e.preventDefault();
                void generateTitle();
              }}
            >
              {generatingTitle ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Sparkles className="mr-2 size-4" />}
              {generatingTitle ? "生成中…" : "生成标题"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => void patch({ archived: !session.archivedAt })}>
              {session.archivedAt ? <ArchiveRestore className="mr-2 size-4" /> : <Archive className="mr-2 size-4" />}
              {session.archivedAt ? "取消归档" : "归档"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={exporting} onSelect={() => void exportHtml()}>
              {exporting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
              导出 HTML
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => onDialog("tags", session)} data-testid="item-tags">
              <Tag className="mr-2 size-4" />
              标签
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} className="text-destructive focus:text-destructive" onSelect={() => onDialog("delete", session)}>
              <Trash2 className="mr-2 size-4" />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 子会话钻取（缩进一层；血缘 = parentSessionPath 关联，omo task 子会话不落盘天然不出现）。
          "全部活动"视图 childrenOpen 直接平铺（knownChildren 已带，无需懒加载）。 */}
      {expandable && (expanded || (childrenOpen && knownChildren !== undefined)) && (
        <div className="ml-4 border-l pl-1.5">
          {(childRows.length === 0 && !loadingChildren && !childrenOpen) ? (
            <div className="px-2 py-1 text-xs text-muted-foreground/60">无子会话</div>
          ) : (
            childRows.map((child) => (
              <SessionItem
                key={child.id}
                session={child}
                showSource
                expandable={false}
                onDialog={onDialog}
                onSelect={onSelect}
                onChanged={onChanged}
                selectable={selectable}
                checked={checked}
                onToggleCheck={onToggleCheck}
                definedKeys={definedKeys}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
