// 写操作确认/冲突弹窗（builtin-file-management 任务 7）：复用 ui/dialog 原语，
// 纯展示组件（重试调用与队列推进由 FilesPage 持有）。无“跳过确认”记忆项（计划 Must NOT）。
// 任务 9 追加：SaveConflictDialog 保存 409 file_changed「重载/覆盖」两选弹窗
// （修正轮按计划契约补覆盖；两选与关闭行为由 FileEditor 持有，仍为纯展示）。
import type { ReactNode } from "react";
import { useT } from "@/i18n/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** 删除确认：目录时明示递归删除与直接子条目数（条目数由调用方拉目录列表提供） */
export function DeleteConfirmDialog({
  path,
  isDir,
  childCount,
  busy,
  onConfirm,
  onCancel,
}: {
  path: string;
  isDir: boolean;
  /** 目录的直接子条目数；null = 统计中 */
  childCount: number | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent data-testid="files-delete-dialog">
        <DialogHeader>
          <DialogTitle>{t("files.confirm.title")}</DialogTitle>
          <DialogDescription>
            {isDir ? t("files.confirm.dirBody", { path }) : t("files.confirm.fileBody", { path })}
          </DialogDescription>
        </DialogHeader>
        {isDir ? (
          <p data-testid="files-delete-child-count" className="text-sm text-muted-foreground">
            {childCount === null ? t("files.confirm.childCountUnknown") : t("files.confirm.childCount", { count: childCount })}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" data-testid="files-delete-cancel" disabled={busy} onClick={onCancel}>
            {t("files.confirm.cancel")}
          </Button>
          <Button variant="destructive" data-testid="files-delete-confirm" disabled={busy} onClick={onConfirm}>
            {t("files.confirm.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** move/upload 409 target_exists 三选：覆盖 / 保留两者（可禁用带原因）/ 取消。
 * keepBoth 缺省启用（move）；upload 服务端不支持 conflict:"rename" 时传
 * keepBothReason 置灰。existing 为 409 载荷携带的既有条目信息（upload 有、move 无）。 */
export function FsConflictDialog({
  desc,
  existing,
  busy,
  keepBothReason,
  onOverwrite,
  onKeepBoth,
  onCancel,
}: {
  desc: string;
  /** 409 载荷 existing（kind/size 等）渲染行；缺省不渲染 */
  existing?: ReactNode;
  busy: boolean;
  /** 传入时“保留两者”置灰并以此文案作 title */
  keepBothReason?: string;
  onOverwrite: () => void;
  onKeepBoth: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent data-testid="files-conflict-dialog">
        <DialogHeader>
          <DialogTitle>{t("files.conflict.title")}</DialogTitle>
          <DialogDescription>{desc}</DialogDescription>
        </DialogHeader>
        {existing}
        <DialogFooter>
          <Button variant="outline" data-testid="files-conflict-cancel" disabled={busy} onClick={onCancel}>
            {t("files.conflict.cancel")}
          </Button>
          {keepBothReason !== undefined ? (
            <Button
              variant="outline"
              data-testid="files-conflict-keep-both"
              disabled
              title={keepBothReason}
            >
              {t("files.conflict.keepBoth")}
            </Button>
          ) : (
            <Button
              variant="outline"
              data-testid="files-conflict-keep-both"
              disabled={busy}
              onClick={onKeepBoth}
            >
              {t("files.conflict.keepBoth")}
            </Button>
          )}
          <Button data-testid="files-conflict-overwrite" disabled={busy} onClick={onOverwrite}>
            {t("files.conflict.overwrite")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 保存 409 file_changed 冲突（任务 9，修正轮：按计划契约两选）：
 * 重载（重拉内容与期望值，本地脏态作废）/ 覆盖（以 409 载荷当前 mtimeNs/size
 * 直接重存本地修改，丢弃磁盘上另一来源的改动）。无显式取消钮（计划两选）；
 * Dialog 原语自带 X 关闭钮（保留），关闭即维持本地内容继续编辑（onDismiss）。 */
export function SaveConflictDialog({
  busy,
  onReload,
  onOverwrite,
  onDismiss,
}: {
  busy: boolean;
  onReload: () => void;
  onOverwrite: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <DialogContent data-testid="files-save-conflict-dialog">
        <DialogHeader>
          <DialogTitle>{t("files.saveConflict.title")}</DialogTitle>
          <DialogDescription>{t("files.saveConflict.desc")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" data-testid="files-save-conflict-reload" disabled={busy} onClick={onReload}>
            {t("files.saveConflict.reload")}
          </Button>
          <Button data-testid="files-save-conflict-overwrite" disabled={busy} onClick={onOverwrite}>
            {t("files.saveConflict.overwrite")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
