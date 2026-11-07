// UI 全局域：连接状态、抽屉开关、当前项目、模型选择、轻提示。
import { create } from "zustand";
import type { ModelInfo, ProjectMeta } from "@/lib/api";
import type { ProjectSortMode } from "@/components/session-list/global-list-data";
import type { TagDisplayMode } from "@/components/session-list/tag-data";

export type ConnectionStatus = "online" | "reconnecting";

/** 设置页分组标识（settings-page-nav 任务 1） */
export type SettingsGroupId = "project" | "model" | "appearance" | "integration" | "system";

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

/** 通知历史记录（2026-11-05 #10）：toast 弹出同时入环形缓冲，设置页「通知记录」可回看。
 * 内存态不落库（刷新即清）；info 与 error 都入（error 关闭后也可找回）。 */
export interface ToastNotification {
  id: number;
  kind: "info" | "error";
  text: string;
  ts: number;
}

/** 外链入口（todo 26）：服务端 kv 配置（键 external-git-url / external-files-url），
 * 未配置为 null 时对应入口隐藏——"未提交变更"页签是核心自有功能不受影响。 */
export interface ExternalLinks {
  gitUrl: string | null;
  filesUrl: string | null;
}

/** 思考块默认展开（docs08-r5 任务 13）：meta_kv 键，字符串 "true"/"false" 存储
 * （PUT /api/settings 只收字符串），缺省 false；bootstrap 读 GET /api/settings 填充，
 * 设置弹层"对话"分区改档即 PUT，跨设备一致不落 localStorage。 */
export const THINKING_EXPANDED_KV = "chat.thinkingDefaultExpanded";

/** 标签全局展示模式（todo 20 v2）：meta_kv 键，"text"|"grid" 字符串存储，缺省 text
 * （文字徽标，历史形态）；行级标签 display 覆盖之上才是全局档（rowTagDisplayMode）。 */
export const TAG_DISPLAY_MODE_KV = "tags.displayMode";

/** 站点名覆盖（2026-11-03 前端小修 A）：meta_kv 键，非空字符串覆盖服务端 env 注入默认
 * （UL_OMO_WEBUI_SITE_NAME 降为部署默认）；留空/缺省回退 env 注入值。 */
export const SITE_NAME_KV = "ui.siteName";

/** 总览笔记块显示条数（2026-11-07 平铺直编批）：meta_kv 键，整数 1..20，缺省 3；
 * 块内步进器就地调节，全局生效（换端不丢，服务端 kv 持久化）。 */
export const OVERVIEW_NOTES_COUNT_KV = "ui.overviewNotesCount";
export const DEFAULT_OVERVIEW_NOTES_COUNT = 3;
export const MAX_OVERVIEW_NOTES_COUNT = 20;
export function parseOverviewNotesCount(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_OVERVIEW_NOTES_COUNT ? n : DEFAULT_OVERVIEW_NOTES_COUNT;
}

/** 站点名消费取值：kv 优先（trim 后非空）> env 注入默认；两者皆无 → null（不渲染） */
export function resolveSiteName(kv: string | null | undefined, injected: string | null): string | null {
  const fromKv = kv?.trim();
  if (fromKv) return fromKv;
  return injected;
}

/** 粘贴图片发送方式（任务 20）：meta_kv 键，"auto"|"attach"|"inline" 字符串存储，缺省 auto。
 * auto = 现状行为（图片始终走内联 images 链路；引擎侧无模型能力分流面）；
 * attach = 图片粘贴改走二进制附件 chip 通道；inline = 强制内联。 */
export const PASTE_IMAGE_MODE_KV = "composer.pasteImageMode";

export type PasteImageMode = "auto" | "attach" | "inline";

/** 仅精确 "attach"/"inline" 视为对应档；键缺失/其他任何值回退 auto（缺省现状） */
export function parsePasteImageMode(raw: string | null | undefined): PasteImageMode {
  return raw === "attach" || raw === "inline" ? raw : "auto";
}

/** 仅 "grid" 视为色格；键缺失/其他任何值回退 text（缺省文字，与历史行为一致） */
export function parseTagDisplayMode(raw: string | null | undefined): TagDisplayMode {
  return raw === "grid" ? "grid" : "text";
}

