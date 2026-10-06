// 主布局 /：桌面（≥1024px）常驻左侧栏 + 主区；≤768px（lg 断点以下）侧栏抽屉化 + 汉堡按钮。
// 初始引导：落到 last_opened_at 最新的项目（lib/bootstrap）。
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { bootstrap } from "@/lib/bootstrap";
import { useUiStore } from "@/stores/ui";
import { Topbar } from "@/components/layout/topbar";
import { Sidebar } from "@/components/layout/sidebar";
import { ChatPlaceholder } from "@/components/layout/chat-placeholder";
import { Button } from "@/components/ui/button";

export function AppShell() {
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const toast = useUiStore((s) => s.toast);
  const [booted, setBooted] = useState(false);
  const [bootFailed, setBootFailed] = useState(false);
  const [retrying, setRetrying] = useState(0);

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

        {/* 主区：todo 16 对话流实体 */}
        <main className="min-w-0 flex-1 overflow-hidden">
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
