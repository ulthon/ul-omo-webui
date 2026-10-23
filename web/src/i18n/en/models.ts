// models domain strings (en): settings "discover models" section (docs08 2026-10-22 batch task 23).
export const models = {
  discoverHeading: "Discover models",
  discoverNote: "Discover models from an OpenAI-compatible provider's /models endpoint; review the preview before importing. Re-running never duplicates.",
  providerLabel: "Provider",
  providerEmpty: "No provider in models.json yet (configure a baseUrl in the agent directory first)",
  noBaseUrl: "No baseUrl (cannot discover)",
  run: "Discover models",
  running: "Discovering…",
  discovered: "Discovered {n} models",
  unchangedNote: "{n} already configured (kept as-is)",
  importSelected: "Import selected",
  importing: "Importing…",
  importDone: "Imported {n} new models",
  nothingNew: "No new models to import",
  loadFailed: "Failed to load provider list",
};
