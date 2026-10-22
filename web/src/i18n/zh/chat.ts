// chat 域词条（zh-CN）：web/src/components/chat/ 各组件用户可见文案，zh 值为迁移前逐字原文。
// 纯函数模块（tool-card-data/commands 等）与引擎 wire 传入文案（权限卡
// title/message、notify 载荷）不在本域，保持原样不译；compact-run 为本地拼装 toast（终验 F2 修复入域）。
export const chat = {
  // 折叠步骤行耗时标签（docs08 2026-10-22 批次任务 7）：thinking-block/tool-card 折叠头
  duration: "{dur}",
  // tool-card.tsx 工具调用卡片
  toolcard: {
    statusRunning: "运行中",
    statusFailed: "失败",
    statusDone: "完成",
    code: "代码",
    args: "参数",
    result: "结果",
    resultViewToggle: "结果视图切换",
    textView: "文本",
    loadingDiff: "加载 diff 视图…",
    collapse: "收起结果",
    expand: "展开全部",
    waiting: "等待工具返回…",
    noResult: "（无结果文本）",
    noTextResult: "（无文本结果）",
  },
  // status-bar.tsx 会话状态条
  statusBar: {
    running: "运行中",
    idle: "空闲",
    detail: "↑{input} ↓{output} 缓存{cache}",
    context: " · 上下文 {n}% · {used}/{limit}",
    usageFailed: "用量不可用",
    usageLoading: "用量统计中…",
  },
  // message-bubble.tsx 消息气泡
  messageBubble: {
    queued: "排队中",
    live: "正在回复",
    assistant: "助手",
    interrupted: "已中断",
    expand: "展开",
    collapse: "收起",
    // 溯源行（docs08 2026-10-22 批次任务 17）：模型短名旁的代理名与用时；
    // 空数据省略不渲染，无占位词条
    originAgent: "代理 {name}",
    originDuration: "用时 {dur}",
    // 变体名歧义注记（docs08 2026-10-22 批次任务 18）：5 级回退到裸名且注册表内
    // 多个变体共用该上游时挂 title 提示（绝不猜）
    modelAmbiguous: "多个模型变体共用此上游名，显示记录的原始名",
  },
  // parts.tsx 未支持内容占位（docs08-r6 任务 10 ①②）
  parts: {
    unsupportedBlock: "未支持内容块：{type}",
    unsupportedCount: { one: "1 个未支持内容块", other: "{n} 个未支持内容块" },
  },
  // message-bubble.tsx custom_message 占位行（docs08-r6 任务 10 ③）
  customMessage: {
    unsupported: "未支持内容：{customType}",
  },
  // message-bubble.tsx loop-guard 三型具名渲染（docs08 2026-10-22 批次任务 2）：
  // 折叠行具名标签（×N 角标由 count>1 条件拼在标签后，不入词条）；
  // 空内容条目展开时的降级占位
  loopGuard: {
    title: "循环防护提醒",
    emptyContent: "（无内容）",
  },
  // queue-bar.tsx 排队条
  queue: {
    cancelFailed: "排队撤销失败",
    pendingCount: { one: "1 条待发", other: "{n} 条待发" },
    suspendedHint: "回合已结束，将在下次发送时执行",
    clear: "清空",
    steerTitle: "插入：下一回合边界并入当前工作",
    followTitle: "跟答：当前回合做完后执行",
    steer: "插入",
    follow: "跟答",
    removeItem: "撤销该条",
    sendNowItem: "立即发送该条",
    sendNowTitle: "立即发送：转插入注入当前回合，其余项保持排队",
    sendNowFailed: "立即发送失败",
  },
  // todo-list.tsx / todo-panel.tsx 任务清单
  todo: {
    inProgress: "进行中",
    abandoned: "已放弃",
    groupLabel: "任务组：{name}",
    progress: "{done}/{total} 已完成",
    statusRunning: "运行中",
    statusFailed: "失败",
    statusDone: "完成",
    panelTitle: "任务清单",
    collapse: "收起任务面板",
    noSession: "未选择会话",
    empty: "本会话还没有 todo 清单",
  },
  // stat-panel.tsx 统计页签
  statPanel: {
    noSession: "未选择会话",
    unavailable: "用量不可用",
    unavailableHint: "统计服务暂时无法访问，稍后自动恢复",
    tokensTitle: "累计 Tokens",
    input: "输入",
    output: "输出",
    total: "总计",
    loading: "用量统计中…",
    cacheTitle: "缓存命中",
    cacheRead: "缓存读",
    cacheWrite: "缓存写",
    contextTitle: "上下文水位",
    contextUsage: "占用",
    noContext: "暂无上下文数据",
    costTitle: "成本",
    costTotal: "累计费用",
    costToday: "今日费用",
    cacheRate: "命中率",
    speedTitle: "回合速度",
    lastTurn: "末回合",
    avgTurns: { one: "平均（1 回合）", other: "平均（{n} 回合）" },
    noData: "暂无数据（回合结束后出现）",
    timeTitle: "耗时估算",
    timeModel: "模型（估）",
    timeTool: "工具",
    subagentsTitle: "子代理费用",
    subagentTotal: "合计",
  },
  // memory-panel.tsx 记忆页签
  memoryPanel: {
    libraryPath: "库路径：{path}",
    todayTitle: "今日 committed 记忆运行数",
    today: { one: "今日 1 条", other: "今日 {n} 条" },
    totalTitle: "facts 条目总数",
    total: { one: "库 1 条", other: "库 {n} 条" },
    filesTitle: "facts + system 文件数",
    files: { one: "1 个文件", other: "{n} 个文件" },
    lastEntry: "最近落条 {time}",
    systemTitle: "repo/system/*.md 磁盘字节和",
    systemSize: "system 文件体积 {size}",
    fileEmpty: "（该文件暂无条目）",
    docEmpty: "（空文件）",
    noSession: "未选择会话",
    noSessionHint: "选择会话或项目后浏览其记忆库",
    unavailable: "记忆不可用",
    retry: "重试",
    loading: "加载记忆…",
    noLibraryTitle: "该项目尚无记忆库",
    noLibraryHint: "记忆按项目目录分库，与同目录 CLI 共用；同目录会话产生记忆后自动建库。",
    noEntriesTitle: "该目录暂无记忆条目",
    noEntriesHint: "记忆按项目目录分库，与同目录 CLI 共用。",
    browsing: "浏览项目：{project}",
    refresh: "刷新记忆",
  },
  // subagent-panel.tsx 子代理页签（docs08-r6 任务 17）
  subagentPanel: {
    noSession: "未选择会话",
    emptyTitle: "本会话暂无子代理调用",
    emptyHint: "会话经 task 工具派发子代理后在此聚合展示（运行中实时进度与终态回复）",
    statusRunning: "运行中",
    statusDispatched: "已派发·后台运行中",
    statusDone: "完成",
    statusFailed: "失败",
    responseTitle: "最终回复",
    responseEmpty: "（无最终回复文本）",
    promptTitle: "提示词",
    metricRuntime: "用时 {dur}",
    metricTurns: "回合 {n}",
    metricToolCalls: "工具 {n}",
    metricTokens: "{n} tok",
    metricOutput: "输出 {n}",
    metricCache: "缓存 {pct}",
  },
  // question-card.tsx 提问卡片
  questionCard: {
    submitFailed: "应答失败，请重试",
    needAnswer: "请至少回答一个问题或填写补充说明",
    title: "助手提问",
    position: "第 {position}/{total} 个待处理",
    waiting: "等待回答",
    later: "可稍后回答",
    expired: "已超时",
    customPlaceholder: "或输入自定义答案（可选）",
    commentPlaceholder: "还有什么要补充的？（可选，提交给助手）",
    pendingHint: "不应答将挂起当前回合（超时自动继续）",
    continuedHint: "回合已继续，回答将作为新消息送达",
    ignore: "忽略",
    submit: "提交回答",
    stepPosition: "第 {step}/{count} 题",
    stepJump: "跳到第 {step} 题",
    prevQuestion: "上一题",
    nextQuestion: "下一题",
    submitPending: "已提交，等待确认…",
    submitFallback: "提交后未收到确认，可重试或取消",
    retrySubmit: "重试",
    cancelSubmit: "取消作答",
  },
  // permission-card.tsx 权限卡片 chrome（引擎传入的 title/message 不在域内）。
  // kindChoice（docs08-r6 任务 6 ③）：非权限 select（提问降级/登录选择）的中性标题
  permissionCard: {
    kindSelect: "权限请求",
    kindChoice: "需要选择",
    kindConfirm: "确认操作",
    kindInput: "需要输入",
    kindEditor: "需要编辑",
    deniedToast: "已拒绝，请在下方填写反馈",
    submitFailed: "应答失败，请重试",
    cancelFailed: "取消失败，请重试",
    position: "第 {position}/{total} 个待处理",
    alwaysAllow: "总是允许 {tool}（本会话前端自动放行）",
    confirm: "确认",
    cancel: "取消",
    submit: "提交",
    submitAll: "提交全文",
    blockHint: "不应答将阻塞当前回合",
    dismiss: "忽略并取消",
  },
  // chat-view.tsx 对话主视图
  chatView: {
    emptyHint: "从左侧选择会话，或新建一个会话开始对话",
    loading: "加载消息…",
    loadFailed: "消息加载失败，请检查服务是否可用",
    retry: "重试",
  },
  // image-lightbox.tsx 图片灯箱
  lightbox: {
    close: "关闭预览",
    imageAlt: "消息图片",
    viewLarge: "查看大图",
    refUnavailable: "工具产出图片暂不可查看",
  },
  // message-actions.tsx 消息操作菜单
  messageActions: {
    copied: "已复制原文",
    copyFailed: "复制失败（浏览器未授权剪贴板）",
    retryBranchCreated: "已创建重试分支，正在重新生成…",
    retryFailed: "重试失败",
    menuLabel: "消息操作",
    copy: "复制原文",
    retry: "重试（从此消息重新生成）",
  },
  // markdown.tsx 表格行操作（todo 8）
  tableActions: {
    copyTable: "复制表格",
    copied: "已复制表格",
    downloadCsv: "下载 CSV",
  },
  // message-list.tsx 虚拟化消息列表
  messageList: {
    empty: "暂无消息，发送第一条消息开始对话",
    syncing: "同步历史…",
    jumpToBottom: "回到底部",
  },
  // nav-rail.tsx 右缘导航轨
  navRail: {
    jumpTo: "跳转到：{title}",
  },
  // permission-queue.tsx 权限队列容器
  permissionQueue: {
    autoAllowed: "已自动允许 {tool}（总是允许）",
  },
  // thinking-block.tsx 思考折叠块
  thinkingBlock: {
    live: "思考中",
    title: "思考过程",
    chars: " … {n} 字",
    ellipsis: "…",
    empty: "（暂无内容）",
  },
  // compact-run.ts 压缩成功 toast（终验 F2：本地拼装文案入域，{key, vars} 渲染）。
  // 任务 18（压缩过程感）：ongoing=进行条（event-dispatch compaction_start/progress）；
  // marker=流内摘要标记块（message-items compactionMarkerOf 派生，{summary}=首行）；
  // autoStarted=自动压缩轻提示（reason!=manual 的 start 帧 toast）
  compact: {
    done: "上下文已压缩：{before} → {after} tokens",
    doneBefore: "上下文已压缩（压缩前 {before} tokens）",
    ongoing: "正在压缩上下文…",
    marker: "上下文已压缩：{summary}",
    autoStarted: "上下文接近上限，正在自动压缩…",
  },
  // commands.ts 斜杠命令表（任务 10）：note 改 getter 懒取词，长文案逐字搬
  commands: {
    compactNote: "压缩上下文：引擎协议直调（与 CLI 同入口）",
    clearNote: "清空上下文：引擎未注册该命令，直发会被模型当作普通消息",
    newNote: "新建会话：引擎未注册该命令，请用侧栏「新建会话」",
    undoNote: "撤销上一条：引擎未注册该命令，直发会被模型当作普通消息",
    gateMessage: "引擎不支持命令 {label}：{note}（实证记录见 docs/verification/05）",
  },
  // memory-entries.ts 记忆标记摘要（任务 10）：summary 改 {key, vars} 纯数据
  memoryMarkers: {
    bound: "已绑定记忆库",
    boundWith: "已绑定记忆库 {identity}",
    acceptedTurns: "本轮已计入记忆",
    projectionPin: "记忆投影已固定",
    kibitzerNudged: "收到 kibitzer 提示",
    memorianNudged: "收到 memorian 提示",
    memoryNotice: "记忆提示",
    recall: "召回记忆 {source}",
    recallPlain: "召回记忆",
  },
} as const;
