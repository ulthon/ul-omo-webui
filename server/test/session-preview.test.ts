// 会话切换 sheet 最后消息预览（r10 todo 8）单测：
// - LRU 缓存行为：同参数二次调用命中缓存不重读文件（mock 文件读计数验证，无时序阈值）；
//   文件增长（mtime+size 变化）失效重读；容量 200 逐出最旧。
// - 尾读提取：最后一条 user/assistant 文本截 60 字；轻量降噪（围栏标记行/行首 #）；
//   只读尾块（读取字节数有界断言）。
// - 病态：空文件/缺失/损坏 JSONL → 空串不炸。
// - 接口面：GET /api/sessions 列表响应逐行携带 preview 字段（50 会话；空会话空串）。
import { describe, expect, test, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  PREVIEW_MAX_CHARS,
  clearSessionPreviewCache,
  extractLastActiveFromTailChunk,
  extractPreviewFromTailChunk,
  readSessionLastActive,
  readSessionPreview,
  stripPreviewNoise,
  type PreviewIo,
} from "../src/api/session-preview";
import { activityKey, byPinnedThenModified, createSessionRoutes } from "../src/api/routes-session";
import type { ApiDeps } from "../src/api/deps";
import type { EngineSessionSummary } from "../src/adapter/engine-adapter";

let dir: string;

