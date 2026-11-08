// 2026-11-08 直做批 #29：粘贴图片发送方式默认档回退 attach（用户定调"优先不进模型"）。
// 键缺失/非法值 → attach；显式合法档（attach/inline/auto）原样保留（存量用户不动）。
import { describe, expect, test } from "vitest";
import { parsePasteImageMode } from "@/stores/ui";

describe("parsePasteImageMode 默认档（#29 优先不进模型）", () => {
  test("键缺失/undefined/null 回退 attach", () => {
    expect(parsePasteImageMode(undefined)).toBe("attach");
    expect(parsePasteImageMode(null)).toBe("attach");
    expect(parsePasteImageMode("")).toBe("attach");
  });

  test("非法值回退 attach", () => {
    expect(parsePasteImageMode("garbage")).toBe("attach");
    expect(parsePasteImageMode("AUTO")).toBe("attach");
  });

  test("显式合法档原样保留（存量用户设置不动）", () => {
    expect(parsePasteImageMode("attach")).toBe("attach");
    expect(parsePasteImageMode("inline")).toBe("inline");
    expect(parsePasteImageMode("auto")).toBe("auto");
  });
});
