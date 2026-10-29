// notes 域词条（zh-CN）：notes 组件族 UI 文案（Wave-2 任务 8 迁入）。
// 值与迁移前组件硬编码文案逐字一致（含「」引号）；域内按组件分组。
// 笔记正文/标题等用户内容不走字典。
export const notes = {
  // 面板级：notes 组件族共用
  backToList: "返回笔记列表",
  newNote: "新建笔记",
  panelTitle: "笔记",
  trashLabel: "回收站",
  addProjectFirst: "请先添加项目",
  deleteConfirm: "删除笔记「{title}」？可在回收站恢复。",
  loading: "加载笔记…",
  loadFailed: "笔记加载失败：{message}",
  // 任务11（r11 todo7 裁剪后沿用）：notes 组件族错误展示兜底键（apiErrorMessage 未命中映射/纯 Error 时）
  actionFailed: "操作失败",
  loadFailedBrief: "笔记加载失败",
  retry: "重试",
  // notes-view 列表态
  view: {
    count: { one: "{n} 条", other: "{n} 条" },
    moreActions: "笔记更多操作",
    filterAll: "全部",
    untitled: "无标题",
    collapseEditor: "收起并保存",
    saving: "保存中…",
    noNotes: "没有笔记",
    noTagMatch: "没有匹配该标签的笔记",
    deleteItem: "删除 {title}",
    restoredToast: "已恢复「{title}」",
    purgeConfirm: "彻底删除「{title}」？此操作不可恢复（含全部历史版本）。",
    purgedToast: "已彻底删除「{title}」",
    emptyTitle: "暂无笔记",
    emptyHint: "为当前项目记录第一篇笔记",
  },
  // 行内编辑器（r11 todo7）沿用：恢复确认与「···」菜单文案（原 详情屏命名空间裁剪）
  detail: {
    restoreVersionConfirm: "恢复到 {time} 的版本？当前正文将被覆盖（可再从版本历史找回）。",
    moreActions: "笔记操作",
    versionHistory: "历史版本",
    deleteNote: "删除笔记",
  },
  // 行内编辑器表单字段（原 编辑表单命名空间裁剪：自动保存后无保存/取消钮）
  edit: {
    titlePlaceholder: "标题",
    titleAria: "笔记标题",
    tagsPlaceholder: "标签（逗号分隔，可留空）",
    tagsAria: "笔记标签",
    contentPlaceholder: "正文",
    contentAria: "笔记正文",
  },
  // notes-trash 回收站列表
  trash: {
    loading: "加载回收站…",
    emptyTitle: "回收站为空",
    emptyHint: "软删除的笔记会出现在这里",
    deletedAt: "删除于 {time}",
    restoreItem: "恢复 {title}",
    purgeItem: "彻底删除 {title}",
  },
  // note-versions 版本历史面板
  versions: {
    title: "历史版本",
    count: { one: "{n} 个", other: "{n} 个" },
    collapse: "收起历史版本",
    loadFailed: "版本加载失败：{error}",
    loading: "加载版本…",
    empty: "暂无历史版本",
    emptyPreview: "（空内容）",
    restore: "恢复",
  },
} as const;
