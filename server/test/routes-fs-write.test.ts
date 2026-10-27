// 文件写操作端点单测（builtin-file-management 任务 4）：
// POST /api/fs/file、POST /api/fs/dir、PATCH /api/fs/entry、DELETE /api/fs/entry。
// 覆盖错误码矩阵：path_escape / target_exists / kind_mismatch / exists / engine_busy /
// root_not_deletable / not_a_directory / invalid_name / copy_failed / not_found /
// invalid_path / invalid_json / invalid_request / insufficient_storage。
// EXDEV 跨设备用「注入 rename 抛 EXDEV」模拟；对账失败用「真 cp 完成后删目标内
// 一个文件」制造缺口；ENOSPC 用「注入 open 一次拒绝」模拟。全部断言走真实
// Hono app + 临时目录真实文件系统（即真实 API 面）。
import { describe, expect, test, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { cp, open, rename } from "node:fs/promises";
import { createFsWriteRoutes } from "../src/api/routes-fs-write";
import type { ApiDeps } from "../src/api/deps";

// 仅包装三个写原语（默认行为 = 真实现），供单测按需注入 EXDEV/ENOSPC/半成品复制；
// 其余导出原样透传（routes-fs-write 与本文件拿到同一 mock 实例）。
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    cp: vi.fn(actual.cp),
    open: vi.fn(actual.open),
  };
});

/** 让下一个 mock 调用以给定 errno 拒绝（绕开重载类型摩擦的最小封装） */
function rejectOnceWith(mock: unknown, code: string): void {
  const err = Object.assign(new Error(`injected ${code}`), { code });
  (mock as { mockRejectedValueOnce: (e: unknown) => unknown }).mockRejectedValueOnce(err);
}

