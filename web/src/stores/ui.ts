// UI 全局域：连接状态、抽屉开关、当前项目、模型选择、轻提示。
import { create } from "zustand";
import type { ModelInfo, ProjectMeta } from "@/lib/api";
import type { ProjectSortMode } from "@/components/session-list/global-list-data";

export type ConnectionStatus = "online" | "reconnecting";

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

/** 外链入口（todo 26）：服务端 kv 配置（键 external-git-url / external-files-url），
 * 未配置为 null 时对应入口隐藏——"未提交变更"页签是核心自有功能不受影响。 */
export interface ExternalLinks {
  gitUrl: string | null;
  filesUrl: string | null;
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
  /** 当前选中模型 "provider/model"（项目切换时应用该项目 preferred_model 偏好） */
  selectedModel: string | null;
  /** 当前选中思考档（W2 todo 8）：项目切换时应用该项目 preferredThinkingLevel 偏好；
   * 引擎 thinking_level_changed 同会话回显同步（显示层，不落偏好）。null = 未选
   * （chip 显示"默认"，prompt 不注入 thinkingLevel）。 */
  selectedThinkingLevel: string | null;
  /** 输入区模型选择弹层开关（W2 todo 8）：chip 点击与 shell 的 Ctrl+P 快捷键共用——
   * 键盘监听在 shell、弹层在 composer，跨组件状态落 store。 */
  modelPickerOpen: boolean;
  /** 外链入口配置（bootstrap 读 GET /api/settings 填充；设置弹层 PUT 更新） */
  externalLinks: ExternalLinks;
  /** 侧栏项目排序档位（C16 todo 9）：meta_kv sidebar.projectSort 持久（缺省 activity），
   * bootstrap 读 GET /api/settings 填充，设置弹层改档即 PUT；不落 localStorage（跨设备一致）。 */
  projectSort: ProjectSortMode;
  /** 手动顺序（C16 todo 9）：meta_kv sidebar.projectOrder 的 JSON 路径数组解析结果；
   * 拖拽/上移下移后本地先行更新再异步落 kv。 */
  projectOrder: string[];
  toast: Toast | null;

  setConnection(status: ConnectionStatus): void;
  setDrawerOpen(open: boolean): void;
  toggleDrawer(): void;
  setProjects(projects: ProjectMeta[]): void;
  setCurrentProject(path: string | null): void;
  setModels(models: ModelInfo[]): void;
  /** 列表进入加载中/加载失败的中性态：清空且不标记"确认为空"（发送防呆 fail-open） */
  resetModels(): void;
  setSelectedModel(model: string | null): void;
  setSelectedThinkingLevel(level: string | null): void;
  setModelPickerOpen(open: boolean): void;
  setExternalLinks(links: ExternalLinks): void;
  setProjectSort(sort: ProjectSortMode): void;
  setProjectOrder(order: string[]): void;
  showToast(text: string, kind?: "info" | "error"): void;
  clearToast(): void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

export const useUiStore = create<UiState>()((set) => ({
  connection: "online",
  drawerOpen: false,
  currentProject: null,
  projects: [],
  models: [],
  modelsLoaded: false,
  selectedModel: null,
  selectedThinkingLevel: null,
  modelPickerOpen: false,
  externalLinks: { gitUrl: null, filesUrl: null },
  projectSort: "activity",
  projectOrder: [],
  toast: null,

  setConnection: (status) => set({ connection: status }),
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (path) => set({ currentProject: path }),
  setModels: (models) => set({ models, modelsLoaded: true }),
  resetModels: () => set({ models: [], modelsLoaded: false }),
  setSelectedModel: (model) => set({ selectedModel: model }),
  setSelectedThinkingLevel: (level) => set({ selectedThinkingLevel: level }),
  setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
  setExternalLinks: (links) => set({ externalLinks: links }),
  setProjectSort: (sort) => set({ projectSort: sort }),
  setProjectOrder: (order) => set({ projectOrder: order }),
  showToast: (text, kind = "info") => {
    if (toastTimer) clearTimeout(toastTimer);
    const id = ++toastSeq;
    set({ toast: { id, kind, text } });
    toastTimer = setTimeout(() => {
      set((s) => (s.toast?.id === id ? { toast: null } : s));
    }, 3200);
  },
  clearToast: () => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: null });
  },
}));
