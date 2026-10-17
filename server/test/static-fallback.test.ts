// 内嵌形态 SPA fallback 路径解析单测（评审建议修复项）：
// 畸形百分号编码（如 /%zz）原实现 decodeURIComponent 抛 URIError 落 Hono 默认
// onError 纯文本 500；现统一抛 ApiError 400，由 index.ts fallback handler 就地转 JSON。
import { describe, expect, test } from "vitest";
import { ApiError } from "../src/api/http";
import { embeddedRelPath } from "../src/embedded-static";

describe("embeddedRelPath（内嵌静态 fallback 路径解析）", () => {
  test("正常路径 decode 并去前导斜杠", () => {
    expect(embeddedRelPath("/")).toBe("");
    expect(embeddedRelPath("/assets/app-abc123.js")).toBe("assets/app-abc123.js");
    expect(embeddedRelPath("/%E4%B8%AD%E6%96%87.txt")).toBe("中文.txt");
  });

  test("畸形百分号编码抛 ApiError 400 invalid_request", () => {
    expect(() => embeddedRelPath("/%zz")).toThrow(ApiError);
    try {
      embeddedRelPath("/%zz");
    } catch (err) {
      const e = err as ApiError;
      expect(e.status).toBe(400);
      expect(e.code).toBe("invalid_request");
    }
  });
});
