// 侧栏占位：会话列表实体由 todo 15 填充（项目分组/分层/搜索/元数据操作）。
// 这里先立住布局骨架：标题、当前项目、空态/加载态。
import { MessageSquare } from "lucide-react";
import { useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function Sidebar() {
  const currentProject = useUiStore((s) => s.currentProject);
  const sessions = useSessionsStore((s) => (currentProject ? s.byProject[currentProject] : undefined));
  const loading = useSessionsStore((s) => s.loading);

  const count = sessions?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-4">
        <span className="text-sm font-medium">会话</span>
        {currentProject && (
          <span className="max-w-[160px] truncate text-xs text-muted-foreground" title={currentProject}>
            {basename(currentProject)}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">加载中…</div>
        ) : count === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <MessageSquare className="size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {currentProject ? "暂无会话" : "先在顶栏选择或添加项目"}
            </p>
          </div>
        ) : (
          // todo 15：会话列表实体渲染（此处占位计数，防止实体组件提前实现）
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">{count} 个会话</div>
        )}
      </div>
    </div>
  );
}
