// models 域词条（zh-CN）：设置面板「发现模型」分区（docs08-2026-10-22 批次任务 23）。
export const models = {
  discoverHeading: "发现模型",
  discoverNote: "从 OpenAI 兼容 provider 的 /models 接口发现模型；预览确认后再导入，重复发现不会重复导入。",
  providerLabel: "Provider",
  providerEmpty: "models.json 中尚无 provider（先在 agent 目录配置 baseUrl）",
  noBaseUrl: "缺 baseUrl（不可发现）",
  run: "发现模型",
  running: "发现中…",
  discovered: "发现 {n} 个模型",
  unchangedNote: "已有 {n} 个保留既有配置",
  importSelected: "导入所选",
  importing: "导入中…",
  importDone: "已导入 {n} 个新模型",
  nothingNew: "没有新模型，无需导入",
  loadFailed: "provider 清单加载失败",
};