/** 仅精确 "true" 视为开启；键缺失/空串/其他任何值回退 false（缺省折叠，与历史行为一致） */
export function parseThinkingExpanded(raw: string | null | undefined): boolean {
  return raw === "true";
}

/** 用法提示显示开关（docs08 2026-10-22 批次任务 25）：meta_kv 键，字符串 "false"=关；
 * 键缺失/其他任何值一律视为开（缺省开，计划口径）。bootstrap 读 GET /api/settings 填充，
 * 设置弹层「提示」分区改档即 PUT，跨设备一致不落 localStorage。 */
export const TIPS_ENABLED_KV = "tips.enabled";

/** 仅精确 "false" 视为关闭；键缺失/空串/其他任何值回退 true（缺省开） */
export function parseTipsEnabled(raw: string | null | undefined): boolean {
  return raw !== "false";
}

interface UiState {
  /** SSE 连接状态（todo 14 写入；初始 online） */
  connection: ConnectionStatus;
  /** ≤768px 侧栏抽屉开关 */
  drawerOpen: boolean;
  /** 当前项目（绝对路径）；初始加载落到 last_opened_at 最新者 */
  currentProject: string | null;
  projects: ProjectMeta[];
  /** GET /api/models 结果（顶栏模型下拉数据源；todo 22） */
  models: ModelInfo[];
  /** 列表是否已完成过一次加载（空列表也是有效的"确认为空"结果；初始/加载失败为 false）。
   * 发送防呆只在 true 且列表为空时拦截——加载失败是"未知"而非"确认为空"，不误伤发送。 */
  modelsLoaded: boolean;
  /** CLI 收藏（GET /api/models favorites，"provider/model" 归一）；
   * 模型弹层顶部收藏组数据源（webui 侧收藏管理暂缺，只读展示 CLI 侧收藏）。 */
  favoriteModels: string[];
  /** 专属提示词映射（GET /api/models promptPresets，"provider/model" → preset 名）：
   * 输入框模型区专属提示词徽标数据源；旧服务端未下发时为空对象（无徽标）。 */
  promptPresets: Record<string, string | null>;
  /** 当前选中模型 "provider/model"（项目切换时应用该项目 preferred_model 偏好） */
  selectedModel: string | null;
  /** 当前选中思考档（W2 todo 8）：项目切换时应用该项目 preferredThinkingLevel 偏好；
   * 引擎 thinking_level_changed 同会话回显同步（显示层，不落偏好）。null = 未选
   * （chip 显示"默认"，prompt 不注入 thinkingLevel）。 */
  selectedThinkingLevel: string | null;
  /** 输入区模型选择弹层开关（W2 todo 8）：chip 点击与 shell 的 Ctrl+L 快捷键共用——
   * 键盘监听在 shell、弹层在 composer，跨组件状态落 store。 */
  modelPickerOpen: boolean;
  /** 快捷键帮助对话框开关（docs08-r7 任务 12）：顶栏帮助钮与 shell 的 ?/Ctrl+K
   * 触发共用，键盘监听在 shell、对话框挂 topbar，跨组件状态落 store（同上款）。 */
  shortcutsHelpOpen: boolean;
  /** 设置全屏页开关（r9 2026-10-26 批次任务 9）：顶栏设置钮与设置页返回钮共用，
   * 跨组件状态落 store（同 shortcutsHelpOpen 款）；全屏页由 shell 条件渲染。 */
  settingsPageOpen: boolean;
  /** 设置页当前分组（settings-page-nav 任务 1）：分组导航选中态，
   * 跨组件状态落 store（同 settingsPageOpen 款）；不持久化，打开页缺省 project。 */
  settingsGroup: SettingsGroupId;
  /** 外链入口配置（bootstrap 读 GET /api/settings 填充；设置弹层 PUT 更新） */
  externalLinks: ExternalLinks;
  /** 侧栏项目排序档位（C16 todo 9）：meta_kv sidebar.projectSort 持久（缺省 activity），
   * bootstrap 读 GET /api/settings 填充，设置弹层改档即 PUT；不落 localStorage（跨设备一致）。 */
  projectSort: ProjectSortMode;
  /** 手动顺序（C16 todo 9）：meta_kv sidebar.projectOrder 的 JSON 路径数组解析结果；
   * 拖拽/上移下移后本地先行更新再异步落 kv。 */
  projectOrder: string[];
  /** 思考块默认展开（docs08-r5 任务 13）：meta_kv chat.thinkingDefaultExpanded 持久
   * （缺省 false）；ThinkingBlock 挂载时读快照，改设置不影响已挂载块（瞬态语义）。 */
  thinkingDefaultExpanded: boolean;
  /** 标签全局展示模式（todo 20 v2）：meta_kv tags.displayMode 持久（缺省 text）；
   * 行级渲染面（侧栏行/切换 sheet）消费，筛选/选择/管理面永远文字+色点不读此档。 */
  tagDisplayMode: TagDisplayMode;
  /** 用法提示显示开关（docs08 2026-10-22 批次任务 25）：meta_kv tips.enabled 持久
   * （缺省开）；空态提示卡与设置「提示」分区共同消费。 */
  tipsEnabled: boolean;
  /** 粘贴图片发送方式：meta_kv composer.pasteImageMode 持久（缺省 auto=现状）；
   * composer onPaste 路由与图片 chip 徽标共同消费。 */
  pasteImageMode: PasteImageMode;
  /** 站点名覆盖（kv ui.siteName，缺省 null=回退 env 注入默认）；
   * 顶栏小字/标签页标题与设置页共同消费（resolveSiteName 取值）。 */
  siteName: string | null;
  /** 总览笔记块显示条数（kv ui.overviewNotesCount，缺省 3，上限 20）：平铺直编批 */
  overviewNotesCount: number;
  /** 斜杠命令集版本号（批次三）：commands_changed 帧到达即 +1，composer 下拉
   *  开着时据此重拉 getCommands（服务端缓存已被同事件失效，立取新值） */
  slashCommandsVersion: number;
  toasts: Toast[];
  notifications: ToastNotification[];

