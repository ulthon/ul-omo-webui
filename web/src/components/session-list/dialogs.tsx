// 重命名/删除确认弹窗（计划 todo 15）：列表级单例托管，SessionItem 通过 onDialog(kind, session)
// 打开。重命名 PATCH renamedTitle（提交空值 = 服务端恢复自动名）；删除 DELETE 前二次确认。
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

export interface SessionDialogState {
  kind: "rename" | "delete";
  session: SessionListItem;
}

export function SessionDialogs({ state, onClose, onChanged }: { state: SessionDialogState | null; onClose: () => void; onChanged: () => void }) {
  const showToast = useUiStore((s) => s.showToast);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state?.kind === "rename") {
      setTitle(state.session.renamedTitle ?? "");
      setError(null);
    }
  }, [state]);

  if (!state) return null;
  const { session } = state;

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
