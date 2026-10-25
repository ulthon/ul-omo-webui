// 公共词条（en）：原 en.ts common 域原样迁移。
export const common = {
  cancel: "Cancel",
  close: "Close",
  copy: "Copy",
  save: "Save",
  delete: "Delete",
  loadFailed: "Failed to load",
  loading: "Loading",
  relJustNow: "just now",
  relMinutes: "{n} minutes ago",
  relHours: "{n} hours ago",
  relDays: "{n} days ago",
  itemCount: { one: "{n} item", other: "{n} items" },
  // lib-layer strings (task 10): user-visible copy produced by non-component modules
  lib: {
    unauthorized: "Not signed in or session expired",
    noModelsSend: "No available models; cannot send (check the engine model configuration)",
    sessionListLoadFailed: "Failed to load session list",
    updateLastOpenedFailed: "Failed to update last-opened time",
    saveModelPrefFailed: "Failed to save model preference",
    saveThinkingPrefFailed: "Failed to save thinking level preference",
    modelChangeRejected: "Model switch to {model} was rejected by the engine ({detail}); current model unchanged",
  },
} as const;
