// 重命名/删除确认弹窗（计划 todo 15）+ 批量删除确认（todo 25）：列表级单例托管，
// SessionItem 通过 onDialog(kind, session) 打开、session-list 打开批量删除。
// 重命名 PATCH renamedTitle（提交空值 = 服务端恢复自动名）；删除 DELETE 前二次确认；
// 批量删除逐个调既有 DELETE 循环 + 进度反馈，失败逐条报告不中断整批（>20 个强化确认）。
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import type { SessionListItem } from "@/lib/api";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type SessionDialogState =
  | { kind: "rename" | "delete"; session: SessionListItem }
  | { kind: "batch-delete"; ids: string[]; titles: string[] };

/** 批量删除强化确认阈值（MUST DO：一次 >20 个二次确认强化） */
const BULK_DELETE_CONFIRM_THRESHOLD = 20;

export function SessionDialogs({ state, onClose, onChanged }: { state: SessionDialogState | null; onClose: () => void; onChanged: () => void }) {
  const showToast = useUiStore((s) => s.showToast);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // batch-delete 专属状态：>20 强化勾选、进度、失败清单
  const [confirmedBulk, setConfirmedBulk] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ title: string; message: string }>>([]);

  useEffect(() => {
    if (state?.kind === "rename") {
      setTitle(state.session.renamedTitle ?? "");
      setError(null);
    }
    if (state?.kind === "batch-delete") {
      setConfirmedBulk(false);
      setProgress(null);
      setFailures([]);
      setError(null);
    }
  }, [state]);

  if (!state) return null;

  const submitRename = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = title.trim();
      // title 与 renamedTitle 同步更新：列表行展示的是服务端合并后的 title
      // （renamedTitle ?? name ?? firstMessage 截断），只 patch renamedTitle 会让行显示滞留旧值
      const nextTitle =
        trimmed === "" ? session.name ?? (session.firstMessage ? session.firstMessage.slice(0, 80) : "(空会话)") : trimmed;
      await api.patchSessionMeta(session.id, { renamedTitle: trimmed === "" ? null : trimmed });
      useSessionsStore.getState().patchSession(session.id, { renamedTitle: trimmed === "" ? null : trimmed, title: nextTitle });
      showToast(trimmed === "" ? "已恢复自动命名" : "已重命名");
      onClose();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "重命名失败");
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteSession(session.id);
      useSessionsStore.getState().removeSession(session.id);
      showToast("会话已删除");
      onClose();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
      setBusy(false);
    }
  };

  /** 批量删除：逐个调既有 DELETE，失败逐条收集不中断整批；完成后统一汇报 */
  const submitBatchDelete = async () => {
    if (busy || state.kind !== "batch-delete") return;
    const { ids, titles } = state;
    setBusy(true);
    setError(null);
    const failed: Array<{ title: string; message: string }> = [];
    let done = 0;
    for (let i = 0; i < ids.length; i++) {
      setProgress({ done: i, total: ids.length });
      try {
        await api.deleteSession(ids[i]);
        useSessionsStore.getState().removeSession(ids[i]);
      } catch (err) {
        failed.push({
          title: titles[i] ?? ids[i],
          message: err instanceof ApiError ? err.message : "删除失败",
        });
      }
      done = i + 1;
      setProgress({ done, total: ids.length });
    }
    setFailures(failed);
    setBusy(false);
    if (failed.length === 0) {
      showToast(`已删除 ${ids.length} 个会话`);
      onClose();
    } else {
      setError(`${failed.length} 个会话删除失败：${failed.map((f) => f.title).join("、")}`);
      showToast(`已删除 ${ids.length - failed.length}/${ids.length} 个，其余失败`, "error");
    }
    onChanged();
  };

  if (state.kind === "batch-delete") {
    const { ids, titles } = state;
    const needStrongConfirm = ids.length > BULK_DELETE_CONFIRM_THRESHOLD;
    const preview = titles.slice(0, 5);
    return (
      <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>批量删除会话</DialogTitle>
            <DialogDescription>
              将删除 {ids.length} 个会话的记录、元数据与引擎侧文件，终端 omo -r 也不再可见。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-32 space-y-0.5 overflow-y-auto rounded bg-muted px-2 py-1.5 text-sm">
            {preview.map((t, i) => (
              <li key={ids[i]} className="truncate" title={t}>
                {t}
              </li>
            ))}
            {titles.length > preview.length && (
              <li className="text-muted-foreground">…等共 {titles.length} 个</li>
            )}
          </ul>
          {needStrongConfirm && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmedBulk}
                onChange={(e) => setConfirmedBulk(e.target.checked)}
                disabled={busy}
              />
              我确认删除全部 {ids.length} 个会话（超过 {BULK_DELETE_CONFIRM_THRESHOLD} 个需强化确认）
            </label>
          )}
          {progress && <p className="text-sm text-muted-foreground">删除中 {progress.done}/{progress.total}…</p>}
          {failures.length > 0 && (
            <ul className="max-h-24 space-y-0.5 overflow-y-auto rounded bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
              {failures.map((f, i) => (
                <li key={`${f.title}-${i}`} className="truncate" title={`${f.title}：${f.message}`}>
                  {f.title}：{f.message}
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {busy ? "取消" : "关闭"}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || (needStrongConfirm && !confirmedBulk)}
              onClick={() => void submitBatchDelete()}
            >
              {busy ? `删除中…` : `删除 ${ids.length} 个`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const { session } = state;
  return state.kind === "rename" ? (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submitRename}>
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>留空提交可恢复自动命名。</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={session.title} autoFocus />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  ) : (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除会话</DialogTitle>
          <DialogDescription>
            将删除会话记录与元数据，引擎侧文件一并移除，终端 omo -r 也不再可见。此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <p className="max-w-full truncate rounded bg-muted px-2 py-1.5 text-sm" title={session.title}>
          {session.title}
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void submitDelete()}>
            {busy ? "删除中…" : "删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