beforeEach(() => {
  clearSessionPreviewCache();
  dir = mkdtempSync(join(tmpdir(), "session-preview-"));
  return () => rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: object[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function msg(role: "user" | "assistant", text: string): object {
  return { type: "message", id: `e-${Math.random().toString(36).slice(2)}`, message: { role, content: text } };
}

/** 计数 fake IO：记录每次 read 的 [start, start+length) 与字节数 */
function fakeIo(file: string, size: number, mtimeMs: number, content: Uint8Array) {
  const reads: Array<{ start: number; length: number }> = [];
  let mtime = mtimeMs;
  let bytes = content;
  let fileSize = size;
  const io: PreviewIo = {
    async stat() {
      return { size: fileSize, mtimeMs: mtime };
    },
    async read(_path, start, length) {
      reads.push({ start, length });
      return bytes.subarray(start, start + length);
    },
  };
  return {
    io,
    reads,
    grow(extra: Uint8Array) {
      const merged = new Uint8Array(bytes.length + extra.length);
      merged.set(bytes);
      merged.set(extra, bytes.length);
      bytes = merged;
      fileSize = merged.length;
      mtime += 1;
    },
    file,
  };
}

const line = (s: string) => `${s}\n`;

describe("readSessionPreview 缓存与尾读", () => {
  test("同参数二次调用命中缓存：read 只发生一次", async () => {
    const content = new TextEncoder().encode(line(JSON.stringify(msg("user", "你好世界"))));
    const f = fakeIo(join(dir, "s1.jsonl"), content.length, 100, content);
    const first = await readSessionPreview("/x/s1.jsonl", "s1", f.io);
    expect(first).toBe("你好世界");
    expect(f.reads).toHaveLength(1);
    const second = await readSessionPreview("/x/s1.jsonl", "s1", f.io);
    expect(second).toBe("你好世界");
    expect(f.reads).toHaveLength(1); // 无第二次读
  });

  test("文件增长（mtime+size 变化）失效缓存并重读", async () => {
    const content = new TextEncoder().encode(line(JSON.stringify(msg("user", "旧消息"))));
    const f = fakeIo(join(dir, "s2.jsonl"), content.length, 100, content);
    await readSessionPreview("/x/s2.jsonl", "s2", f.io);
    expect(f.reads).toHaveLength(1);
    f.grow(new TextEncoder().encode(line(JSON.stringify(msg("assistant", "新消息")))));
    const preview = await readSessionPreview("/x/s2.jsonl", "s2", f.io);
    expect(f.reads).toHaveLength(2); // 失效后重读
    expect(preview).toBe("新消息"); // 取最后一条
  });

  test("尾读字节数有界：不整文件读入", async () => {
    const big = "x".repeat(100_000);
    const content = new TextEncoder().encode(
      line(JSON.stringify(msg("user", big))) + line(JSON.stringify(msg("assistant", "结尾一句"))),
    );
    const f = fakeIo(join(dir, "s3.jsonl"), content.length, 1, content);
    const preview = await readSessionPreview("/x/s3.jsonl", "s3", f.io);
    expect(preview).toBe("结尾一句");
    for (const r of f.reads) {
      expect(r.length).toBeLessThanOrEqual(16 * 1024); // 单次读上限 = 尾块步长
      expect(r.start + r.length).toBe(content.length); // 从文件尾向前
    }
  });

  test("超长文本取末尾 60 字", () => {
    const long = "啊".repeat(200);
    expect(extractPreviewFromTailChunk(line(JSON.stringify(msg("user", long))), true)).toBe(
      "啊".repeat(PREVIEW_MAX_CHARS),
    );
  });

  test("轻量降噪：围栏标记行与行首 # 剥除", () => {
    const text = '```bash\nnpm i\n```\n';
    expect(stripPreviewNoise("# 标题\n正文")).toBe("标题\n正文");
    expect(stripPreviewNoise(text)).toBe("npm i");
    const fenced = `开头\n\`\`\`\ncode line\n\`\`\`\n收尾`;
    expect(extractPreviewFromTailChunk(line(JSON.stringify(msg("assistant", fenced))), true)).toBe(
      "开头\ncode line\n收尾",
    );
  });

  test("user 之后有 assistant 取 assistant；非 message 行（session header/工具行）跳过", () => {
    const chunk =
      line(JSON.stringify({ type: "session", id: "h" })) +
      line(JSON.stringify(msg("user", "问题"))) +
      line(JSON.stringify(msg("assistant", "回答"))) +
      line(JSON.stringify({ type: "toolCall", id: "t1" }));
    expect(extractPreviewFromTailChunk(chunk, true)).toBe("回答");
  });

  test("空文件 / 缺失文件 / 损坏 JSONL → 空串不炸", async () => {
    expect(await readSessionPreview(join(dir, "missing.jsonl"), "m1")).toBe("");
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(await readSessionPreview(empty, "m2")).toBe("");
    const corrupt = join(dir, "corrupt.jsonl");
    writeFileSync(corrupt, "{not json\ngarbage line\n");
    expect(await readSessionPreview(corrupt, "m3")).toBe("");
    expect(extractPreviewFromTailChunk("{broken", true)).toBe("");
  });

  test("无消息的纯 header 文件 → 空串", () => {
    expect(extractPreviewFromTailChunk(line(JSON.stringify({ type: "session", id: "h" })), true)).toBe("");
  });

  test("LRU 容量 200：第 201 个会话逐出最旧（最旧重读，新者命中）", async () => {
    const content = new TextEncoder().encode(line(JSON.stringify(msg("user", "t"))));
    const io: PreviewIo = {
      async stat() {
        return { size: content.length, mtimeMs: 1 };
      },
      async read(_p, start, length) {
        return content.subarray(start, start + length);
      },
    };
    const readSpy = { n: 0 };
    const counting: PreviewIo = { ...io, read: (p, s, l) => ((readSpy.n += 1), io.read(p, s, l)) };
    for (let i = 0; i < 200; i++) await readSessionPreview(`/x/${i}.jsonl`, `id-${i}`, counting);
    const afterFill = readSpy.n;
    await readSessionPreview("/x/id-0.jsonl", "id-0", counting); // 触碰 id-0：LRU 重插到队尾，不重读
    expect(readSpy.n).toBe(afterFill);
    await readSessionPreview("/x/new.jsonl", "id-new", counting); // 挤入第 201 个，逐出最旧的 id-1（id-0 已被触碰重插）
    expect(readSpy.n).toBe(afterFill + 1);
    await readSessionPreview("/x/id-0.jsonl", "id-0", counting); // 触碰过未被逐出 → 命中
    expect(readSpy.n).toBe(afterFill + 1);
    await readSessionPreview("/x/id-1.jsonl", "id-1", counting); // 被逐出 → 重读
    expect(readSpy.n).toBe(afterFill + 2);
  });
});

// ---------------------------------------------------------------- 接口面

function summary(id: string, path: string): EngineSessionSummary {
  return {
    id,
    path,
    cwd: "/proj",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
}

describe("GET /api/sessions 携带 preview 字段", () => {
  test("50 会话列表响应逐行含 preview；空会话为空串", async () => {
    const paths: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (i === 49) {
        paths.push(join(dir, `empty-${i}.jsonl`));
        writeFileSync(paths[i], "");
        continue;
      }
      paths.push(writeJsonl(`s-${i}.jsonl`, [msg("user", `会话 ${i} 的最后消息`)]));
    }
    const sessions = paths.map((p, i) => summary(`sid-${i}`, p));
    const meta = {
      listSessionTags: () => [],
      getSessionMeta: () => null,
      getSessionGeneratedTitle: () => null,
      getProjectMeta: () => null,
    };
    const engines = {
      sessionsList: async () => sessions,
      peekActiveSessionPaths: async () => [],
    };
    const app = new Hono().route(
      "/",
      createSessionRoutes({ meta, engines } as unknown as ApiDeps),
    );
    const res = await app.request(`/api/sessions?project=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ id: string; preview: string }> };
    expect(body.sessions).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      const row = body.sessions.find((s) => s.id === `sid-${i}`);
      expect(row).toBeDefined();
      expect(row!.preview).toBe(i === 49 ? "" : `会话 ${i} 的最后消息`);
    }
  });
});

// ------------------------------------ 真实活跃时刻（排序三模式 2026-11-09）

/** 带时间戳的消息行 */
function timedMsg(role: "user" | "assistant", text: string, timestamp: string): object {
  return { ...msg(role, text), timestamp };
}

describe("lastActiveAt 提取与缓存", () => {
  test("取最后一条 user/assistant 消息的 timestamp；非消息行（查看触发的写）不推进", () => {
    const chunk =
      line(JSON.stringify(timedMsg("user", "问题", "2026-06-01T08:00:00.000Z"))) +
      line(JSON.stringify(timedMsg("assistant", "回答", "2026-06-01T08:01:00.000Z"))) +
      line(JSON.stringify({ type: "toolCall", id: "t1", timestamp: "2026-06-01T08:02:00.000Z" })) +
      line(JSON.stringify({ type: "session-opened", id: "o1", timestamp: "2026-06-09T09:00:00.000Z" }));
    // 纯查看（打开会话写非消息条目，mtime 变化）不推进活跃时刻——修复查看即置顶
    expect(extractLastActiveFromTailChunk(chunk, true)).toBe("2026-06-01T08:01:00.000Z");
  });

  test("无消息/空串/缺失文件 → 空串", async () => {
    expect(extractLastActiveFromTailChunk(line(JSON.stringify({ type: "session", id: "h" })), true)).toBe("");
    expect(extractLastActiveFromTailChunk("", true)).toBe("");
    expect(await readSessionLastActive(join(dir, "missing.jsonl"), "la-missing")).toBe("");
  });

  test("缓存命中不重读：mtime+size 变化才失效重读", async () => {
    const content = new TextEncoder().encode(
      line(JSON.stringify(timedMsg("user", "你好", "2026-06-01T00:00:00.000Z"))),
    );
    const f = fakeIo(join(dir, "la1.jsonl"), content.length, 100, content);
    expect(await readSessionLastActive("/x/la1.jsonl", "la1", f.io)).toBe("2026-06-01T00:00:00.000Z");
    expect(await readSessionLastActive("/x/la1.jsonl", "la1", f.io)).toBe("2026-06-01T00:00:00.000Z");
    expect(f.reads).toHaveLength(1); // 第二次命中缓存
    // 查看触发非消息写：mtime 变化重读，但活跃时刻仍是最后消息时刻
    f.grow(new TextEncoder().encode(line(JSON.stringify({ type: "session-opened", id: "o", timestamp: "2026-06-09T00:00:00.000Z" }))));
    expect(await readSessionLastActive("/x/la1.jsonl", "la1", f.io)).toBe("2026-06-01T00:00:00.000Z");
    expect(f.reads).toHaveLength(2);
  });

  test("GET /api/sessions 逐行携带 lastActiveAt（空会话 null）", async () => {
    const withMsg = writeJsonl("la-route.jsonl", [timedMsg("user", "hi", "2026-06-05T00:00:00.000Z")]);
    const empty = join(dir, "la-route-empty.jsonl");
    writeFileSync(empty, "");
    const meta = {
      listSessionTags: () => [],
      getSessionMeta: () => null,
      getSessionGeneratedTitle: () => null,
      getProjectMeta: () => null,
    };
    const engines = {
      sessionsList: async () => [summary("la-1", withMsg), summary("la-2", empty)],
      peekActiveSessionPaths: async () => [],
    };
    const app = new Hono().route("/", createSessionRoutes({ meta, engines } as unknown as ApiDeps));
    const res = await app.request(`/api/sessions?project=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ id: string; lastActiveAt: string | null }> };
    expect(body.sessions.find((s) => s.id === "la-1")!.lastActiveAt).toBe("2026-06-05T00:00:00.000Z");
    expect(body.sessions.find((s) => s.id === "la-2")!.lastActiveAt).toBeNull();
  });
});

describe("服务端排序键 activityKey / byPinnedThenModified", () => {
  test("activityKey：lastActiveAt 优先，空串/null 回退 modified", () => {
    expect(activityKey({ lastActiveAt: "2026-06-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z" })).toBe(
      "2026-06-01T00:00:00.000Z",
    );
    expect(activityKey({ lastActiveAt: null, modified: "2026-01-01T00:00:00.000Z" })).toBe("2026-01-01T00:00:00.000Z");
  });

  test("置顶优先；非置顶按活跃键降序；纯查看行（仅 mtime 新）不提前", () => {
    const viewed = { pinned: false, modified: "2026-06-10T00:00:00.000Z", lastActiveAt: "2026-05-01T00:00:00.000Z" };
    const messaged = { pinned: false, modified: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-06-01T00:00:00.000Z" };
    const pinned = { pinned: true, modified: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-04-01T00:00:00.000Z" };
    expect([viewed, messaged, pinned].sort(byPinnedThenModified).map((r) => r.lastActiveAt)).toEqual([
      pinned.lastActiveAt,
      messaged.lastActiveAt,
      viewed.lastActiveAt,
    ]);
  });
});
