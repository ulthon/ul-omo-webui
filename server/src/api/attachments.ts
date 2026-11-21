// 附件临时区（docs08-r3 任务 17 / B10 大文本粘贴转附件）：
// 落点 DATA_DIR/attachments/<projectHash>/，prompt 只带绝对路径行由引擎按需读取；
// 过期兜底 = 启动清理 mtime>48h 文件（index.ts 启动序列挂点，发送后文件刻意留存）。
// 安全口径（评审钉死）：
// - POST name 仅接受纯文件名：含路径分隔符（/ 或 \）或 ".." 一律 400（口径 a，非法即拒）；
// - 写入前 mkdir 后 realpath 目录（防 DATA_DIR 本身为符号链接），文件名无分隔符
//   ⇒ 落点必然在目录内；写入后再 realpath 复核（防目录内预置同名符号链接劫持
//   writeFileSync 跟随），越界即删除并 403；
// - DELETE 校验 realpath 必须严格位于本会话所属项目的 attachments/<projectHash>/
//   内——越界（其他项目临时文件、临时区外任意路径、符号链接逃逸）一律 403。
import { createHash } from "node:crypto";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config";
import { ApiError } from "./http";

/** 上传上限可调范围（MB）：设置页输入钝制与两端解析回退共用同口径 */
export const UPLOAD_LIMIT_MB_MIN = 1;
export const UPLOAD_LIMIT_MB_MAX = 1024;

/** 粘贴/选择文件的二进制附件通道单附件上限（MB）：meta_kv composer.fileAttachmentMaxMb，
 * 缺省 10。前端 composer 预检与服务端流式计数共同消费（服务端是唯一真相）。 */
export const FILE_ATTACHMENT_MAX_MB_KV = "composer.fileAttachmentMaxMb";
export const DEFAULT_FILE_ATTACHMENT_MAX_MB = 10;
/** 粘贴图片内联链路大小上限（MB）：meta_kv composer.imageInlineMaxMb，缺省 5。
 * 现状仅前端预检强制（内联图片随 prompt JSON 入参，服务端无字节门槛），配置化后
 * 预检值经 bootstrap 从服务端 kv 下发，两端同源。 */
export const IMAGE_INLINE_MAX_MB_KV = "composer.imageInlineMaxMb";
export const DEFAULT_IMAGE_INLINE_MAX_MB = 5;
/** 大段文本粘贴 JSON 通道单附件上限（MB）：meta_kv composer.textPasteMaxMb，缺省 1 */
export const TEXT_PASTE_MAX_MB_KV = "composer.textPasteMaxMb";
export const DEFAULT_TEXT_PASTE_MAX_MB = 1;

/** 上限解析：整数字符串 MB，1..1024 钝制；键缺失/空串/非整数/越界回退缺省。
 * 与前端 stores/ui.ts parseUploadLimitMb 同口径（双端各自实现，键与范围单一契约）。 */
export function parseUploadLimitMb(raw: string | null | undefined, fallbackMb: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= UPLOAD_LIMIT_MB_MIN && n <= UPLOAD_LIMIT_MB_MAX ? n : fallbackMb;
}

type KvReader = { getKv?(key: string): string | null } | undefined;

function limitBytes(meta: KvReader, kv: string, fallbackMb: number): number {
  return parseUploadLimitMb(meta?.getKv?.(kv), fallbackMb) * 1024 * 1024;
}

/** 二进制通道单附件上限（字节）：逐调用读 kv，设置页改完即生效不重启 */
export function fileAttachmentMaxBytes(meta: KvReader): number {
  return limitBytes(meta, FILE_ATTACHMENT_MAX_MB_KV, DEFAULT_FILE_ATTACHMENT_MAX_MB);
}

/** 图片内联上限（字节）：服务端不强制，仅为单源下发口径保留取值口 */
export function imageInlineMaxBytes(meta: KvReader): number {
  return limitBytes(meta, IMAGE_INLINE_MAX_MB_KV, DEFAULT_IMAGE_INLINE_MAX_MB);
}

