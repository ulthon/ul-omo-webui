// 配置文件读写层单测：读写回环、mtime+size 缓存失效、tmp+rename 原子写、
// 损坏文件明确报错不覆盖、进程内写串行化、目录自动创建、tmp 残留清理。
// 全部用 mkdtemp 隔离目录，绝不触碰真实 ~/.config 与项目根 .senpi-webui.json。
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGlobalDir, openConfigStore } from "../src/conf/config-store";

const tmp = mkdtempSync(join(tmpdir(), "senpi-config-store-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 每个用例独立子目录（bun test 同文件共享模块态，防串数据）
let seq = 0;
function freshDirs(): { globalDir: string; projectRoot: string } {
  seq += 1;
  // globalDir 刻意嵌套不存在路径，顺带覆盖目录自动创建
  return {
    globalDir: join(tmp, `case-${seq}`, "global", "nested"),
    projectRoot: join(tmp, `case-${seq}`, "project"),
  };
}

function tagsPath(globalDir: string): string {
  return join(globalDir, "tags.json");
}

/** 外部进程模拟：改写文件并显式设置 mtime（mtime+size 双变，缓存必失效） */
function externalRewrite(path: string, text: string): void {
  writeFileSync(path, text);
  utimesSync(path, new Date(1000), new Date(1000));
}

/**
 * 写 promise 落定前反复同步读目标文件（setImmediate 让事件循环推进写链，非 sleep），
 * 收集全部读到的原始文本；任何一次读到非法 JSON 即失败（rename 原子性保证）。
 */
async function readUntilSettled(path: string, until: Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  let settled = false;
  until.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    try {
      const raw = readFileSync(path, "utf8");
      JSON.parse(raw);
      seen.push(raw);
    } catch (err) {
      // 文件尚不存在 = 合法旧态（写链未执行 rename），不算原子性破坏
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return seen;
}

async function readErrorMessage(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}

describe("config-store 读写回环", () => {
  test("tags 写读回环 + 磁盘格式（2 空格缩进、末尾换行、稳定排序）", async () => {
    const { globalDir, projectRoot } = freshDirs();
    const store = openConfigStore({ globalDir, projectRoot });
    await store.writeTags([
      { name: "b-tag", sort: 2 },
      { name: "a-tag", sort: 2 },
      { name: "z-tag", sort: 1 },
    ]);

    const tags = store.readTags().tags;
    expect(tags.map((t) => t.name)).toEqual(["z-tag", "a-tag", "b-tag"]);

    const path = tagsPath(globalDir);
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + "\n");
    const onDisk = JSON.parse(raw) as { version: number; tags: { name: string; sort: number }[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.tags.map((t) => t.name)).toEqual(["z-tag", "a-tag", "b-tag"]);
  });

  test("snippets 写读回环", async () => {
    const { globalDir, projectRoot } = freshDirs();
    const store = openConfigStore({ globalDir, projectRoot });
    await store.writeSnippets([
      { content: "继续", sort: 2 },
      { content: "先停", sort: 1 },
    ]);
    expect(store.readSnippets().snippets.map((s) => s.content)).toEqual(["先停", "继续"]);
  });

  test("项目配置读写回环 + patch 保留未提及字段", async () => {
    const { globalDir, projectRoot } = freshDirs();
    const store = openConfigStore({ globalDir, projectRoot });
    await store.updateProjectConfig({
      preferredModel: "zai-coding-cn/glm-5.3",
      permissionPreset: "read-only",
      tags: [{ name: "研究阶段", sort: 1 }],
    });

    const cfg = store.readProjectConfig();
    expect(cfg.preferredModel).toBe("zai-coding-cn/glm-5.3");
    expect(cfg.permissionPreset).toBe("read-only");
    expect(cfg.tags).toEqual([{ name: "研究阶段", sort: 1 }]);
    expect(cfg.snippets).toEqual([]);

    await store.updateProjectConfig({ preferredModel: null });
    const cfg2 = store.readProjectConfig();
    expect(cfg2.preferredModel).toBeNull();
    expect(cfg2.permissionPreset).toBe("read-only");
    expect(cfg2.tags).toEqual([{ name: "研究阶段", sort: 1 }]);
  });

  test("preferredThinkingLevel 写读回环 + 部分更新不动未提及字段（W2 todo 7）", async () => {
    const { globalDir, projectRoot } = freshDirs();
    const store = openConfigStore({ globalDir, projectRoot });
    await store.updateProjectConfig({ preferredThinkingLevel: "max", preferredModel: "m1" });
    const cfg = store.readProjectConfig();
    expect(cfg.preferredThinkingLevel).toBe("max");
    expect(cfg.preferredModel).toBe("m1");

    // 清除（显式 null）不动其他字段
    await store.updateProjectConfig({ preferredThinkingLevel: null });
    const cleared = store.readProjectConfig();
    expect(cleared.preferredThinkingLevel).toBeNull();
    expect(cleared.preferredModel).toBe("m1");

    // 无字段文件读为 null；非法档位抛含路径错误（绝不静默吞）
    const { globalDir: g2, projectRoot: p2 } = freshDirs();
    const store2 = openConfigStore({ globalDir: g2, projectRoot: p2 });
    expect(store2.readProjectConfig().preferredThinkingLevel).toBeNull();

    mkdirSync(p2, { recursive: true });
    const projectFile = join(p2, ".senpi-webui.json");
    writeFileSync(projectFile, JSON.stringify({ version: 1, preferredThinkingLevel: "off" }));
    const msg = await readErrorMessage(() => store2.readProjectConfig());
    expect(msg).toContain(projectFile);
    expect(msg).toContain("preferredThinkingLevel");
  });

  test("字段缺失视为空、顶层未知字段透传保留", async () => {
    const { globalDir, projectRoot } = freshDirs();
    mkdirSync(globalDir, { recursive: true });
    const store = openConfigStore({ globalDir, projectRoot });
    externalRewrite(
      tagsPath(globalDir),
      JSON.stringify({ version: 1, myField: "keep", extra: { nested: true } }),
    );

    const tags = store.readTags();
    expect(tags.version).toBe(1);
    expect(tags.tags).toEqual([]);
    expect(tags.myField).toBe("keep");
    expect((tags.extra as { nested: boolean }).nested).toBe(true);

    await store.writeTags([{ name: "新标签", sort: 1 }]);
    const onDisk = JSON.parse(readFileSync(tagsPath(globalDir), "utf8")) as Record<string, unknown>;
    expect(onDisk.myField).toBe("keep");
    expect(onDisk.extra).toEqual({ nested: true });
  });

  test("文件不存在读为空文档", () => {
    const { globalDir, projectRoot } = freshDirs();
    const store = openConfigStore({ globalDir, projectRoot });
    expect(store.readTags()).toEqual({ version: 1, tags: [] });
    expect(store.readSnippets()).toEqual({ version: 1, snippets: [] });
    const cfg = store.readProjectConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.tags).toEqual([]);
    expect(cfg.snippets).toEqual([]);
    expect(cfg.preferredModel).toBeNull();
    expect(cfg.permissionPreset).toBeNull();
  });
});

describe("config-store 缓存失效与损坏文件", () => {
  test("外部改文件 + touch 后下一次读即新值（mtime+size 缓存失效）", async () => {
    const { globalDir, projectRoot } = freshDirs();
    const store = openConfigStore({ globalDir, projectRoot });
    await store.writeTags([{ name: "旧值", sort: 1 }]);
    expect(store.readTags().tags[0]!.name).toBe("旧值");

    externalRewrite(
      tagsPath(globalDir),
      JSON.stringify({ version: 1, tags: [{ name: "新值", sort: 1 }] }, null, 2),
    );
    expect(store.readTags().tags[0]!.name).toBe("新值");
  });

  test("损坏 JSON 读抛含路径的明确错误（空文件同样报错）", async () => {
    const { globalDir, projectRoot } = freshDirs();
    mkdirSync(globalDir, { recursive: true });
    const store = openConfigStore({ globalDir, projectRoot });
    const path = tagsPath(globalDir);

    externalRewrite(path, "{broken");
    const msg = await readErrorMessage(() => store.readTags());
    expect(msg).toContain(path);
    expect(msg).toContain("JSON");

    externalRewrite(path, "");
    const msgEmpty = await readErrorMessage(() => store.readTags());
    expect(msgEmpty).toContain(path);
  });

  test("损坏文件写前解析失败不覆盖原内容", async () => {
    const { globalDir, projectRoot } = freshDirs();
    mkdirSync(globalDir, { recursive: true });
    const store = openConfigStore({ globalDir, projectRoot });
    const path = tagsPath(globalDir);
    const broken = '{"version":1,"tags":[oops';
    externalRewrite(path, broken);

    const msg = await readErrorMessage(() => store.writeTags([{ name: "x", sort: 1 }]));
    expect(msg).toContain(path);
    expect(readFileSync(path, "utf8")).toBe(broken);
  });
});

describe("config-store 写原子性与串行化", () => {
  test("写入过程中读取只见旧值或新值（tmp+rename 原子）", async () => {
    const { globalDir, projectRoot } = freshDirs();
    const store = openConfigStore({ globalDir, projectRoot });
    await store.writeTags([{ name: "旧值", sort: 1 }]);

    const pending = store.writeTags([{ name: "新值", sort: 1 }]);
    const seen = await readUntilSettled(tagsPath(globalDir), pending);
    await pending;

    expect(seen.length).toBeGreaterThan(0);
    for (const raw of seen) {
      const parsed = JSON.parse(raw) as { tags: { name: string }[] };
      expect(["旧值", "新值"]).toContain(parsed.tags[0]!.name);
    }
    expect(store.readTags().tags[0]!.name).toBe("新值");
  });

  test("并发 10 个写串行无交错，最终值 = 最后排队写入", async () => {
    const { globalDir, projectRoot } = freshDirs();
    const store = openConfigStore({ globalDir, projectRoot });
    const names = ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "final"];
    const all = Promise.all(
      names.map((name) => store.writeTags([{ name, sort: 1 }])),
    );
    const seen = await readUntilSettled(tagsPath(globalDir), all);
    await all;

    for (const raw of seen) {
      const parsed = JSON.parse(raw) as { tags: { name: string }[] };
      expect(names).toContain(parsed.tags[0]!.name);
    }
    expect(store.readTags().tags[0]!.name).toBe("final");
  });
});

describe("config-store 目录与临时文件", () => {
  test("目录不存在时首写自动创建（含嵌套父目录）", async () => {
    const { globalDir, projectRoot } = freshDirs();
    const store = openConfigStore({ globalDir, projectRoot });
    await store.writeTags([{ name: "t", sort: 1 }]);
    expect(store.readTags().tags[0]!.name).toBe("t");

    await store.updateProjectConfig({ preferredModel: "m" });
    expect(store.readProjectConfig().preferredModel).toBe("m");
  });

  test("写前清同目录同前缀崩溃残留 tmp", async () => {
    const { globalDir, projectRoot } = freshDirs();
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, ".tags.json.tmp-stale"), "garbage");
    writeFileSync(join(globalDir, ".snippets.json.tmp-stale"), "garbage");
    const store = openConfigStore({ globalDir, projectRoot });

    await store.writeTags([{ name: "t", sort: 1 }]);
    await store.writeSnippets([{ content: "s", sort: 1 }]);

    const leftovers = readdirSync(globalDir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("config-store 默认路径", () => {
  test("defaultGlobalDir 优先取 SENPI_WEBUI_CONFIG_DIR", () => {
    const saved = process.env.SENPI_WEBUI_CONFIG_DIR;
    try {
      process.env.SENPI_WEBUI_CONFIG_DIR = "/tmp/opencode/n1-1-env-probe";
      expect(defaultGlobalDir()).toBe("/tmp/opencode/n1-1-env-probe");
    } finally {
      if (saved === undefined) {
        delete process.env.SENPI_WEBUI_CONFIG_DIR;
      } else {
        process.env.SENPI_WEBUI_CONFIG_DIR = saved;
      }
    }
  });
});
