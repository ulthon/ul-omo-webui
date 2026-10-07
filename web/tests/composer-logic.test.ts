// Composer 纯逻辑单测（todo 21）：草稿来源决策、图片校验、输入历史翻页。
// localStorage 兜底与 FileReader 走浏览器 QA（.omo/qa/W4/composer.md）。
import { describe, expect, test } from "bun:test";
import type { DraftInfo } from "@/lib/api";
import {
  MAX_IMAGE_BYTES,
  dataUrlToBase64,
  historyPreview,
  resolveDraftSource,
  stepHistoryIndex,
  validateImageFile,
  type LocalDraft,
} from "@/components/composer/composer-logic";

const serverDraft = (content: string): DraftInfo => ({ content, updatedAt: "2026-10-06T00:00:00Z" });
const localDraft = (content: string): LocalDraft => ({ content, savedAt: "2026-10-06T00:00:00Z" });

describe("resolveDraftSource", () => {
  test("服务端草稿非空时优先，来源标记 server", () => {
    expect(resolveDraftSource(serverDraft("服务端"), localDraft("本地"))).toEqual({ content: "服务端", source: "server" });
  });

  test("两处都有时取较新者（保存失败期间的本地兜底不丢），来源标记 local", () => {
    const newerLocal: LocalDraft = { content: "本地较新", savedAt: "2026-10-06T02:00:00Z" };
    const olderServer: DraftInfo = { content: "服务端较旧", updatedAt: "2026-10-06T01:00:00Z" };
    expect(resolveDraftSource(olderServer, newerLocal)).toEqual({ content: "本地较新", source: "local" });
    const newerServer: DraftInfo = { content: "服务端较新", updatedAt: "2026-10-06T03:00:00Z" };
    const olderLocal: LocalDraft = { content: "本地较旧", savedAt: "2026-10-06T01:30:00Z" };
    expect(resolveDraftSource(newerServer, olderLocal)).toEqual({ content: "服务端较新", source: "server" });
  });

  test("服务端为空/缺席时用本地兜底，来源标记 local", () => {
    expect(resolveDraftSource(serverDraft(""), localDraft("本地"))).toEqual({ content: "本地", source: "local" });
    expect(resolveDraftSource(null, localDraft("本地"))).toEqual({ content: "本地", source: "local" });
  });

  test("两处皆空返回空串不回填（source=none）", () => {
    expect(resolveDraftSource(serverDraft(""), localDraft(""))).toEqual({ content: "", source: "none" });
    expect(resolveDraftSource(null, null)).toEqual({ content: "", source: "none" });
  });
});

describe("dataUrlToBase64", () => {
  test("剥离 dataURL 前缀", () => {
    expect(dataUrlToBase64("data:image/png;base64,QUJD")).toBe("QUJD");
  });
  test("无逗号原样返回", () => {
    expect(dataUrlToBase64("QUJD")).toBe("QUJD");
  });
});

describe("validateImageFile", () => {
  test("合法图片通过", () => {
    expect(validateImageFile({ size: 1024, type: "image/png" })).toBeNull();
    expect(validateImageFile({ size: MAX_IMAGE_BYTES, type: "image/jpeg" })).toBeNull();
  });
  test("超过大小上限拒绝并提示上限值", () => {
    const err = validateImageFile({ size: MAX_IMAGE_BYTES + 1, type: "image/png" });
    expect(err).toContain("5MB");
  });
  test("非图片类型拒绝", () => {
    expect(validateImageFile({ size: 10, type: "text/plain" })).toContain("图片");
  });
});

describe("stepHistoryIndex", () => {
  test("older 往更旧，末端截断", () => {
    expect(stepHistoryIndex(0, "older", 3)).toBe(1);
    expect(stepHistoryIndex(2, "older", 3)).toBe(2);
  });
  test("newer 往更新，越过最新返回 null", () => {
    expect(stepHistoryIndex(2, "newer", 3)).toBe(1);
    expect(stepHistoryIndex(0, "newer", 3)).toBeNull();
  });
  test("单条历史 older 停在原位", () => {
    expect(stepHistoryIndex(0, "older", 1)).toBe(0);
  });
});

describe("historyPreview", () => {
  test("折叠空白并截断加省略号", () => {
    expect(historyPreview({ id: 1, projectPath: "/p", content: "a\n  b", createdAt: "" })).toBe("a b");
    const long = "x".repeat(50);
    expect(historyPreview({ id: 1, projectPath: "/p", content: long, createdAt: "" })).toBe(
      `${"x".repeat(40)}…`,
    );
  });
});
