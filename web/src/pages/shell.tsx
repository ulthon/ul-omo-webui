// 主布局 /：桌面（≥1024px）常驻左侧栏 + 主区；≤768px（lg 断点以下）侧栏抽屉化 + 汉堡按钮。
// 初始引导：落到 last_opened_at 最新的项目（lib/bootstrap）。
// 主区页签（todo 19）：「对话 / 未提交变更」切换；对话为默认页签，未提交变更页签挂
// components/diff/changes-view 的 ChangesView。页签状态为 shell 本地 state（无跨组件消费）。
// todo 26：页签栏右侧渲染外链入口（服务端 kv 配置，未配置隐藏）；visualViewport 高度
// 同步（--app-height）解决手机软键盘弹出遮挡输入区（iOS svh 不随键盘收缩）。
import { Suspense, lazy, useEffect, useState } from "react";
import { FolderOpen, GitBranch } from "lucide-react";
import { ApiError } from "@/lib/api";
import { bootstrap } from "@/lib/bootstrap";
import { connectEvents, disconnectEvents } from "@/lib/events";
import { useUiStore } from "@/stores/ui";
import { Topbar } from "@/components/layout/topbar";
import { Sidebar } from "@/components/layout/sidebar";
import { ChatPlaceholder } from "@/components/layout/chat-placeholder";
import { Button } from "@/components/ui/button";

// W5-27 首屏拆分：变更页签（react-diff-view）按需加载，首屏对话页不下载该模块
const ChangesView = lazy(() =>
  import("@/components/diff/changes-view").then((m) => ({ default: m.ChangesView })),
);

type MainTab = "chat" | "changes";

const TAB_CLASS = (active: boolean) =>
  `min-h-11 rounded-lg px-3 py-1.5 text-sm transition-colors lg:min-h-9 ${
    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
  }`;

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

export function AppShell() {
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const toast = useUiStore((s) => s.toast);
  const gitUrl = useUiStore((s) => s.externalLinks.gitUrl);
  const filesUrl = useUiStore((s) => s.externalLinks.filesUrl);
  const [booted, setBooted] = useState(false);
  const [bootFailed, setBootFailed] = useState(false);
  const [retrying, setRetrying] = useState(0);
  const [mainTab, setMainTab] = useState<MainTab>("chat");
  useAppHeight();

  useEffect(() => {
    let cancelled = false;
    bootstrap()
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

  const retry = () => {
    setBootFailed(false);
    setRetrying((n) => n + 1);
  };
  return (
    <div className="flex flex-col bg-background" style={{ height: "var(--app-height, 100svh)" }}>
      <Topbar />
      <div className="relative flex min-h-0 flex-1">
        {/* 抽屉遮罩（lg 以下） */}
        {drawerOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
        )}

        {/* 侧栏：lg 以上常驻，以下抽屉 */}
        <aside
          className={`fixed inset-y-0 left-0 z-40 w-72 border-r bg-sidebar transition-transform duration-200 lg:static lg:h-auto lg:translate-x-0 ${
            drawerOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <Sidebar />
        </aside>

        {/* 主区：todo 16 对话流实体 + todo 19 未提交变更页签 + todo 26 外链入口（kv 配置，未配置隐藏） */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
            <div role="tablist" aria-label="主区视图" className="flex items-center gap-1">
              <button
                type="button"
                role="tab"
                aria-selected={mainTab === "chat"}
                data-testid="main-tab-chat"
                onClick={() => setMainTab("chat")}
                className={TAB_CLASS(mainTab === "chat")}
              >
                对话
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mainTab === "changes"}
                data-testid="main-tab-changes"
                onClick={() => setMainTab("changes")}
                className={TAB_CLASS(mainTab === "changes")}
              >
                未提交变更
              </button>
            </div>
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
            ) : mainTab === "chat" ? (
              <ChatPlaceholder />
            ) : (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    加载变更视图…
                  </div>
                }
              >
                <ChangesView />
              </Suspense>
            )}
          </div>
        </main>
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
