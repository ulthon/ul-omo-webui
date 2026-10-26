// 右栏多功能页签容器（C15 骨架）：中栏永久对话后，任务/变更/笔记/统计/记忆/子代理六页签收敛到右栏。
// 三处宿主由本组件统一渲染：桌面展开（lg 常驻，带拖宽分隔条）、桌面折叠窄条（w-10）、
// 手机固定右缘抽屉（<lg，勿套 --app-height，镜像左栏模式）；开合状态与记忆
// （ul-omo-webui:todo-panel-open）沿用既有契约由宿主（shell）持有传入。
// 宽度（桌面展开档）：默认 384、可拖 320-560——主区与右栏间指针拖拽分隔条
// （pointerdown/move/up + setPointerCapture），拖动中实时钳制，pointerup 才写
// localStorage ul-omo-webui:right-rail-width；读取时缺失/非数值/越界一律落回默认
// 384（钳制兜底：渲染层永远拿不到范围外宽度）。
// dirty 契约（原 shell 页签切换 guard 迁入）：NotesView 经 dirtyRef 上报编辑未保存，
// 切走时弹确认、取消停留原页签；页面刷新路径由 note-detail 的 beforeunload 承担未变。
// 页签面板 lazy：变更/笔记按需加载（react-diff-view / notes 组件本体不进首屏），
// 统计/记忆为静态轻组件（无重依赖，惰性反而闪 fallback）；todo 沿用静态 TodoPanel（首屏右栏常驻，惰性反而闪 fallback）。
// 六页签宽度（docs08-r6 任务 17 在 R4 五页签基础上加「子代理」）：桌面展开默认 384px 内
// zh 全档自然宽不溢出；en 档及拖窄至 <340px 时页签条横向滚动（shrink-0 + overflow-x-auto，
// 替代 R4 的 flex-1 等分——等分下 3 字标签（子代理）会 nowrap 溢出按钮盒，六页签所需宽
// 度已不可等分容纳）。触控目标高度 min-h-11 保持；不换行不截断语义保留（溢出改滚动）。
// oxlint-disable react/only-export-components -- 宽度记忆读写助手与组件强耦合（todo-panel 同款处置）
import { Suspense, lazy, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { FolderOpen, GitBranch, ListTodo, X } from "lucide-react";
import { MemoryPanel } from "@/components/chat/memory-panel";
import { StatPanel } from "@/components/chat/stat-panel";
import { SubagentPanel } from "@/components/chat/subagent-panel";
import { TodoPanel } from "@/components/chat/todo-panel";
import { OverviewPanel } from "@/components/layout/overview-panel";
import { useUiStore } from "@/stores/ui";
import { useT, type MessageKey } from "@/i18n/i18n";

const ChangesView = lazy(() =>
  import("@/components/diff/changes-view").then((m) => ({ default: m.ChangesView })),
);
const NotesView = lazy(() =>
  import("@/components/notes/notes-view").then((m) => ({ default: m.NotesView })),
);

export type RightRailTab = "overview" | "todo" | "changes" | "notes" | "stats" | "memory" | "agents";

// 页签标签键：完整点分路径字面量映射（i18n 死键检测要求键以字面量被引用）
const TAB_LABEL_KEY: Record<RightRailTab, MessageKey> = {
  overview: "login.rightRail.tabOverview",
  todo: "login.rightRail.tabTodo",
  changes: "login.rightRail.tabChanges",
  notes: "login.rightRail.tabNotes",
  stats: "login.rightRail.tabStats",
  memory: "login.rightRail.tabMemory",
  agents: "login.rightRail.tabAgents",
};

const TAB_IDS: RightRailTab[] = ["overview", "todo", "changes", "notes", "stats", "memory", "agents"];

/** 页签记忆 localStorage 键（r9 w2-t8）：值为合法 RightRailTab 字符串；
 *  无记录 / 非法值回退默认总览（仅首次进入生效，存量偏好不覆盖）。 */
const RAIL_TAB_KEY = "ul-omo-webui:right-rail-tab";

/** 页签记忆读取：无记录或非法值返回 null（调用方落默认总览） */
function readRailTabPreference(): RightRailTab | null {
  try {
    const raw = window.localStorage.getItem(RAIL_TAB_KEY);
    return TAB_IDS.includes(raw as RightRailTab) ? (raw as RightRailTab) : null;
  } catch {
    return null;
  }
}

/** 页签记忆写入：仅 switchTab 用户路径调用；storage 不可用静默降级 */
function writeRailTabPreference(tab: RightRailTab): void {
  try {
    window.localStorage.setItem(RAIL_TAB_KEY, tab);
  } catch {
    // storage 不可用：忽略（页面生命周期内 state 仍生效）
  }
}

/** 宽度记忆 localStorage 键与拖宽边界（px） */
const RAIL_WIDTH_KEY = "ul-omo-webui:right-rail-width";
const RAIL_WIDTH_MIN = 320;
const RAIL_WIDTH_MAX = 560;
const RAIL_WIDTH_DEFAULT = 384;

const TAB_CLASS = (active: boolean) =>
  `min-h-11 shrink-0 whitespace-nowrap rounded-lg px-1.5 py-1.5 text-sm transition-colors lg:min-h-9 lg:px-2 ${
    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
  }`;

/** 手机触控目标外链按钮（44px；与 shell 桌面第二层行同尺寸。A6 迁移：手机档外链
 * 入口自第二层行迁入本抽屉头部，配置键（external-git-url/external-files-url）与
 * 打开方式不变） */
const RAIL_EXTERNAL_LINK_CLASS =
  "flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";

/** 手机抽屉头部外链行（A6）：gitUrl/filesUrl 均未配置时整行不渲染 */
function DrawerExternalLinks() {
  const gitUrl = useUiStore((s) => s.externalLinks.gitUrl);
  const filesUrl = useUiStore((s) => s.externalLinks.filesUrl);
  const t = useT();
  if (!gitUrl && !filesUrl) return null;
  return (
    <div
      className="flex shrink-0 items-center justify-end gap-1 border-b px-2 py-1"
      data-testid="right-rail-drawer-external-links"
    >
      {gitUrl && (
        <a
          href={gitUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={t("login.rightRail.openGitLink")}
          title={t("login.rightRail.gitLinkTitle", { url: gitUrl })}
          className={RAIL_EXTERNAL_LINK_CLASS}
        >
          <GitBranch className="size-5" />
        </a>
      )}
      {filesUrl && (
        <a
          href={filesUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={t("login.rightRail.openFilesLink")}
          title={t("login.rightRail.filesLinkTitle", { url: filesUrl })}
          className={RAIL_EXTERNAL_LINK_CLASS}
        >
          <FolderOpen className="size-5" />
        </a>
      )}
    </div>
  );
}

/** 宽度记忆读取：无记录返回默认；手写异常值（9999/0/非数值等）落回默认 384 */
export function readRailWidthPreference(): number {
  try {
    const raw = window.localStorage.getItem(RAIL_WIDTH_KEY);
    if (raw === null) return RAIL_WIDTH_DEFAULT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < RAIL_WIDTH_MIN || value > RAIL_WIDTH_MAX) {
      return RAIL_WIDTH_DEFAULT;
    }
    return value;
  } catch {
    return RAIL_WIDTH_DEFAULT;
  }
}

/** 宽度记忆写入：仅在拖拽结束（pointerup）与键盘微调路径调用；storage 不可用静默降级 */
export function writeRailWidthPreference(width: number): void {
  try {
    window.localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  } catch {
    // storage 不可用：忽略（页面生命周期内 state 仍生效）
  }
}

function clampRailWidth(width: number): number {
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(width)));
}

