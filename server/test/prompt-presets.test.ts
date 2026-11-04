// 专属提示词只读暴露单测（2026-11-03 底栏模型区徽标）。
// 聚焦：resolveModelPromptPreset 解析链（显式档 > 内置匹配器 > null）、
// promptPresetMap 键空间（"provider/model"）、/api/models 载荷 promptPresets 字段。
// 全部 mkdtemp + env 注入隔离 agentDir，绝不触碰真实设置文件。
import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createMetaRoutes } from "../src/api/routes-meta";
import { promptPresetMap, resolveModelPromptPreset } from "../src/api/prompt-presets";
import type { EngineModelInfo } from "../src/adapter/engine-adapter";

const tempRoots: string[] = [];
const savedAgentDir = process.env.UL_OMO_WEBUI_AGENT_DIR;

/** 隔离 agentDir：临时目录 + 可选全局 settings.json（promptPreset 档） */
function isolateAgentDir(settings?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "preset-badge-"));
  tempRoots.push(dir);
  if (settings) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  }
  process.env.UL_OMO_WEBUI_AGENT_DIR = dir;
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
  if (savedAgentDir === undefined) delete process.env.UL_OMO_WEBUI_AGENT_DIR;
  else process.env.UL_OMO_WEBUI_AGENT_DIR = savedAgentDir;
});

const MODELS: EngineModelInfo[] = [
  { provider: "zai-coding-cn", id: "glm-5.3", contextWindow: 1, reasoning: true },
  { provider: "unknown", id: "not-a-preset-model", contextWindow: 1, reasoning: false },
];

describe("resolveModelPromptPreset 解析链", () => {
  test("auto（缺省 settings）走内置匹配器：glm-5.3 命中，未收录模型 null", () => {
    isolateAgentDir();
    expect(resolveModelPromptPreset(MODELS[0]!)).toBe("glm-5.3");
    expect(resolveModelPromptPreset(MODELS[1]!)).toBeNull();
  });

  test("settings.promptPreset 显式档优先于匹配器（对全部模型生效）", () => {
    isolateAgentDir({ promptPreset: "glm-5.2" });
    expect(resolveModelPromptPreset(MODELS[0]!)).toBe("glm-5.2");
    expect(resolveModelPromptPreset(MODELS[1]!)).toBe("glm-5.2");
  });

  test("auto 与缺省同义（显式走匹配器）；读取异常不外抛", () => {
    isolateAgentDir({ promptPreset: "auto" });
    expect(resolveModelPromptPreset(MODELS[0]!)).toBe("glm-5.3");
    // 指向不存在目录：读文件失败静默回退 auto 链
    process.env.UL_OMO_WEBUI_AGENT_DIR = join(tmpdir(), "preset-badge-missing-dir");
    expect(resolveModelPromptPreset(MODELS[0]!)).toBe("glm-5.3");
  });
});

describe("promptPresetMap 键空间", () => {
  test("逐模型键 \"provider/model\"，未命中显式 null（与字段缺席区分）", () => {
    isolateAgentDir();
    expect(promptPresetMap(MODELS)).toEqual({
      "zai-coding-cn/glm-5.3": "glm-5.3",
      "unknown/not-a-preset-model": null,
    });
  });
});

describe("GET /api/models 载荷 promptPresets", () => {
  test("模型枚举响应携带同键映射", async () => {
    isolateAgentDir();
    const app = new Hono().route(
      "/",
      createMetaRoutes({
        meta: { listProjectMeta: () => [{ projectPath: "/proj" }] } as never,
        engines: { modelsList: async () => MODELS } as never,
      }),
    );
    const res = await app.request("/api/models?project=/proj");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promptPresets?: Record<string, string | null> };
    expect(body.promptPresets).toEqual({
      "zai-coding-cn/glm-5.3": "glm-5.3",
      "unknown/not-a-preset-model": null,
    });
  });
});
