// 主布局 /：桌面（≥1024px）常驻左侧栏 + 主区；≤768px（lg 断点以下）侧栏抽屉化 + 汉堡按钮。
// 初始引导：落到 last_opened_at 最新的项目（lib/bootstrap）。
// 主区页签（todo 19）：「对话 / 未提交变更」切换；对话为默认页签，未提交变更页签挂
// components/diff/changes-view 的 ChangesView。页签状态为 shell 本地 state（无跨组件消费）。
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { bootstrap } from "@/lib/bootstrap";
import { connectEvents, disconnectEvents } from "@/lib/events";
import { useUiStore } from "@/stores/ui";
import { Topbar } from "@/components/layout/topbar";
import { Sidebar } from "@/components/layout/sidebar";
import { ChatPlaceholder } from "@/components/layout/chat-placeholder";
import { ChangesView } from "@/components/diff/changes-view";
import { Button } from "@/components/ui/button";

type MainTab = "chat" | "changes";

const TAB_CLASS = (active: boolean) =>
  `min-h-9 rounded-lg px-3 py-1.5 text-sm transition-colors ${
    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
  }`;

export function AppShell() {
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const toast = useUiStore((s) => s.toast);
  const [booted, setBooted] = useState(false);
  const [bootFailed, setBootFailed] = useState(false);
  const [retrying, setRetrying] = useState(0);
  const [mainTab, setMainTab] = useState<MainTab>("chat");

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
    <div className="flex h-svh flex-col bg-background">
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

        {/* 主区：todo 16 对话流实体 + todo 19 未提交变更页签 */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div role="tablist" aria-label="主区视图" className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
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
              <ChangesView />
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
