// 图片按模型能力自动分流 + 历史引用化（docs08-2026-10-23-24 批次任务 19）：
// - 能力判定：models.json 自定义模型条目的 supportsImages:true 才内联；缺席/文件缺失/
//   JSON 损坏/结构异常/模型无法解析 provider 一律视为"不确定"→保守回退附件（绝不误内联）。
// - 分流（发送时）：不支持读图 → 图片 base64 落附件临时区（复用 t17 结构：
//   DATA_DIR/attachments/<projectHash>/），prompt 只拼路径行（B10 铁律），images 置空。
// - 引用化（历史下发）：GET /api/sessions/:id/messages 的 user image part 不再内嵌
//   base64——按内容哈希落 img-* 边车文件后以 {type:"image",ref:{path,name},mimeType}
//   引用形态下发，客户端可见时经 GET /attachments 按需取。任一条目处理失败→原样
//   下发 base64（legacy 兼容，渲染不破）。
// img-* 边车/分流文件被 purgeStaleAttachments 跳过（历史引用长存，见 attachments.ts）。
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { projectAttachmentsDir } from "./attachments";
import { ApiError } from "./http";

export interface InlineImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** mimeType → 扩展名白名单（未知一律 bin，杜绝任意字符进文件名） */
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 当前模型是否支持读图（内联判定）。保守口径：仅当 models.json 可读、能定位到
 * provider/model 条目且其 supportsImages === true 才返回 true；其余一切情况
 * （文件缺失/JSON 损坏/provider 缺失/条目不存在/字段非 true）一律 false。
 * model 形态 "provider/model"（首个 "/" 前为 provider）；无 "/" 无法定位条目 → false。
 */
export function modelSupportsImages(modelsPath: string | undefined, model: string | undefined): boolean {
  if (!modelsPath || typeof model !== "string") return false;
  const idx = model.indexOf("/");
  if (idx <= 0 || idx >= model.length - 1) return false;
  const provider = model.slice(0, idx);
  const id = model.slice(idx + 1);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(modelsPath, "utf8"));
  } catch {
    return false; // 缺失/不可读/JSON 损坏 → 不确定 → 附件
  }
  if (!isRecord(document)) return false;
  const providers = document.providers;
  if (!isRecord(providers)) return false;
  const entry = providers[provider];
  if (!isRecord(entry) || !Array.isArray(entry.models)) return false;
  for (const m of entry.models) {
    if (isRecord(m) && m.id === id) {
      return m.supportsImages === true; // 显式 true 才内联；false/缺席/垃圾值 → 附件
    }
  }
  return false;
}

/** 内容寻址文件名：img-<sha256(data) 前 16 hex>.<ext>（dedup 天然：同图不重复落盘） */
function imageFileName(data: string, mimeType: string): string {
  const ext = IMAGE_EXT[mimeType] ?? "bin";
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
  return `img-${hash}.${ext}`;
}

/** 落盘单个图片字节到项目附件目录（存在即复用）；返回绝对路径。
 * 文件名服务端自生成（哈希+白名单扩展名，纯文件名），mkdir 后 realpath 防越界。 */
function persistImage(root: string, project: string, data: string, mimeType: string): string {
  const dir = projectAttachmentsDir(root, project);
  mkdirSync(dir, { recursive: true });
  const dirReal = realpathSync(dir);
  const target = join(dirReal, imageFileName(data, mimeType));
  if (!existsSync(target)) {
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error("symlink");
    } catch (err) {
      // ENOENT = 无预置文件正常继续；预置符号链接（劫持写跟随）/其他异常一律拒绝
      if (!isENOENT(err)) throw err;
    }
    writeFileSync(target, Buffer.from(data, "base64"));
    const real = realpathSync(target);
    if (real !== target || !real.startsWith(dirReal + "/")) throw new Error("escape");
  }
  return target;
}

const isENOENT = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";

/** 分流：不支持读图的图片转附件（写盘 + 返回 prompt 路径行）。写盘失败 → 500
 * image_attachment_failed（绝不静默内联给无读图能力的模型）。 */
export function convertImagesToAttachments(root: string, project: string, images: InlineImage[]): string[] {
  const lines: string[] = [];
  for (const img of images) {
    let path: string;
    try {
      path = persistImage(root, project, img.data, img.mimeType);
    } catch (err) {
      throw new ApiError(500, "image_attachment_failed", `图片转附件失败：${err instanceof Error ? err.message : String(err)}`);
    }
    lines.push(`[图片已保存为附件：${path}（按需读取）]`);
  }
  return lines;
}

export interface ImageRef {
  path: string;
  name: string;
}

/** 引用形态 part（下发协议）：{type:"image", ref:{path,name}, mimeType}，data 缺席。
 * 客户端 ref.path 经 GET /api/sessions/:id/attachments?path= 按需取字节。 */
export interface ReferencedImagePart {
  type: "image";
  ref: ImageRef;
  mimeType: string;
}

/** 历史引用化：遍历条目，user message content 的内联 image part 落边车后替换为引用
 * 形态。单条目任一步失败 → 该条目原样保留（base64 兼容下发，渲染不破）。返回新数组；
 * 无可变换条目时原数组引用返回。 */
export function referenceizeEntries<T extends { type?: string; message?: unknown }>(entries: T[], root: string, project: string): T[] {
  let changed = false;
  const out = entries.map((entry) => {
    try {
      if (entry.type !== "message") return entry;
      const message = entry.message;
      if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) return entry;
      let entryChanged = false;
      const content = message.content.map((part) => {
        if (!isRecord(part) || part.type !== "image" || typeof part.data !== "string" || part.data === "") return part;
        const mimeType = typeof part.mimeType === "string" && part.mimeType ? part.mimeType : "image/png";
        const path = persistImage(root, project, part.data as string, mimeType);
        entryChanged = true;
        return { type: "image", ref: { path, name: path.split("/").pop() ?? "" }, mimeType } satisfies ReferencedImagePart;
      });
      if (!entryChanged) return entry;
      changed = true;
      return { ...entry, message: { ...message, content } };
    } catch {
      return entry; // 保守：单条目失败不拖垮整页
    }
  });
  return changed ? out : entries;
}
