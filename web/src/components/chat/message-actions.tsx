// 消息级操作菜单（todo 25 → session-branching todo 8）：复制 markdown 原文 /
// 重试（treeNavigation=true 走 navigate+prompt 原会话路径，false 保留 fork 降级
// IS-8）/「从此此处分支」「编辑重发」（user 条目 + treeNavigation 门控，IS-4/IS-5）。
// 动作体在 message-actions-data（依赖注入，测试免 mock）；编辑回填单一源纪律
// （F20）：文本只走 api.putDraft 服务端草稿 + uiStore.draftRefill 信号触发输入框
// 重拉，putDraft 之后绝无内存 handoff（composerInject 通道不复用）。
import { useMemo, useState } from "react";
import { Copy, GitBranch, Loader2, MoreVertical, PencilLine, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import type { WireMessage } from "@/lib/api";
import { capabilities } from "@/lib/capabilities";
import { copyText } from "@/lib/clipboard";
import { useMessagesStore } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  entryRole,
  findForkTargetEntry,
  messageMenuItems,
  messageRawText,
  runBranchFromHere,
  runEditResend,
  runRetry,
  type MessageActionDeps,
} from "./message-actions-data";

export function MessageActions({ sessionId, entryId, align = "start" }: { sessionId: string; entryId: string; align?: "start" | "end" }) {
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const entry = useMessagesStore((s) => {
    const entries = s.bySession[sessionId]?.entries;
    return entries?.find((e) => e.id === entryId) ?? null;
  });
  const t = useT();
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

  const menuItems = messageMenuItems({ role, treeNavigation: capabilities.treeNavigation });

  // 真实依赖装配（chat-view onSwitchSibling 同款注入先例；动作体见 message-actions-data）
  const deps = (): MessageActionDeps => ({
    switchLeaf: (sid, eid, d) => useMessagesStore.getState().switchLeaf(sid, eid, d),
    navigate: (body) => api.navigate(sessionId, body),
    fetchFull: () => api.listMessages(sessionId, { full: true }),
    putDraft: (sid, content) => api.putDraft(sid, content),
    bumpDraftRefill: (sid) => useUiStore.getState().bumpDraftRefill(sid),
    prompt: (sid, body) => api.prompt(sid, body),
    forkSession: (sid, body) => api.forkSession(sid, body),
    selectSession: (sid) => useSessionsStore.getState().select(sid),
    refreshSessions: () => void useSessionsStore.getState().refreshSessions(),
    pushError: (sid, message) => useMessagesStore.getState().pushError(sid, message),
    showToast: (text) => showToast(text),
    retryFailedMessage: (err) => apiErrorMessage(err, "chat.messageActions.retryFailed"),
    texts: {
      branchNavigateFailed: t("chat.messageActions.branchNavigateFailed"),
      retryResent: t("chat.messageActions.retryResent"),
      retryBranchCreated: t("chat.messageActions.retryBranchCreated"),
    },
  });

  const onCopy = async () => {
    const ok = await copyText(messageRawText(entry.message as WireMessage));
    showToast(ok ? t("chat.messageActions.copied") : t("chat.messageActions.copyFailed"), ok ? undefined : "error");
  };

  // 从此此处分支（IS-5）：select 该 user 条目 → switchLeaf 编排，不自动发送
  const onBranchFromHere = async () => {
    if (!forkTarget || busy) return;
    setBusy(true);
    try {
      await runBranchFromHere(sessionId, forkTarget.id, deps());
    } finally {
      setBusy(false);
    }
  };

  // 编辑重发（IS-4）：select → putDraft 单源回填 → 用户改后经既有 prompt 长新分支
  const onEditResend = async () => {
    if (!forkTarget || busy) return;
    setBusy(true);
    try {
      await runEditResend(sessionId, forkTarget.id, forkTarget.text, deps());
    } finally {
      setBusy(false);
    }
  };

  // 重试（IS-8 双路径）：treeNavigation=true 原会话 navigate+prompt；false fork 降级
  const onRetry = async () => {
    if (!forkTarget || busy) return;
    setBusy(true);
    try {
      await runRetry(sessionId, forkTarget.id, forkTarget.text, capabilities.treeNavigation, deps());
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
          aria-label={t("chat.messageActions.menuLabel")}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <MoreVertical className="size-3.5" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-48">
        <DropdownMenuItem data-testid="message-action-copy" onSelect={() => void onCopy()}>
          <Copy className="mr-2 size-4" />
          {t("chat.messageActions.copy")}
        </DropdownMenuItem>
        {menuItems.includes("branchFromHere") && (
          <DropdownMenuItem
            data-testid="message-action-branch-from-here"
            disabled={busy || !forkTarget}
            onSelect={() => void onBranchFromHere()}
          >
            <GitBranch className="mr-2 size-4" />
            {t("chat.messageActions.branchFromHere")}
          </DropdownMenuItem>
        )}
        {menuItems.includes("editResend") && (
          <DropdownMenuItem
            data-testid="message-action-edit-resend"
            disabled={busy || !forkTarget}
            onSelect={() => void onEditResend()}
          >
            <PencilLine className="mr-2 size-4" />
            {t("chat.messageActions.editResend")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          data-testid="message-action-retry"
          disabled={busy || !forkTarget}
          onSelect={() => void onRetry()}
        >
          <RotateCcw className="mr-2 size-4" />
          {t("chat.messageActions.retry")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
