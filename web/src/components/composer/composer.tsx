// 输入框（todo 21，todo 13 重设计）：多行自增高文本域、图片粘贴/选择上传、草稿（use-draft）、
// 输入历史（上箭头翻阅 / 按钮入口）、409 锁提示与中断按钮（16 语义原样保留）。
// todo 20：@ 按钮或键入 @ 弹出文件选择器，选中后经 update() 插入 `@path `
// 引用（光标落插入点之后），路径随 prompt 文本自然发送。
// todo 14：常用语面板（SnippetPanelDialog）——条目插入走草稿链路，条目直发经
// sendText(clearInputs:false) 只发送条目文本，不动输入框既有草稿/图片/历史。
// docs08-r3 A1：常用语按钮改开锚定下拉（SnippetDropdown，AnchoredPanel 基础件），
// 非模态不抢焦点；插入/直发语义同上，「查看全部」仍打开旧弹框兜底（管理留弹框）。
// todo 13 方向 2 布局：textarea 整行在上，工具条行在下（左：历史/@/图片/常用语；
// 右：发送钮 outline 风格）；容器 padding-bottom 兜底安全区，键盘弹出时输入区保持在键盘上方。
// W2 todo 8：工具条右侧增加模型 chip（可搜索选择，Ctrl+P 快捷打开）与思考档 chip
// （模型未下发 supportedThinkingLevels 时整体隐藏），选择随下一条 prompt 注入。
// docs08-r3 任务 19：斜杠输入提示（SlashHints）——值以 / 开头且首 token 未闭合时
// 锚定 textarea 弹三段下拉（引擎命令/技能/用户提示），选择 = 首 token 替换为 /命令
// （尾部空格）走既有 prompt 支持路径；上下/回车导航，Esc 关闭并回退打开前输入。
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUp, AtSign, ChevronDown, ChevronUp, FileText, History, ImagePlus, MessageSquareText, Square, X } from "lucide-react";
import { ApiError, api, type CommandsResponse, type InputHistoryItem } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { useMessagesStore } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";
import { FilePickerDialog } from "@/components/file-tree/file-picker";
import { SnippetPanelDialog } from "@/components/composer/snippet-panel";
import { SnippetDropdown } from "@/components/composer/snippet-dropdown";
import { SlashHints } from "@/components/composer/slash-hints";
import { ModelChip, ThinkingChip } from "@/components/composer/chips";
import { insertSnippet, snippetActionDisabled } from "@/components/composer/snippet-logic";
import { insertMention } from "@/components/file-tree/file-tree-logic";
import {
  EMPTY_SLASH_GROUPS,
  MAX_IMAGES,
  PASTE_ATTACHMENT_THRESHOLD,
  appendAttachmentLines,
  dataUrlToBase64,
  filterSlashGroups,
  flattenSlashItems,
  formatPasteKb,
  historyPreview,
  readFileAsDataUrl,
  slashReplaceToken,
  slashTriggerToken,
  stepHistoryIndex,
  utf8ByteLength,
  validateImageFile,
  type SlashItem,
} from "./composer-logic";
import { useDraft } from "./use-draft";

interface ImageAttachment {
  id: string;
  /** base64（无 dataURL 前缀），随 prompt 发 body.images=[{data,mimeType}]（服务端注入 type:"image"） */
  data: string;
  mimeType: string;
}

/** 大段文本附件 chip（B10 docs08-r3 任务 17）：文件已落服务端临时区，prompt 只带路径行 */
interface TextAttachment {
  id: string;
  name: string;
  /** 服务端临时区绝对路径（DATA_DIR/attachments/<projectHash>/），发送拼接进 prompt */
  path: string;
}

/** 历史翻阅态：items 新在前（服务端 id DESC），index 当前高亮条 */
interface ActiveHistory {
  items: InputHistoryItem[];
  index: number;
}

