// 快捷键帮助词条（docs08-r7 任务 12）：对话框标题/分组名/条目描述。
// 触发键名（Ctrl+P、Enter 等）一律不本地化，显示串唯一来源在 lib/shortcuts.ts 注册表。
export const shortcuts = {
  title: "键盘快捷键",
  description: "当前版本的全部键盘快捷键如下，按分组排列。",
  group: {
    global: "全局",
    composer: "输入区",
    history: "输入历史",
    slash: "斜杠命令",
    overlay: "弹层与面板",
  },
  desc: {
    modelCycle: "循环切换收藏模型",
    modelPicker: "打开模型选择",
    shortcutsHelp: "打开本帮助",
    send: "发送消息",
    newline: "插入换行",
    fileRef: "在光标处插入文件引用",
    historyOlder: "调出上一条历史输入",
    historyNewer: "回到较新的历史输入",
    historyExit: "退出历史翻阅（保留当前文本）",
    slashOpen: "打开斜杠命令菜单",
    slashNav: "在命令间移动高亮",
    slashSelect: "选择高亮命令",
    slashClose: "关闭菜单并回退输入",
    overlayClose: "关闭下拉/面板/对话框/灯箱/抽屉",
  },
  /** Ctrl+P 循环但无收藏时的兜底提示（shell useModelShortcuts toast） */
  noFavoritesToast: "暂无收藏模型，已打开模型选择",
} as const;
