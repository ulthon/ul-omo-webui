// diff 渲染（todo 19）：react-diff-view 封装。
// - DiffView：整段 diff 文本 → 解析 → 逐文件渲染（工具卡片路径，通常单文件）；
// - FileDiff：单文件结构渲染（"未提交变更"页签对全量 diff 切分后按选中文件渲染）。
// 无内容 hunk（二进制 / 纯重命名 / 模式变更）与解析失败均给兜底文案不崩；
// unified / split 两种视图由调用方传入（页签提供切换，工具卡片默认 unified）。
// 大 diff 决策：不做虚拟化——服务端 diff 已 512KB 截断（routes-git DIFF_MAX_BYTES），
// 千行级 diff 约 2-3k 个表格单元格，DOM 直渲 + 容器滚动即可，实测无卡顿再考虑虚拟化。
import { Fragment, useMemo } from "react";
import { Decoration, Diff, Hunk } from "react-diff-view";
import type { FileData } from "react-diff-view";
import { t } from "@/i18n/i18n";
import { parseGitDiff } from "./diff-utils";
import "react-diff-view/style/index.css";
import "./diff.css";

/** 文件状态词按当前语言取词（原 TYPE_LABEL 静态映射改为取词函数，缺省透传原始类型） */
function typeLabel(type: string): string {
  switch (type) {
    case "add":
      return t("diff.type.add");
    case "modify":
      return t("diff.type.modify");
    case "delete":
      return t("diff.type.delete");
    case "rename":
      return t("diff.type.rename");
    case "copy":
      return t("diff.type.copy");
    default:
      return type;
  }
}

/** 文件头行展示路径（删除文件 parseDiff 的 newPath 是 /dev/null，取 oldPath） */
export function diffFilePath(file: FileData): string {
  return file.newPath === "/dev/null" ? file.oldPath : file.newPath;
}

/** 无内容 hunk 时的说明；有内容返回 null */
export function diffEmptyReason(file: FileData): string | null {
  if (file.hunks.length > 0) return null;
  if (file.isBinary) return t("diff.view.binary");
  if (file.type === "rename") return t("diff.view.pureRename");
  return t("diff.view.noTextDiff");
}

export function FileDiff({ file, viewType }: { file: FileData; viewType: "unified" | "split" }) {
  const reason = diffEmptyReason(file);
  if (reason) {
    return (
      <div className="diff-empty" data-testid="diff-empty">
        {reason}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border" data-testid="file-diff">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-2.5 py-1">
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {diffFilePath(file) || t("diff.view.fragment")}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
          {typeLabel(file.type)}
        </span>
      </div>
      <Diff hunks={file.hunks} diffType={file.type} viewType={viewType} className="diff-surface">
        {(hunks) =>
          hunks.map((hunk) => (
            <Fragment key={hunk.content}>
              <Decoration className="diff-hunk-header">{hunk.content}</Decoration>
              <Hunk hunk={hunk} />
            </Fragment>
          ))
        }
      </Diff>
    </div>
  );
}

export function DiffView({
  diffText,
  viewType = "unified",
}: {
  diffText: string;
  viewType?: "unified" | "split";
}) {
  const files = useMemo(() => parseGitDiff(diffText), [diffText]);
  if (files.length === 0) {
    return <div className="diff-empty">{t("diff.view.parseFailed")}</div>;
  }
  return (
    <div className="space-y-2">
      {files.map((file) => (
        <FileDiff key={`${file.oldPath}->${file.newPath}:${file.type}`} file={file} viewType={viewType} />
      ))}
    </div>
  );
}
