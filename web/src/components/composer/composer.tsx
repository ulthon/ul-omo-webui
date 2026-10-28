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
// W2 todo 8：工具条右侧增加模型 chip（可搜索选择，Ctrl+L 快捷打开）与思考档 chip
// （模型未下发 supportedThinkingLevels 时整体隐藏），选择随下一条 prompt 注入。
// docs08-r3 任务 19：斜杠输入提示（SlashHints）——值以 / 开头且首 token 未闭合时
// 锚定 textarea 弹三段下拉（引擎命令/技能/用户提示），选择 = 首 token 替换为 /命令
// （尾部空格）走既有 prompt 支持路径；上下/回车导航，Esc 关闭并回退打开前输入。
// docs08-r7 任务 3：大段粘贴零点击三态——>4KB 粘贴 preventDefault 后立即 POST 挂附件
// chip（加载态，勾选框默认勾选=随消息作为附件发送）；取消勾选=文本经 insertSnippetText
// 立即插入光标处且 chip 消失（best-effort DELETE）；叉=移除+DELETE；POST 失败回退=
// 原文插入输入框（内容永不丢）+toast。三按钮选择条退役；占位符改语法教学（桌面长版/
// 手机短版按视口）。
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUp, AtSign, ChevronDown, ChevronUp, CornerDownRight, FileText, History, Hourglass, ImagePlus, Loader2, MessageSquareText, Plus, RotateCcw, SkipForward, Square, TriangleAlert, X } from "lucide-react";
import { ApiError, api, type CommandsResponse, type InputHistoryItem, type PromptReceipt } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { isSendKey } from "@/lib/shortcuts";
import { apiErrorMessage } from "@/i18n/errors";
import { useUiStore } from "@/stores/ui";
import { useMessagesStore } from "@/stores/messages";
import { useQuestionsStore } from "@/stores/questions";
import { useQueueStore } from "@/stores/queue";
import { useSessionsStore } from "@/stores/sessions";
import { FilePickerDialog } from "@/components/file-tree/file-picker";
import { SnippetPanelDialog } from "@/components/composer/snippet-panel";
import { SnippetDropdown } from "@/components/composer/snippet-dropdown";
import { SlashHints } from "@/components/composer/slash-hints";
import { CapsuleModelTag, ModelChip, ThinkingChip } from "@/components/composer/chips";
import { alignSelectionToApplied, pendingModelBadgeVisible } from "@/components/composer/model-pending";
import { insertSnippet, snippetActionDisabled } from "@/components/composer/snippet-logic";
import { insertMention } from "@/components/file-tree/file-tree-logic";
import { parseSlashCommand } from "@/components/chat/commands";
import { compactToastText, runCompact } from "@/components/chat/compact-run";
import { useIsMobile } from "@/lib/use-is-mobile";
import {
  EMPTY_SLASH_GROUPS,
  FILE_ATTACHMENT_MAX_BYTES,
  MAX_IMAGES,
  appendAttachmentLines,
  appendFileAttachmentLines,
  dataUrlToBase64,
  detachFileChip,
  detachPasteChip,
  failFileChip,
  filterSlashGroups,
  flattenSlashItems,
  formatPasteKb,
  hasUploadingFileChip,
  historyPreview,
  pasteExceedsThreshold,
  readFileAsDataUrl,
  resetFileChip,
  sendableFileChipCount,
  sendableFileChips,
  sendablePasteChips,
  settleFileChip,
  settlePasteChip,
  slashReplaceToken,
  slashTriggerToken,
  startFileChip,
  startPasteChip,
  stepHistoryIndex,
  stopIntent,
  utf8ByteLength,
  validateImageFile,
  type FileChip,
  type PasteChip,
  type SlashItem,
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
let attachmentSeq = 0;

// 多行自增高共用函数（r9：两处 textarea 共用）。文本不变或增长：先量后写，
// scrollHeight 已增长时直接写目标值，未变则零写入（消除旧实现每次击键写 auto 的
// 塌缩中间态——历史流抖动根因）；文本变短：同帧量 auto 后立即写回真实内容高，
// 不产生中间视觉布局。r10 任务 5：变短判定优先于“target≠cur 直写”——超 max-h
// 钳制后 scrollHeight 被 clientHeight 钉在钳制高，清空/删字时直写只会残留钳制高
// （浏览器探针实证：发送后残留 max-h-48 高度不回单行），必须 auto 重量才能量到
// 真实内容高。超过 max-h-48 仍由 CSS 截断并内部滚动。模块级定义供单测直测
const lastLenByEl = new WeakMap<HTMLTextAreaElement, number>();
export function resizeComposerTextarea(el: HTMLTextAreaElement) {
  const prevLen = lastLenByEl.get(el);
  lastLenByEl.set(el, el.value.length);
  if (prevLen !== undefined && el.value.length < prevLen) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    return;
  }
  const target = `${el.scrollHeight}px`;
  if (target !== el.style.height) el.style.height = target;
}

