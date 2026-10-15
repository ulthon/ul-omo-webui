// 主布局 /：桌面（≥1024px）常驻左侧栏 + 主区；≤768px（lg 断点以下）侧栏抽屉化 + 汉堡按钮。
// 初始引导：落到 last_opened_at 最新的项目（lib/bootstrap）。
// C15（docs08-r3 任务 3）：主区永久为对话（ChatPlaceholder），任务/变更/笔记/统计四页签
// 收敛到右栏 RightRail（components/layout/right-rail），原主区"变更/笔记"页签移除。
// todo 26：主区顶栏右侧渲染外链入口（服务端 kv 配置，未配置隐藏）；A6（docs08-r4 任务 6）
// 手机档第二层行退役——右栏抽屉触发钮迁入顶栏、外链迁入右栏抽屉头部，桌面第二层行保留；
// visualViewport 高度同步（--app-height）解决手机软键盘弹出遮挡输入区（iOS svh 不随键盘收缩）。
// W5-15 右栏开合：lg 常驻（展开 / 折叠窄条），<lg 镜像左栏 fixed 抽屉（inset-y-0，勿套
// --app-height，否则软键盘收缩截断抽屉底）；双抽屉互斥（开其一时自动关另一，经 ui store
// subscribe 实现左→右方向）；z 序与折叠记忆（senpi-webui:todo-panel-open）机制不变。
// W2 todo 8：useCtrlPModelPicker 导出供单测挂最小探针验证（避免 mock.module 进程级
// 粘滞污染同进程后跑的测试文件）。
// oxlint-disable react/only-export-components -- useCtrlPModelPicker 是与 shell 布局强耦合的
// 行为 hook，独立成文件只为绕 fast-refresh 惯例反而增加间接层（todo-panel 同款处置）
import { useEffect, useMemo, useState } from "react";
import { FolderOpen, GitBranch } from "lucide-react";
import { ApiError } from "@/lib/api";
import { bootstrap } from "@/lib/bootstrap";
import { connectEvents, disconnectEvents } from "@/lib/events";
import { readSessionUrl } from "@/lib/session-url";
import { useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";
import { Topbar } from "@/components/layout/topbar";
import { Sidebar } from "@/components/layout/sidebar";
import { ChatPlaceholder } from "@/components/layout/chat-placeholder";
import { Button } from "@/components/ui/button";
import { readPanelOpenPreference, writePanelOpenPreference } from "@/components/chat/todo-panel";
import { RightRail } from "@/components/layout/right-rail";
import { useIsMobile } from "@/lib/use-is-mobile";

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

/** Ctrl/Cmd+P 快捷键挂载（W2 todo 8）：打开输入区模型选择弹层（打开态在 ui store，chip 消费）。
 * 对话框内不接管——radix 弹层经 Portal 盖住输入区 chip，快捷键在遮罩下打开等于失效
 * （Oracle 低-7）；无可用模型时同样不开。preventDefault 压掉浏览器默认打印面板。
 * 独立导出成 hook：shell 挂载用，单测可挂最小探针组件验证（不牵起整个 shell 的引导链）。 */
export function useCtrlPModelPicker(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "p") return;
      const target = e.target;
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      e.preventDefault();
      const ui = useUiStore.getState();
      if (ui.modelsLoaded && ui.models.length === 0) return;
      ui.setModelPickerOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function AppShell() {
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const toast = useUiStore((s) => s.toast);
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

  useCtrlPModelPicker();

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

        {/* 侧栏：lg 以上常驻，以下抽屉 */}
        <aside
          className={`fixed inset-y-0 left-0 z-40 w-full border-r bg-sidebar transition-transform duration-200 lg:static lg:h-auto lg:w-72 lg:translate-x-0 ${
            drawerOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <Sidebar />
        </aside>

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
                    aria-label="打开 Git 外链"
                    title={`Git 外链：${gitUrl}`}
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
                    aria-label="打开文件管理外链"
                    title={`文件管理外链：${filesUrl}`}
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
                加载中…
              </div>
            ) : bootFailed ? (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <p className="text-sm text-muted-foreground">加载失败，请检查服务是否可用</p>
                <Button variant="outline" size="sm" onClick={retry}>
                  重试
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

      {/* 轻提示 */}
      {toast && (
        <div
          className={`fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full border px-4 py-2 text-sm shadow-md ${
            toast.kind === "error"
              ? "border-destructive/30 bg-destructive text-destructive-foreground"
              : "bg-foreground text-background"
          }`}
          role="status"
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