function RailLoading({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{text}</div>;
}

function RailTabBar({ tab, onSwitch }: { tab: RightRailTab; onSwitch: (tab: RightRailTab) => void }) {
  const t = useT();
  return (
    <div role="tablist" aria-label={t("login.rightRail.views")} className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5">
      {TAB_IDS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          data-testid={`right-rail-tab-${id}`}
          onClick={() => onSwitch(id)}
          className={TAB_CLASS(tab === id)}
        >
          {t(TAB_LABEL_KEY[id])}
        </button>
      ))}
    </div>
  );
}

/** 当前页签面板体（桌面展开与手机抽屉共用）。onClose 仅 todo 页签消费：
 * 手机抽屉关抽屉、桌面展开收窄条，与既有 TodoPanel 收起钮语义一致。 */
function RailBody({
  tab,
  sessionId,
  notesDirtyRef,
  onClose,
}: {
  tab: RightRailTab;
  sessionId: string | null;
  notesDirtyRef: { current: boolean };
  onClose: () => void;
}) {
  const t = useT();
  if (tab === "todo") return <TodoPanel sessionId={sessionId} onClose={onClose} />;
  if (tab === "overview") return <OverviewPanel sessionId={sessionId} />;
  if (tab === "stats") return <StatPanel sessionId={sessionId} />;
  if (tab === "memory") return <MemoryPanel sessionId={sessionId} />;
  if (tab === "agents") return <SubagentPanel sessionId={sessionId} />;
  return (
    <Suspense fallback={<RailLoading text={tab === "notes" ? t("login.rightRail.loadingNotes") : t("login.rightRail.loadingChanges")} />}>
      {tab === "notes" ? <NotesView dirtyRef={notesDirtyRef} /> : <ChangesView />}
    </Suspense>
  );
}

