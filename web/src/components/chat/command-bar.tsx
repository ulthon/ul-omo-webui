// 斜杠命令按钮行（todo 24）。命令映射与支持度实证见 commands.ts 与
// docs/verification/05：支持路径保留（POST prompt 发送原文，引擎命令系统处理），
// compact 例外（docs08-r5 任务 8）：直调压缩端点（引擎协议面 compact 实证），
// 绝不落 api.prompt（模型会伪执行已压缩）；不支持项禁用死文案，数据驱动显隐，
// 命令门链（commands.ts → chat-view → api.prompt）不随显隐变化，输入拦截继续兜底。
import { useState } from "react";
import { ApiError, api } from "@/lib/api";
import { t } from "@/i18n/i18n";
import { useUiStore } from "@/stores/ui";
import { CHAT_COMMANDS, type ChatCommand } from "./commands";
import { compactToastText, runCompact } from "./compact-run";

export function CommandBar({ sessionId, busy, hydrationLocked = false }: { sessionId: string; busy: boolean; /** 水合锁（docs08-r5 任务 6）：运行态未知窗口禁命令直发；缺省 false 向后兼容既有调用方 */ hydrationLocked?: boolean }) {
  const showToast = useUiStore((s) => s.showToast);
  const [pending, setPending] = useState<string | null>(null);

  const send = async (cmd: ChatCommand) => {
    if (!cmd.supported || busy || hydrationLocked || pending !== null) return;
    setPending(cmd.name);
    try {
      if (cmd.name === "compact") {
        const receipt = await runCompact(sessionId);
        showToast(compactToastText(receipt), "info");
      } else {
        await api.prompt(sessionId, { text: cmd.label });
      }
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : t("chat.commandBar.sendFailed"), "error");
    } finally {
      setPending(null);
    }
  };

  const allUnsupported = CHAT_COMMANDS.every((c) => !c.supported);

  // 全不支持 → 整条不渲染；任一命令受支持才按按钮逻辑出现
  if (allUnsupported) return null;

  return (
    <div data-testid="command-bar" className="flex flex-wrap items-center gap-1.5">
      {CHAT_COMMANDS.map((cmd) => (
        <button
          key={cmd.name}
          type="button"
          data-testid={`cmd-${cmd.name}`}
          disabled={!cmd.supported || busy || hydrationLocked || pending !== null}
          title={cmd.supported ? t("chat.commandBar.sendTitle", { label: cmd.label }) : t("chat.commandBar.unsupportedTitle", { note: cmd.note })}
          aria-disabled={!cmd.supported}
          onClick={() => void send(cmd)}
          className="rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors enabled:hover:bg-muted enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {cmd.label}
        </button>
      ))}
    </div>
  );
}
