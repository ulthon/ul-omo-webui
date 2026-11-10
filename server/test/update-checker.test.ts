// 更新检测单测（2026-10-31 update 批）：fetch 注入三态——有更新/无更新/registry 死。
// env 全量注入（registry 基址/包名/当前版本），不触网、不探测本机 npm config。
// 2026-11-01 批：引擎 current 的 CLI 兑底默认关闸（ENGINE_BIN 空串），未装 stub 包
// 仍保持 unknown 旧语义；兑底自身由专用用例注入 bin 脚本驱动。
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { checkUpdates, compareVersions, engineCurrentVersion, enginePairedVersion } from "../src/update/checker";

const REGISTRY = "http://registry.test";

function setEnv(): void {
  process.env.UL_OMO_WEBUI_UPDATE_REGISTRY = REGISTRY;
  process.env.UL_OMO_WEBUI_UPDATE_PKG = "qa-webui-stub";
  process.env.UL_OMO_WEBUI_UPDATE_CURRENT_OVERRIDE = "1.0.0";
  process.env.UL_OMO_WEBUI_UPDATE_ENGINE_PKG = "qa-engine-stub";
  // 引擎配套版本（2026-11-11 批语义）：latest 不再查 registry，测试用 env 直达覆盖
  process.env.UL_OMO_WEBUI_UPDATE_ENGINE_PAIRED = "9.9.9";
  // CLI 兑底关闸：stub 包未安装，保持 current unknown 旧语义（兑底另测）
  process.env.UL_OMO_WEBUI_UPDATE_ENGINE_BIN = "";
}

afterEach(() => {
  delete process.env.UL_OMO_WEBUI_UPDATE_REGISTRY;
  delete process.env.UL_OMO_WEBUI_UPDATE_PKG;
  delete process.env.UL_OMO_WEBUI_UPDATE_CURRENT_OVERRIDE;
  delete process.env.UL_OMO_WEBUI_UPDATE_ENGINE_PKG;
  delete process.env.UL_OMO_WEBUI_UPDATE_ENGINE_PAIRED;
  delete process.env.UL_OMO_WEBUI_UPDATE_ENGINE_BIN;
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
    // 引擎包 env 指向未安装 stub → current unknown；latest 取配套版本（env 覆盖值），
    // current unknown 则 hasUpdate 恒 false；引擎不查 registry（只拉 webui 元数据）
    expect(result.engine).toEqual({ current: "unknown", latest: "9.9.9", hasUpdate: false });
    expect(seen).toHaveLength(1);
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
    // 引擎 latest 取配套版本，不受 registry 可达性影响
    expect(result.engine).toEqual({ current: "unknown", latest: "9.9.9", hasUpdate: false });
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

// CLI 兑底（2026-11-01 批）：node_modules 解析失败 → 注入 bin --version 取版本。
// stub 放仓库内 test/tmp/（本机 /tmp 可能 noexec，exec 位脚本须在可执行挂载点）。
describe("engineCurrentVersion CLI 兑底", () => {
  const STUB_DIR = new URL("./tmp/update-checker-bin-stub/", import.meta.url).pathname;

  function writeVersionStub(version: string): string {
    mkdirSync(STUB_DIR, { recursive: true });
    const path = `${STUB_DIR}omo-stub.sh`;
    writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  test("node_modules 解析失败 → bin 注入返回 2026.10.27-1；结果缓存进程生命周期", () => {
    setEnv();
    const stub = writeVersionStub("2026.10.27-1");
    try {
      process.env.UL_OMO_WEBUI_UPDATE_ENGINE_BIN = stub;
      expect(engineCurrentVersion()).toBe("2026.10.27-1");
      // 缓存生效：stub 移除后再取仍同值（进程内不重复 spawn）
      rmSync(stub);
      expect(engineCurrentVersion()).toBe("2026.10.27-1");
    } finally {
      rmSync(STUB_DIR, { recursive: true, force: true });
    }
  });

  test("兑底 spawn 失败（bin 不存在）→ unknown 不报错", () => {
    setEnv();
    process.env.UL_OMO_WEBUI_UPDATE_ENGINE_BIN = "./qa-no-such-bin";
    expect(engineCurrentVersion()).toBe("unknown");
  });
});

// 配套版本解析（2026-11-11 批）：env 直达覆盖 > 宿主包（omo-ai）依赖声明。
describe("enginePairedVersion", () => {
  test("env UL_OMO_WEBUI_UPDATE_ENGINE_PAIRED 直达覆盖生效", () => {
    process.env.UL_OMO_WEBUI_UPDATE_ENGINE_PAIRED = "2026.11.10-2";
    expect(enginePairedVersion()).toBe("2026.11.10-2");
    delete process.env.UL_OMO_WEBUI_UPDATE_ENGINE_PAIRED;
  });

  test("宿主包不存在（node_modules 与全局均无）→ unknown 不报错", () => {
    process.env.UL_OMO_WEBUI_UPDATE_ENGINE_PAIRED = ""; // 显式清空：走宿主包解析
    process.env.UL_OMO_WEBUI_UPDATE_ENGINE_HOST_PKG = "qa-no-such-host";
    try {
      expect(enginePairedVersion()).toBe("unknown");
    } finally {
      delete process.env.UL_OMO_WEBUI_UPDATE_ENGINE_PAIRED;
      delete process.env.UL_OMO_WEBUI_UPDATE_ENGINE_HOST_PKG;
    }
  });
});
