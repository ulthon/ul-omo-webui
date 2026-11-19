// 写操作确认/冲突弹窗（builtin-file-management 任务 7）：复用 ui/dialog 原语，
// 纯展示组件（重试调用与队列推进由 FilesPage 持有）。无“跳过确认”记忆项（计划 Must NOT）。
// 任务 9 追加：SaveConflictDialog 保存 409 file_changed「重载/覆盖」两选弹窗
// （修正轮按计划契约补覆盖；两选与关闭行为由 FileEditor 持有，仍为纯展示）。
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useT } from "@/i18n/i18n";
import { ApiError, api } from "@/lib/api";
import { apiErrorMessage } from "@/i18n/errors";
import { useUiStore } from "@/stores/ui";
import { FileTree } from "@/components/file-tree/file-tree";
import { parentOf, useFileTreeController } from "@/components/file-tree/file-tree-controller";
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

/** 项目内相对路径拼接（"" 根特判，同 files.tsx 本地副本） */
function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** 末段路径（源条目名） */
function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** 树形移动选择器（files-ux-revamp 任务 9 / IS-6）：替换旧的 typed-path 移动对话框。
 * 内嵌 directoriesOnly FileTree 选目标目录（数据源自持 controller，不复用
 * DirectoryTree——数据源不同，明确出界）；打开时经 controller.reveal 预展开源父目录
 * 并默认选中它；确认即以 joinRel(targetDir, baseName(from)) 发起 fsMove，409
 * target_exists 复用既有三选弹窗（覆盖/保留两者/取消，取消后留在本弹窗可改选目标），
 * 成功经 onDone(moved, to) 交宿主统一收口刷新（refetchAfterOp 归宿主持有）。 */
export function FsMoveDialog({
  project,
  from,
  onDone,
  onClose,
}: {
  project: string;
  /** 移动源相对路径 */
  from: string;
  /** 成功（含冲突重试成功）回调：moved 恒 true，to 为最终目标相对路径；宿主据此收口刷新 */
  onDone: (moved: boolean, to: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const pushGlobalError = useUiStore((s) => s.pushGlobalError);
  const sourceParent = parentOf(from);
  const [targetDir, setTargetDir] = useState(sourceParent);
  const [busy, setBusy] = useState(false);
  // 409 冲突中的目标路径（null = 无冲突弹窗）；重试参数契约与旧流一致
  const [conflictTo, setConflictTo] = useState<string | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const controller = useFileTreeController(project);
  const reveal = controller.reveal;
  useEffect(() => {
    void reveal(sourceParent);
  }, [reveal, sourceParent]);

  const destination = joinRel(targetDir, baseName(from));

  const attempt = async (to: string, params?: { overwrite?: true; conflict?: "rename" }) => {
    setBusy(true);
    try {
      await api.fsMove(project, from, to, params);
      onDone(true, to);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "target_exists") {
        setConflictTo(to);
      } else {
        pushGlobalError(apiErrorMessage(err, "files.op.moveFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const resolveConflict = async (choice: "overwrite" | "rename") => {
    if (!conflictTo || conflictBusy) return;
    setConflictBusy(true);
    try {
      await api.fsMove(project, from, conflictTo, choice === "overwrite" ? { overwrite: true } : { conflict: "rename" });
      setConflictTo(null);
      onDone(true, conflictTo);
    } catch (err) {
      pushGlobalError(apiErrorMessage(err, "files.op.moveFailed"));
    } finally {
      setConflictBusy(false);
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent data-testid="files-move-dialog">
          <DialogHeader>
            <DialogTitle>{t("files.move.title")}</DialogTitle>
            <DialogDescription>{t("files.move.targetLabel")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 min-h-0 overflow-y-auto">
            <FileTree
              project={project}
              selectedPath={targetDir}
              onSelect={() => {}}
              onDirectoryOpen={setTargetDir}
              controller={controller}
              directoriesOnly
            />
          </div>
          <p data-testid="files-move-destination" className="text-sm text-muted-foreground">
            {t("files.move.destination", { path: destination })}
          </p>
          <DialogFooter>
            <Button variant="outline" data-testid="files-move-cancel" disabled={busy} onClick={onClose}>
              {t("files.conflict.cancel")}
            </Button>
            <Button data-testid="files-move-confirm" disabled={busy} onClick={() => void attempt(destination)}>
              {t("files.move.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {conflictTo ? (
        <FsConflictDialog
          desc={t("files.conflict.moveDesc", { path: conflictTo })}
          busy={conflictBusy}
          onOverwrite={() => void resolveConflict("overwrite")}
          onKeepBoth={() => void resolveConflict("rename")}
          onCancel={() => setConflictTo(null)}
        />
      ) : null}
    </>
  );
}
