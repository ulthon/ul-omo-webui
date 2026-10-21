// 公共词条（zh-CN）：原 zh.ts common 域原样迁移。
export const common = {
  cancel: "取消",
  close: "关闭",
  save: "保存",
  delete: "删除",
  loadFailed: "加载失败",
  loading: "加载中",
  relJustNow: "刚刚",
  relMinutes: "{n} 分钟前",
  relHours: "{n} 小时前",
  relDays: "{n} 天前",
  itemCount: { one: "1 项", other: "{n} 项" },
  // lib 层散点（任务 10）：非组件模块（api/bootstrap/preferences/stores）产出的用户可见文案
  lib: {
    unauthorized: "未登录或会话已过期",
    noModelsSend: "无可用模型，无法发送（请检查引擎模型配置）",
    sessionListLoadFailed: "会话列表加载失败",
    updateLastOpenedFailed: "更新最近打开时间失败",
    saveModelPrefFailed: "保存模型偏好失败",
    saveThinkingPrefFailed: "保存思考级别偏好失败",
    modelChangeRejected: "模型 {model} 切换被引擎拒绝（{detail}），当前模型不变",
  },
} as const;
