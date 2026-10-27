// 主布局 /：桌面（≥1024px）常驻左侧栏 + 主区；≤768px（lg 断点以下）侧栏抽屉化 + 汉堡按钮。
// 初始引导：落到 last_opened_at 最新的项目（lib/bootstrap）。
// C15（docs08-r3 任务 3）：主区永久为对话（ChatPlaceholder），任务/变更/笔记/统计四页签
// 收敛到右栏 RightRail（components/layout/right-rail），原主区"变更/笔记"页签移除。
// todo 26：主区顶栏右侧渲染外链入口（服务端 kv 配置，未配置隐藏）；A6（docs08-r4 任务 6）
// 手机档第二层行退役——右栏抽屉触发钮迁入顶栏、外链迁入右栏抽屉头部，桌面第二层行保留；
// visualViewport 高度同步（--app-height）解决手机软键盘弹出遮挡输入区（iOS svh 不随键盘收缩）。
// W5-15 右栏开合：lg 常驻（展开 / 折叠窄条），<lg 镜像左栏 fixed 抽屉（inset-y-0，勿套
// --app-height，否则软键盘收缩截断抽屉底）；双抽屉互斥（开其一时自动关另一，经 ui store
// subscribe 实现左→右方向）；z 序与折叠记忆（ul-omo-webui:todo-panel-open）机制不变。
// W2 todo 8 / r9 2026-10-26 批次：useModelShortcuts 导出供单测挂最小探针验证（避免
// mock.module 进程级粘滞污染同进程后跑的测试文件）。
// oxlint-disable react/only-export-components -- useModelShortcuts 是与 shell 布局强耦合的
// 行为 hook，独立成文件只为绕 fast-refresh 惯例反而增加间接层（todo-panel 同款处置）
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Check, CircleAlert, Copy, FolderOpen, GitBranch, X } from "lucide-react";
import { ApiError } from "@/lib/api";
import { bootstrap } from "@/lib/bootstrap";
import { connectEvents, disconnectEvents } from "@/lib/events";
import { useT, t } from "@/i18n/i18n";
import { readSessionUrl } from "@/lib/session-url";
import { useUiStore } from "@/stores/ui";
import type { Toast } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";
import { Topbar } from "@/components/layout/topbar";
import { Sidebar } from "@/components/layout/sidebar";
import { ChatPlaceholder } from "@/components/layout/chat-placeholder";
import { Button } from "@/components/ui/button";
import { readPanelOpenPreference, writePanelOpenPreference } from "@/components/chat/todo-panel";
import { RightRail } from "@/components/layout/right-rail";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  readSidebarWidthPreference,
  writeSidebarWidthPreference,
} from "@/components/layout/sidebar-resize";
import { SettingsPage } from "@/pages/settings";
import { FilesPage } from "@/pages/files";
import { useIsMobile } from "@/lib/use-is-mobile";
import { isModelCycleBackward, isModelCycleForward, isModelPickerTrigger } from "@/lib/shortcuts";
import { nextFavoriteModel, selectModel } from "@/lib/model-cycle";
import { useShortcutsHelp } from "@/lib/use-shortcuts-help";

/** 复制到剪贴板（toast 复制钮）：优先 navigator.clipboard（https/localhost），
 * 本应用常经局域网 http 访问（非安全上下文 clipboard 为 undefined）降级
 * 隐藏 textarea + execCommand——两路都不成时返回 false 让按钮回退无反馈态。 */
