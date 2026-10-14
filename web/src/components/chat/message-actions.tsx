// 消息级操作菜单（计划 todo 25）：复制 markdown 原文 + 重试（fork 分支后自动重发原文）。
// "编辑后重发"按降级约定不渲染入口：capabilities.editResend=false（verification/05 P1-6，
// 官配引擎无 continue_from_leaf 协议面），fork 重试为替代路径，代码层无该入口。
import { useMemo, useState } from "react";
import { Copy, Loader2, MoreVertical, RotateCcw } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { WireMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { refreshSessions } from "@/lib/bootstrap";
import { useMessagesStore } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { entryRole, findForkTargetEntry, messageRawText } from "./message-actions-data";

export function MessageActions({ sessionId, entryId, align = "start" }: { sessionId: string; entryId: string; align?: "start" | "end" }) {
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const entry = useMessagesStore((s) => {
    const entries = s.bySession[sessionId]?.entries;
    return entries?.find((e) => e.id === entryId) ?? null;
  });
  const role = entryRole(entry ?? undefined);
  // fork 目标与重发原文：本条为 user 取自身，assistant 就近向前取 user 条目
  const forkTarget = useMemo(() => {
    if (!entry || !role) return null;
    const entries = useMessagesStore.getState().bySession[sessionId]?.entries ?? [];
    const target = findForkTargetEntry(entries, entryId, role);
    if (!target?.id) return null;
    return { id: target.id, text: messageRawText(target.message as WireMessage) };
  }, [entry, role, sessionId, entryId]);

  if (!entry || (role !== "user" && role !== "assistant")) return null;

  const onCopy = async () => {
    const ok = await copyText(messageRawText(entry.message as WireMessage));
    showToast(ok ? "已复制原文" : "复制失败（浏览器未授权剪贴板）", ok ? undefined : "error");
  };

  const onRetry = async () => {
    if (!forkTarget || busy) return;
    setBusy(true);
    try {
      const forked = await api.forkSession(sessionId, { entryId: forkTarget.id, position: "before" });
      // 切到 fork 会话（human 视图不列 fork 子会话，"全部活动"视图按血缘归组可见）+ 列表刷新
      useSessionsStore.getState().select(forked.session.id);
      void refreshSessions();
      showToast("已创建重试分支，正在重新生成…");
      // 重试语义：fork 的新会话是该消息之前的上下文，自动重发原消息触发新一轮生成
      if (forked.text) {
        await api.prompt(forked.session.id, { text: forked.text });
      }
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "重试失败", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* todo 26 走查修复：手机无 hover，opacity-0 使消息操作不可达——lg 以下常显；触控 44px */}
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 text-muted-foreground opacity-100 transition-opacity data-[state=open]:opacity-100 lg:size-5 lg:opacity-0 lg:group-hover:opacity-100"
          aria-label="消息操作"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <MoreVertical className="size-3.5" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-48">
        <DropdownMenuItem onSelect={() => void onCopy()}>
          <Copy className="mr-2 size-4" />
          复制原文
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy || !forkTarget} onSelect={() => void onRetry()}>
          <RotateCcw className="mr-2 size-4" />
          重试（从此消息重新生成）
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
