// 斜杠命令表与拦截判定（todo 24）。
// 实证结论（docs/verification/05「/compact /clear /new /undo 命令支持度实证」）：
// 四命令均未注册于引擎命令系统（getCommands 83 条无命中），prompt 直发会被引擎当
// 普通消息交给模型，且模型会伪造"已执行"（"已撤销"/"上下文已清空"均无实际效果）
// ——故四命令判不支持：按钮禁用 + 输入拦截明示，绝不静默直发。
import { ApiError } from "@/lib/api";

export interface ChatCommand {
  /** 命令名（不含斜杠，小写） */
  name: string;
  label: string;
  supported: boolean;
  /** 不支持时的明示文案 */
  note: string;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    name: "compact",
    label: "/compact",
    supported: false,
    note: "压缩上下文：引擎未注册该命令，直发会被模型当作普通消息",
  },
  {
    name: "clear",
    label: "/clear",
    supported: false,
    note: "清空上下文：引擎未注册该命令，直发会被模型当作普通消息",
  },
  {
    name: "new",
    label: "/new",
    supported: false,
    note: "新建会话：引擎未注册该命令，请用侧栏「新建会话」",
  },
  {
    name: "undo",
    label: "/undo",
    supported: false,
    note: "撤销上一条：引擎未注册该命令，直发会被模型当作普通消息",
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
      `引擎不支持命令 ${cmd.label}：${cmd.note}（实证记录见 docs/verification/05）`,
    );
  };
}

export const commandGate = makeCommandGate(CHAT_COMMANDS);
