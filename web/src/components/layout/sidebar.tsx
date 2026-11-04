// 侧栏：标题行（会话）+ 会话列表实体（components/session-list，todo 15）。
// F-1（docs08-r4 验证波 F3）：手机档抽屉 w-full 全屏后遮罩不可点、无任何可见关闭途径——
// 标题行右侧补关闭钮（lg 以下渲染，桌面常驻侧栏无此钮），复用 ui store 的 setDrawerOpen。
// 手机抽屉头部重整（openchamber 形态对齐）：头部只留「会话」标题与关闭钮，不再显示
// 项目名（项目切换入口在顶栏下拉/会话切换 sheet，抽屉头部重复且常驻旧名易误导）；
// 头部行 h-12、关闭钮 size-10 圆形 ghost 自然居中（替代原 size-11 挤 h-9 行所需的
// mt-1 -mb-3 负 margin 矫正）。
import { X } from "lucide-react";
import { useUiStore } from "@/stores/ui";
import { SessionList } from "@/components/session-list/session-list";
import { useT } from "@/i18n/i18n";

export function Sidebar() {
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);

  const t = useT();
  return (
    <div className="flex h-full flex-col">
      {/* 手机抽屉头部（openchamber 形态）：h-12 行内标题+关闭钮自然居中；lg 档维持
          h-10 px-4（无关闭钮，常驻侧栏） */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3 lg:h-10 lg:px-4">
        <span className="text-sm font-medium">{t("login.sidebar.sessions")}</span>
        {/* F-1 关闭钮：仅 lg 以下（抽屉形态）渲染；size-10 圆形 ghost 同 openchamber
            手机抽屉关闭钮规格，h-12 行内自然居中，无需负 margin 矫正 */}
        <button
          type="button"
          aria-label={t("login.sidebar.closeDrawer")}
          title={t("common.close")}
          data-testid="sidebar-close"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          onClick={() => setDrawerOpen(false)}
        >
          <X className="size-5" />
        </button>
      </div>
      <SessionList />
    </div>
  );
}
