// chat 域词条（en）：键集与 zh/chat.ts 完全一致（聚合处 satisfies 锁定），英文为自然翻译。
// 计数词条按英文复数规则用 one/other；插值占位符与 zh 同名。
export const chat = {
  // tool-card.tsx
  toolcard: {
    statusRunning: "Running",
    statusFailed: "Failed",
    statusDone: "Done",
    code: "Code",
    args: "Args",
    result: "Result",
    resultViewToggle: "Result view toggle",
    textView: "Text",
    loadingDiff: "Loading diff view…",
    collapse: "Collapse result",
    expand: "Expand all",
    waiting: "Waiting for tool result…",
    noResult: "(no result text)",
    noTextResult: "(no text result)",
  },
  // status-bar.tsx
  statusBar: {
    running: "Running",
    idle: "Idle",
    detail: "↑{input} ↓{output} cache {cache}",
    context: " · context {n}%",
    usageFailed: "Usage unavailable",
    usageLoading: "Computing usage…",
  },
  // message-bubble.tsx
  messageBubble: {
    queued: "Queued",
    live: "Responding",
    assistant: "Assistant",
    interrupted: "Interrupted",
  },
  // queue-bar.tsx
  queue: {
    cancelFailed: "Failed to cancel the queued item",
    pendingCount: { one: "1 pending", other: "{n} pending" },
    suspendedHint: "Turn has ended; these will run on the next send",
    clear: "Clear",
    steerTitle: "Steer: joins the current work at the next turn boundary",
    followTitle: "Follow-up: runs after the current turn finishes",
    steer: "Steer",
    follow: "Follow-up",
    removeItem: "Remove this item",
  },
  // todo-list.tsx / todo-panel.tsx
  todo: {
    inProgress: "In progress",
    abandoned: "Abandoned",
    groupLabel: "Task group: {name}",
    progress: "{done}/{total} completed",
    statusRunning: "Running",
    statusFailed: "Failed",
    statusDone: "Done",
    panelTitle: "Todos",
    collapse: "Collapse todo panel",
    noSession: "No session selected",
    empty: "No todos in this session yet",
  },
  // stat-panel.tsx
  statPanel: {
    noSession: "No session selected",
    unavailable: "Usage unavailable",
    unavailableHint: "The stats service is temporarily unreachable; it should recover automatically",
    tokensTitle: "Total tokens",
    input: "Input",
    output: "Output",
    total: "Total",
    loading: "Computing usage…",
    cacheTitle: "Cache hits",
    cacheRead: "Cache read",
    cacheWrite: "Cache write",
    contextTitle: "Context level",
    contextUsage: "Used",
    noContext: "No context data yet",
    costTitle: "Cost",
    costTotal: "Total cost",
    speedTitle: "Turn speed",
    avgTurns: { one: "avg (1 turn)", other: "avg ({n} turns)" },
    noData: "No data yet (appears after a turn ends)",
  },
  // memory-panel.tsx
  memoryPanel: {
    libraryPath: "Library path: {path}",
    todayTitle: "Memory runs committed today",
    today: { one: "1 today", other: "{n} today" },
    totalTitle: "Total facts entries",
    total: { one: "1 entry", other: "{n} entries" },
    filesTitle: "facts + system file count",
    files: { one: "1 file", other: "{n} files" },
    lastEntry: "Last entry {time}",
    systemTitle: "repo/system/*.md bytes on disk",
    systemSize: "system files {size}",
    fileEmpty: "(no entries in this file)",
    docEmpty: "(empty file)",
    noSession: "No session selected",
    noSessionHint: "Select a session or project to browse its memory library",
    unavailable: "Memory unavailable",
    retry: "Retry",
    loading: "Loading memory…",
    noLibraryTitle: "No memory library for this project yet",
    noLibraryHint:
      "Memory is stored per project directory and shared with the CLI in the same directory; a library is created automatically once sessions there produce memories.",
    noEntriesTitle: "No memory entries in this directory yet",
    noEntriesHint: "Memory is stored per project directory and shared with the CLI in the same directory.",
    browsing: "Browsing: {project}",
    refresh: "Refresh memory",
  },
  // question-card.tsx
  questionCard: {
    submitFailed: "Failed to respond, please retry",
    needAnswer: "Answer at least one question or add a comment",
    title: "Assistant question",
    position: "#{position} of {total} pending",
    waiting: "Waiting for your answer",
    later: "Can answer later",
    expired: "Timed out",
    customPlaceholder: "Or type a custom answer (optional)",
    commentPlaceholder: "Anything else to add? (optional, sent to the assistant)",
    pendingHint: "Not answering will block the current turn (auto-continues after timeout)",
    continuedHint: "The turn has already continued; your answer will arrive as a new message",
    ignore: "Dismiss",
    submit: "Submit answer",
  },
  // permission-card.tsx
  permissionCard: {
    kindSelect: "Permission request",
    kindConfirm: "Confirm action",
    kindInput: "Input required",
    kindEditor: "Edit required",
    deniedToast: "Denied; provide feedback below",
    submitFailed: "Failed to respond, please retry",
    cancelFailed: "Failed to cancel, please retry",
    position: "#{position} of {total} pending",
    alwaysAllow: "Always allow {tool} (frontend auto-approves for this session)",
    confirm: "Confirm",
    cancel: "Cancel",
    submit: "Submit",
    submitAll: "Submit full text",
    blockHint: "Not responding will block the current turn",
    dismiss: "Dismiss and cancel",
  },
  // chat-view.tsx
  chatView: {
    emptyHint: "Select a session on the left, or start a new conversation",
    loading: "Loading messages…",
    loadFailed: "Failed to load messages; check that the service is available",
    retry: "Retry",
  },
  // command-bar.tsx
  commandBar: {
    sendFailed: "Failed to send command",
    sendTitle: "Send {label}",
    unsupportedTitle: "Not supported by engine: {note}",
  },
  // image-lightbox.tsx
  lightbox: {
    close: "Close preview",
    imageAlt: "Message image",
    viewLarge: "View full size",
    refUnavailable: "Tool-produced images cannot be viewed yet",
  },
  // message-actions.tsx
  messageActions: {
    copied: "Original text copied",
    copyFailed: "Copy failed (clipboard permission not granted)",
    retryBranchCreated: "Retry branch created; regenerating…",
    retryFailed: "Retry failed",
    menuLabel: "Message actions",
    copy: "Copy original text",
    retry: "Retry (regenerate from this message)",
  },
  // message-list.tsx
  messageList: {
    empty: "No messages yet; send the first message to start the conversation",
    syncing: "Syncing history…",
    jumpToBottom: "Back to bottom",
  },
  // nav-rail.tsx
  navRail: {
    jumpTo: "Jump to: {title}",
  },
  // permission-queue.tsx
  permissionQueue: {
    autoAllowed: "Auto-allowed {tool} (always allow)",
  },
  // thinking-block.tsx
  thinkingBlock: {
    live: "Thinking",
    title: "Thinking process",
    chars: " … {n} chars",
    ellipsis: "…",
    empty: "(no content)",
  },
  // commands.ts (task 10): note read lazily via getter; long copy transplanted verbatim
  commands: {
    compactNote: "Compact context: verified working over the engine protocol surface (spike calls session.compact directly); the webui endpoint is called directly",
    clearNote: "Clear context: not registered by the engine; sending it directly would be treated by the model as a plain message",
    newNote: "New session: not registered by the engine; use \"New session\" in the sidebar",
    undoNote: "Undo last message: not registered by the engine; sending it directly would be treated by the model as a plain message",
    gateMessage: "Engine does not support command {label}: {note} (see docs/verification/05 for the verification record)",
  },
  // memory-entries.ts marker summaries (task 10): summary is {key, vars} plain data
  memoryMarkers: {
    bound: "Memory library bound",
    boundWith: "Memory library bound {identity}",
    acceptedTurns: "Counted into memory this turn",
    projectionPin: "Memory projection pinned",
    kibitzerNudged: "kibitzer nudge received",
    memorianNudged: "memorian nudge received",
    memoryNotice: "Memory notice",
  },
} as const;
