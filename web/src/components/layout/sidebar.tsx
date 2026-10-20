// 侧栏：标题行（会话 + 当前项目名）+ 会话列表实体（components/session-list，todo 15）。
// F-1（docs08-r4 验证波 F3）：手机档抽屉 w-full 全屏后遮罩不可点、无任何可见关闭途径——
// 标题行右侧补关闭钮（lg 以下渲染，桌面常驻侧栏无此钮），复用 ui store 的 setDrawerOpen。
import { X } from "lucide-react";
import { useUiStore } from "@/stores/ui";
import { SessionList } from "@/components/session-list/session-list";
import { useT } from "@/i18n/i18n";

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function Sidebar() {
  const currentProject = useUiStore((s) => s.currentProject);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);

  const t = useT();
  return (
    <div className="flex h-full flex-col">
      {/* A1（docs08-r4 任务 5）：手机档收紧 h-9 px-3，lg 档维持 h-10 px-4 不变 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 lg:h-10 lg:px-4">
        <span className="text-sm font-medium">{t("login.sidebar.sessions")}</span>
        <div className="flex min-w-0 items-center">
          {currentProject && (
            <span className="max-w-[160px] truncate text-xs text-muted-foreground" title={currentProject}>
              {basename(currentProject)}
            </span>
          )}
          {/* F-1 关闭钮：仅 lg 以下（抽屉形态）渲染；size-11 保证 44px 触控目标。
              mt-1 -mb-3 让 44px 高的按钮整体落在 h-9 标题行内的视口内（居中会向上
              出血 4px 被屏幕裁掉），布局盒仍 36px，任务 5 间距不破坏 */}
          <button
            type="button"
            aria-label={t("login.sidebar.closeDrawer")}
            title={t("common.close")}
            data-testid="sidebar-close"
            className="mt-1 -mb-3 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            onClick={() => setDrawerOpen(false)}
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
      <SessionList />
    </div>
  );
}
