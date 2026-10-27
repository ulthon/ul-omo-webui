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
  // 在线编辑（任务 8）：资格三条件、脏态守卫、保存状态条
  edit: {
    button: "编辑",
    backAria: "返回预览",
    saveButton: "保存",
    dirtyMarker: "有未保存的修改",
    reasonTooLarge: "文件超过 2MB，无法在线编辑",
    reasonTruncated: "文件过大被截断，无法在线编辑",
    reasonBinary: "二进制文件无法在线编辑",
    confirmLeave: "有未保存的修改，确定离开吗？",
    statusSaving: "保存中",
    statusSaved: "已保存",
    statusFailed: "保存失败",
    statusUnavailable: "保存不可用",
    loadFailed: "文件内容加载失败",
  },
  // 保存冲突弹窗（任务 9：PUT /api/fs/file 409 file_changed → 重载/取消两选）
  saveConflict: {
    title: "文件已被修改",
    desc: "文件已被修改（引擎或其他来源）。你的本地修改未保存，可重载最新内容或保留本地修改继续编辑。",
    reload: "重载",
    cancel: "取消",
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
    canceled: "已取消",
  },
  // 删除确认弹窗（任务 7：目录递归警告 + 直接子条目数；引擎忙专用文案）
  confirm: {
    title: "确认删除",
    fileBody: "将永久删除文件“{path}”，此操作不可撤销。",
    dirBody: "将永久删除目录“{path}”及其全部内容，此操作不可撤销。",
    childCount: "该目录包含 {count} 个直接子条目。",
    childCountUnknown: "正在统计直接子条目…",
    confirm: "删除",
    cancel: "取消",
    engineBusy: "引擎正在此项目工作，稍后再试",
  },
  // 冲突三选弹窗（move 409 target_exists / upload 409 target_exists）
  conflict: {
    title: "目标已存在",
    moveDesc: "目标路径已存在：{path}",
    uploadDesc: "“{name}”已存在于目录 {dir}",
    existingInfo: "已有条目：{kind}，{size}",
    overwrite: "覆盖",
    keepBoth: "保留两者",
    cancel: "取消",
    keepBothDisabled: "上传暂不支持自动改名，无法保留两者",
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