let imageSeq = 0;
let attachmentSeq = 0;

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

  // 大段粘贴转附件（B10）：attachmentsRef 同步镜像同 images 模式；pasteOffer =
  // 超阈值粘贴挂起的选择（原样插入/作为附件发送/忽略），同一时刻至多一条（新粘贴覆盖旧条）
  const [attachments, setAttachments] = useState<TextAttachment[]>([]);
  const attachmentsRef = useRef<TextAttachment[]>([]);
  const setAttachmentsBoth = useCallback((next: TextAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);
  const [pasteOffer, setPasteOffer] = useState<{ content: string; bytes: number } | null>(null);

  const [history, setHistory] = useState<ActiveHistory | null>(null);
  /** 进入历史翻阅前的输入内容（下翻越过最新一条时还原） */
  const draftBeforeHistoryRef = useRef("");

  // @ 引用选择器（todo 20）：trigger = 触发时 @ 字符在文本中的下标（按钮入口为 null，
  // 在当前光标处插入）。选中后经 update() 走草稿链路插入 `@path `，光标落插入点之后。
  const [picker, setPicker] = useState<{ open: boolean; trigger: number | null } | null>(null);

  // 常用语（todo 14 / docs08-r3 A1）：snippetDropdown* = 工具条按钮的锚定下拉；
  // snippetOpen 仅作「查看全部」打开旧弹框（SnippetPanelDialog）的开关
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [snippetDropdownOpen, setSnippetDropdownOpen] = useState(false);
  const [snippetAnchor, setSnippetAnchor] = useState<HTMLElement | null>(null);
  const closeSnippetDropdown = useCallback(() => setSnippetDropdownOpen(false), []);

  // ---------- 斜杠输入提示（docs08-r3 任务 19） ----------
  // 触发纯派生自 textarea 值（/ 开头 + 首 token 未闭合）；slashDismissedToken 记录
  // 「被显式关闭时的 token」实现外点/Esc 关闭后同 token 不再弹出，继续输入（token
  // 变化）即重开。anchor 用 state 存 DOM 元素（Task12 契约：勿在读渲染期读 ref.current）。
  const [slashAnchor, setSlashAnchor] = useState<HTMLElement | null>(null);
  const [slashData, setSlashData] = useState<CommandsResponse | null>(null);
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [slashDismissedToken, setSlashDismissedToken] = useState<string | null>(null);
  /** 打开前输入快照：Esc 回退目标 */
  const slashSnapshotRef = useRef("");
  /** document 段 Esc 监听读的镜像（effect 同步，见取数块前） */
  const slashOpenRef = useRef(false);

  /** 输入统一入口：任何输入都重置下拉高亮（token 变化后从头导航） */
  const applyText = useCallback(
    (next: string) => {
      setSlashHighlight(0);
      update(next);
    },
    [update],
  );

  const openPicker = useCallback((trigger: number | null) => {
    setPicker({ open: true, trigger });
  }, []);

  const insertRef = useCallback(
    (path: string, trigger: number | null) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? textRef.current.length;
      const { content, caret: nextCaret } = insertMention(textRef.current, caret, trigger, path);
      applyText(content);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [applyText, textRef],
  );

  const onPickFile = useCallback(
    (path: string) => {
      insertRef(path, picker?.trigger ?? null);
      setPicker(null);
    },
    [insertRef, picker],
  );

  // 常用语插入（todo 14）：在光标处插入条目文本，走 update() 草稿链路（防抖 PUT），
  // 光标落插入内容之后；不动图片与历史态。焦点由面板 onCloseAutoFocus 归还输入框
  // （focus() 保留 selection），这里只负责 caret 落位
  const insertSnippetText = useCallback(
    (snippet: string) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? textRef.current.length;
      const { content, caret: nextCaret } = insertSnippet(textRef.current, caret, snippet);
      applyText(content);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [applyText, textRef],
  );

  // 多行自增高：每次渲染后按内容校正高度；超过 max-h-48 由 CSS 截断并内部滚动
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  });

  // ---------- 斜杠提示派生与行为（docs08-r3 任务 19） ----------

  // 触发与快照：slashOpen 纯派生自 textarea 值；快照在「从不匹配到匹配」的转移帧
  // 记录打开前内容（覆盖 onChange/回填/草稿恢复全部路径——use-draft 恢复不经 update）
  const slashToken = useMemo(() => slashTriggerToken(text), [text]);
  const slashOpen = slashToken !== null && slashDismissedToken !== slashToken;
  const prevTextRef = useRef("");
  useEffect(() => {
    if (slashTriggerToken(prevTextRef.current) === null && slashToken !== null) {
      slashSnapshotRef.current = prevTextRef.current;
    }
    prevTextRef.current = text;
    // document 段 Esc 回退监听读的最新开合态镜像（effect 同步，不在渲染期写 ref）
    slashOpenRef.current = slashOpen;
  }, [text, slashToken, slashOpen]);

  // 取数：下拉开着即取（服务端 60s 按项目缓存，单次 RPC 毫秒级）；失败静默按空处理
  useEffect(() => {
    if (!slashOpen || !project) return;
    let active = true;
    api
      .getCommands(project)
      .then((res) => {
        if (active && res.project === project) setSlashData(res);
      })
      .catch(() => {
        // 置空三段：面板显示空态，打字主路径零关联
        if (active) setSlashData(null);
      });
    return () => {
      active = false;
    };
  }, [slashOpen, project]);

  const slashGroups = useMemo(
    () => (slashData && slashToken !== null ? filterSlashGroups(slashData, slashToken) : EMPTY_SLASH_GROUPS),
    [slashData, slashToken],
  );
  const slashItems = useMemo(() => flattenSlashItems(slashGroups), [slashGroups]);
  // 高亮越界防御（items 收缩后残留大下标）：Enter/渲染都取钳制值
  const safeHighlight = slashItems.length > 0 ? Math.min(slashHighlight, slashItems.length - 1) : 0;

  /** AnchoredPanel onClose（外点/Esc 截停共用）：记下关闭时 token，同 token 不再弹出 */
  const closeSlashHints = useCallback(() => {
    setSlashDismissedToken(slashTriggerToken(textRef.current));
  }, [textRef]);

  /** Esc 专属的输入回退：恢复打开前快照（面板随值派生自动关闭） */
  const revertSlashInput = useCallback(() => {
    const snapshot = slashSnapshotRef.current;
    closeSlashHints();
    applyText(snapshot);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(snapshot.length, snapshot.length);
    });
  }, [closeSlashHints, applyText]);

  // AnchoredPanel 的 Esc 截停在 document 捕获段（stopPropagation）先执行并调 onClose
  //（只关面板不回退）；同节点后注册的本监听仍会收到该按键，在此补 Esc 特有的输入
  // 回退。外点关闭不回退（输入保留，继续输入即 token 变化自动重开）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !slashOpenRef.current) return;
      e.preventDefault();
      revertSlashInput();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [revertSlashInput]);

  /** 选择条目：首 token 替换为 /<name>（含尾部空格），光标落末尾；补参数后按普通 prompt 发送 */
  const selectSlashItem = useCallback(
    (item: SlashItem) => {
      const next = slashReplaceToken(textRef.current, item.name);
      applyText(next);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.length, next.length);
      });
    },
    [applyText, textRef],
  );

  // anchor 用 state 存 DOM 元素（Task12 契约）：ref callback 挂载即置（历史回填等
  // 不经 onChange 的路径也能锚定），卸载随 busy 分支整体换 UI 时清空
  const textareaRefCb = useCallback((el: HTMLTextAreaElement | null) => {
    textareaRef.current = el;
    setSlashAnchor(el);
  }, []);

  // ---------- 发送 ----------

  /**
   * 发送文本两态入口（todo 14）：
   * - clearInputs:true = 普通发送（键盘/按钮），携带输入框图片与大段文本附件，成功后
   *   清图片/附件/草稿/历史态。附件生命周期铁律（B10）：发送成功后附件条仅本地清空，
   *   绝不 DELETE——prompt 只带绝对路径行，文件留待引擎按需读取（48h 按龄清理兜底）；
   * - clearInputs:false = 常用语直发：只发送该文本，不掺输入框现有内容，也不清空现有
   *   草稿/图片/附件/历史条。两态共用 prompt 调用、appendInputHistory 与 onSent。
   * prompt 体拼接（B10）：用户文本 + 换行 + 每附件一行
   * `[大段文本已保存为附件：<绝对路径>（按需读取）]`——附件正文不进 prompt。
   */
  const sendText = useCallback(
    async (rawText: string, opts: { clearInputs: boolean }) => {
      const trimmed = rawText.trim();
      const imgs = opts.clearInputs ? imagesRef.current : undefined;
      const atts = opts.clearInputs ? attachmentsRef.current : [];
      if (busy || sending) return;
      // 普通发送：文本/图片/附件皆空早退（原校验扩展，有图或有附件无文本仍可发）；直发必须有文本
      if (!trimmed && imgs && imgs.length === 0 && atts.length === 0) return;
      if (!trimmed && !opts.clearInputs) return;
      setSending(true);
      setError(null);
      try {
        const outgoingImages =
          imgs && imgs.length > 0 ? imgs.map(({ data, mimeType }) => ({ data, mimeType })) : undefined;
        const outgoingText = appendAttachmentLines(trimmed, atts);
        const receipt = await api.prompt(sessionId, { text: outgoingText, images: outgoingImages });
        // 缺陷修复（新会话首条用户消息不显示）：prompt 成功即本地乐观入列——首条消息
        // 的服务端事件以路由句柄寻址，handle→durable 映射回填前不入列，靠本地占位；
        // 回执带回真实 id 时即时换 key（消息槽 + 会话行 + 选中态），不等会话行刷新。
        // 入列文本与 prompt 同源（含附件路径行），与引擎落盘消息保持一致。
        const messages = useMessagesStore.getState();
        messages.appendLocalUserEntry(sessionId, outgoingText, outgoingImages);
        if (receipt.streaming) messages.setStreaming(sessionId, true);
        if (typeof receipt.durableSessionId === "string" && receipt.durableSessionId !== sessionId) {
          messages.adoptDurableId(sessionId, receipt.durableSessionId);
          useSessionsStore.getState().adoptSessionId(sessionId, receipt.durableSessionId);
        }
        if (opts.clearInputs) {
          setImagesBoth([]);
          // 附件仅本地清空，不调 DELETE（文件留引擎按需读取，48h 清理兜底）
          setAttachmentsBoth([]);
          clearDraft();
          setHistory(null);
          draftBeforeHistoryRef.current = "";
        }
        // 输入历史追加（服务端去重、上限 200）；存用户原文（不含附件路径行，回填可编辑）；
        // 空文本不追加（直发也属一次输入）
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
    },
    [busy, sending, sessionId, project, clearDraft, setImagesBoth, setAttachmentsBoth, onSent],
  );

  const send = useCallback(() => sendText(textRef.current, { clearInputs: true }), [sendText, textRef]);

  // 常用语直发（todo 14）：只发送条目文本（clearInputs:false），不动输入框既有内容
  const sendSnippetNow = useCallback(
    (snippet: string) => {
      void sendText(snippet, { clearInputs: false });
    },
    [sendText],
  );

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
      // 图片粘贴链路原样（B10 不改语义）：图片文件优先于文本分支
      const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
      if (files.length > 0) {
        e.preventDefault();
        void addImageFiles(files);
        return;
      }
      // 大段文本（B10）：text/plain 超 4KB 拦截默认粘贴，弹选择条（原样插入/作为附件
      // 发送/忽略）；阈值内走浏览器默认行为不动
      const text = e.clipboardData.getData("text/plain");
      if (text) {
        const bytes = utf8ByteLength(text);
        if (bytes > PASTE_ATTACHMENT_THRESHOLD) {
          e.preventDefault();
          setPasteOffer({ content: text, bytes });
        }
      }
    },
    [addImageFiles],
  );

  // ---------- 大段粘贴转附件（B10） ----------

  /** 选择条「原样插入」：内容走草稿链路插入光标处，光标落插入内容之后 */
  const insertPasteContent = useCallback(
    (content: string) => {
      setPasteOffer(null);
      insertSnippetText(content);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [insertSnippetText],
  );

  /** 选择条「作为附件发送」：POST 落服务端临时区后加附件 chip；失败 toast 不加条 */
  const attachPasteContent = useCallback(
    async (content: string) => {
      setPasteOffer(null);
      try {
        const res = await api.postAttachment(sessionId, { content });
        setAttachmentsBoth([...attachmentsRef.current, { id: `att-${++attachmentSeq}`, name: res.name, path: res.path }]);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "附件保存失败", "error");
      }
    },
    [sessionId, setAttachmentsBoth, showToast],
  );

  /** chip 显式移除：本地即删 + fire DELETE（失败 toast；文件另有 48h 按龄清理兜底）。
   * 发送成功清空条绝不走这里（附件留存供引擎按需读取）。 */
  const removeAttachment = useCallback(
    (id: string) => {
      const target = attachmentsRef.current.find((a) => a.id === id);
      setAttachmentsBoth(attachmentsRef.current.filter((a) => a.id !== id));
      if (target) {
        void api.removeAttachment(sessionId, target.path).catch((err: unknown) => {
          showToast(err instanceof Error ? err.message : "附件清理失败（48h 后自动清理）", "error");
        });
      }
    },
    [sessionId, setAttachmentsBoth, showToast],
  );

  // ---------- 输入历史 ----------

  /** 回填历史条目（可编辑）：文本进草稿链路，光标移到末尾；按钮入口时顺带聚焦 */
  const backfill = useCallback(
    (content: string) => {
      applyText(content);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(content.length, content.length);
      });
    },
    [applyText],
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
          applyText(el.value.slice(0, pos) + "@" + el.value.slice(el.selectionEnd));
          openPicker(pos);
        }
        return;
      }
      // 斜杠下拉在场且有可选项时 ↑/↓/Enter 归导航（优先于历史翻阅）：高亮循环移动，
      // 回车选择高亮项（首 token 替换后值含空格，下拉随值派生自动关闭）。过滤后无
      // 命中（如 /comp 唯一候选 compact 被不支持名单排除）不消费按键——Enter 落到
      // 正常发送路径，由命令门拦截不支持的命令并行内明示。
      if (slashOpen && slashItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashHighlight((i) => (i + 1) % slashItems.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashHighlight((i) => (i - 1 + slashItems.length) % slashItems.length);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          selectSlashItem(slashItems[safeHighlight]!);
          return;
        }
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
    [history, send, historyOlder, historyNewer, closeHistory, openHistory, openPicker, applyText, slashOpen, slashItems, safeHighlight, selectSlashItem],
  );

  // ---------- 中断态（原 16 行为：状态行 + 停止按钮，输入区让位） ----------

  if (busy) {
    return (
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 pb-[max(env(safe-area-inset-bottom),8px)] text-xs text-muted-foreground">
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

  const canSend = (text.trim().length > 0 || images.length > 0 || attachments.length > 0) && !sending;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 pb-[max(env(safe-area-inset-bottom),8px)]">
      {pasteOffer && (
        <div
          data-testid="paste-offer-bar"
          className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
        >
          <span className="shrink-0">大段文本（{formatPasteKb(pasteOffer.bytes)}）：</span>
          <button
            type="button"
            data-testid="paste-insert"
            onClick={() => insertPasteContent(pasteOffer.content)}
            className="min-h-8 rounded-md border px-2 transition-colors hover:bg-muted"
          >
            原样插入
          </button>
          <button
            type="button"
            data-testid="paste-attach"
            onClick={() => void attachPasteContent(pasteOffer.content)}
            className="min-h-8 rounded-md border px-2 transition-colors hover:bg-muted"
          >
            作为附件发送
          </button>
          <button
            type="button"
            data-testid="paste-dismiss"
            onClick={() => setPasteOffer(null)}
            className="min-h-8 rounded-md border px-2 text-muted-foreground transition-colors hover:bg-muted"
          >
            忽略
          </button>
        </div>
      )}
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
      {attachments.length > 0 && (
        <div className="flex gap-2 overflow-x-auto overscroll-x-contain py-0.5" data-testid="attachment-strip">
          {attachments.map((att) => (
            <div
              key={att.id}
              data-testid="attachment-chip"
              className="flex h-11 min-w-0 shrink-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-2 text-xs"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="max-w-44 truncate" title={att.path}>
                {att.name}
              </span>
              <button
                type="button"
                aria-label="移除附件"
                data-testid="attachment-chip-remove"
                onClick={() => removeAttachment(att.id)}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* todo 13：textarea 整行占满（自增高不变），工具按钮独立成行放下方 */}
      <textarea
        ref={textareaRefCb}
        data-testid="composer-input"
        value={text}
        rows={1}
        placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        disabled={sending}
        onChange={(e) => applyText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="max-h-48 min-h-11 w-full resize-none overflow-y-auto rounded-lg border border-input bg-transparent px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
      />
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
      <div className="flex items-center gap-1">
        <div className="flex shrink-0 items-center gap-1">
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
          {/* 常用语锚定下拉入口（docs08-r3 A1）；「查看全部」进旧弹框 */}
          <button
            type="button"
            data-testid="snippet-btn"
            aria-label="常用语"
            title="常用语"
            aria-expanded={snippetDropdownOpen}
            onClick={(e) => {
              setSnippetAnchor(e.currentTarget);
              setSnippetDropdownOpen((v) => !v);
            }}
            className={`flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted ${
              snippetDropdownOpen ? "bg-muted text-foreground" : "text-muted-foreground"
            }`}
          >
            <MessageSquareText className="size-5" />
          </button>
        </div>
        {/* 模型 / 思考 chip（W2 todo 8）：第二模型选择面 + 思考档选择，右侧组随发送钮对齐 */}
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <ThinkingChip />
          <ModelChip />
          {/* 发送钮降视觉比重：outline 风格，仅 canSend 时 accent 填充 */}
          <button
            type="button"
            data-testid="send-btn"
            aria-label="发送"
            disabled={!canSend}
            onClick={() => void send()}
            className={`flex size-11 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:pointer-events-none disabled:opacity-50 ${
              canSend
                ? "border-border bg-accent text-accent-foreground hover:bg-muted dark:border-input"
                : "border-border bg-background text-muted-foreground hover:bg-muted dark:border-input dark:bg-input/30"
            }`}
          >
            <ArrowUp className="size-5" />
          </button>
        </div>
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
      {slashOpen && slashAnchor && (
        <SlashHints
          anchor={slashAnchor}
          groups={slashGroups}
          highlight={safeHighlight}
          onSelect={selectSlashItem}
          onClose={closeSlashHints}
        />
      )}
      {snippetDropdownOpen && snippetAnchor && (
        <SnippetDropdown
          anchor={snippetAnchor}
          onClose={closeSnippetDropdown}
          project={project}
          busy={busy}
          sending={sending}
          // 插入：先收下拉再走草稿链路；rAF 焦点回输入框（排队晚于 insertSnippetText
          // 的 caret 落位 rAF，focus() 保留 selection）
          onInsert={(content) => {
            closeSnippetDropdown();
            insertSnippetText(content);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
          // 直发：收下拉后走 sendText(clearInputs:false)，不动既有草稿/图片/历史
          onSendNow={(content) => {
            closeSnippetDropdown();
            sendSnippetNow(content);
          }}
          onViewAll={() => {
            closeSnippetDropdown();
            setSnippetOpen(true);
          }}
        />
      )}
      {snippetOpen && (
        <SnippetPanelDialog
          open
          onOpenChange={(open) => {
            if (!open) setSnippetOpen(false);
          }}
          project={project}
          actionDisabled={snippetActionDisabled(busy, sending)}
          onInsert={(content) => {
            insertSnippetText(content);
            setSnippetOpen(false);
          }}
          onSendNow={(content) => {
            setSnippetOpen(false);
            sendSnippetNow(content);
          }}
          // 关闭后焦点回输入框（radix 默认回触发钮）；插入光标已在 insertSnippetText
          // 的 rAF 中落位，focus() 保留现有 selection
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            textareaRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