function copyTextCompat(text: string): boolean {
  try {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 单条轻提示（docs08 2026-10-25 用户反馈）：文字可选中可复制（点文字不触发任何动作），
 * 右侧操作钮 error=[复制+关闭]、info=[关闭]；error 左侧警示图标常驻，长文本折行。 */
function ToastItem({ toast, onClose, closeLabel, copyLabel }: {
  toast: Toast;
  onClose: () => void;
  closeLabel: string;
  copyLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  // 复制成功反馈 1.5s 后回退图标；卸载/重复点击时重置旧 timer（不依赖定时泄漏）
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (revertTimer.current) clearTimeout(revertTimer.current);
  }, []);
  const onCopy = () => {
    if (!copyTextCompat(toast.text)) return;
    setCopied(true);
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = setTimeout(() => setCopied(false), 1500);
  };
  const isError = toast.kind === "error";
  return (
    <div
      data-testid="toast-item"
      role={isError ? "alert" : "status"}
      className={`flex w-full items-start gap-1.5 rounded-lg border px-3 py-2 text-left text-sm shadow-md max-w-full ${
        isError
          ? "border-destructive/40 bg-destructive text-destructive-foreground"
          : "border-transparent bg-foreground text-background"
      }`}
    >
      {isError && <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words">{toast.text}</span>
      {isError && (
        <button
          type="button"
          onClick={onCopy}
          aria-label={copyLabel}
          title={copyLabel}
          className="shrink-0 cursor-pointer rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        title={closeLabel}
        className="shrink-0 cursor-pointer rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/** 手机触控目标外链按钮（44px；desktop 同尺寸不碍事） */
const EXTERNAL_LINK_CLASS =
  "flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";

/** visualViewport → --app-height：软键盘弹出时 vv.height 收缩，根容器随之缩小，
 * flex 布局压缩消息列表（内部滚动），composer/状态条保持键盘上方可视。
 * 桌面无键盘（vv.height=窗口高）零影响。scroll 一并监听：iOS 聚焦输入时会把 body
 * 整体上推（offsetTop>0），app 高度锁定视口后必须回滚到 0，否则顶部被推出屏幕。 */
function useAppHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      document.documentElement.style.setProperty("--app-height", `${vv.height}px`);
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
}

/** 模型快捷键挂载（W2 todo 8 起，r9 2026-10-26 批次对齐 native）：Ctrl/Cmd+P 与
 * Shift+Ctrl/Cmd+P 在 CLI 收藏内循环切换模型，Ctrl/Cmd+L 打开输入区模型选择弹层
 * （打开态在 ui store，chip 消费）。对话框内不接管——radix 弹层经 Portal 盖住输入区
 * chip，快捷键在遮罩下触发等于失效；无可用模型（确认为空）时同样不动。
 * preventDefault 压掉浏览器默认（打印面板 / 地址栏聚焦，含焦点在 textarea 时压字符）。
 * 循环每次按键即时重读 getState——收藏列表两次按键间变化（SSE/刷新）不会用到旧快照；
 * 无收藏时 toast 提示并打开弹层兜底；选中与持久化走 lib/model-cycle.selectModel
 * （与 chip 点击同一条「写 selectedModel + 防抖持久化」路径）。
 * 独立导出成 hook：shell 挂载用，单测可挂最小探针组件验证（不牵起整个 shell 的引导链）。
 * docs08-r7 任务 12：键位判定收拢 lib/shortcuts 注册表（唯一来源）。 */
export function useModelShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const backward = isModelCycleBackward(e);
      const forward = isModelCycleForward(e);
      if (!forward && !backward && !isModelPickerTrigger(e)) return;
      const target = e.target;
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      e.preventDefault();
      const ui = useUiStore.getState();
      if (ui.modelsLoaded && ui.models.length === 0) return;
      if (forward || backward) {
        const next = nextFavoriteModel(ui.favoriteModels, ui.selectedModel, backward ? -1 : 1);
        if (next === null) {
          ui.showToast(t("shortcuts.noFavoritesToast"));
          ui.setModelPickerOpen(true);
          return;
        }
        selectModel(next);
        return;
      }
      ui.setModelPickerOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** 左侧栏（r9 2026-10-26 批次 w2-t7）：lg+ 常驻宽度可拖拽（右缘手柄，模式镜像
 * right-rail：pointerdown/move/up + setPointerCapture，拖动中实时钳制，pointerup 才
 * 写 localStorage ul-omo-webui:sidebar-width）；左右方向键 ±16px 即时记忆，双击重置
 * 默认 288。宽度经 CSS 变量 --sidebar-width 只在 lg 断点消费，手机抽屉 w-full
 * 不受影响（手柄也 hidden lg:block 不渲染）。抽出为独立导出组件：单测直接挂载，
 * 免去拉起整页 AppShell（useModelShortcuts 同款 only-export-components 豁免已声明）。 */
export function AppSidebar({ drawerOpen }: { drawerOpen: boolean }) {
  const t = useT();
  const [width, setWidth] = useState(() => readSidebarWidthPreference());
  // 拖拽中的实时宽度镜像：pointerup 写记忆需要最终值，state 异步读不到
  const widthRef = useRef(width);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const applyWidth = (next: number) => {
    widthRef.current = next;
    setWidth(next);
  };
  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: widthRef.current };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  // 右缘手柄：向右拖变宽（与右栏左缘手柄方向相反）
  const onHandlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    applyWidth(clampSidebarWidth(drag.startWidth + (e.clientX - drag.startX)));
  };
  // pointerup：落记忆；pointercancel：只终止拖拽（宽度已实时钳制，记忆留给下次完整拖拽）
  const onHandlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    writeSidebarWidthPreference(widthRef.current);
  };
  const onHandlePointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  // 键盘微调（可聚焦分隔条）：左右方向键 ±16px 并即时记忆
  const onHandleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clampSidebarWidth(widthRef.current + (e.key === "ArrowLeft" ? -16 : 16));
    applyWidth(next);
    writeSidebarWidthPreference(next);
  };
  const onHandleDoubleClick = () => {
    applyWidth(SIDEBAR_WIDTH_DEFAULT);
    writeSidebarWidthPreference(SIDEBAR_WIDTH_DEFAULT);
  };

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 w-full border-r bg-sidebar transition-transform duration-200 lg:static lg:h-auto lg:w-[var(--sidebar-width)] lg:translate-x-0 ${
        drawerOpen ? "translate-x-0" : "-translate-x-full"
      }`}
      style={{ ["--sidebar-width" as string]: `${width}px` }}
    >
      {/* 桌面（lg+）拖宽手柄：骑跨右缘边框，w-1.5 命中区 + hover/focus 视觉反馈；
          手机档不渲染（hidden lg:block），抽屉 w-full 不受影响 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("login.sidebarResize.resizeHandle")}
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        tabIndex={0}
        data-testid="sidebar-resize-handle"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerCancel}
        onKeyDown={onHandleKeyDown}
        onDoubleClick={onHandleDoubleClick}
        className="absolute inset-y-0 right-0 z-10 hidden w-1.5 cursor-col-resize touch-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none lg:block"
      />
      <Sidebar />
    </aside>
  );}

/** 文件管理全屏页占位空壳（builtin-file-management 任务 1）：仅页头（标题+返回钮），
 *  三栏内容由任务 2 填充；fixed 覆盖层形态同 SettingsPage，交互同款（返回钮经
 *  ui store filesPageOpen 回原视图，SSE 不中断）。 */
export function FilesPagePlaceholder() {
  const t = useT();
  const setFilesPageOpen = useUiStore((s) => s.setFilesPageOpen);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t("files.page.closeAria")}
          data-testid="files-page-close"
          onClick={() => setFilesPageOpen(false)}
        >
          <X className="size-5" />
        </Button>
        <h1 className="text-base font-medium">{t("files.page.title")}</h1>
      </header>
      <div data-testid="files-page" className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">{t("files.page.placeholder")}</p>
      </div>
    </div>
  );
}

export function AppShell() {
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const settingsPageOpen = useUiStore((s) => s.settingsPageOpen);
  const filesPageOpen = useUiStore((s) => s.filesPageOpen);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);
  const gitUrl = useUiStore((s) => s.externalLinks.gitUrl);
  const filesUrl = useUiStore((s) => s.externalLinks.filesUrl);
  const [booted, setBooted] = useState(false);
  const [bootFailed, setBootFailed] = useState(false);
  const [retrying, setRetrying] = useState(0);
  // W5-15 右栏：当前会话（与会话视图同源派生：选中优先、?session= 深链兜底）。
  // B1：读取统一走 lib/session-url（与 chat-view 同一助手，避免漂移）；挂载引导完成后
  // 按 URL 参数显式 select（见 bootstrap effect），本兜底仅覆盖引导完成前的窗口。
  const selectedSessionId = useSessionsStore((s) => s.selectedId);
  const urlSessionId = useMemo(() => readSessionUrl(), []);
  const t = useT();
  const todoSessionId = selectedSessionId ?? urlSessionId;
  // 折叠态：无 localStorage 记忆时按视口取默认（lg 展开 / <lg 关闭）；一经交互记忆为准
  const [todoPanelOpen, setTodoPanelOpen] = useState(() => {
    const stored = readPanelOpenPreference();
    if (stored !== null) return stored;
    return window.matchMedia("(min-width: 1024px)").matches;
  });
  useAppHeight();

  // 右栏开合：记忆持久化；开启侧先关左抽屉（互斥——左→右方向见下方 subscribe）
  const toggleTodoPanel = () => {
    const next = !todoPanelOpen;
    setTodoPanelOpen(next);
    writePanelOpenPreference(next);
    if (next) setDrawerOpen(false);
  };

  // 双抽屉互斥另一半：左抽屉经顶栏汉堡开启时收起右栏（toggleTodoPanel 只覆盖右→左）
  useEffect(
    () =>
      useUiStore.subscribe((state, prev) => {
        if (!state.drawerOpen || prev.drawerOpen) return;
        setTodoPanelOpen(false);
        writePanelOpenPreference(false);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    bootstrap()
      .then(() => {
        // B1 显式恢复：引导完成后按 URL 参数选中会话，store 与 URL 一致（非仅视图兜底）。
        // bootstrap 先行完毕才恢复——openProject 的 refreshSessions 不写 selectedId，
        // 恢复动作不会被引导流程覆盖；select 内部会原地把同一 id 写回 URL（无害幂等）。
        if (cancelled) return;
        const urlId = readSessionUrl();
        if (urlId) useSessionsStore.getState().select(urlId);
      })
      .catch((err: unknown) => {
        // 401 已由 api client 跳登录页；其余错误显示重试
        if (!cancelled && !(err instanceof ApiError && err.status === 401)) setBootFailed(true);
      })
      .finally(() => {
        if (!cancelled) setBooted(true);
      });
    return () => {
      cancelled = true;
    };
  }, [retrying]);

  // SSE 实时流：整页全程单条连接，随主布局挂载/卸载（todo 14）
  useEffect(() => {
    connectEvents();
    return () => disconnectEvents();
  }, []);

  useModelShortcuts();
  // 快捷键帮助触发（docs08-r7 任务 12）：? / Ctrl+K 打开帮助对话框（开关在 ui store，
  // 对话框挂 topbar）；登录页不挂 AppShell，本 hook 不存在即登录页零影响。
  useShortcutsHelp();

  // A6（docs08-r4 任务 6）：手机档第二层整行退役——右栏触发钮迁入顶栏（topbar 手机档
  // 右簇），git/files 外链手机档迁入右栏抽屉头部（right-rail.tsx）；桌面（lg+）第二层
  // 行保留原样（外链入口不动）。条件渲染（useIsMobile），非 CSS 隐藏——手机档 DOM 不存在。
  const isMobile = useIsMobile();

  const retry = () => {
    setBootFailed(false);
    setRetrying((n) => n + 1);
  };
  return (
    <div className="flex flex-col bg-background" style={{ height: "var(--app-height, 100svh)" }}>
      <Topbar onToggleTodoPanel={toggleTodoPanel} />
      <div className="relative flex min-h-0 flex-1">
        {/* 抽屉遮罩（lg 以下）：左右抽屉共用（互斥下至多一个开启；z-30 镜像左栏） */}
        {(drawerOpen || todoPanelOpen) && (
          <div
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            onClick={() => {
              setDrawerOpen(false);
              setTodoPanelOpen(false);
              writePanelOpenPreference(false);
            }}
            aria-hidden
          />
        )}

        {/* 侧栏：lg 以上常驻（宽度可拖拽持久化），以下抽屉 */}
        <AppSidebar drawerOpen={drawerOpen} />

        {/* 主区：永久对话（C15）。A6：手机档第二层行退役（右栏触发钮在顶栏、外链在右栏
            抽屉头部）；桌面行保留——git/files 外链入口原位（kv 配置，未配置隐藏） */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!isMobile && (
            <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5" data-testid="layout-second-row">
              <div className="ml-auto flex items-center gap-1">
                {gitUrl && (
                  <a
                    href={gitUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t("login.shell.openGitLink")}
                    title={t("login.shell.gitLinkTitle", { url: gitUrl })}
                    className={EXTERNAL_LINK_CLASS}
                  >
                    <GitBranch className="size-5" />
                  </a>
                )}
                {filesUrl && (
                  <a
                    href={filesUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t("login.shell.openFilesLink")}
                    title={t("login.shell.filesLinkTitle", { url: filesUrl })}
                    className={EXTERNAL_LINK_CLASS}
                  >
                    <FolderOpen className="size-5" />
                  </a>
                )}
              </div>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {!booted ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t("login.shell.booting")}
              </div>
            ) : bootFailed ? (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <p className="text-sm text-muted-foreground">{t("login.shell.bootFailed")}</p>
                <Button variant="outline" size="sm" onClick={retry}>
                  {t("login.shell.retry")}
                </Button>
              </div>
            ) : (
              <ChatPlaceholder />
            )}
          </div>
        </main>

        {/* C15 右栏：桌面展开（带拖宽分隔条与四页签）/ 桌面折叠窄条 / 手机抽屉三形态
            统一由 RightRail 渲染；开合状态与记忆机制沿用 W5-15（todoPanelOpen） */}
        <RightRail open={todoPanelOpen} onToggle={toggleTodoPanel} sessionId={todoSessionId} />
      </div>

      {/* 设置独立全屏页（r9 2026-10-26 批次任务 9）：fixed 覆盖层，shell 本体保持挂载
          （SSE 与引导状态不中断），返回钮经 ui store settingsPageOpen 回原视图 */}
      {settingsPageOpen && <SettingsPage />}

      {/* 文件管理独立全屏页（builtin-file-management 任务 2 三栏实现）：fixed 覆盖层，
          shell 本体保持挂载（SSE 不中断）；返回钮经 ui store filesPageOpen 回原视图 */}
      {filesPageOpen && <FilesPage />}

      {/* 轻提示栈：info 3.2s 自动消失；error 常驻直到显式关闭。至多 3 条同列堆叠
          （超出丢最旧并 console.warn），文字可选中可复制，点文字本体不触发任何动作 */}
      {toasts.length > 0 && (
        <div
          data-testid="toast-stack"
          className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex w-max max-w-[90vw] -translate-x-1/2 flex-col items-stretch gap-2"
        >
          {toasts.map((item) => (
            <div key={item.id} className="pointer-events-auto flex justify-center">
              <ToastItem
                toast={item}
                onClose={() => dismissToast(item.id)}
                closeLabel={t("common.close")}
                copyLabel={t("common.copy")}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
