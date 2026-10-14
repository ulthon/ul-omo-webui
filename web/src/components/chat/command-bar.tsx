// 斜杠命令按钮行（todo 24）。命令映射与支持度实证见 commands.ts 与
// docs/verification/05：支持路径保留（POST prompt 发送原文，引擎命令系统处理）；
// 全不支持时整条不渲染（docs08-r3 任务 14/A4：数据驱动显隐，禁用态死文案移除），
// 命令门链（commands.ts → chat-view → api.prompt）不随显隐变化，输入拦截继续兜底。
import { useState } from "react";
import { ApiError, api } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { CHAT_COMMANDS, type ChatCommand } from "./commands";

export function CommandBar({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const showToast = useUiStore((s) => s.showToast);
  const [pending, setPending] = useState<string | null>(null);

  const send = async (cmd: ChatCommand) => {
    if (!cmd.supported || busy || pending !== null) return;
    setPending(cmd.name);
    try {
      await api.prompt(sessionId, { text: cmd.label });
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "命令发送失败", "error");
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
          disabled={!cmd.supported || busy || pending !== null}
          title={cmd.supported ? `发送 ${cmd.label}` : `引擎不支持：${cmd.note}`}
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
