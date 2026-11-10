// 路由透传单测（engine-upgrade-5169 批 4a）：target=engine 时 installer 的 501
// 错误码 engine_upgrade_via_webui_release 经 /api/update/install 原样透传
// （状态行 501 + body.error.code/message）。installUpdate 全程不触网（engine 分支先行返回）。
import { describe, expect, test } from "vitest";
import { Hono } from "hono";
import { createUpdateRoutes } from "../src/api/routes-update";

function makeApp(): Hono {
  return createUpdateRoutes({ shutdown: () => {} });
}

describe("POST /api/update/install target=engine", () => {
  test("透传 501 状态与错误码 engine_upgrade_via_webui_release", async () => {
    const res = await makeApp().request("/api/update/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "engine", version: "2026.11.10-2" }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("engine_upgrade_via_webui_release");
    expect(body.error?.message).toBe("引擎升级搭载 webui 发版，请更新 webui");
  });

  test("非法 target 仍 400（校验先于 installer）", async () => {
    const res = await makeApp().request("/api/update/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "other", version: "1.0.0" }),
    });
    expect(res.status).toBe(400);
  });
});
