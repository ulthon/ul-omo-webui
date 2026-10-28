// 工具域词条（zh-CN，r10 todo 17）：设置页「工具启停」分区。
// 工具启停是引擎 spawn 参数级配置（--tools/--exclude-tools/--no-tools），变更后需
// 重启项目引擎生效；全部关闭 = 显式空集降级（引擎零工具），UI 出明确降级提示。
export const tools = {
  heading: "工具启停",
  note: "逐工具关闭后，项目引擎不再调用该工具。启停是引擎启动参数级配置：保存后需重启项目引擎才生效。",
  noProject: "未选择项目",
  loadFailed: "工具目录加载失败",
  save: "保存",
  saving: "保存中…",
  saved: "工具启停已保存",
  saveFailed: "工具启停保存失败",
  restartPromptTitle: "重启项目引擎以生效",
  restartPromptDesc: "工具启停已写入项目配置，需重启当前项目的引擎进程后生效。现在重启吗？",
  restartNow: "立即重启",
  restartLater: "稍后手动重启",
  restartFailed: "重启失败",
  restarted: "项目引擎已重启",
  degraded: "已关闭全部工具：项目引擎将以零工具模式运行（--no-tools），仅对话不可执行操作。",
  disabledCount: "已关闭 {n} 个",
} as const;
