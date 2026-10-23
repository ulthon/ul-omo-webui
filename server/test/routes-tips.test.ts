// tips 用法提示路由单测（docs08-2026-10-22 批次任务 25）：聚焦缓存与降级语义层——
// 启动缓存+TTL 重拉、失败沿用旧缓存、无缓存失败空表不崩、PATH 回落、合法空数组缓存、
// 输出契约解析（脏项剔除/requiresCommand 收口/非数组判失败）。spawn 全替身注入，
// 绝不真实 spawn；now 注入推进 TTL，无真实等待。
import { describe, expect, test } from "vitest";
import { createTipsRoutes, parseTipsOutput, type TipsRouteDeps, type TipsSpawnSync } from "../src/api/routes-tips";

interface SpawnCall {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

/** 按调用次序回放脚本化结果（脚本耗尽后重复最后一项）；记录 file/args/env 供断言 */
function fakeSpawn(script: Array<{ error?: Error; status: number | null; stdout?: string }>) {
  const calls: SpawnCall[] = [];
  const impl: TipsSpawnSync = (file, args, opts) => {
    calls.push({ file, args, env: opts.env });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    return { error: next.error, status: next.status, stdout: next.stdout ?? "" };
  };
  return { impl, calls };
}

const ok = (tips: unknown) => ({ status: 0, stdout: JSON.stringify(tips) });

function mount(spawn: TipsSpawnSync, opts: Partial<Pick<TipsRouteDeps, "ttlMs" | "now">> = {}) {
  return createTipsRoutes({ agentDir: "/tmp/agent", cliPath: "/fake/cli.js", spawn, ...opts });
}

/** GET 并解包 { tips } */
async function getTips(app: ReturnType<typeof createTipsRoutes>): Promise<{ tips: Array<Record<string, unknown>> }> {
  const res = await app.request("/api/tips");
  expect(res.status).toBe(200);
  return (await res.json()) as { tips: Array<Record<string, unknown>> };
}

describe("GET /api/tips", () => {
  test("启动缓存命中：GET 返回 CLI 清单且不再 spawn；argv/env 与引擎 spawn 同源", async () => {
    const { impl, calls } = fakeSpawn([
      ok([{ id: "a", text: "A tip", requiresCommand: "efforts" }, { id: "b", text: "B" }]),
    ]);
    const body = await getTips(mount(impl));
    expect(body.tips).toEqual([{ id: "a", text: "A tip", requiresCommand: "efforts" }, { id: "b", text: "B" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(process.execPath);
    expect(calls[0].args).toEqual(["/fake/cli.js", "--list-tips"]);
    expect(calls[0].env.OMO_CODING_AGENT_DIR).toBe("/tmp/agent");
    expect(calls[0].env.SENPI_CODING_AGENT_DIR).toBe("/tmp/agent");
  });

  test("TTL 内复用缓存，到期后下次 GET 重拉", async () => {
    let t = 0;
    const { impl, calls } = fakeSpawn([ok([{ id: "a", text: "A" }]), ok([{ id: "a", text: "A2" }])]);
    const app = mount(impl, { ttlMs: 100, now: () => t });
    expect((await getTips(app)).tips[0]?.text).toBe("A");
    t = 50; // TTL 内：不重拉
    expect((await getTips(app)).tips[0]?.text).toBe("A");
    expect(calls).toHaveLength(1);
    t = 150; // 到期（150 - 0 >= 100）：重拉取新值
    expect((await getTips(app)).tips[0]?.text).toBe("A2");
    expect(calls).toHaveLength(2);
  });

  test("失败沿用旧缓存：过期重拉失败仍回旧清单", async () => {
    let t = 0;
    const { impl, calls } = fakeSpawn([ok([{ id: "a", text: "A" }]), { status: 1, stdout: "" }]);
    const app = mount(impl, { ttlMs: 100, now: () => t });
    expect((await getTips(app)).tips).toHaveLength(1);
    t = 200;
    expect((await getTips(app)).tips).toEqual([{ id: "a", text: "A" }]);
    expect(calls).toHaveLength(2);
  });

  test("无缓存失败 → 空表 200 不崩（非零退出 / spawn 异常两种形态）", async () => {
    const { impl } = fakeSpawn([{ status: 1, stdout: "" }]);
    expect((await getTips(mount(impl))).tips).toEqual([]);
    const throwing: TipsSpawnSync = () => {
      throw new Error("spawn threw");
    };
    expect((await getTips(mount(throwing))).tips).toEqual([]);
  });

  test("无 cliPath 回落 PATH omo（argv=[omo, --list-tips]）", async () => {
    const { impl, calls } = fakeSpawn([ok([])]);
    await getTips(createTipsRoutes({ agentDir: "/tmp/agent", spawn: impl }));
    expect(calls[0]?.file).toBe("omo");
    expect(calls[0]?.args).toEqual(["--list-tips"]);
  });

  test("合法空数组是成功：缓存空清单，TTL 内不重拉", async () => {
    const { impl, calls } = fakeSpawn([ok([])]);
    const app = mount(impl, { ttlMs: 100, now: () => 0 });
    expect((await getTips(app)).tips).toEqual([]);
    expect((await getTips(app)).tips).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("parseTipsOutput", () => {
  test("非 JSON / 非数组返回 null（失败语义，区别于合法空表）", () => {
    expect(parseTipsOutput("")).toBeNull();
    expect(parseTipsOutput("not json")).toBeNull();
    expect(parseTipsOutput('{"a":1}')).toBeNull();
    expect(parseTipsOutput("null")).toBeNull();
  });

  test("脏项剔除与 requiresCommand 形态收口（多余字段不透传）", () => {
    expect(
      parseTipsOutput(
        JSON.stringify([
          { id: "a", text: "A" },
          { id: "", text: "空 id 剔除" },
          { text: "缺 id 剔除" },
          { id: "b" },
          null,
          "str",
          { id: "c", text: "C", requiresCommand: "model" },
          { id: "d", text: "D", requiresCommand: true },
          { id: "e", text: "E", requiresCommand: "", extra: 1 },
        ]),
      ),
    ).toEqual([
      { id: "a", text: "A" },
      { id: "c", text: "C", requiresCommand: "model" },
      { id: "d", text: "D", requiresCommand: true },
      { id: "e", text: "E" },
    ]);
  });
});
