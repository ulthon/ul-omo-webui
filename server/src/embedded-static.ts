import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isCompiledBinary } from "./runtime-paths";
import { ApiError } from "./api/http";

/**
 * 构建期嵌入的 web 静态资产（scripts/build-binary.ts 生成 static-assets.generated.ts）。
 *
 * 三形态行为（W6 todo 29 实测验证）：
 * - bun compile 产物：动态 import 字面量被编译器内联，资产随二进制分发
 * - 源码形态 + 已跑构建脚本：直接读生成模块（与产物行为一致）
 * - 源码形态 + 未跑构建脚本：模块缺失 → null，调用方回落磁盘 web/dist
 */
export interface StaticAsset {
  /** text 形态为 UTF-8 原文；binary 形态为 base64 */
  data: string;
  binary: boolean;
}

export type EmbeddedStaticAssets = Record<string, StaticAsset>;

/** 内嵌形态 SPA fallback 的相对路径解析：decode + 去前导斜杠。
 * 畸形百分号编码（如 /%zz）令 decodeURIComponent 抛 URIError，统一按 400 形状抛出，
 * 由调用方转 JSON 错误响应（不经 route() 包装，必须就地 catch）。 */
export function embeddedRelPath(rawPath: string): string {
  try {
    return decodeURIComponent(rawPath).replace(/^\/+/, "");
  } catch {
    throw new ApiError(400, "invalid_request", "路径包含非法百分号编码");
  }
}

export async function loadEmbeddedStatic(): Promise<EmbeddedStaticAssets | null> {
  // 源码形态先探测短路（生成模块是构建产物，未构建的工作区没有此文件）；
  // 编译形态跳过探测（模块已内联进二进制，磁盘路径探测无意义）
  if (!isCompiledBinary() && !existsSync(resolve(import.meta.dir, "static-assets.generated.ts"))) {
    return null;
  }
  try {
    // @ts-ignore 构建产物模块：构建脚本生成后才存在，未构建的源码工作区没有此文件
    const m = await import("./static-assets.generated.ts");
    return (m as { EMBEDDED_STATIC: EmbeddedStaticAssets | null }).EMBEDDED_STATIC ?? null;
  } catch {
    return null;
  }
}
