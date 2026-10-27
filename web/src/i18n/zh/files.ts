// files 域词条（zh-CN）：内置文件管理页（builtin-file-management 任务 1 骨架）。
// 本任务只落入口/页头/空态所需键；后续任务只增不改既有键。
export const files = {
  // 顶栏入口钮
  entry: {
    openAria: "打开文件管理",
  },
  // 文件管理页（任务 1 为占位空壳，任务 2 填三栏内容）
  page: {
    title: "文件管理",
    closeAria: "关闭文件管理",
    placeholder: "文件管理页建设中",
  },
} as const;
