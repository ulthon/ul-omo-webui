// 思考级别纯助手（W2 todo 8）：chip 可选档与 prompt 注入共用一套判定。
// 服务端两个入口（prompt parseThinkingLevel、PATCH preferredThinkingLevel）都只接受
// low/high/max；而 models-store 下发的 supportedThinkingLevels（thinkingLevelMap 键）
// 是开放集（可能含 off 等档）。过滤到服务端可持久化/可发送的档位，避免 chip 提供必然
// 400 的选项。
import type { ModelInfo } from "@/lib/api";

/** 服务端可持久化 / 可随 prompt 发送的思考档全集（镜像 server THINKING_LEVEL_VALUES） */
export const THINKING_LEVEL_PERSIST_VALUES: readonly string[] = ["low", "high", "max"];

/** 所选模型可用的思考档（保模型声明顺序、去重、滤掉服务端不支持的档）。
 * 模型未下发 supportedThinkingLevels（字段缺席）或过滤后为空 → 空数组 =
 * 思考 chip 整体隐藏（不是禁用），prompt 注入同样视为未选。 */
export function thinkingLevelOptions(model: ModelInfo | null | undefined): string[] {
  const supported = model?.supportedThinkingLevels;
  if (!Array.isArray(supported)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of supported) {
    if (typeof raw !== "string" || seen.has(raw)) continue;
    seen.add(raw);
    if (THINKING_LEVEL_PERSIST_VALUES.includes(raw)) out.push(raw);
  }
  return out;
}

/** prompt 注入档：模型可用档非空且用户有当前选择时注入，否则 undefined
 * （JSON 序列化即缺字段，服务端 parseThinkingLevel 视为 absent）。 */
export function effectiveThinkingLevel(
  model: ModelInfo | null | undefined,
  selected: string | null,
): string | undefined {
  return thinkingLevelOptions(model).length > 0 ? (selected ?? undefined) : undefined;
}
