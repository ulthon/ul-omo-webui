// 消息级操作菜单（todo 25 → session-branching todo 8/todo 9）：复制 markdown 原文 /
// 重试（treeNavigation=true 走 navigate+prompt 原会话路径，false 保留 fork 降级
// IS-8）/「从此此处分支」「编辑重发」（user 条目 + treeNavigation 门控，IS-4/IS-5）/
// assistant 侧「编辑回复」（editResend 能力位 true：edit+continue+刷新链，IS-6 主路径）
// 或降级「复制到新会话续跑」（能力位 false：fork at 含该回复另起会话，功能不砍）。
// 动作体在 message-actions-data（依赖注入，测试免 mock）；编辑回填单一源纪律
// （F20）：文本只走 api.putDraft 服务端草稿 + uiStore.draftRefill 信号触发输入框
// 重拉，putDraft 之后绝无内存 handoff（composerInject 通道不复用）。assistant 编辑
// 文本经 AssistantEditDialog 采集（CLI 编辑器同构），确认后两段链一次性走完。
import { useMemo, useState } from "react";
import { Copy, GitBranch, Loader2, MoreVertical, PencilLine, RotateCcw, Split } from "lucide-react";
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
  runCopyContinueNewSession,
  runEditReply,
  runEditResend,
  runRetry,
  type MessageActionDeps,
} from "./message-actions-data";
import { AssistantEditDialog } from "./assistant-edit-dialog";

export function MessageActions({
  sessionId,
  entryId,
  align = "start",
  switchDisabled,
}: {
  sessionId: string;
  entryId: string;
  align?: "start" | "end";
  /** 流式/运行/等待中锁定（todo 9 复用既有口径：chat-view branchSwitchLocked 下传）
   *  ——assistant 编辑/降级项菜单级禁用，与 store 侧前置门双层兑底 */
  switchDisabled?: boolean;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const entry = useMessagesStore((s) => {
    const entries = s.bySession[sessionId]?.entries;
    return entries?.find((e) => e.id === entryId) ?? null;
  });
  // 本地叶指针（F13 CAS）：edit_assistant_message 的 expectedLeafId 透传源
  const leafId = useMessagesStore((s) => s.bySession[sessionId]?.leafId ?? null);
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

  const menuItems = messageMenuItems({
    role,
    treeNavigation: capabilities.treeNavigation,
    editResend: capabilities.editResend,
  });

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
    actionFailedMessage: (err, fallbackKey) => apiErrorMessage(err, fallbackKey),
    editAssistant: (sid, body) => api.editAssistantMessage(sid, body),
    continueFromLeaf: (sid, body) => api.continueFromLeaf(sid, body),
    refreshAfterContinue: (sid, d) => useMessagesStore.getState().refreshAfterContinue(sid, d),
    recalibrateAfterStale: (sid, d) => useMessagesStore.getState().recalibrateAfterStale(sid, d),
    texts: {
      branchNavigateFailed: t("chat.messageActions.branchNavigateFailed"),
      retryResent: t("chat.messageActions.retryResent"),
      retryBranchCreated: t("chat.messageActions.retryBranchCreated"),
      copyContinueCreated: t("chat.messageActions.copyContinueCreated"),
      editRefreshFailed: t("chat.messageActions.editRefreshFailed"),
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

  // 编辑回复（IS-6 主路径，todo 9）：对话框采集编辑文本（菜单只开窗不动作，
  // 流式锁定时入口禁用）；确认后 edit→continue→刷新两段链一次性走完，
  // expectedLeafId=本地叶指针透传（F13）
  const onEditReplyConfirm = async (text: string) => {
    if (!entry || busy) return;
    setEditOpen(false);
    setBusy(true);
    try {
      await runEditReply(sessionId, entryId, text, leafId ?? undefined, deps());
    } finally {
      setBusy(false);
    }
  };

  // 复制到新会话续跑（IS-6 降级路径）：fork at 含该回复另起会话，不自动发送
  const onCopyContinue = async () => {
    if (!entry || busy) return;
    setBusy(true);
    try {
      await runCopyContinueNewSession(sessionId, entryId, deps());
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
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
        {menuItems.includes("editReply") && (
          <DropdownMenuItem
            data-testid="message-action-edit-reply"
            disabled={busy || switchDisabled === true}
            onSelect={() => {
              if (busy || switchDisabled === true) return;
              setEditOpen(true);
            }}
          >
            <PencilLine className="mr-2 size-4" />
            {t("chat.messageActions.editReply")}
          </DropdownMenuItem>
        )}
        {menuItems.includes("copyContinue") && (
          <DropdownMenuItem
            data-testid="message-action-copy-continue"
            disabled={busy || switchDisabled === true}
            onSelect={() => {
              if (busy || switchDisabled === true) return;
              void onCopyContinue();
            }}
          >
            <Split className="mr-2 size-4" />
            {t("chat.messageActions.copyContinue")}
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
    <AssistantEditDialog
      open={editOpen}
      onOpenChange={setEditOpen}
      initialText={messageRawText(entry.message as WireMessage)}
      locked={switchDisabled === true}
      onConfirm={(text) => void onEditReplyConfirm(text)}
    />
    </>
  );
}
