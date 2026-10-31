// 诊断中心（2026-10-31 日志采集增强批）：级别切换/日志查看/一键导出诊断包。
export const diagnostics = {
  title: "诊断",
  desc: "运行日志与性能观测。出问题时点「导出诊断包」，把文件发给开发者即可离线分析前后端全链路。",
  level: "日志级别",
  levelHint: "切换立即生效无需重启；debug 最详细（逐请求/逐帧），info 为默认平衡档。",
  sourceFrontend: "前端日志",
  sourceServer: "服务端日志",
  refresh: "刷新",
  autoRefresh: "自动刷新",
  export: "导出诊断包",
  exporting: "导出中…",
  exportDone: "诊断包已下载",
  exportFailed: "导出失败",
  serverUnavailable: "服务端日志不可达（诊断包仅含前端部分）",
  empty: "暂无日志（级别过高或刚打开页面）",
};
