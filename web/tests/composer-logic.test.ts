// Composer 纯逻辑单测（todo 21）：草稿来源决策、图片校验、输入历史翻页。
// localStorage 兜底与 FileReader 走浏览器 QA（.omo/qa/W4/composer.md）。
import { describe, expect, test } from "vitest";
import type { DraftInfo } from "@/lib/api";
import {
  MAX_IMAGE_BYTES,
  PASTE_ATTACHMENT_THRESHOLD,
  appendAttachmentLines,
  appendFileAttachmentLines,
  dataUrlToBase64,
  detachFileChip,
  detachPasteChip,
  failFileChip,
  formatPasteKb,
  hasUploadingFileChip,
  historyPreview,
  pasteExceedsThreshold,
  resetFileChip,
  resolveDraftSource,
  sendableFileChipCount,
  sendableFileChips,
  sendablePasteChips,
  settleFileChip,
  settlePasteChip,
  startPasteChip,
  stepHistoryIndex,
  utf8ByteLength,
  validateImageFile,
  type FileChip,
  type LocalDraft,
  type PasteChip,
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

describe("大段粘贴转附件（B10 docs08-r3 任务 17）", () => {
  test("阈值常量为 4096 字节", () => {
    expect(PASTE_ATTACHMENT_THRESHOLD).toBe(4096);
  });
  test("utf8ByteLength 按 UTF-8 字节计（CJK 3 字节、emoji 4 字节）", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("中")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("中".repeat(1366))).toBe(4098); // > 4KB：按字符数误判会漏
  });
  test("formatPasteKb：一位小数，≥100KB 取整", () => {
    expect(formatPasteKb(4097)).toBe("4 KB");
    expect(formatPasteKb(5321)).toBe("5.2 KB");
    expect(formatPasteKb(1024 * 250)).toBe("250 KB");
  });
  test("appendAttachmentLines：文本+换行+路径行；内容不进 prompt", () => {
    const atts = [{ path: "/data/attachments/abc123/paste-1.txt" }];
    expect(appendAttachmentLines("你好", atts)).toBe(
      "你好\n[大段文本已保存为附件：/data/attachments/abc123/paste-1.txt（按需读取）]",
    );
  });
  test("appendAttachmentLines：多附件多行；纯附件发送仅路径行；无附件原样返回", () => {
    const atts = [{ path: "/a/1.txt" }, { path: "/b/2.txt" }];
    expect(appendAttachmentLines("hi", atts)).toBe(
      "hi\n[大段文本已保存为附件：/a/1.txt（按需读取）]\n[大段文本已保存为附件：/b/2.txt（按需读取）]",
    );
    expect(appendAttachmentLines("", atts)).toBe(
      "[大段文本已保存为附件：/a/1.txt（按需读取）]\n[大段文本已保存为附件：/b/2.txt（按需读取）]",
    );
    expect(appendAttachmentLines("原文", [])).toBe("原文");
  });
});

describe("大段粘贴零点击三态（docs08-r7 任务 3）", () => {
  const chip = (over: Partial<PasteChip> = {}): PasteChip => ({
    id: "att-1",
    name: "",
    path: "",
    content: "x".repeat(5000),
    bytes: 5000,
    stage: "uploading",
    ...over,
  });

  test("pasteExceedsThreshold：4096 字节恰好不转（浏览器默认粘贴）", () => {
    expect(pasteExceedsThreshold("a".repeat(4096))).toBe(false);
  });

  test("pasteExceedsThreshold：4097 字节零点击转附件 chip", () => {
    expect(pasteExceedsThreshold("a".repeat(4097))).toBe(true);
  });

  test("pasteExceedsThreshold：CJK 多字节按字节口径（字符数会误判）", () => {
    expect(pasteExceedsThreshold("中".repeat(1365))).toBe(false); // 4095 字节
    expect(pasteExceedsThreshold("中".repeat(1366))).toBe(true); // 4098 字节
    // 字符数 4096、字节数 4098：按字符误判会漏判
    expect(pasteExceedsThreshold("a".repeat(4094) + "中")).toBe(true);
  });

  test("startPasteChip：上传中 chip 追加队尾，既有 chip 保留（多粘贴共存）", () => {
    const ready = chip({ id: "att-0", name: "paste-0.txt", path: "/a/paste-0.txt", stage: "ready" });
    const next = startPasteChip([ready], chip({ id: "att-1" }));
    expect(next).toHaveLength(2);
    expect(next[0]?.id).toBe("att-0");
    expect(next[1]).toMatchObject({ id: "att-1", stage: "uploading", name: "", path: "" });
  });

  test("settlePasteChip：落就绪态更新 name/path/stage，原文保留", () => {
    const { chips, orphan } = settlePasteChip([chip({ id: "att-1", content: "原文" })], "att-1", "paste-1.txt", "/a/paste-1.txt");
    expect(orphan).toBe(false);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      id: "att-1",
      name: "paste-1.txt",
      path: "/a/paste-1.txt",
      stage: "ready",
      content: "原文",
    });
  });

  test("settlePasteChip：chip 已被抢先出列（在途取消/发送清空）→ orphan=true 列表原样", () => {
    expect(settlePasteChip([], "att-2", "paste-2.txt", "/a/paste-2.txt")).toEqual({ chips: [], orphan: true });
    const unrelated = chip({ id: "att-9" });
    const res = settlePasteChip([unrelated], "att-2", "n", "/p");
    expect(res.orphan).toBe(true);
    expect(res.chips).toEqual([unrelated]);
  });

  test("detachPasteChip：出列并带回整条 chip（取消勾选据 content 回插、据 stage 定 DELETE）", () => {
    const c = chip({ id: "att-1", name: "n.txt", path: "/a/n.txt", stage: "ready", content: "原文" });
    const { chips, detached } = detachPasteChip([c], "att-1");
    expect(chips).toEqual([]);
    expect(detached).toEqual(c);
  });

  test("detachPasteChip：上传中 chip 出列同样带回原文（在途取消内容不丢）", () => {
    const c = chip({ id: "att-1", content: "在途原文", path: "" });
    const { chips, detached } = detachPasteChip([c], "att-1");
    expect(chips).toEqual([]);
    expect(detached).toMatchObject({ stage: "uploading", content: "在途原文", path: "" });
  });

  test("detachPasteChip：未知 id 列表原样、detached=null", () => {
    const c = chip({ id: "att-1" });
    const { chips, detached } = detachPasteChip([c], "att-x");
    expect(chips).toEqual([c]);
    expect(detached).toBeNull();
  });

  test("sendablePasteChips：仅就绪 chip 拼路径行；上传中一律不携带（空文本+纯上传中发送早退）", () => {
    const chips = [
      chip({ id: "a", name: "a.txt", path: "/a/a.txt", stage: "ready" }),
      chip({ id: "b", content: "b", bytes: 1 }),
    ];
    expect(sendablePasteChips(chips)).toEqual([{ path: "/a/a.txt" }]);
    expect(sendablePasteChips([chips[1]!])).toEqual([]);
    expect(appendAttachmentLines("", sendablePasteChips(chips))).toBe(
      "[大段文本已保存为附件：/a/a.txt（按需读取）]",
    );
  });
});

