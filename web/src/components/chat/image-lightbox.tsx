// 图片 part 渲染（todo 23）。两类来源：
//   1) 用户上传图：message content 内联 {type:"image", data:base64, mimeType}（P1-3 实证内联原样存储）
//      —— 内联缩略渲染，点击开灯箱（大图预览、遮罩/Esc 关闭、图片适配视口、触控可达）。
//   2) 工具产出图（image_ref 形态）：get_media 无 REST 路由（verification/05 边界），按降级约定
//      渲染占位提示，不阻塞其余内容。
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { WirePart } from "@/lib/api";
import { api } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { ImageOff, X } from "lucide-react";

/** 灯箱：fixed 全屏遮罩 + 图片适配视口；点遮罩或 Esc 关闭；关闭按钮 44px 触控达标 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const t = useT();
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        className="max-h-full max-w-full object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label={t("chat.lightbox.close")}
        className="absolute right-3 top-3 flex size-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <X className="size-5" />
      </button>
    </div>,
    document.body,
  );
}

/** 引用形态按需取（任务 19 历史引用化）：挂载即取一次，objectURL 渲染，卸载回收；
 * 失败（410 过期/网络）→ failed 占位，不阻塞气泡其余内容 */
function useReferencedImageSrc(sessionId: string | undefined, path: string | undefined): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!sessionId || !path) return;
    let url: string | null = null;
    let alive = true;
    api.fetchAttachmentBlob(sessionId, path).then(
      (blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [sessionId, path]);
  return { src, failed };
}

/** 内联图片 part：缩略展示（限制最大高度），点击进灯箱看大图。双形态（任务 19）：
 * - data（base64）：legacy 内联原样渲染（旧会话兼容，历史下发不再携带但客户端仍可遇）；
 * - ref.path：引用形态，经 GET /api/sessions/:id/attachments?path= 按需取字节。 */
export function ImagePart({ part, sessionId }: { part: WirePart; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const data = typeof part.data === "string" ? part.data : "";
  const refPath =
    !data && part.ref && typeof part.ref === "object" && typeof (part.ref as { path?: unknown }).path === "string"
      ? ((part.ref as { path: string }).path)
      : undefined;
  const { src: fetchedSrc, failed } = useReferencedImageSrc(sessionId, refPath);
  const mimeType = typeof part.mimeType === "string" && part.mimeType ? part.mimeType : "image/png";
  const src = data ? `data:${mimeType};base64,${data}` : fetchedSrc;
  if (refPath && failed) {
    return <ImageExpiredPlaceholder />;
  }
  if (!src) return null;
  const alt = t("chat.lightbox.imageAlt");
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("chat.lightbox.viewLarge")}
        className="block max-w-full cursor-zoom-in overflow-hidden rounded-lg border"
      >
        <img src={src} alt={alt} loading="lazy" className="max-h-64 w-auto max-w-full object-contain" />
      </button>
      {open && <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 引用图片取回失败/过期占位（任务 19）：附件已删/过期（410）或网络失败——提示不阻塞渲染 */
export function ImageExpiredPlaceholder() {
  const t = useT();
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="size-3.5 shrink-0" />
      {t("chat.lightbox.refExpired")}
    </div>
  );
}

/** 工具产出图占位（image_ref）：get_media 无 REST 路由，按 verification/05 降级——提示不阻塞渲染 */
export function ImageRefPlaceholder() {
  const t = useT();
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="size-3.5 shrink-0" />
      {t("chat.lightbox.refUnavailable")}
    </div>
  );
}
