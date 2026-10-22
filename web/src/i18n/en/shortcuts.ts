// Shortcuts-help strings (en): keys/title/group names mirror zh key set exactly
// (satisfies parity). Trigger key names are never localized; display strings live
// in lib/shortcuts.ts registry as the single source.
export const shortcuts = {
  title: "Keyboard shortcuts",
  description: "All keyboard shortcuts in this version, grouped below.",
  group: {
    global: "Global",
    composer: "Composer",
    history: "Input history",
    slash: "Slash commands",
    overlay: "Panels & overlays",
  },
  desc: {
    modelPicker: "Open model picker",
    shortcutsHelp: "Open this help",
    send: "Send message",
    newline: "Insert line break",
    fileRef: "Insert file reference at cursor",
    historyOlder: "Recall older input history",
    historyNewer: "Return to newer input history",
    historyExit: "Exit history browsing (keep current text)",
    slashOpen: "Open slash command menu",
    slashNav: "Move highlight across commands",
    slashSelect: "Select highlighted command",
    slashClose: "Close menu and revert input",
    overlayClose: "Close dropdown/panel/dialog/lightbox/drawer",
  },
} as const;
