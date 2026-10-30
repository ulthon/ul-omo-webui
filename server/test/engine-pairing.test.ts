// 引擎官配守护常驻测试（engine-upgrade 2026-10-30 todo 7）：把 todo 6 的安装态断言
// 固化为门禁——omo-ai 与 @code-yeongyu/senpi 的配对一旦漂移（声明版本与实装版本不
// 一致、引擎内部携带陈旧嵌套副本，即 2026-10-25 probe_gate_failed 事故形态），vitest
// 门禁即红。全部为确定性文件读取：无网络、无等待、不执行引擎代码。
// 漂移演练（验证守护真的能咬人）：设 ENGINE_GUARD_PKGS 把实装树指到别处（如
// node_modules.bak-5.1.30），断言应红；默认读真树，仓库不做任何改动。
import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// 实装树目录：默认 <repo>/node_modules；漂移演练时由 ENGINE_GUARD_PKGS 覆盖
const pkgsDir = process.env.ENGINE_GUARD_PKGS
  ? resolve(process.env.ENGINE_GUARD_PKGS)
  : join(repoRoot, "node_modules");

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

const rootPkg = readJson(join(repoRoot, "package.json"));
const serverPkg = readJson(join(repoRoot, "server", "package.json"));
const omoPkg = readJson(join(pkgsDir, "omo-ai", "package.json"));
const senpiPkg = readJson(join(pkgsDir, "@code-yeongyu", "senpi", "package.json"));

/** 递归收集实装树内 omo-ai / @code-yeongyu/senpi 的全部副本（含嵌套 node_modules）。 */
function collectEngineCopies(dir: string, depth: number, acc: string[]): void {
  if (depth > 10) return;
  let ents: import("node:fs").Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.name === "node_modules") {
      collectEngineCopies(p, depth + 1, acc);
    } else if (e.name.startsWith("@")) {
      collectEngineCopies(p, depth, acc);
    } else {
      const pj = join(p, "package.json");
      if (existsSync(pj)) {
        try {
          const name = readJson(pj).name as string | undefined;
          if (name === "omo-ai" || name === "@code-yeongyu/senpi") acc.push(p);
        } catch {
          // 解析失败的目录不属引擎守护面，忽略
        }
      }
    }
  }
}

describe("引擎官配守护（engine-upgrade 2026-10-30 todo 7）", () => {
  test("双 package.json 声明版本 === 实装树版本（omo-ai 与 @code-yeongyu/senpi）", () => {
    expect(omoPkg.version).toBe(rootPkg.dependencies["omo-ai"]);
    expect(omoPkg.version).toBe(serverPkg.dependencies["omo-ai"]);
    expect(senpiPkg.version).toBe(rootPkg.dependencies["@code-yeongyu/senpi"]);
    expect(senpiPkg.version).toBe(serverPkg.dependencies["@code-yeongyu/senpi"]);
  });

  test("官配对：omo-ai 依赖声明的 senpi 版本 === 顶层实装 senpi 版本", () => {
    expect(omoPkg.dependencies["@code-yeongyu/senpi"]).toBe(senpiPkg.version);
  });

  test("无陈旧嵌套副本：实装树内双包各恰好一份（2026-10-25 事故形态守卫）", () => {
    const copies: string[] = [];
    collectEngineCopies(pkgsDir, 0, copies);
    const topOmo = join(pkgsDir, "omo-ai");
    const topSenpi = join(pkgsDir, "@code-yeongyu", "senpi");
    const nested = copies.filter((p) => p !== topOmo && p !== topSenpi);
    expect(nested).toEqual([]);
    // omo-ai 自身携带的嵌套 senpi（事故首选解析路径）显式再断言一次
    expect(existsSync(join(topOmo, "node_modules", "@code-yeongyu", "senpi"))).toBe(false);
  });

  test("实装引擎暴露 RPC 能力令牌：extension_events 与 question 字面量在位", () => {
    const cap = readFileSync(
      join(pkgsDir, "@code-yeongyu", "senpi", "dist", "modes", "rpc", "custom-capability.js"),
      "utf8",
    );
    expect(cap).toContain("extension_events");
    expect(cap).toContain("question");
  });

  test("入口在位：包主入口与 dist/bundle/cli.js 可达（裸导入解析目标存在）", () => {
    expect(existsSync(join(pkgsDir, "@code-yeongyu", "senpi", "dist", "index.js"))).toBe(true);
    expect(existsSync(join(pkgsDir, "@code-yeongyu", "senpi", "dist", "bundle", "cli.js"))).toBe(true);
  });
});
