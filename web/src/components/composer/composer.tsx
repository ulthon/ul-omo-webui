// 输入框（todo 21）：多行自增高文本域、图片粘贴/选择上传、草稿（use-draft）、
// 输入历史（上箭头翻阅 / 按钮入口）、409 锁提示与中断按钮（16 语义原样保留）。
// todo 20：@ 按钮（输入框旁）或键入 @ 弹出文件选择器，选中后经 update() 插入 `@path `
// 引用（光标落插入点之后），路径随 prompt 文本自然发送。
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUp, AtSign, ChevronDown, ChevronUp, History, ImagePlus, Square, X } from "lucide-react";
import { ApiError, api, type InputHistoryItem } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { FilePickerDialog } from "@/components/file-tree/file-picker";
import { insertMention } from "@/components/file-tree/file-tree-logic";
import {
  MAX_IMAGES,
  dataUrlToBase64,
  historyPreview,
  readFileAsDataUrl,
  stepHistoryIndex,
  validateImageFile,
} from "./composer-logic";
import { useDraft } from "./use-draft";

interface ImageAttachment {
  id: string;
  /** base64（无 dataURL 前缀），随 prompt 发 body.images=[{data,mimeType}]（服务端注入 type:"image"） */
  data: string;
  mimeType: string;
}

/** 历史翻阅态：items 新在前（服务端 id DESC），index 当前高亮条 */
interface ActiveHistory {
  items: InputHistoryItem[];
  index: number;
}

let imageSeq = 0;