  setConnection(status: ConnectionStatus): void;
  setDrawerOpen(open: boolean): void;
  toggleDrawer(): void;
  setProjects(projects: ProjectMeta[]): void;
  setCurrentProject(path: string | null): void;
  setModels(models: ModelInfo[], promptPresets?: Record<string, string | null>): void;
  setFavoriteModels(models: string[]): void;
  /** 列表进入加载中/加载失败的中性态：清空且不标记"确认为空"（发送防呆 fail-open） */
  resetModels(): void;
  setSelectedModel(model: string | null): void;
  setSelectedThinkingLevel(level: string | null): void;
  setModelPickerOpen(open: boolean): void;
  setShortcutsHelpOpen(open: boolean): void;
  setSettingsPageOpen(open: boolean): void;
  setSettingsGroup(group: SettingsGroupId): void;
  /** 文件管理全屏页开关（builtin-file-management 任务 1）：同 settingsPageOpen 款，
   *  顶栏入口钮与页面返回钮共用，跨组件状态落 store；全屏页由 shell 条件渲染。 */
  filesPageOpen: boolean;
  setFilesPageOpen(open: boolean): void;
  setExternalLinks(links: ExternalLinks): void;
  setProjectSort(sort: ProjectSortMode): void;
  setProjectOrder(order: string[]): void;
  setThinkingDefaultExpanded(expanded: boolean): void;
  setTagDisplayMode(mode: TagDisplayMode): void;
  setTipsEnabled(enabled: boolean): void;
  setPasteImageMode(mode: PasteImageMode): void;
  setSiteName(name: string | null): void;
  setOverviewNotesCount(n: number): void;
  bumpSlashCommandsVersion(): void;
  showToast(text: string, kind?: "info" | "error"): void;
  dismissToast(id: number): void;
  clearNotifications(): void;
}

// 轻提示栈（docs08 2026-10-25 用户反馈）：底部同列堆叠至多 MAX_TOASTS 条，各自独立关闭，
// 文字可选中可复制（点文字本体不触发任何动作）。info 各自计时自动消失（timer 按 id 归档）；
// error 常驻直到显式关闭（遗漏错误比多看一眼代价高）。超限丢最旧并 console.warn 留痕。
const MAX_TOASTS = 3;
// 2026-11-05 #10：3.2s→8s——黑框提示经常没来得及看就消失；历史记录同步兑底（丢失可回看）
const INFO_TOAST_MS = 8000;
// 环形缓冲：超出丢最旧（与 toast 栈的丢最旧同语义，但历史层无需 console.warn——本身就可回看容量边界）
const MAX_NOTIFICATIONS = 200;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
let toastSeq = 0;

