// oxlint-disable react/only-export-components -- buildForkIndexes/formatRelative 纯函数随组件同文件导出（W3 todo 10 单列表契约，todo-panel 先例）
// 会话列表行（W3 todo 10 单列表重构）：状态点（运行中/等待权限/空闲/出错，SSE runStates 优先、
// 引擎探询 active 兜底）+ 标题（fork 行带「(fork #N)」后缀，编号 = 同父兄弟按 sessionPath 序，
// 列表加载时由 session-list 经 buildForkIndexes 一次算好传入）+ 来源标识（fork 子会话 GitFork
// 徽标；人工创建不显标，docs08-r3 C14 紧凑化）+ 标签徽标（todo 11，最多 1 + N、孤儿灰显可清理）
// + 未读徽标 + 相对时间（docs08-r5 任务 11 紧凑格式：Ns/Nm/Nh/Nd/M/D，跨年 YY/M/D，对标 OC 不汉化）
// + 子会话行内展开（唯一视图：点 chevron 展开/收起；knownChildren 已带则免请求，
// 否则懒加载后按血缘过滤——旧「人工视图钻取」入口语义由行内展开吸收）
// + 元数据操作菜单（置顶/重命名/生成标题/归档/复制会话 ID/复制标题/导出 HTML/标签/删除——
// 重命名与删除弹窗由父级单例托管，标签走锚定下拉（docs08-r3 任务 13，锚点=行菜单钮））。
import { useRef, useState } from "react";
import { ChevronRight, Copy, Download, GitFork, Hash, Loader2, MoreVertical, Pin, Sparkles, SquarePen, SquareCheckBig, Square, Tag, Trash2, Archive, ArchiveRestore, PinOff } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { SessionListItem } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useSessionsStore, type SessionRunState } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { t } from "@/i18n/i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TagBadges } from "./tag-badge";

/** 紧凑相对时间（docs08-r5 任务 11 对标 OC：数字+字母不汉化——汉字占宽大）：<60s → Ns；
 *  <60m → Nm；<24h → Nh；<30d → Nd；≥30d → M/D（跨年 YY/M/D）。未来时间（时钟偏移）
 *  按 0s 钳制；非法 ISO 返回空串。导出供全档位单测（task-11）。 */
