// fileTree 域词条（zh-CN）：directory-tree / file-preview UI 文案（Wave-2 任务 8 迁入）。
// 值与迁移前组件硬编码文案逐字一致（含全角括号与反斜杠路径示例）；
// file-tree.tsx / file-picker.tsx 不在本域（他域任务），三个 *-logic.ts 纯函数任务 10 处理。
export const fileTree = {
  // directory-tree 目录树与目录选择弹窗
  tree: {
    collapse: "收起",
    expand: "展开",
    addedBadge: "已添加",
    loadFailed: "目录加载失败",
    serverTreeAria: "服务器目录",
    empty: "目录为空",
    notAbsolute: "路径必须是绝对路径（如 /home/user/proj 或 D:\\projects\\proj）",
    notReadable: "目录不可读",
    notFound: "路径不存在：{path}（可新建并添加）",
    createFailed: "创建失败，请重试",
    dialogTitle: "浏览目录",
    dialogHint: "输入路径回车跳转，单击选中、双击进入；已添加的项目置灰标记，仍可双击进入",
    pathPlaceholder: "如 /home/user/my-project 或 D:\\projects\\my-project",
    pathAria: "目录路径",
    listAria: "目录列表",
    showHidden: "显示隐藏目录",
    allHiddenNote: "（均为隐藏目录，可打开上方开关显示）",
    addedTitle: "已添加：仍可双击进入",
    noSelection: "尚未选择目录",
    cancel: "取消",
    creating: "创建中…",
    createAndAdd: "新建并添加",
    pickThis: "选择此目录",
  },
  // file-preview 只读预览
  preview: {
    loadFailed: "文件加载失败",
    truncatedSuffix: " · 已截断",
    insertRef: "插入引用",
    loadFailedTitle: "预览加载失败",
    imageFile: "图片文件（{mime}）",
    imageNoInline: "只读接口不下发二进制内容，暂无法内联显示；完整大小 {size}",
    binaryFile: "二进制文件，不渲染内容",
    emptyFile: "空文件",
    tooLarge: "文件较大（完整 {size}），仅显示前 2 MB。预览为只读，请用本地编辑器打开原文件查看完整内容。",
  },
  // file-picker.tsx @ 文件选择器（任务 10 编排补入）
  picker: {
    title: "引用文件",
    description: "选择文件插入 @ 路径引用（只读预览）",
    searchPlaceholder: "模糊搜索文件名或路径…",
    clearSearch: "清空搜索",
    indexing: "正在索引文件…",
    noMatch: "无匹配文件",
    backToList: "返回文件列表",
    previewEmpty: "选择文件查看只读预览",
    indexingStatus: "索引中（搜索渐进可用）",
    indexedCount: { one: "已索引 {n} 项", other: "已索引 {n} 项" },
    enterHint: "搜索时 Enter 插入首个命中",
    cancel: "取消",
  },
} as const;
