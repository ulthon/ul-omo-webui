// chat 域词条（en）：键集与 zh/chat.ts 完全一致（聚合处 satisfies 锁定），英文为自然翻译。
// 计数词条按英文复数规则用 one/other；插值占位符与 zh 同名。
export const chat = {
  // Collapsed step-row duration label (task 7): thinking-block/tool-card headers
  duration: "{dur}",
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
    context: " · context {n}% · {used}/{limit}",
    usageFailed: "Usage unavailable",
    usageLoading: "Computing usage…",
  },
  // message-bubble.tsx
  messageBubble: {
    queued: "Queued",
    live: "Responding",
    assistant: "Assistant",
    interrupted: "Interrupted",
    expand: "Expand",
    collapse: "Collapse",
    // Origin line (docs08 2026-10-22 batch task 17): agent name + elapsed next to
    // the model short name; omitted entirely when data is missing
    originAgent: "agent {name}",
    originDuration: "{dur}",
    // Variant ambiguity note (docs08 2026-10-22 batch task 18): title hint when the
    // 5-level fallback lands on the raw upstream name shared by multiple variants
    modelAmbiguous: "Multiple model variants share this upstream name; showing the recorded raw name",
  },
  // parts.tsx unsupported placeholders (docs08-r6 task 10 ①②)
  parts: {
    unsupportedBlock: "Unsupported content block: {type}",
    unsupportedCount: { one: "1 unsupported content block", other: "{n} unsupported content blocks" },
  },
  // message-bubble.tsx custom_message placeholder (docs08-r6 task 10 ③)
  customMessage: {
    unsupported: "Unsupported content: {customType}",
  },
  // message-bubble.tsx loop-guard named rendering (docs08 2026-10-22 batch task 2):
  // collapsed row label (the ×N badge is appended conditionally, not part of the string);
  // fallback for entries with empty content when expanded
  loopGuard: {
    title: "Loop guard notice",
    emptyContent: "(no content)",
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
    sendNowItem: "Send this item now",
    sendNowTitle: "Send now: injects as steer into the current turn; other items stay queued",
    sendNowFailed: "Failed to send now",
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
    costToday: "Today's cost",
    cacheRate: "Hit rate",
    speedTitle: "Turn speed",
    lastTurn: "Last turn",
    avgTurns: { one: "avg (1 turn)", other: "avg ({n} turns)" },
    noData: "No data yet (appears after a turn ends)",
    timeTitle: "Time (estimated)",
    timeModel: "Model (est.)",
    timeTool: "Tools",
    subagentsTitle: "Subagent costs",
    subagentTotal: "Total",
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
  // subagent-panel.tsx (docs08-r6 task 17)
  subagentPanel: {
    noSession: "No session selected",
    emptyTitle: "No subagent calls in this session yet",
    emptyHint: "Subagents spawned via the task tool are aggregated here (live progress and final replies)",
    statusRunning: "Running",
    statusDispatched: "Dispatched · running in background",
    statusDone: "Completed",
    statusFailed: "Failed",
    responseTitle: "Final response",
    responseEmpty: "(no final response text)",
    promptTitle: "Prompt",
    metricRuntime: "time {dur}",
    metricTurns: "turns {n}",
    metricToolCalls: "tools {n}",
    metricTokens: "{n} tok",
    metricOutput: "out {n}",
    metricCache: "cache {pct}",
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
    stepPosition: "Question {step} of {count}",
    stepJump: "Go to question {step}",
    prevQuestion: "Previous",
    nextQuestion: "Next",
    submitPending: "Submitted, awaiting confirmation…",
    submitFallback: "No confirmation after submit; retry or cancel",
    retrySubmit: "Retry",
    cancelSubmit: "Cancel answer",
    // r11 todo 6: tabbed control model additions
    questionTab: "Question",
    commentTab: "Notes",
    remainingHint: "{n} question(s) unanswered",
    resolvedAnswered: "Question answered",
    resolvedTimedOut: "Question timed out",
    resolvedCancelled: "Question cancelled",
    resolvedGeneric: "Question resolved",
    hintPending: "Questions pending",
    hintCount: "{n} total",
    hintView: "View",
  },
  // permission-card.tsx
  permissionCard: {
    kindSelect: "Permission request",
    kindChoice: "Selection required",
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
  // image-lightbox.tsx
  lightbox: {
    close: "Close preview",
    imageAlt: "Message image",
    viewLarge: "View full size",
    refUnavailable: "Tool-produced images cannot be viewed yet",
    refExpired: "Image attachment expired or unavailable",
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
  // markdown.tsx 表格行操作（todo 8）
  tableActions: {
    copyTable: "Copy table",
    copied: "Table copied",
    downloadCsv: "Download CSV",
  },
  // message-list.tsx
  messageList: {
    empty: "No messages yet; send the first message to start the conversation",
    syncing: "Syncing history…",
    jumpToBottom: "Back to bottom",
  },
  // tip-card.tsx (docs08 2026-10-22 batch task 25: empty-state tip card)
  tipCard: {
    label: "Tip",
    next: "Show another",
    dismiss: "Dismiss",
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
  // compact-run.ts compact success toast (final-wave F2: locally assembled copy).
  // Task 18 (compaction progress feel): ongoing = banner (event-dispatch
  // compaction_start/progress); marker = in-stream summary block (message-items
  // compactionMarkerOf, {summary} = first line); autoStarted = auto-compaction
  // toast (start frame with reason != manual)
  compact: {
    done: "Context compacted: {before} → {after} tokens",
    doneBefore: "Context compacted ({before} tokens before)",
    ongoing: "Compacting context…",
    marker: "Context compacted: {summary}",
    autoStarted: "Context nearing its limit; auto-compaction in progress…",
  },
  // Session-level event lines (r10 todo 7): in-stream system lines
  // (translated in event-dispatch, held in messages store sessionEvents);
  // {text} in queued is a first-line truncated snippet (dismissed on delivery);
  // compactionDone line removed 2026-10-31 (marker block carries the fact)
  sessionEvents: {
    queued: "Queued: {text}",
    modelSwitch: "Model switched to {model}",
  },
  // Background activity bar (r10 todo 11): driven by omo.task.updated snapshots, renders only when non-empty
  activity: {
    barTitle: "Background tasks · {n} running",
    statusRunning: "Running",
    statusDone: "Done",
    doneCount: "{n} done",
  },
  // commands.ts (task 10): note read lazily via getter; long copy transplanted verbatim
  commands: {
    compactNote: "Compact context: direct call over the engine protocol (same entry point as the CLI)",
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
    acceptedTurnsCount: "Counted into memory this turn ×{count}",
    projectionPin: "Memory projection pinned",
    kibitzerNudged: "kibitzer nudge received",
    memorianNudged: "memorian nudge received",
    memoryNotice: "Memory notice",
    recall: "Recalled memory {source}",
    recallPlain: "Recalled memory",
  },
  /** Memory parked warning card (docs08 2026-10-25 user feedback, CLI-parity inline) */
  notice: {
    memoryReflectionPausedTitle: "Memory auto-reflection paused · {n} consecutive failures",
    memoryReflectionPausedWhy: "Recommendation: {path}",
    memoryReflectionPausedProbe: "Next automatic probe at {time}",
    memoryReflectionPausedRetry: "Run /reflect to retry now",
  },
} as const;
