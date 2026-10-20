// 只读文件预览（todo 20）：文本直接渲染、图片内联、二进制提示不渲染、大文件截断提示。
// 只读硬约束：无任何写入口。
// 服务端契约（todo 9）：fs/file 对二进制（NUL 探测）返回 binary=true 且 content=null——
// 位图（png/jpg 等真二进制图片）拿不到字节，前端识别类型后展示占位说明（降级记录）；
// 文本型图片（svg）content 可用，转 data URL 真内联。
import { useEffect, useState } from "react";
import { Ban, FileText, FileWarning, ImageIcon, LoaderCircle } from "lucide-react";
import { api, type FsFileResponse } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { t } from "@/i18n/i18n";
import { baseName, formatBytes, imageMimeOf } from "./file-tree-logic";

type PreviewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "file"; data: FsFileResponse };

export function FilePreview({
  project,
  path,
  onInsert,
}: {
  project: string;
  path: string;
  /** 传入时渲染「插入引用」按钮（@ 选择器场景）；独立预览可不传 */
  onInsert?: (path: string) => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  // 初始即 loading；调用方以 key={path} 重挂载派生重置，effect 只发请求不同步 setState
  const [state, setState] = useState<PreviewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    api
      .fsFile(project, path)
      .then((data) => {
        if (!cancelled) setState({ kind: "file", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : t("fileTree.preview.loadFailed");
        setState({ kind: "error", message });
        showToast(message, "error");
      });
    return () => {
      cancelled = true;
    };
  }, [project, path, showToast]);

  const mime = imageMimeOf(path);

  return (
    <div data-testid="file-preview" className="flex min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2 border-b pb-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span data-testid="preview-path" className="truncate font-mono text-xs" title={path}>
            {path}
          </span>
          {state.kind === "file" && (
            <span className="text-xs text-muted-foreground">
              {formatBytes(state.data.size)}
              {state.data.truncated ? t("fileTree.preview.truncatedSuffix") : ""}
            </span>
          )}
        </div>
        {onInsert && state.kind === "file" && (
          <button
            type="button"
            data-testid="preview-insert"
            onClick={() => onInsert(path)}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs text-primary-foreground transition-colors hover:bg-primary/80"
          >
            {t("fileTree.preview.insertRef")}
          </button>
        )}
      </div>

      {state.kind === "loading" && (
        <div className="flex h-24 items-center justify-center text-muted-foreground">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      )}
      {state.kind === "error" && (
        <div data-testid="preview-error" className="flex flex-col items-start gap-1 p-3 text-sm">
          <span className="flex items-center gap-1.5 text-destructive">
            <FileWarning className="size-4" />
            {t("fileTree.preview.loadFailedTitle")}
          </span>
          <span className="text-xs text-muted-foreground">{state.message}</span>
        </div>
      )}
      {state.kind === "file" &&
        (() => {
          const { data } = state;
          if (data.binary) {
            // 位图：契约限制（binary → content=null）拿不到字节，展示类型识别占位（只读降级）
            if (mime && mime !== "image/svg+xml") {
              return (
                <div data-testid="preview-image-placeholder" className="flex flex-col items-center gap-2 p-6 text-center">
                  <ImageIcon className="size-10 text-muted-foreground/40" />
                  <p className="text-sm">{t("fileTree.preview.imageFile", { mime })}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("fileTree.preview.imageNoInline", { size: formatBytes(data.size) })}
                  </p>
                </div>
              );
            }
            return (
              <div data-testid="preview-binary" className="flex flex-col items-center gap-2 p-6 text-center">
                <Ban className="size-10 text-muted-foreground/40" />
                <p className="text-sm">{t("fileTree.preview.binaryFile")}</p>
                <p className="text-xs text-muted-foreground">
                  {baseName(path)} · {formatBytes(data.size)}
                </p>
              </div>
            );
          }
          if (data.content === "") {
            return (
              <div data-testid="preview-empty" className="flex flex-col items-center gap-2 p-6 text-center">
                <FileText className="size-10 text-muted-foreground/40" />
                <p className="text-sm">{t("fileTree.preview.emptyFile")}</p>
              </div>
            );
          }
          return (
            <div className="flex min-h-0 flex-col gap-2">
              {data.truncated && (
                <div data-testid="preview-truncated" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                  {t("fileTree.preview.tooLarge", { size: formatBytes(data.size) })}
                </div>
              )}
              {mime === "image/svg+xml" ? (
                <div className="flex justify-center p-3">
                  <img
                    data-testid="preview-image"
                    src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(data.content ?? "")))}`}
                    alt={baseName(path)}
                    className="max-h-64 max-w-full rounded-lg border"
                  />
                </div>
              ) : (
                <pre
                  data-testid="preview-text"
                  className="min-h-0 flex-1 overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all"
                >
                  {data.content}
                </pre>
              )}
            </div>
          );
        })()}
    </div>
  );
}