/** 右栏容器：open/onToggle 由宿主传入（折叠记忆 ul-omo-webui:todo-panel-open 的既有机制不变）。
 *  sessionId 与会话视图同源派生；无选中会话时 todo/统计各自显示空态，
 *  变更/笔记按项目维度自带空态（原样挂载不改）。 */
export function RightRail({
  open,
  onToggle,
  sessionId,
}: {
  open: boolean;
  onToggle: () => void;
  sessionId: string | null;
}) {
  // 页签记忆（r9 w2-t8）：无存量偏好默认总览（首位），有则尊重存量；
  // 切页签时写回（读写同键一致，stale state 对抗口径）
  const [tab, setTab] = useState<RightRailTab>(() => readRailTabPreference() ?? "overview");
  // 笔记编辑未保存标记：NotesView 编辑态写入，切页签时读取做确认（契约自 shell 迁入）
  const notesDirtyRef = useRef(false);
  const [width, setWidth] = useState(() => readRailWidthPreference());
  // 拖拽中的实时宽度镜像：pointerup 写记忆需要最终值，state 异步读不到
  const widthRef = useRef(width);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const t = useT();
  // F-C：手机抽屉 Escape 关闭（仅 <lg 生效，桌面展开档不受影响）。
  // 抽屉打开时挂 document keydown，桌面视口（matchMedia lg 命中）直接放行。
  useEffect(() => {
    if (!open) return;
    const onDrawerKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (window.matchMedia("(min-width: 1024px)").matches) return;
      onToggle();
    };
    document.addEventListener("keydown", onDrawerKeyDown);
    return () => document.removeEventListener("keydown", onDrawerKeyDown);
  }, [open, onToggle]);

  const switchTab = (next: RightRailTab) => {
    if (tab === "notes" && next !== "notes" && notesDirtyRef.current) {
      if (!window.confirm(t("login.rightRail.confirmLeaveNotes"))) return;
    }
    setTab(next);
    writeRailTabPreference(next);
  };

  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: widthRef.current };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = clampRailWidth(drag.startWidth + (drag.startX - e.clientX));
    widthRef.current = next;
    setWidth(next);
  };
  // pointerup：落记忆；pointercancel（拖拽中窗口失焦/系统中断）：只终止拖拽，
  // 宽度已实时钳制不破版，记忆留给下次完整拖拽
  const onHandlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    writeRailWidthPreference(widthRef.current);
  };
  const onHandlePointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  // 键盘微调（可聚焦分隔条）：左右方向键 ±16px 并即时记忆
  const onHandleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clampRailWidth(widthRef.current + (e.key === "ArrowLeft" ? 16 : -16));
    widthRef.current = next;
    setWidth(next);
    writeRailWidthPreference(next);
  };

  return (
    <>
      {/* 桌面（lg+）展开：拖宽分隔条 + 五页签栏 + 面板体。分隔条绝对定位骑跨左缘边框，
          w-1.5 命中区 + hover/focus 视觉反馈；宽度内联样式承载拖宽 */}
      {open ? (
        <aside
          aria-label={t("login.rightRail.rail")}
          data-testid="right-rail"
          className="relative hidden shrink-0 flex-col border-l bg-background lg:flex"
          style={{ width }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("login.rightRail.resizeHandle")}
            aria-valuenow={width}
            aria-valuemin={RAIL_WIDTH_MIN}
            aria-valuemax={RAIL_WIDTH_MAX}
            tabIndex={0}
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerCancel}
            onKeyDown={onHandleKeyDown}
            className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
          />
          <RailTabBar tab={tab} onSwitch={switchTab} />
          <div className="min-h-0 flex-1">
            <RailBody tab={tab} sessionId={sessionId} notesDirtyRef={notesDirtyRef} onClose={onToggle} />
          </div>
        </aside>
      ) : (
        <aside
          aria-label={t("login.rightRail.railCollapsed")}
          className="hidden w-10 shrink-0 flex-col items-center border-l bg-background py-2 lg:flex"
        >
          <button
            type="button"
            aria-label={t("login.rightRail.expandRail")}
            title={t("login.rightRail.expandRail")}
            onClick={onToggle}
            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <ListTodo className="size-4" />
          </button>
        </aside>
      )}

      {/* F-C：手机抽屉背板（仅 <lg 显示，z-[44] 低于抽屉 z-[45]），点击关闭；
          桌面档 lg:hidden 隐藏，桌面布局零改动 */}
      {open && (
        <div
          data-testid="right-rail-drawer-backdrop"
          aria-hidden="true"
          onClick={onToggle}
          className="fixed inset-0 z-[44] bg-black/40 lg:hidden"
        />
      )}

      {/* 手机（<lg）：固定右缘抽屉，镜像左栏模式（inset-y-0 维持——iOS 软键盘收缩会
          截断抽屉底部）；z-[45] 高于左抽屉 z-40、低于 toast z-50（沿用 W5-15 结论）。
          A6：头部承载自第二层行迁入的 git/files 外链（桌面折叠条不受影响）。
          F-C：头部行补全页签通用关闭钮（沿 TodoPanel 收起钮形态），修复非 Tasks
          页签无关闭口抽屉困局 */}
      <aside
        aria-label={t("login.rightRail.rail")}
        data-testid="right-rail-drawer"
        className={`fixed inset-y-0 right-0 z-[45] flex w-80 flex-col border-l bg-background transition-transform duration-200 lg:hidden ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex shrink-0 items-center justify-end border-b px-2 py-1">
          <button
            type="button"
            aria-label={t("login.rightRail.collapseRail")}
            data-testid="right-rail-drawer-close"
            title={t("login.rightRail.collapseRail")}
            onClick={onToggle}
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <DrawerExternalLinks />
        <RailTabBar tab={tab} onSwitch={switchTab} />
        <div className="min-h-0 flex-1">
          <RailBody tab={tab} sessionId={sessionId} notesDirtyRef={notesDirtyRef} onClose={onToggle} />
        </div>
      </aside>
    </>
  );
}
