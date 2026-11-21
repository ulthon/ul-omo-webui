// 2026-11-20 设置页可调批：上传上限三档解析口径（与 server 端 parseUploadLimitMb 同契约）。
// 键缺失/空串/非整数/越界（<1 或 >1024）回退缺省；合法整数原样保留。
import { describe, expect, test } from "vitest";
import {
  DEFAULT_FILE_ATTACHMENT_MAX_MB,
  DEFAULT_IMAGE_INLINE_MAX_MB,
  DEFAULT_TEXT_PASTE_MAX_MB,
  parseUploadLimitMb,
} from "@/stores/ui";

describe("parseUploadLimitMb（MB 整数 1..1024，非法回退缺省）", () => {
  test("键缺失/undefined/null/空串回退缺省", () => {
    expect(parseUploadLimitMb(undefined, DEFAULT_FILE_ATTACHMENT_MAX_MB)).toBe(10);
    expect(parseUploadLimitMb(null, DEFAULT_IMAGE_INLINE_MAX_MB)).toBe(5);
    expect(parseUploadLimitMb("", DEFAULT_TEXT_PASTE_MAX_MB)).toBe(1);
  });

  test("非整数/越界回退缺省", () => {
    for (const raw of ["abc", "2.5", "0", "-5", "2000", "10mb"]) {
      expect(parseUploadLimitMb(raw, 10)).toBe(10);
    }
  });

  test("合法边界值原样保留（1 与 1024）", () => {
    expect(parseUploadLimitMb("1", 10)).toBe(1);
    expect(parseUploadLimitMb("1024", 10)).toBe(1024);
  });
});
