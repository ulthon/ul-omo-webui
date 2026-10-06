// Git 只读路由（todo 9）：子进程跑 git status --porcelain / git diff。
// 只读承诺：只跑查询型命令，无 staging/commit；cwd=realpath 后的项目目录（无文件路径参数，无逃逸面）。
import { spawnSync } from "node:child_process";
import { Hono, type Context } from "hono";
import { ApiError, route } from "./http";
import type { ApiDeps } from "./deps";
import { validateProjectInput } from "./paths";

const GIT_TIMEOUT_MS = 10_000;
const DIFF_MAX_BYTES = 512 * 1024;

function runGit(project: string, args: string[], maxBuffer: number): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd: project,
    timeout: GIT_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer,
  });
  return {
    status: r.status ?? -1,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

function requireRepo(project: string, stderr: string, status: number): void {
  if (stderr.includes("not a git repository") || stderr.includes("not a worktree")) {
    throw new ApiError(409, "not_a_git_repo", `目录不是 git 仓库：${project}`);
  }
  if (status !== 0) {
    throw new ApiError(500, "git_error", `git 命令失败（exit=${status}）：${stderr.slice(-300)}`);
  }
}

export function createGitRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // 未提交变更：porcelain v1 行解析（XY status + path）
  app.get("/api/git/status", route(async (c: Context) => {
    const project = validateProjectInput(c.req.query("project"));
    const r = runGit(project, ["status", "--porcelain"], 16 * 1024 * 1024);
    requireRepo(project, r.stderr, r.status);
    const entries = r.stdout
      .split("\n")
      .filter((line) => line.length >= 3)
      .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
    return c.json({ project, entries, raw: r.stdout });
  }));

  // 工作区 diff（git diff 原文；512KB 截断保护）
  app.get("/api/git/diff", route(async (c: Context) => {
    const project = validateProjectInput(c.req.query("project"));
    const r = runGit(project, ["--no-pager", "diff"], DIFF_MAX_BYTES + 1024);
    requireRepo(project, r.stderr, r.status);
    const diff = r.stdout.slice(0, DIFF_MAX_BYTES);
    return c.json({ project, diff, truncated: r.stdout.length > DIFF_MAX_BYTES });
  }));

  return app;
}
