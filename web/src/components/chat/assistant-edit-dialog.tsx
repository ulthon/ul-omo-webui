// assistant 回复编辑对话框（session-branching todo 9，IS-6 能力位 true 主路径）：
// CLI 官配编辑流的 webui 等价物——编辑器携带 AI 回复原文，保存即走
// edit_assistant_message + continue_from_leaf 两段链（F12；动作体在
// message-actions-data runEditReply，本组件只取编辑文本，不发网络不读 store）。
// 纯受控展示件：open/初始文本/确认回调全由父注入，测试直接渲染断言。
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/i18n/i18n";

export function AssistantEditDialog({
  open,
  onOpenChange,
  initialText,
  /** 流式/运行中锁定（chat-view branchSwitchLocked 同口径）：确认钮禁用 */
  locked,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialText: string;
  locked?: boolean;
  onConfirm: (text: string) => void;
}) {
  const t = useT();
  const [text, setText] = useState(initialText);
  // 每次打开重置为最新原文（同一条目二次编辑不残留上次草稿）
  useEffect(() => {
    if (open) setText(initialText);
  }, [open, initialText]);

  const blank = text.trim() === "";
  const confirmDisabled = locked === true || blank;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="assistant-edit-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("chat.messageActions.editReplyTitle")}</DialogTitle>
          <DialogDescription>{t("chat.messageActions.editReplyHint")}</DialogDescription>
        </DialogHeader>
        <textarea
          data-testid="assistant-edit-textarea"
          className="flex min-h-48 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          value={text}
          aria-label={t("chat.messageActions.editReplyTitle")}
          onChange={(e) => setText(e.target.value)}
        />
        <DialogFooter>
          <Button
            data-testid="assistant-edit-cancel"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="assistant-edit-confirm"
            disabled={confirmDisabled}
            onClick={() => {
              if (confirmDisabled) return;
              onConfirm(text);
            }}
          >
            {t("chat.messageActions.editReplyConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
