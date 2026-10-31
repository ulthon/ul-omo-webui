// 更新检测单测（2026-10-31 update 批）：fetch 注入三态——有更新/无更新/registry 死。
// env 全量注入（registry 基址/包名/当前版本），不触网、不探测本机 npm config。
import { afterEach, describe, expect, test } from "vitest";
import { checkUpdates, compareVersions } from "../src/update/checker";

const REGISTRY = "http://registry.test";

function setEnv(): void {
  process.env.UL_OMO_WEBUI_UPDATE_REGISTRY = REGISTRY;
  process.env.UL_OMO_WEBUI_UPDATE_PKG = "qa-webui-stub";
  process.env.UL_OMO_WEBUI_UPDATE_CURRENT_OVERRIDE = "1.0.0";
  process.env.UL_OMO_WEBUI_UPDATE_ENGINE_PKG = "qa-engine-stub";
}

afterEach(() => {
  delete process.env.UL_OMO_WEBUI_UPDATE_REGISTRY;
  delete process.env.UL_OMO_WEBUI_UPDATE_PKG;
  delete process.env.UL_OMO_WEBUI_UPDATE_CURRENT_OVERRIDE;
  delete process.env.UL_OMO_WEBUI_UPDATE_ENGINE_PKG;
});

function metaResponse(latest: string): Response {
  return new Response(JSON.stringify({ "dist-tags": { latest } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("checkUpdates", () => {
  test("有更新：latest 大于 current → hasUpdate true 且版本透传", async () => {
    setEnv();
    const seen: string[] = [];
    const result = await checkUpdates({
      fetchImpl: async (url) => {
        seen.push(url);
        return metaResponse("1.0.1");
      },
    });
    expect(result.webui).toEqual({ current: "1.0.0", latest: "1.0.1", hasUpdate: true });
    // 引擎包 env 指向未安装 stub → current unknown，latest 仍透传、hasUpdate 恒 false
    expect(result.engine).toEqual({ current: "unknown", latest: "1.0.1", hasUpdate: false });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(`${REGISTRY}/${encodeURIComponent("qa-webui-stub")}`);
  });

  test("无更新：latest 等于 current → hasUpdate false", async () => {
    setEnv();
    const result = await checkUpdates({ fetchImpl: async () => metaResponse("1.0.0") });
    expect(result.webui).toEqual({ current: "1.0.0", latest: "1.0.0", hasUpdate: false });
  });

  test("registry 死（fetch reject）：latest unknown、hasUpdate false、整体仍 resolve", async () => {
    setEnv();
    const result = await checkUpdates({
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    expect(result.webui).toEqual({ current: "1.0.0", latest: "unknown", hasUpdate: false });
    expect(result.engine).toEqual({ current: "unknown", latest: "unknown", hasUpdate: false });
  });
});

describe("compareVersions", () => {
  test("点分数字逐段 + 数字前缀容尾 + 前导 v 剥离", () => {
    expect(compareVersions("2026.10.28", "2026.10.27-1")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
  });
});
