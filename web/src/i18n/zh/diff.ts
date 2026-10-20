// diff 域词条（zh-CN）：diff-view / changes-view UI 文案（Wave-2 任务 8 迁入）。
// 值与迁移前组件硬编码文案逐字一致；纯函数文件 diff-utils.ts 不在本域（任务 10）。
export const diff = {
  // 文件状态词（原 diff-view TYPE_LABEL 静态映射，改为取词函数消费）
  type: {
    add: "新增",
    modify: "修改",
    delete: "删除",
    rename: "重命名",
    copy: "复制",
  },
  // diff-view 渲染
  view: {
    binary: "二进制文件，无文本 diff",
    pureRename: "纯重命名（内容未变）",
    noTextDiff: "无文本差异（二进制或仅元数据变更）",
    fragment: "diff 片段",
    parseFailed: "无法解析 diff 内容",
  },
  // changes-view 未提交变更页签
  changes: {
    untrackedNote: "未跟踪文件：尚未纳入 Git 管理，暂无 diff 内容。",
    stagedNote: "该文件改动已暂存（staged），暂无未暂存的工作区 diff。",
    title: "未提交变更",
    fileCount: { one: "{n} 个文件", other: "{n} 个文件" },
    truncated: "diff 过大已截断",
    refresh: "刷新变更",
    addProjectFirst: "请先添加项目",
    loading: "加载变更…",
    loadFailed: "变更加载失败：{message}",
    retry: "重试",
    noGitTitle: "无 Git 仓库",
    noGitHint: "当前项目目录不是 git 仓库，没有变更可查看",
    cleanTitle: "工作区干净",
    cleanHint: "没有未提交的变更",
  },
} as const;
