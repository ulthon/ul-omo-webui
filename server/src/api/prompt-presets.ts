// 专属提示词（prompt-preset）只读暴露：模型 id → 引擎内置 preset 名映射。
// 引擎在会话侧按模型自动套用内置专属系统提示（prompt-preset 扩展），此前仅 CLI 头部
// 可见；这里把同一解析结果只读下发给 webui（/api/models 载荷 promptPresets 字段）。
// 解析链对齐引擎 presets.js resolvePresetName：settings.promptPreset 显式档 >
// 模型元数据 promptPreset > 内置匹配器（@code-yeongyu/senpi/prompt-presets 公共导出）。
// 用户自带 system prompt（customPrompt）时引擎不套用——该场景 webui 不产生，徽标恒按
// 上链展示（偏差见任务报告）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../config";
import type { EngineModelInfo } from "../adapter/engine-adapter";

/** 引擎 prompt-preset 公共解析器（@code-yeongyu/senpi 包官方导出面，勿改深路径） */
import { resolvePresetName as resolveContractPresetName } from "@code-yeongyu/senpi/prompt-presets";

/** settings.json 的 promptPreset 档解析（镜像引擎 parsePromptPreset 语义的宽松子集）：
 * "auto"/缺省/非法 → undefined（走内置匹配器）；其余字符串按引擎 VALID_PRESETS 白名单
 * 由调用方保证（引擎侧写入口已校验，这里不再复刻白名单）。 */
function explicitPreset(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || value === "auto") return undefined;
  return value;
}

/** 读全局 settings.json 的 promptPreset（agentDir 同源引擎全局设置目录；缺文件/解析
 * 失败一律 undefined——徽标是增强展示，任何读取异常都不得影响 /api/models 主链路）。 */
function globalPresetSetting(): string | undefined {
  try {
    const raw = readFileSync(join(agentDir(), "settings.json"), "utf8");
    return explicitPreset(JSON.parse(raw)?.promptPreset);
  } catch {
    return undefined;
  }
}

/** 单模型解析：显式档优先，否则内置匹配器（未命中返回 null，web 端不渲染徽标） */
export function resolveModelPromptPreset(model: Pick<EngineModelInfo, "provider" | "id">): string | null {
  const explicit = globalPresetSetting();
  if (explicit) return explicit;
  return resolveContractPresetName({ providerID: model.provider, modelID: model.id, name: model.id }) ?? null;
}

/** 模型清单 → "provider/model" → preset 名映射（null 值同样下发：显式表达「无专属
 * 提示词」，与字段缺席（旧服务端）区分）。解析纯 CPU、无 IO（settings 每次调用读一次）。 */
export function promptPresetMap(models: EngineModelInfo[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const m of models) {
    out[`${m.provider}/${m.id}`] = resolveModelPromptPreset(m);
  }
  return out;
}
