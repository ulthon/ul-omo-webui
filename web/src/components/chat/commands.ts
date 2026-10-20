// 斜杠命令表与拦截判定（todo 24）。
// 实证结论（docs/verification/05 + docs08-r5 任务 8 spike 重核）：
// - /compact 翻案为支持（docs08-r5 任务 8）：命令不在引擎 get_commands 枚举（隔离实例
//   重核 75 条无命中，枚举源只收 extension/prompts/skills），但官方 RpcClient 暴露
//   类型化 compact()（协议面 compact -> session.compact()，与 CLI /compact 共用入口），
//   webui 直调压缩端点，绝不进 prompt 通道（模型会伪执行）。
// - /clear /new /undo 仍无稳定会话级调用面：prompt 直发被模型当普通消息并伪造"已执行"
//   ——判不支持：按钮禁用 + 输入拦截明示，绝不静默直发。
import { ApiError } from "@/lib/api";
import { t } from "@/i18n/i18n";

export interface ChatCommand {
  /** 命令名（不含斜杠，小写） */
  name: string;
  label: string;
  supported: boolean;
  /** 不支持时的明示文案（任务 10：getter 懒取词，避免模块加载期求值；组件/门读到的
   *  已是当前语言渲染后的字符串，对外契约不变） */
  note: string;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    name: "compact",
    label: "/compact",
    supported: true,
    get note() {
      return t("chat.commands.compactNote");
    },
  },
  {
    name: "clear",
    label: "/clear",
    supported: false,
    get note() {
      return t("chat.commands.clearNote");
    },
  },
  {
    name: "new",
    label: "/new",
    supported: false,
    get note() {
      return t("chat.commands.newNote");
    },
  },
  {
    name: "undo",
    label: "/undo",
    supported: false,
    get note() {
      return t("chat.commands.undoNote");
    },
  },
];

export interface ParsedCommand {
  name: string;
  args: string;
}

/** 解析 / 前缀命令："/compact 参数" → {name:"compact",args:"参数"}；非命令文本返回 null */
export function parseSlashCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const m = trimmed.slice(1).match(/^([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

export function lookupCommand(name: string): ChatCommand | undefined {
  return CHAT_COMMANDS.find((c) => c.name === name);
}

/**
 * prompt 命令门（chat-view 经 api.setPromptGate 注册）：
 * 命中映射表内不支持的命令 → 抛 ApiError 阻止直通模型（composer 行内展示）；
 * 支持的命令与非映射文本（引擎 83 条注册命令如 /init /todo、普通消息）原样放行。
 */
export function makeCommandGate(commands: ChatCommand[]): (text: string) => void {
  return (text: string) => {
    const parsed = parseSlashCommand(text);
    if (!parsed) return;
    const cmd = commands.find((c) => c.name === parsed.name);
    if (!cmd || cmd.supported) return;
    throw new ApiError(
      501,
      "command_unsupported",
      t("chat.commands.gateMessage", { label: cmd.label, note: cmd.note }),
    );
  };
}

export const commandGate = makeCommandGate(CHAT_COMMANDS);