export function Composer({
  sessionId,
  busy,
  onSent,
  onAborted,
}: {
  sessionId: string;
  /** 会话回合中或权限未决（chat-view composerLocked）：输入禁用 + 停止按钮（原 16 行为） */
  busy: boolean;
  onSent: () => void;
  onAborted: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const project = useUiStore((s) => s.currentProject);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 竞态防护判据（草稿回填用）：输入框为空（还没打字）或非焦点（没在打）才允许回填，
  // 绝不覆盖用户正在输入的内容。useDraft 的恢复是网络异步回调，判定函数挂载即就绪。
  const canRestoreRef = useRef<() => boolean>(() => true);
  const { text, textRef, update, clear: clearDraft } = useDraft(sessionId, canRestoreRef);
  useEffect(() => {
    canRestoreRef.current = () => {
      const el = textareaRef.current;
      const focused = el !== null && document.activeElement === el;
      return textRef.current.length === 0 || !focused;
    };
  });

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** imagesRef 同步镜像：send/addImageFiles 等异步流程读最新值，不依赖渲染闭包 */
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const imagesRef = useRef<ImageAttachment[]>([]);
  const setImagesBoth = useCallback((next: ImageAttachment[]) => {
    imagesRef.current = next;
    setImages(next);
  }, []);

  const [history, setHistory] = useState<ActiveHistory | null>(null);
  /** 进入历史翻阅前的输入内容（下翻越过最新一条时还原） */
  const draftBeforeHistoryRef = useRef("");

  // @ 引用选择器（todo 20）：trigger = 触发时 @ 字符在文本中的下标（按钮入口为 null，
  // 在当前光标处插入）。选中后经 update() 走草稿链路插入 `@path `，光标落插入点之后。
  const [picker, setPicker] = useState<{ open: boolean; trigger: number | null } | null>(null);

  const openPicker = useCallback((trigger: number | null) => {
    setPicker({ open: true, trigger });
  }, []);

  const insertRef = useCallback(
    (path: string, trigger: number | null) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? textRef.current.length;
      const { content, caret: nextCaret } = insertMention(textRef.current, caret, trigger, path);
      update(content);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [update, textRef],
  );

  const onPickFile = useCallback(
    (path: string) => {
      insertRef(path, picker?.trigger ?? null);
      setPicker(null);
    },
    [insertRef, picker],
  );

  // 多行自增高：每次渲染后按内容校正高度；超过 max-h-48 由 CSS 截断并内部滚动
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  });

  // ---------- 发送 ----------

  const send = useCallback(async () => {
    const trimmed = textRef.current.trim();
    const imgs = imagesRef.current;
    if ((!trimmed && imgs.length === 0) || busy || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.prompt(sessionId, {
        text: trimmed,
        images: imgs.length > 0 ? imgs.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
      });
      setImagesBoth([]);
      clearDraft();
      setHistory(null);
      draftBeforeHistoryRef.current = "";
      // 输入历史追加（服务端去重、上限 200）；空文本不追加
      if (project && trimmed) void api.appendInputHistory(project, trimmed).catch(() => {});
      onSent();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("该会话正在被另一个窗口处理中，请等待其完成后再发送");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSending(false);
    }
  }, [busy, sending, sessionId, project, clearDraft, setImagesBoth, onSent, textRef]);

  const abort = useCallback(async () => {
    try {
      await api.abort(sessionId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "中断失败", "error");
    } finally {
      onAborted();
    }
  }, [sessionId, onAborted, showToast]);

  // ---------- 图片 ----------

  const addImageFiles = useCallback(
    async (files: File[]) => {
      const accepted: ImageAttachment[] = [];
      for (const file of files) {
        const problem = validateImageFile(file);
        if (problem) {
          showToast(problem, "error");
          continue;
        }
        try {
          const dataUrl = await readFileAsDataUrl(file);
          accepted.push({
            id: `img-${++imageSeq}`,
            data: dataUrlToBase64(dataUrl),
            mimeType: file.type || "image/png",
          });
        } catch {
          showToast("图片读取失败", "error");
        }
      }
      if (accepted.length === 0) return;
      const room = MAX_IMAGES - imagesRef.current.length;
      if (room <= 0) {
        showToast(`最多 ${MAX_IMAGES} 张图片`, "error");
        return;
      }
      if (accepted.length > room) showToast(`最多 ${MAX_IMAGES} 张图片，已保留前 ${room} 张`, "error");
      setImagesBoth([...imagesRef.current, ...accepted.slice(0, room)]);
    },
    [showToast, setImagesBoth],
  );

  const removeImage = useCallback(
    (id: string) => setImagesBoth(imagesRef.current.filter((img) => img.id !== id)),
    [setImagesBoth],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
      if (files.length > 0) {
        e.preventDefault();
        void addImageFiles(files);
      }
    },
    [addImageFiles],
  );

  // ---------- 输入历史 ----------

  /** 回填历史条目（可编辑）：文本进草稿链路，光标移到末尾；按钮入口时顺带聚焦 */
  const backfill = useCallback(
    (content: string) => {
      update(content);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(content.length, content.length);
      });
    },
    [update],
  );

  const openHistory = useCallback(async () => {
    if (!project || busy || sending) return;
    let items: InputHistoryItem[];
    try {
      ({ items } = await api.listInputHistory(project, 200));
    } catch {
      return; // 无历史/网络失败静默不打扰
    }
    if (items.length === 0) return;
    draftBeforeHistoryRef.current = textRef.current;
    setHistory({ items, index: 0 });
    backfill(items[0].content);
  }, [project, busy, sending, backfill, textRef]);

  const historyOlder = useCallback(() => {
    if (!history) return;
    const next = stepHistoryIndex(history.index, "older", history.items.length);
    if (next === null || next === history.index) return;
    backfill(history.items[next].content);
    setHistory({ ...history, index: next });
  }, [history, backfill]);

  const historyNewer = useCallback(() => {
    if (!history) return;
    const next = stepHistoryIndex(history.index, "newer", history.items.length);
    if (next === null) {
      // 越过最新一条：退出历史态并还原进入前的草稿（取消浏览不动用户原稿）
      backfill(draftBeforeHistoryRef.current);
      setHistory(null);
      return;
    }
    backfill(history.items[next].content);
    setHistory({ ...history, index: next });
  }, [history, backfill]);

  const closeHistory = useCallback(() => {
    // Esc 收起：仅退出翻阅态，保留当前（已回填/已编辑）文本，不还原
    setHistory(null);
  }, []);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;
      // 键入 @ 弹出文件选择器（todo 20）：preventDefault 后自行插入字符——
      // 弹窗打开时 radix Dialog 会立刻抢走焦点，浏览器默认插入会误落进弹窗搜索框
      if (e.key === "@") {
        const el = e.currentTarget;
        if (el.selectionStart === el.selectionEnd) {
          e.preventDefault();
          const pos = el.selectionStart;
          update(el.value.slice(0, pos) + "@" + el.value.slice(el.selectionEnd));
          openPicker(pos);
        }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
        return;
      }
      if (e.key === "ArrowUp") {
        if (history) {
          e.preventDefault();
          historyOlder();
          return;
        }
        const el = e.currentTarget;
        // 仅光标位于首行且无选区时调出历史：多行内容/选中文本时 ↑ 是正常光标移动；
        // 移动端软键盘不产生 ArrowUp 键，触屏走历史按钮入口
        if (el.selectionStart === el.selectionEnd && !el.value.slice(0, el.selectionStart).includes("\n")) {
          e.preventDefault();
          void openHistory();
        }
        return;
      }
      if (e.key === "ArrowDown" && history) {
        e.preventDefault();
        historyNewer();
        return;
      }
      if (e.key === "Escape" && history) {
        e.preventDefault();
        closeHistory();
      }
    },
    [history, send, historyOlder, historyNewer, closeHistory, openHistory, openPicker, update],
  );

  // ---------- 中断态（原 16 行为：状态行 + 停止按钮，输入区让位） ----------

  if (busy) {
    return (
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
          会话处理中，暂不能发送
        </span>
        <button
          type="button"
          data-testid="abort-btn"
          onClick={() => void abort()}
          className="flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-xs text-destructive transition-colors hover:bg-destructive/10"
        >
          <Square className="size-3" />
          停止生成
        </button>
      </div>
    );
  }

  const canSend = (text.trim().length > 0 || images.length > 0) && !sending;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
      {history && (
        <div
          data-testid="history-bar"
          className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-1.5 py-1 text-xs text-muted-foreground"
        >
          <button
            type="button"
            data-testid="history-prev"
            aria-label="更早一条"
            onClick={historyOlder}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted"
          >
            <ChevronUp className="size-4" />
          </button>
          <span className="shrink-0 tabular-nums">
            {history.index + 1}/{history.items.length}
          </span>
          <span className="min-w-0 flex-1 truncate">{historyPreview(history.items[history.index])}</span>
          <span className="hidden shrink-0 sm:inline">Esc 退出</span>
          <button
            type="button"
            data-testid="history-next"
            aria-label="更新一条"
            onClick={historyNewer}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
      )}
      {images.length > 0 && (
        <div className="flex gap-2 overflow-x-auto overscroll-x-contain py-0.5" data-testid="image-strip">
          {images.map((img) => (
            <div key={img.id} data-testid="image-thumb" className="relative size-16 shrink-0">
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt="待发送图片"
                className="size-16 rounded-lg border object-cover"
              />
              <button
                type="button"
                aria-label="移除图片"
                data-testid="image-thumb-remove"
                onClick={() => removeImage(img.id)}
                className="absolute -top-2.5 -right-2.5 flex size-11 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:text-destructive"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          data-testid="history-btn"
          aria-label="输入历史"
          title="输入历史（↑ 翻阅）"
          aria-pressed={history !== null}
          onClick={() => (history ? closeHistory() : void openHistory())}
          className={`flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted ${
            history ? "bg-muted text-foreground" : "text-muted-foreground"
          }`}
        >
          <History className="size-5" />
        </button>
        <button
          type="button"
          data-testid="at-btn"
          aria-label="引用文件"
          title="引用文件（插入 @路径）"
          disabled={!project}
          onClick={() => openPicker(null)}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        >
          <AtSign className="size-5" />
        </button>
        <button
          type="button"
          data-testid="image-btn"
          aria-label="添加图片"
          title="添加图片（可粘贴截图）"
          onClick={() => fileInputRef.current?.click()}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted"
        >
          <ImagePlus className="size-5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          data-testid="composer-file-input"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void addImageFiles(files);
          }}
        />
        <textarea
          ref={textareaRef}
          data-testid="composer-input"
          value={text}
          rows={1}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          disabled={sending}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="max-h-48 min-h-11 w-full resize-none overflow-y-auto rounded-lg border border-input bg-transparent px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
        <button
          type="button"
          data-testid="send-btn"
          aria-label="发送"
          disabled={!canSend}
          onClick={() => void send()}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/80 disabled:pointer-events-none disabled:opacity-50"
        >
          <ArrowUp className="size-5" />
        </button>
      </div>
      {error && (
        <p className="text-xs text-destructive" data-testid="composer-error">
          {error}
        </p>
      )}
      {picker?.open && project && (
        <FilePickerDialog
          open
          onOpenChange={(open) => {
            if (!open) setPicker(null);
          }}
          project={project}
          onPick={onPickFile}
        />
      )}
    </div>
  );
}
