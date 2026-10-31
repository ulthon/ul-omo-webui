// Diagnostics center (2026-10-31 logging batch): level switch / log viewer / one-click bundle export.
export const diagnostics = {
  title: "Diagnostics",
  desc: "Runtime logs and performance traces. When something breaks, click Export and send the file to the developer for offline full-chain analysis.",
  level: "Log level",
  levelHint: "Takes effect immediately, no restart; debug is the most verbose (per request / per frame), info is the default.",
  sourceFrontend: "Frontend logs",
  sourceServer: "Server logs",
  refresh: "Refresh",
  autoRefresh: "Auto refresh",
  export: "Export bundle",
  exporting: "Exporting…",
  exportDone: "Bundle downloaded",
  exportFailed: "Export failed",
  serverUnavailable: "Server logs unreachable (bundle contains frontend only)",
  empty: "No entries yet (level too high or page just opened)",
};
