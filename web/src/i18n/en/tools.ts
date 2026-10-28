// Tools domain strings (en, r10 todo 17): settings "Tool enable/disable" section.
// Key set locked to zh/tools.ts via the aggregator satisfies clause.
export const tools = {
  heading: "Tool enable/disable",
  note: "A disabled tool will never be called by the project engine. Tool toggles are engine spawn-level configuration: restart the project engine after saving to take effect.",
  noProject: "No project selected",
  loadFailed: "Failed to load tool catalog",
  save: "Save",
  saving: "Saving…",
  saved: "Tool toggles saved",
  saveFailed: "Failed to save tool toggles",
  restartPromptTitle: "Restart project engine to apply",
  restartPromptDesc: "Tool toggles have been written to the project config. Restart the current project's engine process to apply. Restart now?",
  restartNow: "Restart now",
  restartLater: "Restart later manually",
  restartFailed: "Restart failed",
  restarted: "Project engine restarted",
  degraded: "All tools are disabled: the project engine will run with zero tools (--no-tools), chat only, no actions.",
  disabledCount: "{n} disabled",
} as const;
