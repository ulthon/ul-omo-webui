// 窄档单列推入式共享壳（files-ux-revamp 任务 4）：list -> preview -> edit 三个层级
// 由派生而非栈数组维护——真实深度恒为 2 层 + 编辑态，宿主（files.tsx / rail-files-panel.tsx
// 后续任务接入）只传当前态即可，壳组件不做任何返回栈记账。
//
// selectionKey 契约（宿主必须遵守）：宿主提供的复合键 `${selected}#${openSeq}`，
// 其中 openSeq 是宿主自维护的打开令牌——每次打开动作都自增（包括重按同一文件行、
// 快速重复打开同一文件），selected 变回 null 时归零。这样保证"返回列表后再按同一个
// 文件"会再次推入预览（与今日无条件 setMobilePane("preview") 行为对齐）。壳组件自身
// 只依赖一条规则：selectionKey 引用变化 => 清除 narrow 局部 dismissed 标记。
//
// 层级判定：editing ? "edit" : (selectionKey 非空且未被返回 ? "preview" : "list")。
// dismissed 是本组件唯一内部状态：预览层返回钮点击后置真，回到 list；仅读目标，
// 该转换不做脏态守卫（FileEditor 自带 onBack/dirtyRef 编辑层语义，见 file-editor.tsx）。
//
// onBackGuard 为宿主未来用途的透传 prop（如编辑层外部守卫），预览->列表的只读返回
// 不消费它，保留在接口里以稳定签名。
//
// 宽度正交性：本壳不感知断点/媒体查询，也绝不渲染文件树；何时渲染由宿主决定。
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useT } from "@/i18n/i18n";

export type NarrowStackLevel = "list" | "preview" | "edit";

export function NarrowStack({
  header,
  breadcrumb,
  toolbar,
  list,
  preview,
  editing,
  selectionKey,
  // onBackGuard 为宿主未来用途透传，预览->列表只读返回不消费：不参与渲染派生，
  // 故不解构（签名保留，见文件头说明），由宿主在自己的事件链里调用
  testId,
}: {
  /** 顶层附加内容（如页头）；各层级恒渲染 */
  header?: ReactNode;
  breadcrumb: ReactNode;
  toolbar: ReactNode;
  list: ReactNode;
  preview: ReactNode;
  editing: boolean;
  /** 宿主复合键 `${selected}#${openSeq}`，见文件头契约说明；null = 未选中 */
  selectionKey: string | null;
  /** 宿主未来用途透传，预览->列表只读返回不消费（见文件头说明） */
  onBackGuard: () => boolean;
  testId: string;
}) {
  const t = useT();
  // 唯一内部状态：窄档局部"返回列表"标记（selectionKey 引用变化即清除）
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // 引用对比：宿主每次打开动作换新令牌 => 新键引用 => dismissed 复位，重新推入预览
    setDismissed(false);
  }, [selectionKey]);

  const level: NarrowStackLevel = editing ? "edit" : selectionKey !== null && !dismissed ? "preview" : "list";

  return (
    <div data-testid={testId} data-level={level} className="flex min-h-0 flex-1 flex-col">
      {header}
      {level === "list" && (
        <>
          {toolbar}
          {breadcrumb}
          <div data-testid={`${testId}-list`} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {list}
          </div>
        </>
      )}
      {level === "preview" && (
        <>
          {breadcrumb}
          <div className="shrink-0">
            <button
              type="button"
              data-testid={`${testId}-back`}
              aria-label={t("files.narrow.backAria")}
              title={t("files.narrow.backAria")}
              onClick={() => setDismissed(true)}
              className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </button>
          </div>
          <div data-testid={`${testId}-preview`} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {preview}
          </div>
        </>
      )}
      {level === "edit" && (
        // 编辑层整层交给编辑器（FileEditor 自带返回到预览的 onBack 语义），壳不加返回钮
        <div data-testid={`${testId}-edit`} className="flex min-h-0 flex-1 flex-col">
          {preview}
        </div>
      )}
    </div>
  );
}