/** 文本通道单附件上限（字节）：逐调用读 kv */
export function textPasteMaxBytes(meta: KvReader): number {
  return limitBytes(meta, TEXT_PASTE_MAX_MB_KV, DEFAULT_TEXT_PASTE_MAX_MB);
}
/** 临时附件按龄清理阈值：48h（引擎按需读取窗口，过期文件启动时清扫；
 * 清扫后 GET 服务端返回 410 attachment_expired —— 死链语义在 API 面显式化） */
export const ATTACHMENT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** 附件临时区根：DATA_DIR/attachments（测试经 deps.attachmentsRoot 注入临时目录） */
export function attachmentsRoot(): string {
  return join(DATA_DIR, "attachments");
}

/** 项目路径 → 附件子目录名：稳定 sha256 前 16 hex。仓内无 projectHash 先例（引擎侧
 * encodeCwdToSessionDirName 是引擎会话库命名惯例，含原始路径字符，不适用于本产品
 * 数据目录）；哈希避免项目路径特殊字符直接进文件系统路径，前 16 hex 对单用户
 * 临时区碰撞概率可忽略。 */
export function projectAttachmentsHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

export function projectAttachmentsDir(root: string, projectPath: string): string {
  return join(root, projectAttachmentsHash(projectPath));
}

/**
 * name 白名单（评审钉死口径 a：非法即 400）：必须为纯文件名——含路径分隔符（/ 或 \）
 * 或 ".." 一律拒绝；undefined/null/空串视为未提供（返回 undefined，调用方自生成文件名）。
 */
export function validateAttachmentName(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new ApiError(400, "invalid_name", "name 必须是字符串");
  if (raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
    throw new ApiError(400, "invalid_name", "name 只能是纯文件名（不得含路径分隔符或 ..）");
  }
  return raw;
}

/** 自生成文件名：时间戳 + 短随机，避免并发粘贴同名覆盖 */
export function generatedAttachmentName(): string {
  return `paste-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`;
}

/** 二进制通道自生成文件名（任意格式，缺省 .bin 扩展名） */
export function generatedBinaryAttachmentName(): string {
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bin`;
}

/** 历史引用图片边车/分流文件名前缀（img-<hash>.<ext>）：被会话历史长期引用，
 *  按龄清扫跳过（仅清 paste-/upload- 等临时上传），保证历史会话图片可持续按需取。 */
export const HISTORY_IMAGE_PREFIX = "img-";

/** 历史引用图片严格内容寻址形态（img-<16 hex>.<白名单扩展>）：仅此形态豁免清扫。
 * 防上传通道仿冒（验证审查发现）：validateAttachmentName 只拒路径分隔符与 ..，
 * 用户可 POST name=img-evil.txt 白拿豁免无限留存；严格正则下仿冒名超龄照清。 */
export const HISTORY_IMAGE_NAME = /^img-[0-9a-f]{16}\.(png|jpg|jpeg|gif|webp|svg|bmp|bin)$/

/**
 * 启动清理：扫 root 下各项目哈希子目录内 mtime 超龄的文件删除（子目录保留）。
 * img-* 历史引用图片跳过（任务 19：被历史条目长期引用，不随 48h 清理变死链）。
 * 单文件失败（竞态删除/权限）跳过不阻塞启动；root 不存在 = 从未有附件，返回 0。
 */
export function purgeStaleAttachments(root: string, maxAgeMs = ATTACHMENT_MAX_AGE_MS, now = Date.now()): number {
  let hashes: string[];
  try {
    hashes = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const hash of hashes) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, hash));
    } catch {
      continue; // 非目录/权限问题：跳过
    }
    for (const name of entries) {
      const file = join(root, hash, name);
      try {
        const stat = statSync(file);
        if (!stat.isFile()) continue;
        if (HISTORY_IMAGE_NAME.test(name)) continue;
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(file);
          removed++;
        }
      } catch {
        continue;
      }
    }
  }
  return removed;
}