export function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "";
  const date = new Date(iso);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${Math.max(s, 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const year = date.getFullYear();
  if (year !== new Date().getFullYear()) return `${String(year).slice(-2)}/${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function StatusDot({ runState, active }: { runState: SessionRunState | null; active: boolean | null }) {
  // runStates 一旦有值即权威（SSE 见过事件）；null 才回落引擎探询的 active（不回落，仅初始参考）
  let cls = "bg-muted-foreground/30";
  let title = t("sessionList.item.statusIdle");
  if (runState === "waiting") {
    cls = "bg-amber-500 animate-pulse";
    title = t("sessionList.item.statusWaiting");
  } else if (runState === "error") {
    cls = "bg-destructive";
    title = t("sessionList.item.statusError");
  } else if (runState === "running" || (runState === null && active === true)) {
    cls = "bg-sky-500 animate-pulse";
    title = t("sessionList.item.statusRunning");
  }
  return <span className={`size-1.5 shrink-0 rounded-full ${cls}`} title={title} />;
}

/** 来源标识（W3 todo 10 改名；docs08-r3 C14 紧凑化删「人工」分支——仅 fork 子会话显标，
 * 人工创建无徽标，行内不再有恒显的来源噪音）。 */
function SourceBadge({ session }: { session: SessionListItem }) {
  if (!session.parentSessionPath) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 rounded border bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground"
      title={t("sessionList.item.forkedFrom", { path: session.parentSessionPath })}
    >
      <GitFork className="size-2.5" />
      fork
    </span>
  );
}

/**
 * fork 编号（W3 todo 10）：fork 会话标题后缀「(fork #N)」的 N = 同父兄弟中按 sessionPath
 * 升序的位次（sessionPath 文件名以 ISO 时间戳开头，≈ 创建顺序）。列表加载时对整份数据
 * 算一次并缓存（session-list useMemo），避免每次渲染重排导致编号抖动。
 * 键取会话 path（血缘身份，id 在占位换名场景会变）。非 fork 会话不进表。
 */
export function buildForkIndexes(sessions: SessionListItem[]): Map<string, number> {
  const byParent = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    if (!s.parentSessionPath) continue;
    const list = byParent.get(s.parentSessionPath);
    if (list) list.push(s);
    else byParent.set(s.parentSessionPath, [s]);
  }
  const out = new Map<string, number>();
  for (const siblings of byParent.values()) {
    siblings
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .forEach((s, i) => out.set(s.path, i + 1));
  }
  return out;
}

export interface SessionItemProps {
  session: SessionListItem;
  /** fork 编号表（W3 todo 10）：列表加载时由 session-list 经 buildForkIndexes 一次算好传入；
   * fork 行查到编号即渲染标题后缀「(fork #N)」，缺表/未命中（如搜索结果不在主列表数据集）不显示后缀 */
  forkIndexes?: Map<string, number>;
  /** 搜索模式下显示来源项目名（basename） */
  projectLabel?: string;
  /** 列表已随响应带出的子会话（省一次懒加载请求）；缺省走懒加载 */
  knownChildren?: SessionListItem[];
  /** 是否可展开子会话（顶层会话 true，子会话行 false） */
  expandable: boolean;
  /** 打开重命名/删除弹窗（父级单例托管）；"标签" 打开锚定下拉（父级接线，任务 13；
   *  anchor = 行菜单钮元素，供父级把 TagDropdown 锚定到本行） */
  onDialog: (kind: "rename" | "delete" | "tags", session: SessionListItem, anchor?: HTMLElement) => void;
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

export function SessionItem({ session, forkIndexes, projectLabel, knownChildren, expandable, onDialog, onSelect, onChanged, selectable, checked, onToggleCheck, definedKeys }: SessionItemProps) {
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
  // 行菜单钮（"标签"锚定下拉的锚点元素；菜单项 onSelect 时菜单已关、按钮仍挂载，矩形稳定）
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  // 展示用子会话：懒加载结果优先，否则用列表已带出的 knownChildren（props 会变，
  // 不能在 useState 初始值里固化——那会拿不到首屏之后才出现的数据）
  const childRows = children ?? knownChildren ?? [];
  const hasKnownChildren = knownChildren !== undefined && knownChildren.length > 0;

  /** 行内展开/收起（W3 todo 10：唯一视图的子会话展开入口，展开态为本次会话内的瞬态）。
   * 首次展开且子会话未随列表带出时才走懒加载（archived=all，按血缘过滤）；
   * knownChildren 已带则免请求——旧 childrenOpen 平铺路径删除后由此保证契约。 */
  const toggle = async () => {
    if (!expanded && children === null && !hasKnownChildren) {
      setLoadingChildren(true);
      try {
        const res = await api.listSessions({ project: session.project, archived: "all" });
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

  // fork 标题后缀（W3 todo 10）：编号表命中才显示（搜索结果不在主列表数据集时自然缺省）
  const forkIndex = session.parentSessionPath ? forkIndexes?.get(session.path) : undefined;

  /** 复制会话 ID / 标题（A8）：一律走降级助手（纯 HTTP 非安全源 navigator.clipboard 恒 undefined，
   * 禁止裸用 clipboard API），按返回布尔 toast。复制的是点击时刻的 props 快照值——
   * 菜单打开期间会话被重命名不影响本次复制结果（stale 即语义）。 */
  const copyField = async (text: string, label: string) => {
    const ok = await copyText(text);
    showToast(ok ? `已复制${label}` : "复制失败（浏览器未授权剪贴板）", ok ? undefined : "error");
  };

  return (
    <div>
      {/* 行密度（2026-10-15 对标 OpenChamber，双端一起压；docs08-r5 任务 11 行高保持不变）：
          手机 = py-1 + 子件 ≤32px → 40px 行；桌面 = lg:py-2 → 36px 行（菜单钮桌面改为绝对定位
          脱离文档流后，行高改由内边距维持）；行间距为零（相邻 div 贴排），信息密度以文字为主。 */}
      <div
        className={`group relative flex items-center gap-1 rounded-md px-1.5 py-1 text-sm lg:py-2 ${
          selected ? "bg-primary/10" : "hover:bg-accent/50"
        }`}
      >
        {/* 选中态双信号之二：行首 2px primary 竖条（C13）。inset-y-1 + rounded-full
            做圆角补偿——竖条圆头收进行圆角内，不与 rounded-md 行角打架；与
            hover:bg-accent/50（无竖条无 primary 底）彻底拉开。 */}
        {selected && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />}
        {/* 批量选择框（行首；勾选集合提升到 session-list） */}
        {selectable && (
          <button
            type="button"
            role="checkbox"
            aria-checked={!!checked}
            aria-label={t("sessionList.item.selectSession", { title: session.title })}
            className="flex size-8 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground lg:size-5"
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
            aria-label={expanded ? t("sessionList.item.collapseChildren") : t("sessionList.item.expandChildren")}
            className={`flex size-7 shrink-0 items-center justify-center rounded hover:bg-muted lg:size-4 ${
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
          <span className="size-7 shrink-0 lg:size-4" />
        )}
        <StatusDot runState={runState} active={session.active} />

        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={handleSelect}>
          {/* min-w-9：极端挤压（超长标题+多徽标窄行）下标题保底 2 字符宽，
              防止 truncate 的 flex 收缩极值把标题压成 0 宽（overflow hidden 使
              min-width:auto 失效，无此下限会整段消失） */}
          <span className={`min-w-9 truncate ${session.archivedAt ? "text-muted-foreground" : ""}`} title={session.title}>
            {session.pinned && <Pin className="mr-1 inline size-3 shrink-0 align-[-1px] text-muted-foreground" />}
            {forkIndex ? `${session.title} (fork #${forkIndex})` : session.title}
          </span>
          <SourceBadge session={session} />
          <TagBadges session={session} definedKeys={definedKeys ?? null} />
          {session.archivedAt && (
            <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground">
              {t("sessionList.item.archivedBadge")}
            </span>
          )}
          {projectLabel && (
            <span className="shrink min-w-0 truncate rounded bg-muted px-1 py-px text-[10px] leading-none text-muted-foreground" title={session.project}>
              {projectLabel}
            </span>
          )}
          {/* 相对时间（紧凑格式，docs08-r5 任务 11）双端常显；桌面 hover 时隐藏，行尾菜单钮
              绝对定位叠加到同一槽位（时间隐/菜单显，回收菜单常占宽度）；菜单打开期间
              （data-state=open）保持隐藏——invisible 保布局零跳版，min-w-0 truncate 收缩
              防线与未读 shrink-0 保位不变 */}
          <span className="ml-auto shrink min-w-0 truncate text-[11px] text-muted-foreground/70 lg:group-hover:invisible lg:group-has-[[data-state=open]]:invisible">{formatRelative(session.modified)}</span>
          {session.unreadCount > 0 && (
            <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground">
              {session.unreadCount > 99 ? "99+" : session.unreadCount}
            </span>
          )}
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* 手机常显（无 hover 可言）；触控目标 32px（2026-10-15 密度对标由 44px 收窄——
                选中主目标=整行 40px 全宽，菜单是次要动作，OC 同款量级；行高不再被按钮撑到 52px）。
                桌面（docs08-r5 任务 11 对标 OC）：absolute 定位到行尾时间同一槽位，group-hover
                交换显隐（时间隐/菜单显），回收 32px 常占宽度；菜单打开（data-state=open）与
                键盘 focus-visible 时不随 hover 消失。行高改由 lg:py-2 维持（见行容器注释） */}
            <Button
              ref={menuBtnRef}
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 opacity-100 transition-opacity focus-visible:opacity-100 data-[state=open]:opacity-100 lg:absolute lg:right-1.5 lg:top-1/2 lg:-translate-y-1/2 lg:opacity-0 lg:group-hover:opacity-100"
              aria-label={t("sessionList.item.sessionActions")}
            >
              <MoreVertical className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem disabled={busy} onSelect={() => void patch({ pinned: !session.pinned })}>
              {session.pinned ? <PinOff className="mr-2 size-4" /> : <Pin className="mr-2 size-4" />}
              {session.pinned ? t("sessionList.item.unpin") : t("sessionList.item.pin")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => onDialog("rename", session)}>
              <SquarePen className="mr-2 size-4" />
              {t("sessionList.item.rename")}
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
              {generatingTitle ? t("sessionList.item.generating") : t("sessionList.item.generateTitle")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => void patch({ archived: !session.archivedAt })}>
              {session.archivedAt ? <ArchiveRestore className="mr-2 size-4" /> : <Archive className="mr-2 size-4" />}
              {session.archivedAt ? t("sessionList.item.unarchive") : t("sessionList.item.archive")}
            </DropdownMenuItem>
            {/* 任务11 递延：copyField 的 label 实参随 toast 文案一并迁移，此处仅迁移菜单可见文案 */}
            <DropdownMenuItem data-testid="item-copy-id" onSelect={() => void copyField(session.id, "会话 ID")}>
              <Hash className="mr-2 size-4" />
              {t("sessionList.item.copyId")}
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="item-copy-title" onSelect={() => void copyField(session.title, "标题")}>
              <Copy className="mr-2 size-4" />
              {t("sessionList.item.copyTitle")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={exporting} onSelect={() => void exportHtml()}>
              {exporting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
              {t("sessionList.item.exportHtml")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => onDialog("tags", session, menuBtnRef.current ?? undefined)}
              data-testid="item-tags"
            >
              <Tag className="mr-2 size-4" />
              {t("sessionList.item.tags")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} className="text-destructive focus:text-destructive" onSelect={() => onDialog("delete", session)}>
              <Trash2 className="mr-2 size-4" />
              {t("common.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 子会话行内展开（W3 todo 10：仅展开时渲染，缩进一层；血缘 = parentSessionPath 关联，
          omo task 子会话不落盘天然不出现）。fork 编号表透传子行保持后缀连续。 */}
      {expandable && expanded && (
        <div className="ml-4 border-l pl-1.5">
          {childRows.length === 0 && !loadingChildren ? (
            <div className="px-2 py-1 text-xs text-muted-foreground/60">{t("sessionList.item.noChildren")}</div>
          ) : (
            childRows.map((child) => (
              <SessionItem
                key={child.id}
                session={child}
                forkIndexes={forkIndexes}
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
