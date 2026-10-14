// 右栏多功能页签容器（C15 骨架）：中栏永久对话后，任务/变更/笔记/统计四页签收敛到右栏。
// 三处宿主由本组件统一渲染：桌面展开（lg 常驻，带拖宽分隔条）、桌面折叠窄条（w-10）、
// 手机固定右缘抽屉（<lg，勿套 --app-height，镜像左栏模式）；开合状态与记忆
// （senpi-webui:todo-panel-open）沿用既有契约由宿主（shell）持有传入。
// 宽度（桌面展开档）：默认 384、可拖 320-560——主区与右栏间指针拖拽分隔条
// （pointerdown/move/up + setPointerCapture），拖动中实时钳制，pointerup 才写
// localStorage senpi-webui:right-rail-width；读取时缺失/非数值/越界一律落回默认
// 384（钳制兜底：渲染层永远拿不到范围外宽度）。
// dirty 契约（原 shell 页签切换 guard 迁入）：NotesView 经 dirtyRef 上报编辑未保存，
// 切走时弹确认、取消停留原页签；页面刷新路径由 note-detail 的 beforeunload 承担未变。
// 页签面板 lazy：变更/笔记按需加载（react-diff-view / notes 组件本体不进首屏），
// 统计为静态 StatPanel（组件轻、无重依赖）；todo 沿用静态 TodoPanel（首屏右栏常驻，惰性反而闪 fallback）。
// oxlint-disable react/only-export-components -- 宽度记忆读写助手与组件强耦合（todo-panel 同款处置）
import { Suspense, lazy, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ListTodo } from "lucide-react";
import { StatPanel } from "@/components/chat/stat-panel";
import { TodoPanel } from "@/components/chat/todo-panel";

const ChangesView = lazy(() =>
  import("@/components/diff/changes-view").then((m) => ({ default: m.ChangesView })),
);
const NotesView = lazy(() =>
  import("@/components/notes/notes-view").then((m) => ({ default: m.NotesView })),
);

export type RightRailTab = "todo" | "changes" | "notes" | "stats";

const TABS: { id: RightRailTab; label: string }[] = [
  { id: "todo", label: "任务" },
  { id: "changes", label: "变更" },
  { id: "notes", label: "笔记" },
  { id: "stats", label: "统计" },
];

/** 宽度记忆 localStorage 键与拖宽边界（px） */
const RAIL_WIDTH_KEY = "senpi-webui:right-rail-width";
const RAIL_WIDTH_MIN = 320;
const RAIL_WIDTH_MAX = 560;
const RAIL_WIDTH_DEFAULT = 384;

const TAB_CLASS = (active: boolean) =>
  `min-h-11 flex-1 rounded-lg px-2 py-1.5 text-sm transition-colors lg:min-h-9 ${
    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
  }`;

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
  return (
    <div role="tablist" aria-label="右栏视图" className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          data-testid={`right-rail-tab-${t.id}`}
          onClick={() => onSwitch(t.id)}
          className={TAB_CLASS(tab === t.id)}
        >
          {t.label}
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
  if (tab === "todo") return <TodoPanel sessionId={sessionId} onClose={onClose} />;
  if (tab === "stats") return <StatPanel sessionId={sessionId} />;
  return (
    <Suspense fallback={<RailLoading text={tab === "notes" ? "加载笔记视图…" : "加载变更视图…"} />}>
      {tab === "notes" ? <NotesView dirtyRef={notesDirtyRef} /> : <ChangesView />}
    </Suspense>
  );
}

/** 右栏容器：open/onToggle 由宿主传入（折叠记忆 senpi-webui:todo-panel-open 的既有机制不变）。
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
  const [tab, setTab] = useState<RightRailTab>("todo");
  // 笔记编辑未保存标记：NotesView 编辑态写入，切页签时读取做确认（契约自 shell 迁入）
  const notesDirtyRef = useRef(false);
  const [width, setWidth] = useState(() => readRailWidthPreference());
  // 拖拽中的实时宽度镜像：pointerup 写记忆需要最终值，state 异步读不到
  const widthRef = useRef(width);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const switchTab = (next: RightRailTab) => {
    if (tab === "notes" && next !== "notes" && notesDirtyRef.current) {
      if (!window.confirm("笔记有未保存的修改，离开将丢失。确定离开吗？")) return;
    }
    setTab(next);
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
      {/* 桌面（lg+）展开：拖宽分隔条 + 四页签栏 + 面板体。分隔条绝对定位骑跨左缘边框，
          w-1.5 命中区 + hover/focus 视觉反馈；宽度内联样式承载拖宽 */}
      {open ? (
        <aside
          aria-label="右栏"
          data-testid="right-rail"
          className="relative hidden shrink-0 flex-col border-l bg-background lg:flex"
          style={{ width }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖拽调整右栏宽度"
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
          aria-label="右栏（已折叠）"
          className="hidden w-10 shrink-0 flex-col items-center border-l bg-background py-2 lg:flex"
        >
          <button
            type="button"
            aria-label="展开右栏"
            title="展开右栏"
            onClick={onToggle}
            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <ListTodo className="size-4" />
          </button>
        </aside>
      )}

      {/* 手机（<lg）：固定右缘抽屉，镜像左栏模式（inset-y-0 维持——iOS 软键盘收缩会
          截断抽屉底部）；z-[45] 高于左抽屉 z-40、低于 toast z-50（沿用 W5-15 结论） */}
      <aside
        aria-label="右栏"
        data-testid="right-rail-drawer"
        className={`fixed inset-y-0 right-0 z-[45] flex w-80 flex-col border-l bg-background transition-transform duration-200 lg:hidden ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <RailTabBar tab={tab} onSwitch={switchTab} />
        <div className="min-h-0 flex-1">
          <RailBody tab={tab} sessionId={sessionId} notesDirtyRef={notesDirtyRef} onClose={onToggle} />
        </div>
      </aside>
    </>
  );
}
