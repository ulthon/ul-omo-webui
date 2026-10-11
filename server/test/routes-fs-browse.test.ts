// 受限目录浏览端点单测（todo 7）：GET /api/fs/browse
// 覆盖：正常列出（仅目录）、默认 home（工厂注入 base，不 mock os.homedir）、
// ../ 越界 403、符号链接出界 403、隐藏目录标注、目录级 EACCES 空+标注、
// entry 级失败跳过（悬空 symlink）、malformed 输入（NUL/不存在/非目录/空串）。
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createFsRoutes, fsErrorCode } from "../src/api/routes-fs";
import type { ApiDeps } from "../src/api/deps";

// browse 端点不触 meta/engines（纯文件系统只读）：类型面要求的空依赖占位
const deps = { meta: null, engines: null } as unknown as ApiDeps;

function buildApp(browseHome?: string): Hono {
  const app = new Hono();
  app.route("/", createFsRoutes(deps, browseHome));
  return app;
}

function makeTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

interface BrowseEntry {
  name: string;
  path: string;
  hidden: boolean;
}

describe("GET /api/fs/browse", () => {
  test("正常列出：仅子目录、绝对路径、隐藏标注、失败 entry 跳过", async () => {
    const root = makeTempRoot("fs-browse-list-");
    try {
      mkdirSync(join(root, "alpha"));
      mkdirSync(join(root, "beta"));
      mkdirSync(join(root, ".hidden-dir"));
      writeFileSync(join(root, "file.txt"), "x");
      // 悬空 symlink：dirent 非目录，代表"单 entry 失败跳过"场景（root 环境无法构造 EACCES entry）
      symlinkSync(join(root, "missing"), join(root, "dangling"));

      const res = await buildApp(root).request(
        `/api/fs/browse?path=${encodeURIComponent(root)}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: BrowseEntry[] };
      const names = body.entries.map((e) => e.name).sort();
      expect(names).toEqual([".hidden-dir", "alpha", "beta"]);
      const alpha = body.entries.find((e) => e.name === "alpha");
      expect(alpha).toEqual({ name: "alpha", path: join(root, "alpha"), hidden: false });
      const hidden = body.entries.find((e) => e.name === ".hidden-dir");
      expect(hidden).toEqual({
        name: ".hidden-dir",
        path: join(root, ".hidden-dir"),
        hidden: true,
      });
    } finally {
      cleanup(root);
    }
  });

  test("path 缺省 = 注入的 home base（工厂参数，不 mock 全局）", async () => {
    const home = makeTempRoot("fs-browse-home-");
    try {
      mkdirSync(join(home, "projects"));
      mkdirSync(join(home, ".config"));
      writeFileSync(join(home, "note.txt"), "x");

      const res = await buildApp(home).request("/api/fs/browse");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: BrowseEntry[] };
      const names = body.entries.map((e) => e.name).sort();
      expect(names).toEqual([".config", "projects"]);
    } finally {
      cleanup(home);
    }
  });

  test("?path= 空串等价缺省（列 base 本身）", async () => {
    const home = makeTempRoot("fs-browse-empty-");
    try {
      mkdirSync(join(home, "solo"));
      const res = await buildApp(home).request("/api/fs/browse?path=");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: BrowseEntry[] };
      expect(body.entries.map((e) => e.name)).toEqual(["solo"]);
    } finally {
      cleanup(home);
    }
  });

  test("相对路径相对 base 解析（补全场景）", async () => {
    const root = makeTempRoot("fs-browse-rel-");
    try {
      mkdirSync(join(root, "parent"));
      mkdirSync(join(root, "parent", "child"));
      const res = await buildApp(root).request("/api/fs/browse?path=parent");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: BrowseEntry[] };
      expect(body.entries.map((e) => e.name)).toEqual(["child"]);
      expect(body.entries[0]?.path).toBe(join(root, "parent", "child"));
    } finally {
      cleanup(root);
    }
  });

  test("越界 403：../ 逃逸（resolve 包含性）", async () => {
    const root = makeTempRoot("fs-browse-escape-");
    try {
      const res = await buildApp(root).request(
        `/api/fs/browse?path=${encodeURIComponent("../../")}`,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("path_escape");
    } finally {
      cleanup(root);
    }
  });

  test("符号链接出界 403（单次 realpath 复核）", async () => {
    const root = makeTempRoot("fs-browse-symlink-");
    try {
      symlinkSync("/etc", join(root, "out-link"));
      const res = await buildApp(root).request(
        `/api/fs/browse?path=${encodeURIComponent(join(root, "out-link"))}`,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("path_escape");
    } finally {
      cleanup(root);
    }
  });

  test("绝对路径注入 403：?path=/etc/../", async () => {
    const root = makeTempRoot("fs-browse-abs-");
    try {
      const res = await buildApp(root).request("/api/fs/browse?path=/etc/../");
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("path_escape");
    } finally {
      cleanup(root);
    }
  });

  test("目录级 EACCES：200 空 entries + error 标注（root 环境构造失效时如实跳过）", async () => {
    const root = makeTempRoot("fs-browse-eacces-");
    const locked = join(root, "locked");
    try {
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      // root 绕过目录权限检查：构造失效则端到端场景跳过（QA 记录），
      // EACCES → 标注的映射逻辑由 fsErrorCode 纯函数测试覆盖
      let constructed = false;
      try {
        readdirSync(locked);
      } catch (err) {
        constructed = fsErrorCode(err) === "eacces";
      }
      if (!constructed) {
        console.log("EACCES 端到端构造不可用（root 环境绕过目录权限），跳过");
        return;
      }
      const res = await buildApp(root).request(
        `/api/fs/browse?path=${encodeURIComponent(locked)}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: BrowseEntry[]; error?: string };
      expect(body.entries).toEqual([]);
      expect(body.error).toBe("eacces");
    } finally {
      chmodSync(locked, 0o755);
      cleanup(root);
    }
  });

  test("fsErrorCode：EACCES 映射为 eacces 标注，其余不标注", () => {
    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    expect(fsErrorCode(eacces)).toBe("eacces");
    expect(fsErrorCode(enoent)).toBeNull();
    expect(fsErrorCode(new Error("plain"))).toBeNull();
    expect(fsErrorCode("not an error object")).toBeNull();
  });

  test("malformed：NUL 字节 400", async () => {
    const root = makeTempRoot("fs-browse-nul-");
    try {
      const res = await buildApp(root).request(
        `/api/fs/browse?path=${encodeURIComponent("a\0b")}`,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_path");
    } finally {
      cleanup(root);
    }
  });

  test("malformed：超长路径 400", async () => {
    const root = makeTempRoot("fs-browse-long-");
    try {
      const res = await buildApp(root).request(`/api/fs/browse?path=${"a".repeat(5000)}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_path");
    } finally {
      cleanup(root);
    }
  });

  test("目标不存在 404", async () => {
    const root = makeTempRoot("fs-browse-404-");
    try {
      const res = await buildApp(root).request(
        `/api/fs/browse?path=${encodeURIComponent(join(root, "nope"))}`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
    } finally {
      cleanup(root);
    }
  });

  test("目标是文件 400 not_a_directory", async () => {
    const root = makeTempRoot("fs-browse-file-");
    try {
      writeFileSync(join(root, "f.txt"), "x");
      const res = await buildApp(root).request(
        `/api/fs/browse?path=${encodeURIComponent(join(root, "f.txt"))}`,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_a_directory");
    } finally {
      cleanup(root);
    }
  });
});