function clearToastTimer(id: number): void {
  const timer = toastTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    toastTimers.delete(id);
  }
}

export const useUiStore = create<UiState>()((set) => ({
  connection: "online",
  drawerOpen: false,
  currentProject: null,
  projects: [],
  models: [],
  modelsLoaded: false,
  promptPresets: {},
  favoriteModels: [],
  selectedModel: null,
  selectedThinkingLevel: null,
  modelPickerOpen: false,
  shortcutsHelpOpen: false,
  settingsPageOpen: false,
  settingsGroup: "project",
  filesPageOpen: false,
  externalLinks: { gitUrl: null, filesUrl: null },
  projectSort: "activity",
  projectOrder: [],
  thinkingDefaultExpanded: false,
  tagDisplayMode: "text",
  tipsEnabled: true,
  pasteImageMode: "auto",
  siteName: null,
  overviewNotesCount: DEFAULT_OVERVIEW_NOTES_COUNT,
  slashCommandsVersion: 0,
  toasts: [],
  notifications: [],

  setConnection: (status) => set({ connection: status }),
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (path) => set({ currentProject: path }),
  setModels: (models, promptPresets = {}) => set({ models, modelsLoaded: true, promptPresets }),
  setFavoriteModels: (favoriteModels) => set({ favoriteModels }),
  resetModels: () => set({ models: [], modelsLoaded: false, favoriteModels: [], promptPresets: {} }),
  setSelectedModel: (model) => set({ selectedModel: model }),
  setSelectedThinkingLevel: (level) => set({ selectedThinkingLevel: level }),
  setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
  setShortcutsHelpOpen: (open) => set({ shortcutsHelpOpen: open }),
  setSettingsPageOpen: (open) => set({ settingsPageOpen: open }),
  setSettingsGroup: (group) => set({ settingsGroup: group }),
  setFilesPageOpen: (open) => set({ filesPageOpen: open }),
  setExternalLinks: (links) => set({ externalLinks: links }),
  setProjectSort: (sort) => set({ projectSort: sort }),
  setProjectOrder: (order) => set({ projectOrder: order }),
  setThinkingDefaultExpanded: (thinkingDefaultExpanded) => set({ thinkingDefaultExpanded }),
  setTagDisplayMode: (tagDisplayMode) => set({ tagDisplayMode }),
  setTipsEnabled: (tipsEnabled) => set({ tipsEnabled }),
  setPasteImageMode: (pasteImageMode) => set({ pasteImageMode }),
  setSiteName: (siteName) => set({ siteName }),
  setOverviewNotesCount: (overviewNotesCount) => set({ overviewNotesCount }),
  bumpSlashCommandsVersion: () => set((s) => ({ slashCommandsVersion: s.slashCommandsVersion + 1 })),
  showToast: (text, kind = "info") => {
    const id = ++toastSeq;
    set((s) => {
      let rest = s.toasts;
      if (rest.length >= MAX_TOASTS) {
        // 丢最旧：同步清它的自动消失 timer，丢的内容 console.warn 留痕（控制台仍可查）
        for (const old of rest.slice(0, rest.length - MAX_TOASTS + 1)) {
          clearToastTimer(old.id);
          console.warn(`[toast] cap ${MAX_TOASTS} exceeded, dropped oldest:`, old.text);
        }
        rest = rest.slice(rest.length - MAX_TOASTS + 1);
      }
      return {
        toasts: [...rest, { id, kind, text }],
        notifications: [...s.notifications, { id, kind, text, ts: Date.now() }].slice(-MAX_NOTIFICATIONS),
      };
    });
    // 仅 info 自动消失；error 常驻展示直到用户点关闭钮（遗漏错误比多看一眼代价高）
    if (kind === "info") {
      toastTimers.set(
        id,
        setTimeout(() => {
          toastTimers.delete(id);
          set((s) => ({ toasts: s.toasts.filter((it) => it.id !== id) }));
        }, INFO_TOAST_MS),
      );
    }
  },
  dismissToast: (id) => {
    clearToastTimer(id);
    set((s) => ({ toasts: s.toasts.filter((it) => it.id !== id) }));
  },
  clearNotifications: () => set({ notifications: [] }),
}));
