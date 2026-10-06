// UI 全局域：连接状态、抽屉开关、当前项目、agent/模型选择、轻提示。
import { create } from "zustand";
import type { ModelInfo, ProjectMeta } from "@/lib/api";

export type ConnectionStatus = "online" | "reconnecting";

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

interface UiState {
  /** SSE 连接状态（todo 14 写入；初始 online） */
  connection: ConnectionStatus;
  /** ≤768px 侧栏抽屉开关 */
  drawerOpen: boolean;
  /** 当前项目（绝对路径）；初始加载落到 last_opened_at 最新者 */
  currentProject: string | null;
  projects: ProjectMeta[];
  /** GET /api/models 结果（占位展示用；真实切换 todo 22） */
  models: ModelInfo[];
  /** 引擎 agent 枚举无协议面（capabilities.agentsList=false）时为 true，UI 显示"无 agent 枚举"语义 */
  agentsDegraded: boolean;
  /** 当前选中模型 "provider/model"（初始取项目偏好或列表首个） */
  selectedModel: string | null;
  toast: Toast | null;

  setConnection(status: ConnectionStatus): void;
  setDrawerOpen(open: boolean): void;
  toggleDrawer(): void;
  setProjects(projects: ProjectMeta[]): void;
  setCurrentProject(path: string | null): void;
  setModels(models: ModelInfo[]): void;
  setAgentsDegraded(degraded: boolean): void;
  setSelectedModel(model: string | null): void;
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
  agentsDegraded: false,
  selectedModel: null,
  toast: null,

  setConnection: (status) => set({ connection: status }),
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (path) => set({ currentProject: path }),
  setModels: (models) => set({ models }),
  setAgentsDegraded: (degraded) => set({ agentsDegraded: degraded }),
  setSelectedModel: (model) => set({ selectedModel: model }),
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
