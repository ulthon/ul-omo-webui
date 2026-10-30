import { ApiError } from "./api/http";

/**
 * 构建期嵌入的 web 静态资产（scripts/build-package.mjs 生成 static-assets.generated.ts）。
 *
 * 三形态行为：
 * - esbuild bundle（npm 包）与 bun compile 产物：动态 import 字面量被构建器内联，
 *   资产随产物分发，加载必成功
 * - 源码形态 + 已跑构建脚本：vitest/bun 直接读生成模块
 * - 源码形态 + 未跑构建脚本：模块缺失 → import 失败 → null，调用方回落磁盘 web/dist
 */
export interface StaticAsset {
  /** text 形态为 UTF-8 原文；binary 形态为 base64 */
  data: string;
  binary: boolean;
}

export type EmbeddedStaticAssets = Record<string, StaticAsset>;

/** 文本上下文（<title> 等）的 HTML 实体转义：& < > " ' 五字符，
 * 防站点名破出文本节点或被浏览器二次解析为标签（畸形输入硬化）。 */
function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 内联 <script> 上下文的 JSON 载荷硬化：JSON.stringify 后把 < > & 转成 Unicode 转义。
 * 防三类破壳：`</script>` 提前闭合、`<!--`/`<script` 注释态歧义、`&` 实体二次解码；
 * 转义发生在 JSON 字符串字面量内部，前端 JSON.parse 后还原为原值（站点名原义无损）。 */
function jsonForInlineScript(v: string): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/** 注入站点名到 index.html（engine-upgrade 2026-10-30 批次 todo3，内嵌/磁盘双路共用）：
 * ① <title> 内容替换为 HTML 转义后的站点名（无 <title> 的畸形产物在 head 内补一个）；
 * ② <head> 起始处注入 window.__SITE_NAME__ 载荷（供登录副标题/顶栏小字消费）；
 * siteName 为 null 时原样返回同一引用（未设置全链零改动的实现锚点）；
 * 无 <head> 的畸形产物载荷前置到文档头（浏览器容错解析仍归 head）。 */
export function injectSiteName(html: string, siteName: string | null): string {
  if (siteName === null) return html;
  const hadTitle = /<title>[\s\S]*?<\/title>/.test(html);
  let out = hadTitle
    ? html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtmlText(siteName)}</title>`)
    : html;
  const titleLine = hadTitle ? "" : `<title>${escapeHtmlText(siteName)}</title>`;
  const scriptLine = `<script>window.__SITE_NAME__=${jsonForInlineScript(siteName)}</script>`;
  const headOpen = out.indexOf("<head>");
  if (headOpen >= 0) {
    const at = headOpen + "<head>".length;
    out = out.slice(0, at) + titleLine + scriptLine + out.slice(at);
  } else {
    out = titleLine + scriptLine + out;
  }
  return out;
}

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
  try {
    // @ts-ignore 构建产物模块：构建脚本生成后才存在，未构建的源码工作区没有此文件
    const m = (await import("./static-assets.generated.ts")) as {
      EMBEDDED_STATIC?: EmbeddedStaticAssets | null;
    };
    return m.EMBEDDED_STATIC ?? null;
  } catch {
    return null;
  }
}