export function Composer({
  sessionId,
  queueAvailable,
  permissionLocked,
  hydrationLocked,
  onSent,
  onAborted,
}: {
  sessionId: string;
  /** 排队可用性 = 会话流式态或已知 running 运行态（docs08-r4 任务 11 + r5 任务 6）：输入可用、发送变排队 */
  queueAvailable: boolean;
  /** 权限锁 = 权限未决：禁一切输入动作，保持整锁形态（原 busy 语义的一半，语义不放宽） */
  permissionLocked: boolean;
  /** 水合锁（docs08-r5 任务 6）：刷新/会话打开后至首个权威运行态信号前禁发送（悲观默认
   * 按「进行中」阻塞）；只锁发送不换权限锁形态，解锁后不回锁（见 hydration-lock.ts） */
  hydrationLocked: boolean;
  onSent: () => void;
  onAborted: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const project = useUiStore((s) => s.currentProject);
  // 中断逃逸口（docs08-r6 任务 6 ①）：runState running/waiting 与未决提问并入中断钮
  // 可见性（保守并集，宁多勿少）——SSE 信号缺失/僵尸复位后 runState 停 waiting、或仅
  // 提问未决的死局也有中断口。仅作用停止钮，不改排队语义（queueAvailable 独立）。
  const runState = useSessionsStore((s) => s.runStates[sessionId]);
  const hasPendingQuestion = useQuestionsStore((s) => (s.bySession[sessionId]?.length ?? 0) > 0);
  const interruptible =
    queueAvailable || runState === "running" || runState === "waiting" || hasPendingQuestion || runState === "background_running";
  // 模型待生效判定（docs08-r6 任务 8 ④ + docs08 2026-10-22 批次任务 27）：生效模型源三路
  // ——prompt 回执 appliedModel（下方写入）、SSE model_changed（event-dispatch 写入）、
  // 会话历史水合（messages store setEntries/appendEntries，任务 27a）。判定与基线对齐
  // 纯函数见 model-pending.ts（机制 a/b 说明与键空间核实记录在彼处）。
  const appliedModel = useSessionsStore((s) => s.appliedModels[sessionId] ?? null);
  const selectedModelForBadge = useUiStore((s) => s.selectedModel);
  // (c) 挂载对齐（docs08 2026-10-22 批次任务 27）：切会话（chat-view 按 key 重挂载）时
  // 选中对齐该会话已知生效模型——cached 会话切回无水合事件，基线在这里补齐；applied
  // 未知（新会话/尾窗缺载）留全局选中（输入初值语义）。回执/SSE model_changed 路径
  // 不对齐（水合到达的对齐在 messages store 水合点，仅水合路径）：发送中改选、真待
  // 生效挂标不被冲掉。刻意不写偏好持久化（scheduleModelPreferencePersist 只属显式
  // 选择，localStorage 初值语义不变）。
  useEffect(() => {
    const applied = useSessionsStore.getState().appliedModels[sessionId];
    const next = alignSelectionToApplied(typeof applied === "string" && applied !== "" ? applied : null, useUiStore.getState().selectedModel);
    if (next !== null) useUiStore.getState().setSelectedModel(next);
  }, [sessionId]);
  const modelPendingEffect = pendingModelBadgeVisible(queueAvailable, selectedModelForBadge, appliedModel);
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

  // 大段粘贴零点击三态（docs08-r7 任务 3）：attachmentsRef 同步镜像同 images 模式；
  // 粘贴超阈值即挂上传中 chip（加载态），勾选框默认勾选=随消息作为附件发送
  const [attachments, setAttachments] = useState<PasteChip[]>([]);
  const attachmentsRef = useRef<PasteChip[]>([]);
  const setAttachmentsBoth = useCallback((next: PasteChip[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  // 通用文件附件三态 chip（docs08 2026-10-23/24 批次任务 18）：任意格式非图片文件
  //（粘贴/选择）→ 二进制附件通道；fileSourcesRef 保留 id→File 供失败重试重新 POST
  const [fileChips, setFileChips] = useState<FileChip[]>([]);
  const fileChipsRef = useRef<FileChip[]>([]);
  const fileSourcesRef = useRef(new Map<string, File>());
  const setFileChipsBoth = useCallback((next: FileChip[]) => {
    fileChipsRef.current = next;
    setFileChips(next);
  }, []);

  const [history, setHistory] = useState<ActiveHistory | null>(null);
  /** 进入历史翻阅前的输入内容（下翻越过最新一条时还原） */
  const draftBeforeHistoryRef = useRef("");

  // @ 引用选择器（todo 20）：trigger = 触发时 @ 字符在文本中的下标（按钮入口为 null，
  // 在当前光标处插入）。选中后经 update() 走草稿链路插入 `@path `，光标落插入点之后。
  const [picker, setPicker] = useState<{ open: boolean; trigger: number | null } | null>(null);

  // 常用语（todo 14 / docs08-r3 A1）：snippetDropdown* = 工具条按钮的锚定下拉；
  // snippetOpen 仅作「查看全部」打开旧弹框（SnippetPanelDialog）的开关。
  // docs08-r5 任务 9：手机档常用语钮迁出工具行，独立常驻胶囊内左端第一位
  // （OC ⊕ 同位形态），点击直达下拉——一步可达；桌面工具行保留原钮零改动。
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [snippetDropdownOpen, setSnippetDropdownOpen] = useState(false);
  const [snippetAnchor, setSnippetAnchor] = useState<HTMLElement | null>(null);
  const closeSnippetDropdown = useCallback(() => setSnippetDropdownOpen(false), []);

  // docs08-r4 任务 7：手机档（<sm）胶囊输入区。历史/@/图片/常用语/chips 收进"更多"
  // 入口（胶囊左端"+"），展开的工具行在胶囊上方；textarea 聚焦即收起展开区（只留
  // 胶囊+发送），blur 后可再点"+"展开。桌面档（sm+）布局与本状态无涉。
  const isCompact = useIsMobile("(max-width: 639.98px)");
  const [toolsOpen, setToolsOpen] = useState(false);

  // 排队发送模式（docs08-r4 任务 11，spike 指引 1）：默认 followUp（做完后继续），
  // 可切 steer（下一回合边界插入当前工作）；ref 镜像供异步发送读最新值（images 同款）
  const [queueMode, setQueueMode] = useState<"steer" | "followUp">("followUp");
  const queueModeRef = useRef<"steer" | "followUp">("followUp");
  const toggleQueueMode = useCallback(() => {
    const next = queueModeRef.current === "followUp" ? "steer" : "followUp";
    queueModeRef.current = next;
    setQueueMode(next);
  }, []);

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

  // 每次渲染后按内容校正高度（r9：共用 resizeComposerTextarea，先量后写）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    resizeComposerTextarea(el);
  });

  // ---------- 斜杠提示派生与行为（docs08-r3 任务 19） ----------

  // 触发与快照：slashOpen 纯派生自 textarea 值；快照在「从不匹配到匹配」的转移帧
  // 记录打开前内容（覆盖 onChange/回填/草稿恢复全部路径——use-draft 恢复不经 update）
  const slashToken = useMemo(() => slashTriggerToken(text), [text]);
  const t = useT();
  // 等待提示条（docs08-r6 任务 12 ①）：runState=waiting（等待提问/权限应答）时明示
  // 「等待中」，消除“回合在跑却没动静”的观感。纯派生渲染，不锁任何输入（排队语义不变）。
  const showWaitingHint = runState === "waiting";
  const waitingHintNode = showWaitingHint ? (
    <div
      data-testid="composer-waiting-hint"
      className="flex items-center gap-1.5 rounded-lg border bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
    >
      <Hourglass className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{t("composer.waitingHint")}</span>
    </div>
  ) : null;
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
      const atts = opts.clearInputs ? sendablePasteChips(attachmentsRef.current) : [];
      // stale_state 钉死（任务 18）：文件 chip 上传在途时发送门拦截（不排队不吞 chip，
      // 落定后用户再发）——避免路径行缺失的半截发送
      if (opts.clearInputs && hasUploadingFileChip(fileChipsRef.current)) {
        setError(t("composer.fileUploadInFlight"));
        return;
      }
      const fileAtts = opts.clearInputs ? sendableFileChips(fileChipsRef.current) : [];
      // busy 语义定则（docs08-r4 任务 11）：权限锁禁发送；流式态放行（发送变排队）。
      // 水合锁（docs08-r5 任务 6）同禁发送：运行态未知窗口悲观默认阻塞。
      // 排队判定读发送瞬间的 store 流式态与运行态（不经渲染闭包，回合刚结束/开始的窗口也对）
      if (permissionLocked || hydrationLocked || sending) return;
      // 普通发送：文本/图片/附件皆空早退（原校验扩展，有图或有附件无文本仍可发）；直发必须有文本
      if (!trimmed && imgs && imgs.length === 0 && atts.length === 0 && fileAtts.length === 0) return;
      if (!trimmed && !opts.clearInputs) return;
      // /compact 精确解析（docs08-r5 任务 8）：裸命令直调压缩端点后返回——不追加本地
      // 用户气泡、不写输入历史、绝不落入 api.prompt（无此拦截则翻案后的放行命令会被
      // 模型当普通消息伪执行已压缩）；带参数行内明示拒绝（引擎 compact 无参数面）；
      // 失败保留输入（不 clearDraft），错误行内展示。
      const compactParsed = parseSlashCommand(trimmed);
      if (compactParsed?.name === "compact") {
        if (compactParsed.args !== "") {
          setError(t("composer.compactNoArgs"));
          return;
        }
        setSending(true);
        setError(null);
        try {
          const receipt = await runCompact(sessionId);
          clearDraft();
          setHistory(null);
          const toast = compactToastText(receipt);
          showToast(t(toast.key, toast.vars), "info");
          onSent();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setSending(false);
        }
        return;
      }
      setSending(true);
      setError(null);
      try {
        const outgoingImages =
          imgs && imgs.length > 0 ? imgs.map(({ data, mimeType }) => ({ data, mimeType })) : undefined;
        const outgoingText = appendFileAttachmentLines(appendAttachmentLines(trimmed, atts), fileAtts);
        const msgStreaming = useMessagesStore.getState().bySession[sessionId]?.streaming ?? false;
        const rs = useSessionsStore.getState().runStates[sessionId];
        // 已知 running（SSE 权威链）同样转排队（docs08-r5 任务 6：r4 排队语义不回退）
        const queuing = msgStreaming || rs === "running" || rs === "waiting";
        // 排队请求只带 streamingBehavior（spike 铁律；api.prompt 自动剥模型/思考档注入，
        // images 未实测随排队投递、同样省略——图片条保留待下次直发）
        let receipt: PromptReceipt;
        try {
          receipt = await api.prompt(
            sessionId,
            queuing
              ? { text: outgoingText, streamingBehavior: queueModeRef.current }
              : { text: outgoingText, images: outgoingImages },
          );
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 409)) throw err;
          // 回合结束瞬间竞态（QA 实测）：本地流式位已翻 false 但服务端单驱动守卫
          // 尚未清位——转排队重试一次。spike F2：实例内回合中带 streamingBehavior
          // 一律 queued（跨进程从不 409），排队是 already processing 的正确动作。
          receipt = await api.prompt(sessionId, { text: outgoingText, streamingBehavior: queueModeRef.current });
        }
        // 缺陷修复（新会话首条用户消息不显示）：prompt 成功即本地乐观入列——首条消息
        // 的服务端事件以路由句柄寻址，handle→durable 映射回填前不入列，靠本地占位；
        // 回执带回真实 id 时即时换 key（消息槽 + 会话行 + 选中态），不等会话行刷新。
        // 入列文本与 prompt 同源（含附件路径行），与引擎落盘消息保持一致。
        const messages = useMessagesStore.getState();
        if (receipt.disposition === "queued") {
          // 排队接受（回执 queued）：本地排队列表乐观占位（queue_update 确认后转正式
          // 项）。docs08-r7 任务 15：消息流不再插“排队中”占位（单显示源=排队条，
          // 零假象）；投递时服务端 user 帧经载荷身份收敛守卫直接入列。
          // 不动 streaming 态（排队回合同一 run，run 尾才 settle 一次——spike (b)-5）。
          useQueueStore.getState().addPending(sessionId, outgoingText, queueModeRef.current);
          // 入队可见反馈（docs08-r6 任务 12 ②）：排队接受即轻提示，消除「点了没反应」观感。
          // 只读回执 disposition（服务端真实结果），不影响排队语义本身。
          showToast(t("composer.queuedFeedback"), "info");
          if (opts.clearInputs) {
            // 附件路径行已随排队文本投递 → 附件条清空；图片未投递 → 保留待直发
            setAttachmentsBoth([]);
            setFileChipsBoth([]);
            fileSourcesRef.current.clear();
            clearDraft();
            setHistory(null);
            draftBeforeHistoryRef.current = "";
          }
        } else {
          messages.appendLocalUserEntry(sessionId, outgoingText, outgoingImages);
          // 发消息即上浮（任务 13 ②）：直发乐观入列同时上浮会话行（不等待 onSent /
          // agent_start 刷新）；此刻行仍以当前 sessionId 入键（adopt 在其后才换 key）
          useSessionsStore.getState().floatSessionUp(sessionId);
          if (receipt.streaming) messages.setStreaming(sessionId, true);
          if (typeof receipt.durableSessionId === "string" && receipt.durableSessionId !== sessionId) {
            messages.adoptDurableId(sessionId, receipt.durableSessionId);
            useSessionsStore.getState().adoptSessionId(sessionId, receipt.durableSessionId);
          }
          // 生效模型即时落库（docs08-r6 任务 8 ②④⑤）：直发回执 appliedModel（setModel
          // 成功回模型行）；SSE model_changed 同值幂等收敛。adopt 后按真实 id 入键。
          if (typeof receipt.appliedModel === "string" && receipt.appliedModel) {
            const appliedKey =
              typeof receipt.durableSessionId === "string" && receipt.durableSessionId ? receipt.durableSessionId : sessionId;
            useSessionsStore.getState().setAppliedModel(appliedKey, receipt.appliedModel);
          }
          if (opts.clearInputs) {
            setImagesBoth([]);
            // 附件仅本地清空，不调 DELETE（文件留引擎按需读取，48h 清理兜底）
            setFileChipsBoth([]);
            fileSourcesRef.current.clear();
            setAttachmentsBoth([]);
            clearDraft();
            setHistory(null);
            draftBeforeHistoryRef.current = "";
          }
        }
        // 输入历史追加（服务端去重、上限 200）；存用户原文（不含附件路径行，回填可编辑）；
        // 空文本不追加（直发也属一次输入）
        if (project && trimmed) void api.appendInputHistory(project, trimmed).catch(() => {});
        onSent();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // 兜底文案（spike 指引 4）：正常"发送撞回合"已转排队，409 仅剩外部驱动/状态漂移
          setError(t("composer.sessionBusy"));
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setSending(false);
      }
    },
    [permissionLocked, hydrationLocked, sending, sessionId, project, clearDraft, setImagesBoth, setAttachmentsBoth, setFileChipsBoth, onSent, showToast, t],
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
      showToast(apiErrorMessage(err, "composer.interruptFailed"), "error");
    } finally {
      onAborted();
    }
  }, [sessionId, onAborted, showToast]);

  const stopClick = useCallback(() => {
    // 后台态停止钮（任务 12）：非流式回合下不中断——后台任务不在 abort 协议面作用域内，
    // 出提示代替中断语义；叠加流式回合时 abort 仍作用于当前回合（stopIntent 判定）
    if (stopIntent(runState, queueAvailable) === "background-hint") {
      showToast(t("composer.backgroundTaskHint"));
      return;
    }
    void abort();
  }, [runState, queueAvailable, abort, showToast, t]);

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
          showToast(t("composer.imageReadFailed"), "error");
        }
      }
      if (accepted.length === 0) return;
      const room = MAX_IMAGES - imagesRef.current.length;
      if (room <= 0) {
        showToast(t("composer.imageLimit", { n: MAX_IMAGES }), "error");
        return;
      }
      if (accepted.length > room) showToast(t("composer.imageLimitKept", { n: MAX_IMAGES, kept: room }), "error");
      setImagesBoth([...imagesRef.current, ...accepted.slice(0, room)]);
    },
    [showToast, setImagesBoth, t],
  );

  const removeImage = useCallback(
    (id: string) => setImagesBoth(imagesRef.current.filter((img) => img.id !== id)),
    [setImagesBoth],
  );

  /** 粘贴 chip POST（零点击，docs08-r7 任务 3）：成功落就绪态（name/path 填充，勾选框
   * 保持勾选=随消息作为附件发送）；chip 已被抢先取消勾选/叉除/发送清空时孤儿文件
   * best-effort DELETE（静默，48h 按龄清理兑底）。失败回退（内容永不丢）：chip 出列，
   * 原文经 insertSnippetText 立即插入光标处 + toast。 */
  const uploadPasteAttachment = useCallback(
    async (id: string, content: string) => {
      try {
        const res = await api.postAttachment(sessionId, { content });
        const settled = settlePasteChip(attachmentsRef.current, id, res.name, res.path);
        setAttachmentsBoth(settled.chips);
        if (settled.orphan) {
          void api.removeAttachment(sessionId, res.path).catch(() => {});
        }
      } catch (err) {
        const { chips, detached } = detachPasteChip(attachmentsRef.current, id);
        setAttachmentsBoth(chips);
        if (detached) {
          insertSnippetText(detached.content);
          requestAnimationFrame(() => textareaRef.current?.focus());
        }
        showToast(apiErrorMessage(err, "composer.attachmentSaveFailed"), "error");
      }
    },
    [sessionId, setAttachmentsBoth, insertSnippetText, showToast],
  );

  // ---------- 通用文件附件（docs08 2026-10-23/24 批次任务 18） ----------

  /** 文件 chip POST（二进制通道）：成功落就绪态（path 填充）；chip 已被抢先移除/发送
   * 清空时孤儿文件 best-effort DELETE；失败落 failed 态（chip 保留供重试）。 */
  const uploadFileAttachment = useCallback(
    async (id: string) => {
      const file = fileSourcesRef.current.get(id);
      if (!file) return;
      try {
        const res = await api.postBinaryAttachment(sessionId, file, file.name);
        const settled = settleFileChip(fileChipsRef.current, id, res.path);
        setFileChipsBoth(settled.chips);
        if (settled.orphan) {
          void api.removeAttachment(sessionId, res.path).catch(() => {});
        }
      } catch (err) {
        setFileChipsBoth(failFileChip(fileChipsRef.current, id, apiErrorMessage(err, "composer.fileUploadFailed")));
      }
    },
    [sessionId, setFileChipsBoth],
  );

  /** 非图片文件入口（粘贴/选择共用）：空文件与超限（10MB）跳过 + toast（重试也必败，
   * 不出 chip）；其余挂上传中 chip 后立即 POST */
  const addFileFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        if (file.size === 0) {
          showToast(t("composer.fileEmptySkipped"), "error");
          continue;
        }
        if (file.size > FILE_ATTACHMENT_MAX_BYTES) {
          showToast(t("composer.fileTooLarge", { name: file.name }), "error");
          continue;
        }
        const id = `file-${++attachmentSeq}`;
        fileSourcesRef.current.set(id, file);
        setFileChipsBoth(
          startFileChip(fileChipsRef.current, { id, name: file.name, bytes: file.size, path: "", stage: "uploading", error: "" }),
        );
        void uploadFileAttachment(id);
      }
    },
    [showToast, t, setFileChipsBoth, uploadFileAttachment],
  );

  /** 失败重试：回上传中态后重新 POST（重用 fileSourcesRef 里的原始 File） */
  const retryFileChip = useCallback(
    (id: string) => {
      setFileChipsBoth(resetFileChip(fileChipsRef.current, id));
      void uploadFileAttachment(id);
    },
    [setFileChipsBoth, uploadFileAttachment],
  );

  /** 文件 chip 移除：本地即删 + 源 Map 清理；就绪态另发 DELETE（失败 toast；48h 按龄
   * 清理兑底）；发送成功清空条绝不走这里 */
  const removeFileChip = useCallback(
    (id: string) => {
      const { chips, detached } = detachFileChip(fileChipsRef.current, id);
      setFileChipsBoth(chips);
      fileSourcesRef.current.delete(id);
      if (detached && detached.stage === "ready" && detached.path !== "") {
        void api.removeAttachment(sessionId, detached.path).catch((err: unknown) => {
          showToast(apiErrorMessage(err, "composer.attachmentCleanupFailed"), "error");
        });
      }
    },
    [sessionId, setFileChipsBoth, showToast],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // 粘贴分流（任务 18）：剪贴板文件按类型分拆——图片走内联链路（B10 不改语义，
      // 分流是任务 19），其余任意格式挂文件 chip 走二进制附件通道；混合剪贴板
      //（图片+文件）两路各自行处理
      const files = Array.from(e.clipboardData.files);
      if (files.length > 0) {
        e.preventDefault();
        const images = files.filter((f) => f.type.startsWith("image/"));
        const others = files.filter((f) => !f.type.startsWith("image/"));
        if (images.length > 0) void addImageFiles(images);
        if (others.length > 0) void addFileFiles(others);
        return;
      }
      // 大段文本（docs08-r7 任务 3）：text/plain 超 4KB 拦截默认粘贴，零点击立即挂
      // 上传中 chip（POST 在途，勾选框默认勾选）；阈值内（含恰好 4096 字节）走浏览器
      // 默认行为不动
      const text = e.clipboardData.getData("text/plain");
      if (text && pasteExceedsThreshold(text)) {
        e.preventDefault();
        const id = `att-${++attachmentSeq}`;
        setAttachmentsBoth(
          startPasteChip(attachmentsRef.current, {
            id,
            name: "",
            path: "",
            content: text,
            bytes: utf8ByteLength(text),
            stage: "uploading",
          }),
        );
        void uploadPasteAttachment(id, text);
      }
    },
    [addImageFiles, addFileFiles, setAttachmentsBoth, uploadPasteAttachment],
  );

  // ---------- 大段粘贴零点击三态（docs08-r7 任务 3） ----------

  /** 取消勾选（三态之二）：原文经 insertSnippetText 立即插入光标处且 chip 消失；
   * 就绪 chip 即刻 best-effort DELETE（失败静默——内容已回插，文件另有 48h 按龄清理
   * 兑底）；上传中 chip 无路径可删，落定时按孤儿清理。 */
  const uncheckPasteAttachment = useCallback(
    (id: string) => {
      const { chips, detached } = detachPasteChip(attachmentsRef.current, id);
      setAttachmentsBoth(chips);
      if (!detached) return;
      insertSnippetText(detached.content);
      requestAnimationFrame(() => textareaRef.current?.focus());
      if (detached.stage === "ready" && detached.path !== "") {
        void api.removeAttachment(sessionId, detached.path).catch(() => {});
      }
    },
    [sessionId, setAttachmentsBoth, insertSnippetText],
  );

  /** chip 显式移除：本地即删 + fire DELETE（失败 toast；文件另有 48h 按龄清理兜底）。
   * 发送成功清空条绝不走这里（附件留存供引擎按需读取）。 */
  const removeAttachment = useCallback(
    (id: string) => {
      const target = attachmentsRef.current.find((a) => a.id === id);
      setAttachmentsBoth(attachmentsRef.current.filter((a) => a.id !== id));
      if (target) {
        void api.removeAttachment(sessionId, target.path).catch((err: unknown) => {
          showToast(apiErrorMessage(err, "composer.attachmentCleanupFailed"), "error");
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
    // busy 语义定则（docs08-r4 任务 11）：历史翻阅仅权限锁拦（流式态放行）
    if (!project || permissionLocked || sending) return;
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
  }, [project, permissionLocked, sending, backfill, textRef]);

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
      if (isSendKey(e)) {
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

  // ---------- 权限锁形态（原 busy 整锁：权限未决禁一切输入动作，语义不放宽） ----------
  // 流式态不再走整锁（docs08-r4 任务 11）：输入保留、发送变排队、停止钮移入正常形态

  if (permissionLocked) {
    return (
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 pb-[max(env(safe-area-inset-bottom),8px)] text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
          {t("composer.lockedHint")}
        </span>
        <button
          type="button"
          data-testid="abort-btn"
          onClick={() => void abort()}
          className="flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-xs text-destructive transition-colors hover:bg-destructive/10"
        >
          <Square className="size-3" />
          {t("composer.stopGeneration")}
        </button>
      </div>
    );
  }

  const canSend =
    (text.trim().length > 0 || images.length > 0 || attachments.length > 0 || sendableFileChipCount(fileChips) > 0) &&
    !sending &&
    !hydrationLocked;
  // 发送中忙碌态（docs08-r7 任务 13）：POST 在途时发送钮呼吸（busy-pulse），
  // 桌面/手机双分支同源；禁用态语义不变，仅叠加视觉节奏
  const sendBusyCls = sending ? " animate-busy-pulse" : "";

  // ---------- 桌面/手机共享子树（docs08-r4 任务 7）：两分支同源，仅容器排布不同 ----------

  const historyBar = history ? (
    <div
      data-testid="history-bar"
      className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-1.5 py-1 text-xs text-muted-foreground"
    >
      <button
        type="button"
        data-testid="history-prev"
        aria-label={t("composer.historyOlder")}
        onClick={historyOlder}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted"
      >
        <ChevronUp className="size-4" />
      </button>
      <span className="shrink-0 tabular-nums">
        {history.index + 1}/{history.items.length}
      </span>
      <span className="min-w-0 flex-1 truncate">{historyPreview(history.items[history.index])}</span>
      <span className="hidden shrink-0 sm:inline">{t("composer.historyEscHint")}</span>
      <button
        type="button"
        data-testid="history-next"
        aria-label={t("composer.historyNewer")}
        onClick={historyNewer}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted"
      >
        <ChevronDown className="size-4" />
      </button>
    </div>
  ) : null;
  const imageStrip =
    images.length > 0 ? (
      <div className="flex gap-2 overflow-x-auto overscroll-x-contain py-0.5" data-testid="image-strip">
        {images.map((img) => (
          <div key={img.id} data-testid="image-thumb" className="relative size-16 shrink-0">
            <img
              src={`data:${img.mimeType};base64,${img.data}`}
              alt={t("composer.pendingImageAlt")}
              className="size-16 rounded-lg border object-cover"
            />
            <button
              type="button"
              aria-label={t("composer.imageRemove")}
              data-testid="image-thumb-remove"
              onClick={() => removeImage(img.id)}
              className="absolute -top-2.5 -right-2.5 flex size-11 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:text-destructive"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    ) : null;
  const attachmentStrip =
    attachments.length > 0 ? (
      <div className="flex gap-2 overflow-x-auto overscroll-x-contain py-0.5" data-testid="attachment-strip">
        {attachments.map((att) => (
          <div
            key={att.id}
            data-testid="attachment-chip"
            className="flex h-11 min-w-0 shrink-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-2 text-xs"
          >
            {att.stage === "uploading" ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : (
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="max-w-44 truncate" title={att.path || undefined}>
              {att.stage === "uploading" ? formatPasteKb(att.bytes) : att.name}
            </span>
            {/* 三态勾选框（docs08-r7 任务 3）：恒勾选展示——取消勾选=文本立即插入输入框
                且 chip 消失（无重勾路径，chip 随取消即卸载）；aria 兼作 tooltip（OC 全站原则） */}
            <input
              type="checkbox"
              data-testid="attachment-chip-toggle"
              aria-label={t("composer.pasteAttachKeep")}
              title={t("composer.pasteAsTextHint")}
              checked
              onChange={() => uncheckPasteAttachment(att.id)}
              className="size-4 shrink-0 cursor-pointer accent-primary"
            />
            <button
              type="button"
              aria-label={t("composer.attachmentRemove")}
              data-testid="attachment-chip-remove"
              onClick={() => removeAttachment(att.id)}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    ) : null;
  // 文件附件三态 chip 条（任务 18）：uploading=旋转图标 + 文件名·体积；ready=文件
  // 图标 + 文件名（title 路径）；failed=警示图标 + 错误文案 + 重试/移除双钮
  const fileAttachmentStrip =
    fileChips.length > 0 ? (
      <div className="flex gap-2 overflow-x-auto overscroll-x-contain py-0.5" data-testid="file-attachment-strip">
        {fileChips.map((fc) => (
          <div
            key={fc.id}
            data-testid="file-attachment-chip"
            data-stage={fc.stage}
            className="flex h-11 min-w-0 shrink-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-2 text-xs"
          >
            {fc.stage === "uploading" ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : fc.stage === "failed" ? (
              <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
            ) : (
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span
              className="max-w-44 truncate"
              title={fc.stage === "ready" ? fc.path : fc.error || fc.name || undefined}
            >
              {fc.stage === "uploading"
                ? `${fc.name} · ${formatPasteKb(fc.bytes)}`
                : fc.stage === "failed"
                  ? fc.name
                  : fc.name}
            </span>
            {fc.stage === "failed" ? (
              <button
                type="button"
                aria-label={t("composer.fileRetry")}
                title={fc.error}
                data-testid="file-attachment-retry"
                onClick={() => retryFileChip(fc.id)}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
              >
                <RotateCcw className="size-4" />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={t("composer.attachmentRemove")}
              data-testid="file-attachment-remove"
              onClick={() => removeFileChip(fc.id)}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    ) : null;
  // 低频工具按钮本体：桌面工具条与手机"更多"工具行共用（仅收纳位置不同，逻辑零改动）。
  // docs08-r5 任务 9：常用语钮拆出为独立钮（snippetButton）——手机档常驻胶囊内
  // 一步直达，桌面档仍排在工具行末位（顺序/形态零改动）。
  const toolButtons = (
    <>
      <button
        type="button"
        data-testid="history-btn"
        aria-label={t("composer.historyAria")}
        title={t("composer.historyTitle")}
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
        aria-label={t("composer.fileRefAria")}
        title={t("composer.fileRefTitle")}
        disabled={!project}
        onClick={() => openPicker(null)}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
      >
        <AtSign className="size-5" />
      </button>
      <button
        type="button"
        data-testid="image-btn"
        aria-label={t("composer.imageAddAria")}
        title={t("composer.imageAddTitle")}
        onClick={() => fileInputRef.current?.click()}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted"
      >
        <ImagePlus className="size-5" />
      </button>
    </>
  );
  // 常用语钮（docs08-r5 任务 9）：桌面在工具行末位（size-11 方角），手机常驻胶囊内
  // 左端第一位（size-9 圆形，与 "+" 同形态）——一步直达下拉
  const snippetButtonNode = (buttonClass: string) => (
    <button
      type="button"
      data-testid="snippet-btn"
      aria-label={t("composer.snippetButton")}
      title={t("composer.snippetButton")}
      aria-expanded={snippetDropdownOpen}
      onClick={(e) => {
        setSnippetAnchor(e.currentTarget);
        setSnippetDropdownOpen((v) => !v);
      }}
      className={buttonClass}
    >
      <MessageSquareText className="size-5" />
    </button>
  );
  const snippetButtonMd = snippetButtonNode(
    `flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted ${
      snippetDropdownOpen ? "bg-muted text-foreground" : "text-muted-foreground"
    }`,
  );
  const snippetButtonSm = snippetButtonNode(
    `flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted ${
      snippetDropdownOpen ? "bg-muted text-foreground" : "text-muted-foreground"
    }`,
  );
  const errorLine = error ? (
    <p className="text-xs text-destructive" data-testid="composer-error">
      {error}
    </p>
  ) : null;
  const fileInputNode = (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      data-testid="composer-file-input"
      className="hidden"
      onChange={(e) => {
        // 选择器开放任意格式（任务 18）：图片走内联链路不变，其余挂文件 chip 走
        // 二进制附件通道；不再限制 accept（无 accept 即全格式）
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        const images = files.filter((f) => f.type.startsWith("image/"));
        const others = files.filter((f) => !f.type.startsWith("image/"));
        if (images.length > 0) void addImageFiles(images);
        if (others.length > 0) void addFileFiles(others);
      }}
    />
  );
  const filePickerNode =
    picker?.open && project ? (
      <FilePickerDialog
        open
        onOpenChange={(open) => {
          if (!open) setPicker(null);
        }}
        project={project}
        onPick={onPickFile}
      />
    ) : null;
  const slashHintsNode =
    slashOpen && slashAnchor ? (
      <SlashHints
        anchor={slashAnchor}
        groups={slashGroups}
        highlight={safeHighlight}
        onSelect={selectSlashItem}
        onClose={closeSlashHints}
      />
    ) : null;
  const snippetDropdownNode =
    snippetDropdownOpen && snippetAnchor ? (
      <SnippetDropdown
        anchor={snippetAnchor}
        onClose={closeSnippetDropdown}
        project={project}
        // busy 语义定则（docs08-r4 任务 11）：仅权限锁禁直发——流式态直发转排队
        busy={permissionLocked}
        sending={sending}
        // 手机档 inline 流内（docs08-r5 任务 9）：胶囊上方条区渲染，与斜杠提示同区；
        // 桌面锚定档不受影响（缺省 sheet 值只在窄视口生效）
        mobilePresentation={isCompact ? "inline" : "sheet"}
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
    ) : null;
  const snippetPanelNode = snippetOpen ? (
    <SnippetPanelDialog
      open
      onOpenChange={(open) => {
        if (!open) setSnippetOpen(false);
      }}
      project={project}
      // busy 语义定则（docs08-r4 任务 11）：仅权限锁禁直发——流式态直发转排队
      actionDisabled={snippetActionDisabled(permissionLocked, sending)}
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
  ) : null;

  // 排队模式切换钮（docs08-r4 任务 11）：流式态可见，点击在 followUp/steer 间切换，
  // 图标+title 明示两档语义（跟答=做完后继续 / 插入=下一回合边界并入当前工作）；
  // 尺寸/圆角随断点参数化（手机胶囊内 size-9 圆全、桌面工具行 size-11 圆角）
  const queueModeToggleNode = (buttonClass: string) =>
    queueAvailable ? (
      <button
        type="button"
        data-testid="queue-mode-btn"
        aria-label={queueMode === "followUp" ? t("composer.queueFollowUpAria") : t("composer.queueInsertAria")}
        title={
          queueMode === "followUp"
            ? t("composer.queueFollowUpTitle")
            : t("composer.queueInsertTitle")
        }
        onClick={toggleQueueMode}
        className={buttonClass}
      >
        {queueMode === "followUp" ? <SkipForward className="size-4" /> : <CornerDownRight className="size-4" />}
      </button>
    ) : null;
  // 停止钮（流式态保留，abort 语义不变：中断当前回合；排队项挂起待下次发送——spike (b)-6）。
  // docs08-r6 任务 6 ①：可见性从 queueAvailable 扩为保守并集 interruptible
  // （queueAvailable || runState running/waiting || hasPendingQuestion），手机/桌面双档
  // 经同一工厂都出——死局（runState 停 idle/waiting 且无流式态）也有中断逃逸口
  const stopButtonNode = (buttonClass: string) =>
    interruptible ? (
      <button
        type="button"
        data-testid="abort-btn"
        aria-label={t("composer.stopGeneration")}
        title={runState === "background_running" ? t("composer.backgroundTaskHint") : t("composer.stopTitle")}
        onClick={stopClick}
        className={buttonClass}
      >
        <Square className={runState === "background_running" && !queueAvailable ? "size-4 text-violet-500" : "size-4"} />
      </button>
    ) : null;
  const stopButtonSm = stopButtonNode(
    "flex size-9 shrink-0 items-center justify-center rounded-xl border border-border text-destructive transition-colors hover:bg-destructive/10",
  );
  const queueModeToggleSm = queueModeToggleNode(
    "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted",
  );
  const stopButtonMd = stopButtonNode(
    "flex size-11 shrink-0 items-center justify-center rounded-lg border border-border text-destructive transition-colors hover:bg-destructive/10",
  );
  const queueModeToggleMd = queueModeToggleNode(
    "flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted",
  );

  // ---------- 手机档（<sm）上下结构输入区（docs08-r4 任务 7；docs08-r5 任务 9；
  // ---------- docs08-r6 任务 13 重排：上行 textarea 整行宽（自适应增高），下行功能钮+发送） ----------
  // 参考在线 OpenChamber 390 实拍（.omo/evidence/docs08-r5/task-9-oc-390-*.png 与
  // docs08-r4-notes/openchamber-mobile-390-input.png）。任务 13 用户拍板：胶囊三圆钮
  // 同行挤占输入宽度的形态退役，改为上下两行——上行 textarea 占满整行（自增高不变，
  // 单行汉字容量提升）；下行常用语/收纳/排队切换 + 停止/发送。上方各条（历史/图片/
  // 附件/粘贴 chip）、聚焦收起、visualViewport 键盘、草稿、斜杠内联、图片附件条、
  // 粘贴转附件全链路不变；桌面档零改动。
  if (isCompact) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 pb-[max(env(safe-area-inset-bottom),8px)]">
        {historyBar}
        {imageStrip}
        {attachmentStrip}
        {fileAttachmentStrip}
        {waitingHintNode}
        {toolsOpen && (
          <div className="flex flex-wrap items-center gap-1" data-testid="composer-tools-row">
            {toolButtons}
            <div className="ml-auto flex items-center gap-1">
              <ThinkingChip />
            </div>
          </div>
        )}
        {/* 斜杠提示（任务 7）与常用语下拉（任务 9）均为 inline 档：输入区上方条区流内渲染 */}
        {slashHintsNode}
        {snippetDropdownNode}
        {/* 上行：textarea 整行宽（testid 沿用 composer-capsule，等待提示/中断口等既有断言不随重排漂移）；
            模型浮签保持右上角常驻（待生效徽标语义不变） */}
        <div
          data-testid="composer-capsule"
          className="relative"
        >
          <div className="absolute -top-2.5 right-2 z-10">
            <CapsuleModelTag pendingEffect={modelPendingEffect} />
          </div>
          <textarea
            ref={textareaRefCb}
            data-testid="composer-input"
            value={text}
            rows={1}
            placeholder={t("composer.placeholderTeachMobile")}
            disabled={sending}
            onChange={(e) => applyText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => setToolsOpen(false)}
            className="max-h-48 min-h-9 w-full resize-none overflow-y-auto rounded-xl border border-input bg-background px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/50 disabled:opacity-50"
          />
        </div>
        {/* 下行：常用语一步直达 + 低频工具收纳靠左；排队切换/停止/发送靠右 */}
        <div className="flex items-center gap-1">
          {snippetButtonSm}
          <button
            type="button"
            data-testid="composer-more-btn"
            aria-label={t("composer.moreAria")}
            title={t("composer.moreTitle")}
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen((v) => !v)}
            className={`flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted ${
              toolsOpen ? "bg-muted text-foreground" : "text-muted-foreground"
            }`}
          >
            <Plus className="size-5" />
          </button>
          <div className="ml-auto flex items-center gap-1">
            {queueModeToggleSm}
            {stopButtonSm}
            <button
              type="button"
              data-testid="send-btn"
              aria-label={queueAvailable ? t("composer.sendQueuedAria") : t("composer.sendAria")}
              title={queueAvailable ? t("composer.sendQueuedTitle") : t("composer.sendAria")}
              disabled={!canSend}
              onClick={() => void send()}
              className={`flex size-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                canSend ? "bg-accent text-accent-foreground hover:bg-muted" : "bg-muted text-muted-foreground"
              }${sendBusyCls}`}
            >
              <ArrowUp className="size-5" />
            </button>
          </div>
        </div>
        {fileInputNode}
        {errorLine}
        {filePickerNode}
        {/* snippetDropdownNode 已在上方条区渲染（docs08-r5 任务 9），不重复挂载 */}
        {snippetPanelNode}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 pb-[max(env(safe-area-inset-bottom),8px)]">
      {historyBar}
      {imageStrip}
      {attachmentStrip}
      {fileAttachmentStrip}
      {waitingHintNode}
      {/* todo 13：textarea 整行占满（自增高不变），工具按钮独立成行放下方 */}
      <textarea
        ref={textareaRefCb}
        data-testid="composer-input"
        value={text}
        rows={1}
        placeholder={t("composer.placeholderTeach")}
        disabled={sending}
        onChange={(e) => applyText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="max-h-48 min-h-11 w-full resize-none overflow-y-auto rounded-lg border border-input bg-transparent px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
      />
      {fileInputNode}
      <div className="flex items-center gap-1">
        <div className="flex shrink-0 items-center gap-1">
          {toolButtons}
          {/* 常用语钮仍居工具行末位（docs08-r5 任务 9：仅手机档迁出，桌面零改动） */}
          {snippetButtonMd}
        </div>
        {/* 模型 / 思考 chip（W2 todo 8）：第二模型选择面 + 思考档选择，右侧组随发送钮对齐。
            流式态（docs08-r4 任务 11）：停止钮与排队模式切换钮插队发送钮左侧，发送变排队语义 */}
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <ThinkingChip />
          <ModelChip />
          {stopButtonMd}
          {queueModeToggleMd}
          {/* 发送钮降视觉比重：outline 风格，仅 canSend 时 accent 填充 */}
          <button
            type="button"
            data-testid="send-btn"
            aria-label={queueAvailable ? t("composer.sendQueuedAria") : t("composer.sendAria")}
            title={queueAvailable ? t("composer.sendQueuedTitle") : t("composer.sendAria")}
            disabled={!canSend}
            onClick={() => void send()}
            className={`flex size-11 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:pointer-events-none disabled:opacity-50 ${
              canSend
                ? "border-border bg-accent text-accent-foreground hover:bg-muted dark:border-input"
                : "border-border bg-background text-muted-foreground hover:bg-muted dark:border-input dark:bg-input/30"
            }${sendBusyCls}`}
          >
            <ArrowUp className="size-5" />
          </button>
        </div>
      </div>
      {errorLine}
      {filePickerNode}
      {slashHintsNode}
      {snippetDropdownNode}
      {snippetPanelNode}
    </div>
  );
}
