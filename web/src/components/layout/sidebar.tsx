// 侧栏：标题行（会话 + 当前项目名）+ 会话列表实体（components/session-list，todo 15）。
import { useUiStore } from "@/stores/ui";
import { SessionList } from "@/components/session-list/session-list";

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function Sidebar() {
  const currentProject = useUiStore((s) => s.currentProject);

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
      <SessionList />
    </div>
  );
}