describe("通用文件附件三态 chip（docs08 2026-10-23/24 批次任务 18）", () => {
  const fchip = (over: Partial<FileChip> = {}): FileChip => ({
    id: "file-1",
    name: "demo.zip",
    bytes: 2048,
    path: "",
    stage: "uploading",
    error: "",
    ...over,
  });

  test("appendFileAttachmentLines：文本+换行+路径行；纯文件发送仅路径行；无文件原样返回；内容不进 prompt", () => {
    const files = [{ path: "/data/attachments/abc123/upload-1.zip" }];
    expect(appendFileAttachmentLines("你好", files)).toBe(
      "你好\n[已附加文件：/data/attachments/abc123/upload-1.zip（按需读取）]",
    );
    expect(appendFileAttachmentLines("", files)).toBe(
      "[已附加文件：/data/attachments/abc123/upload-1.zip（按需读取）]",
    );
    expect(appendFileAttachmentLines("原文", [])).toBe("原文");
  });

  test("appendFileAttachmentLines：多文件多行；与大段文本行可叠加拼接", () => {
    const files = [{ path: "/a/1.zip" }, { path: "/b/2.pdf" }];
    expect(appendFileAttachmentLines("hi", files)).toBe(
      "hi\n[已附加文件：/a/1.zip（按需读取）]\n[已附加文件：/b/2.pdf（按需读取）]",
    );
    expect(appendFileAttachmentLines(appendAttachmentLines("hi", [{ path: "/t/1.txt" }]), files)).toBe(
      "hi\n[大段文本已保存为附件：/t/1.txt（按需读取）]\n[已附加文件：/a/1.zip（按需读取）]\n[已附加文件：/b/2.pdf（按需读取）]",
    );
  });

  test("settleFileChip：落就绪态填 path 清 error；在途出列 → orphan=true 列表原样", () => {
    const { chips, orphan } = settleFileChip([fchip()], "file-1", "/a/upload-1.zip");
    expect(orphan).toBe(false);
    expect(chips[0]).toMatchObject({ stage: "ready", path: "/a/upload-1.zip", name: "demo.zip" });
    expect(settleFileChip([], "file-9", "/p")).toEqual({ chips: [], orphan: true });
  });

  test("failFileChip / resetFileChip：失败带错误文案保留 chip；重试回上传中态清 path 与 error", () => {
    const failed = failFileChip([fchip()], "file-1", "附件超过 10MB 上限");
    expect(failed[0]).toMatchObject({ stage: "failed", error: "附件超过 10MB 上限", path: "" });
    const retried = resetFileChip(failed, "file-1");
    expect(retried[0]).toMatchObject({ stage: "uploading", error: "", path: "" });
    // 未知 id 原样
    expect(failFileChip([fchip()], "file-x", "e")[0]).toMatchObject({ stage: "uploading" });
  });

  test("detachFileChip：出列带回整条；未知 id 原样 detached=null", () => {
    const c = fchip({ path: "/a/x.zip", stage: "ready" });
    expect(detachFileChip([c], "file-1")).toEqual({ chips: [], detached: c });
    expect(detachFileChip([c], "file-x")).toEqual({ chips: [c], detached: null });
  });

  test("sendableFileChips / hasUploadingFileChip / sendableFileChipCount：仅 ready 可携带；uploading 触发送门；failed 不使能发送", () => {
    const chips = [
      fchip({ id: "a", path: "/a.zip", stage: "ready" }),
      fchip({ id: "b" }),
      fchip({ id: "c", stage: "failed", error: "x" }),
    ];
    expect(sendableFileChips(chips)).toEqual([{ path: "/a.zip" }]);
    expect(hasUploadingFileChip(chips)).toBe(true);
    expect(hasUploadingFileChip([chips[0]!, chips[2]!])).toBe(false);
    expect(sendableFileChipCount(chips)).toBe(1);
    expect(sendableFileChipCount([chips[2]!])).toBe(0);
  });
});
