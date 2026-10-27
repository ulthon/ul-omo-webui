// files 域词条（zh-CN）：内置文件管理页（builtin-file-management 任务 1 骨架）。
// 本任务只落入口/页头/空态所需键；后续任务只增不改既有键。
export const files = {
  // 顶栏入口钮
  entry: {
    openAria: "打开文件管理",
  },
  // 文件管理页（任务 1 为占位空壳，任务 2 填三栏内容；placeholder 键保留不删，只增不改）
  page: {
    title: "文件管理",
    closeAria: "关闭文件管理",
    placeholder: "文件管理页建设中",
  },
  // 页头项目下拉
  project: {
    label: "项目",
    selectAria: "选择项目",
    empty: "暂无已注册项目",
  },
  // 页头面包屑
  breadcrumb: {
    root: "根目录",
  },
  // 中栏文件列表
  list: {
    heading: "文件",
    name: "名称",
    size: "大小",
    mtime: "修改时间",
    type: "类型",
    empty: "此目录为空",
    loadFailed: "目录加载失败",
    sortByName: "按名称排序",
    sortBySize: "按大小排序",
    sortByMtime: "按修改时间排序",
    sortByType: "按类型排序",
    notAvailable: "—",
  },
  // 类型列文案
  type: {
    directory: "目录",
    file: "文件",
    symlink: "符号链接",
    other: "其他",
  },
  // 右栏预览
  preview: {
    empty: "选择文件以预览",
  },
  // 页面级错误
  error: {
    projectsLoadFailed: "项目列表加载失败",
  },
  // 手机档单栏层叠面板切换（≤768px）
  mobile: {
    tree: "目录",
    list: "列表",
    preview: "预览",
    switcherAria: "切换面板",
  },
  // 操作面工具栏（任务 6）
  toolbar: {
    newFile: "新建文件",
    newDir: "新建目录",
    upload: "上传",
    refresh: "刷新",
  },
  // 右键菜单（列表与树共用；目录多“在此上传”）
  menu: {
    download: "下载",
    rename: "重命名",
    move: "移动",
    remove: "删除",
    uploadHere: "在此上传",
  },
  // 新建/重命名/移动对话框（目标相对路径输入）
  dialog: {
    newFileTitle: "新建文件",
    newDirTitle: "新建目录",
    renameTitle: "重命名",
    moveTitle: "移动",
    nameLabel: "名称（当前目录内相对路径）",
    targetLabel: "目标相对路径（支持跨目录）",
    confirm: "确定",
    cancel: "取消",
  },
  // 上传队列（逐个排队 + 进度 + 结果态）
  upload: {
    queueTitle: "上传队列",
    uploading: "上传中",
    done: "完成",
    failed: "失败",
    conflict: "目标已存在",
  },
  // 操作结果 toast 兜底文案（成功/失败）
  op: {
    createFileFailed: "新建文件失败",
    createDirFailed: "新建目录失败",
    renameFailed: "重命名失败",
    moveFailed: "移动失败",
    deleteFailed: "删除失败",
    uploadFailed: "上传失败",
  },
} as const;