function makeProject(prefix = "fswrite-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** 引擎网关可注入面：peek 为闭包，逐请求重新取值（stale_state 用可变状态验证） */
function buildApp(peek: () => string[] | null = () => []): Hono {
  const deps = {
    meta: null,
    engines: { peekActiveSessionPaths: async () => peek() },
  } as unknown as ApiDeps;
  const app = new Hono();
  app.route("/", createFsWriteRoutes(deps));
  return app;
}

function post(app: Hono, project: string, body: unknown, endpoint: string): Promise<Response> | Response {
  return app.request(`/api/fs/${endpoint}?project=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function patch(app: Hono, project: string, body: unknown): Promise<Response> | Response {
  return app.request(`/api/fs/entry?project=${encodeURIComponent(project)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function del(app: Hono, project: string, path: string): Promise<Response> | Response {
  return app.request(
    `/api/fs/entry?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,
    { method: "DELETE" },
  );
}

async function errCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

/** 常用夹具：docs/ 目录 + plain.txt 文件 */
function seedBasic(root: string): void {
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "plain.txt"), "x");
}

describe("POST /api/fs/file（新建文件）", () => {
  test("成功：201 {path,size,mtimeNs}，内容落盘，mtimeNs 为纳秒数字符串", async () => {
    const root = makeProject();
    try {
      seedBasic(root);
      const res = await post(buildApp(), root, { path: "docs/a.md", content: "hello" }, "file");
      expect(res.status).toBe(201);
      const body = (await res.json()) as { path: string; size: number; mtimeNs: string };
      expect(body.path).toBe(join(root, "docs", "a.md"));
      expect(body.size).toBe(5);
      expect(typeof body.mtimeNs).toBe("string");
      expect(/^\d+$/.test(body.mtimeNs)).toBe(true);
      expect(readFileSync(join(root, "docs", "a.md"), "utf8")).toBe("hello");
    } finally {
      cleanup(root);
    }
  });

  test("content 缺省：建空文件，size 0", async () => {
    const root = makeProject();
    try {
      const res = await post(buildApp(), root, { path: "empty.txt" }, "file");
      expect(res.status).toBe(201);
      const body = (await res.json()) as { size: number };
      expect(body.size).toBe(0);
      expect(statSync(join(root, "empty.txt")).size).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  test("目标已存在（常规文件）→ 409 exists", async () => {
    const root = makeProject();
    try {
      seedBasic(root);
      const res = await post(buildApp(), root, { path: "plain.txt" }, "file");
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe("exists");
    } finally {
      cleanup(root);
    }
  });

  test("目标位置预置悬空符号链接 → open(wx) 拒预置 → 409 exists（链接未被跟随）", async () => {
    const root = makeProject();
    try {
      seedBasic(root);
      symlinkSync(join(root, "elsewhere.txt"), join(root, "docs", "pre.md"));
      const res = await post(buildApp(), root, { path: "docs/pre.md", content: "evil" }, "file");
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe("exists");
      // 链接仍悬空（未写入任何内容）
      expect(existsSync(join(root, "elsewhere.txt"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("../ 逃逸 → 403 path_escape", async () => {
    const root = makeProject();
    try {
      const res = await post(buildApp(), root, { path: "../evil.txt" }, "file");
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe("path_escape");
    } finally {
      cleanup(root);
    }
  });

  test("中间组件是文件 → 400 not_a_directory", async () => {
    const root = makeProject();
    try {
      seedBasic(root);
      const res = await post(buildApp(), root, { path: "plain.txt/sub.md" }, "file");
      expect(res.status).toBe(400);
      expect(await errCode(res)).toBe("not_a_directory");
    } finally {
      cleanup(root);
    }
  });

  test("中间目录符号链接 → 403 path_escape", async () => {
    const root = makeProject();
    try {
      symlinkSync("/etc", join(root, "etc-link"));
      const res = await post(buildApp(), root, { path: "etc-link/a.md" }, "file");
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe("path_escape");
    } finally {
      cleanup(root);
    }
  });

  test("最终段含 win32 保留字符 → 400 invalid_name", async () => {
    const root = makeProject();
    try {
      const res = await post(buildApp(), root, { path: "docs/a<b.txt" }, "file");
      expect(res.status).toBe(400);
      expect(await errCode(res)).toBe("invalid_name");
    } finally {
      cleanup(root);
    }
  });

  test("退化输入（空串/点，指向项目根）→ 400 invalid_path", async () => {
    const root = makeProject();
    try {
      for (const p of ["", "."]) {
        const res = await post(buildApp(), root, { path: p }, "file");
        expect(res.status).toBe(400);
        expect(await errCode(res)).toBe("invalid_path");
      }
    } finally {
      cleanup(root);
    }
  });

  test("父目录不存在 → 404 not_found（不做隐式补建）", async () => {
    const root = makeProject();
    try {
      const res = await post(buildApp(), root, { path: "missing/a.md" }, "file");
      expect(res.status).toBe(404);
      expect(await errCode(res)).toBe("not_found");
    } finally {
      cleanup(root);
    }
  });

  test("content 非字符串 → 400 invalid_request；非法 JSON → 400 invalid_json", async () => {
    const root = makeProject();
    try {
      const bad = await post(buildApp(), root, { path: "a.txt", content: 123 }, "file");
      expect(bad.status).toBe(400);
      expect(await errCode(bad)).toBe("invalid_request");
      const malformed = await post(buildApp(), root, "{not-json", "file");
      expect(malformed.status).toBe(400);
      expect(await errCode(malformed)).toBe("invalid_json");
    } finally {
      cleanup(root);
    }
  });

  test("ENOSPC（注入 open 一次拒绝）→ 507 insufficient_storage，无半成品残留", async () => {
    const root = makeProject();
    try {
      rejectOnceWith(open, "ENOSPC");
      const res = await post(buildApp(), root, { path: "big.bin", content: "x" }, "file");
      expect(res.status).toBe(507);
      expect(await errCode(res)).toBe("insufficient_storage");
      expect(existsSync(join(root, "big.bin"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});

describe("POST /api/fs/dir（建目录）", () => {
  test("单层成功：201 {path}，目录落盘", async () => {
    const root = makeProject();
    try {
      const res = await post(buildApp(), root, { path: "newdir" }, "dir");
      expect(res.status).toBe(201);
      const body = (await res.json()) as { path: string };
      expect(body.path).toBe(join(root, "newdir"));
      expect(statSync(join(root, "newdir")).isDirectory()).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test("parents:true 深链逐层补建（a/b/c 全缺失）", async () => {
    const root = makeProject();
    try {
      const res = await post(buildApp(), root, { path: "a/b/c", parents: true }, "dir");
      expect(res.status).toBe(201);
      expect(statSync(join(root, "a", "b", "c")).isDirectory()).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test("parents:false（缺省）父目录缺失 → 404 not_found", async () => {
    const root = makeProject();
    try {
      const res = await post(buildApp(), root, { path: "a/b/c" }, "dir");
      expect(res.status).toBe(404);
      expect(await errCode(res)).toBe("not_found");
      expect(existsSync(join(root, "a"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("单层已存在 → 409 exists；parents 且目标已存在 → 409 exists", async () => {
    const root = makeProject();
    try {
      seedBasic(root);
      const r1 = await post(buildApp(), root, { path: "docs" }, "dir");
      expect(r1.status).toBe(409);
      expect(await errCode(r1)).toBe("exists");
      const r2 = await post(buildApp(), root, { path: "docs", parents: true }, "dir");
      expect(r2.status).toBe(409);
      expect(await errCode(r2)).toBe("exists");
      // 已存在但为文件同样 409（mkdir EEXIST）
      const r3 = await post(buildApp(), root, { path: "plain.txt", parents: true }, "dir");
      expect(r3.status).toBe(409);
      expect(await errCode(r3)).toBe("exists");
    } finally {
      cleanup(root);
    }
  });

  test("parents 链中组件是文件 → 400 not_a_directory", async () => {
    const root = makeProject();
    try {
      seedBasic(root);
      const res = await post(buildApp(), root, { path: "plain.txt/sub/deep", parents: true }, "dir");
      expect(res.status).toBe(400);
      expect(await errCode(res)).toBe("not_a_directory");
    } finally {
      cleanup(root);
    }
  });

  test("非法名/退化输入 → 400 invalid_name / invalid_path", async () => {
    const root = makeProject();
    try {
      const badName = await post(buildApp(), root, { path: "a<b" }, "dir");
      expect(badName.status).toBe(400);
      expect(await errCode(badName)).toBe("invalid_name");
      const degenerate = await post(buildApp(), root, { path: "" }, "dir");
      expect(degenerate.status).toBe(400);
      expect(await errCode(degenerate)).toBe("invalid_path");
    } finally {
      cleanup(root);
    }
  });
});

describe("PATCH /api/fs/entry（重命名/移动）", () => {
  test("同目录重命名：200 {ok,path}，旧名消失内容保持", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "a.txt"), "payload");
      const res = await patch(buildApp(), root, { from: "docs/a.txt", to: "docs/b.txt" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; path: string };
      expect(body.ok).toBe(true);
      expect(body.path).toBe(join(root, "docs", "b.txt"));
      expect(existsSync(join(root, "docs", "a.txt"))).toBe(false);
      expect(readFileSync(join(root, "docs", "b.txt"), "utf8")).toBe("payload");
    } finally {
      cleanup(root);
    }
  });

  test("跨目录移动文件成功", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "docs"));
      mkdirSync(join(root, "sub"));
      writeFileSync(join(root, "docs", "a.txt"), "move-me");
      const res = await patch(buildApp(), root, { from: "docs/a.txt", to: "sub/a.txt" });
      expect(res.status).toBe(200);
      expect(readFileSync(join(root, "sub", "a.txt"), "utf8")).toBe("move-me");
      expect(existsSync(join(root, "docs", "a.txt"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("目录递归移动成功（嵌套内容随迁）", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "sub", "nested"), { recursive: true });
      writeFileSync(join(root, "sub", "nested", "deep.txt"), "deep");
      const res = await patch(buildApp(), root, { from: "sub", to: "moved-dir" });
      expect(res.status).toBe(200);
      expect(readFileSync(join(root, "moved-dir", "nested", "deep.txt"), "utf8")).toBe("deep");
      expect(existsSync(join(root, "sub"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("符号链接移动：链接本体随迁（不跟随），目标文件不动", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "real.txt"), "real");
      symlinkSync("real.txt", join(root, "link.md"));
      const res = await patch(buildApp(), root, { from: "link.md", to: "moved.md" });
      expect(res.status).toBe(200);
      expect(lstatSync(join(root, "moved.md")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(root, "moved.md"))).toBe("real.txt");
      expect(readFileSync(join(root, "real.txt"), "utf8")).toBe("real");
    } finally {
      cleanup(root);
    }
  });

  test("目标存在且未指定策略 → 409 target_exists，源目标都保持原状", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "from.txt"), "F");
      writeFileSync(join(root, "to.txt"), "T");
      const res = await patch(buildApp(), root, { from: "from.txt", to: "to.txt" });
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe("target_exists");
      expect(readFileSync(join(root, "to.txt"), "utf8")).toBe("T");
      expect(readFileSync(join(root, "from.txt"), "utf8")).toBe("F");
    } finally {
      cleanup(root);
    }
  });

  test("overwrite:true file→file 同型覆盖成功", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "from.txt"), "NEW");
      writeFileSync(join(root, "to.txt"), "OLD");
      const res = await patch(buildApp(), root, { from: "from.txt", to: "to.txt", overwrite: true });
      expect(res.status).toBe(200);
      expect(readFileSync(join(root, "to.txt"), "utf8")).toBe("NEW");
      expect(existsSync(join(root, "from.txt"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("overwrite:true dir→dir 同型覆盖成功（目标递归删除后源整体迁入）", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "srcdir"));
      writeFileSync(join(root, "srcdir", "keep.txt"), "KEEP");
      mkdirSync(join(root, "dstdir"));
      writeFileSync(join(root, "dstdir", "stale.txt"), "STALE");
      const res = await patch(buildApp(), root, { from: "srcdir", to: "dstdir", overwrite: true });
      expect(res.status).toBe(200);
      expect(existsSync(join(root, "dstdir", "stale.txt"))).toBe(false);
      expect(readFileSync(join(root, "dstdir", "keep.txt"), "utf8")).toBe("KEEP");
    } finally {
      cleanup(root);
    }
  });

  test("overwrite:true file→dir / dir→file / 涉符号链接 → 400 kind_mismatch", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "f.txt"), "F");
      mkdirSync(join(root, "d"));
      symlinkSync("f.txt", join(root, "s.link"));
      const f2d = await patch(buildApp(), root, { from: "f.txt", to: "d", overwrite: true });
      expect(f2d.status).toBe(400);
      expect(await errCode(f2d)).toBe("kind_mismatch");
      const d2f = await patch(buildApp(), root, { from: "d", to: "f.txt", overwrite: true });
      expect(d2f.status).toBe(400);
      expect(await errCode(d2f)).toBe("kind_mismatch");
      const s2f = await patch(buildApp(), root, { from: "s.link", to: "f.txt", overwrite: true });
      expect(s2f.status).toBe(400);
      expect(await errCode(s2f)).toBe("kind_mismatch");
    } finally {
      cleanup(root);
    }
  });

  test("conflict:'rename'：剥扩展 + ' (n)' 首个空闲，原目标保留，源迁走", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "src.txt"), "S");
      writeFileSync(join(root, "rpt.txt"), "R");
      const res = await patch(buildApp(), root, { from: "src.txt", to: "rpt.txt", conflict: "rename" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { path: string };
      expect(body.path).toBe(join(root, "rpt (1).txt"));
      expect(readFileSync(join(root, "rpt (1).txt"), "utf8")).toBe("S");
      expect(readFileSync(join(root, "rpt.txt"), "utf8")).toBe("R");
      expect(existsSync(join(root, "src.txt"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("conflict:'rename' 序号顺延与无扩展名形态", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "src.txt"), "S1");
      writeFileSync(join(root, "rpt.txt"), "R");
      writeFileSync(join(root, "rpt (1).txt"), "R1");
      const r1 = await patch(buildApp(), root, { from: "src.txt", to: "rpt.txt", conflict: "rename" });
      expect(r1.status).toBe(200);
      const b1 = (await r1.json()) as { path: string };
      expect(b1.path).toBe(join(root, "rpt (2).txt"));

      writeFileSync(join(root, "src2.txt"), "S2");
      writeFileSync(join(root, "archive"), "A");
      const r2 = await patch(buildApp(), root, { from: "src2.txt", to: "archive", conflict: "rename" });
      expect(r2.status).toBe(200);
      const b2 = (await r2.json()) as { path: string };
      expect(b2.path).toBe(join(root, "archive (1)"));
    } finally {
      cleanup(root);
    }
  });

  test("conflict:'rename' 1-99 序号全占用 → 409 target_exists", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "src.txt"), "S");
      writeFileSync(join(root, "rpt.txt"), "R");
      for (let n = 1; n <= 99; n++) {
        writeFileSync(join(root, `rpt (${n}).txt`), "x");
      }
      const res = await patch(buildApp(), root, { from: "src.txt", to: "rpt.txt", conflict: "rename" });
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe("target_exists");
      expect(existsSync(join(root, "src.txt"))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test("overwrite 与 conflict 同给 → 400 invalid_request；非法 conflict 值 → 400", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "a.txt"), "A");
      writeFileSync(join(root, "b.txt"), "B");
      const both = await patch(buildApp(), root, { from: "a.txt", to: "b.txt", overwrite: true, conflict: "rename" });
      expect(both.status).toBe(400);
      expect(await errCode(both)).toBe("invalid_request");
      const badConflict = await patch(buildApp(), root, { from: "a.txt", to: "b.txt", conflict: "skip" });
      expect(badConflict.status).toBe(400);
      expect(await errCode(badConflict)).toBe("invalid_request");
    } finally {
      cleanup(root);
    }
  });

  test("from === to 且 overwrite:true → 400 invalid_request（防自覆盖毁源）", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "a.txt"), "A");
      const res = await patch(buildApp(), root, { from: "a.txt", to: "a.txt", overwrite: true });
      expect(res.status).toBe(400);
      expect(await errCode(res)).toBe("invalid_request");
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("A");
    } finally {
      cleanup(root);
    }
  });

  test("目录移动到自身内部 → 400 invalid_request（EINVAL 映射，源保持）", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "sub", "inner"), { recursive: true });
      writeFileSync(join(root, "sub", "f.txt"), "x");
      const res = await patch(buildApp(), root, { from: "sub", to: "sub/inside" });
      expect(res.status).toBe(400);
      expect(await errCode(res)).toBe("invalid_request");
      expect(existsSync(join(root, "sub", "f.txt"))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test("engine_busy：from 精确命中活跃会话路径 → 409，源保持", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "a.txt"), "A");
      const sessionPath = join(root, "a.txt");
      const app = buildApp(() => [sessionPath]);
      const res = await patch(app, root, { from: "a.txt", to: "b.txt" });
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe("engine_busy");
      expect(existsSync(join(root, "a.txt"))).toBe(true);
      expect(existsSync(join(root, "b.txt"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("engine_busy：from 为活跃会话文件的祖先目录 → 409", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "docs"));
      const sessionPath = join(root, "docs", "s", "session.jsonl");
      const app = buildApp(() => [sessionPath]);
      const res = await patch(app, root, { from: "docs", to: "docs2" });
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe("engine_busy");
      expect(existsSync(join(root, "docs"))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test("engine_busy：活跃会话路径与 from 无关 → 放行成功", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "a.txt"), "A");
      const app = buildApp(() => [join(root, "unrelated", "session.jsonl")]);
      const res = await patch(app, root, { from: "a.txt", to: "b.txt" });
      expect(res.status).toBe(200);
      expect(existsSync(join(root, "b.txt"))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test("engine_busy 逐请求重查：忙转闲后同请求放行（stale_state）", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "a.txt"), "A");
      let state: string[] | null = [join(root, "a.txt")];
      const app = buildApp(() => state);
      const first = await patch(app, root, { from: "a.txt", to: "b.txt" });
      expect(first.status).toBe(409);
      expect(await errCode(first)).toBe("engine_busy");
      state = []; // 引擎回合结束
      const second = await patch(app, root, { from: "a.txt", to: "b.txt" });
      expect(second.status).toBe(200);
      expect(existsSync(join(root, "b.txt"))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test("EXDEV 降级 cp：目录跨设备复制对账通过后删源（注入 rename 抛 EXDEV）", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "subex"));
      writeFileSync(join(root, "subex", "a.txt"), "A".repeat(10));
      writeFileSync(join(root, "subex", "b.txt"), "B".repeat(200));
      rejectOnceWith(rename, "EXDEV");
      const res = await patch(buildApp(), root, { from: "subex", to: "subex-moved" });
      expect(res.status).toBe(200);
      expect(readFileSync(join(root, "subex-moved", "a.txt"), "utf8")).toBe("A".repeat(10));
      expect(readFileSync(join(root, "subex-moved", "b.txt"), "utf8")).toBe("B".repeat(200));
      expect(existsSync(join(root, "subex"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("EXDEV 单文件跨设备复制成功（countTree 文件路径）", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "cross.txt"), "CROSS");
      rejectOnceWith(rename, "EXDEV");
      const res = await patch(buildApp(), root, { from: "cross.txt", to: "cross-moved.txt" });
      expect(res.status).toBe(200);
      expect(readFileSync(join(root, "cross-moved.txt"), "utf8")).toBe("CROSS");
      expect(existsSync(join(root, "cross.txt"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("EXDEV 对账失败（真 cp 后目标缺一文件）→ 500 copy_failed，目标回滚源保持", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "subex"));
      writeFileSync(join(root, "subex", "a.txt"), "A".repeat(10));
      writeFileSync(join(root, "subex", "b.txt"), "B".repeat(200));
      rejectOnceWith(rename, "EXDEV");
      // 真 cp 完成后删目标内一个文件，制造对账缺口
      (
        cp as unknown as {
          mockImplementationOnce: (f: (...a: unknown[]) => Promise<void>) => unknown;
        }
      ).mockImplementationOnce(async (...args: unknown[]) => {
        const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        await (real.cp as (...a: unknown[]) => Promise<void>)(...args);
        await real.unlink(join(String(args[1]), "b.txt"));
      });
      const res = await patch(buildApp(), root, { from: "subex", to: "subex-moved" });
      expect(res.status).toBe(500);
      expect(await errCode(res)).toBe("copy_failed");
      // 目标整体回滚，源两文件完好
      expect(existsSync(join(root, "subex-moved"))).toBe(false);
      expect(existsSync(join(root, "subex", "a.txt"))).toBe(true);
      expect(existsSync(join(root, "subex", "b.txt"))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test("from 不存在 → 404 not_found；to 父目录不存在 → 404 not_found", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "a.txt"), "A");
      const noFrom = await patch(buildApp(), root, { from: "ghost.txt", to: "docs/b.txt" });
      expect(noFrom.status).toBe(404);
      expect(await errCode(noFrom)).toBe("not_found");
      const noParent = await patch(buildApp(), root, { from: "docs/a.txt", to: "missing/b.txt" });
      expect(noParent.status).toBe(404);
      expect(await errCode(noParent)).toBe("not_found");
    } finally {
      cleanup(root);
    }
  });

  test("from/to 含 .. → 403 path_escape", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "a.txt"), "A");
      const badFrom = await patch(buildApp(), root, { from: "../a.txt", to: "b.txt" });
      expect(badFrom.status).toBe(403);
      expect(await errCode(badFrom)).toBe("path_escape");
      const badTo = await patch(buildApp(), root, { from: "a.txt", to: "../b.txt" });
      expect(badTo.status).toBe(403);
      expect(await errCode(badTo)).toBe("path_escape");
    } finally {
      cleanup(root);
    }
  });
});

describe("DELETE /api/fs/entry（删除）", () => {
  test("删文件：200 {ok:true}，条目消失", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "gone.txt"), "x");
      const res = await del(buildApp(), root, "gone.txt");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(existsSync(join(root, "gone.txt"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("删目录：递归删除嵌套内容", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "tree", "nested"), { recursive: true });
      writeFileSync(join(root, "tree", "nested", "deep.txt"), "x");
      const res = await del(buildApp(), root, "tree");
      expect(res.status).toBe(200);
      expect(existsSync(join(root, "tree"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("删符号链接：只删链接本体，目标保留", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "real.txt"), "real");
      symlinkSync("real.txt", join(root, "link.md"));
      const res = await del(buildApp(), root, "link.md");
      expect(res.status).toBe(200);
      expect(existsSync(join(root, "link.md"))).toBe(false);
      expect(readFileSync(join(root, "real.txt"), "utf8")).toBe("real");
    } finally {
      cleanup(root);
    }
  });

  test("path 指向项目根（空串/点）→ 400 root_not_deletable", async () => {
    const root = makeProject();
    try {
      for (const p of ["", "."]) {
        const res = await del(buildApp(), root, p);
        expect(res.status).toBe(400);
        expect(await errCode(res)).toBe("root_not_deletable");
      }
      expect(existsSync(root)).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test("path 缺参 → 400 invalid_path；../ 逃逸 → 403 path_escape；不存在 → 404 not_found", async () => {
    const root = makeProject();
    try {
      const missing = await buildApp().request(
        `/api/fs/entry?project=${encodeURIComponent(root)}`,
        { method: "DELETE" },
      );
      expect(missing.status).toBe(400);
      expect(await errCode(missing)).toBe("invalid_path");
      const escape = await del(buildApp(), root, "../x");
      expect(escape.status).toBe(403);
      expect(await errCode(escape)).toBe("path_escape");
      const ghost = await del(buildApp(), root, "ghost.txt");
      expect(ghost.status).toBe(404);
      expect(await errCode(ghost)).toBe("not_found");
    } finally {
      cleanup(root);
    }
  });

  test("engine_busy：peek 非空（任意路径）→ 409", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "a.txt"), "A");
      const app = buildApp(() => [join(root, "somewhere", "session.jsonl")]);
      const res = await del(app, root, "a.txt");
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe("engine_busy");
      expect(existsSync(join(root, "a.txt"))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test("engine_busy：peek 为 []（空闲）与 null（未就绪）均放行", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "a.txt"), "A");
      writeFileSync(join(root, "b.txt"), "B");
      const idle = await del(buildApp(() => []), root, "a.txt");
      expect(idle.status).toBe(200);
      const notReady = await del(buildApp(() => null), root, "b.txt");
      expect(notReady.status).toBe(200);
    } finally {
      cleanup(root);
    }
  });

  test("engine_busy 逐请求重查：忙转闲后放行（stale_state）", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "a.txt"), "A");
      let state: string[] | null = [join(root, "session.jsonl")];
      const app = buildApp(() => state);
      const first = await del(app, root, "a.txt");
      expect(first.status).toBe(409);
      expect(await errCode(first)).toBe("engine_busy");
      state = [];
      const second = await del(app, root, "a.txt");
      expect(second.status).toBe(200);
      expect(existsSync(join(root, "a.txt"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});
