// auth 域词条（zh-CN）：设置页「认证」分区（r10 批次任务 13）。
export const auth = {
  heading: "认证",
  note: "粘贴 API key 后点击测试；测试通过才写入引擎认证配置，无效 key 不会保存。key 不会明文显示或记录。",
  providerLabel: "provider",
  providerCustom: "自定义…",
  providerCustomPlaceholder: "provider 名称",
  providerRequired: "请选择或填写 provider",
  keyRequired: "请粘贴 API key",
  keyPlaceholder: "粘贴 API key",
  test: "测试并保存",
  testing: "测试中…",
  testOk: "凭证有效，已保存",
  testFailed: "凭证测试未通过",
  rejectNotConfigured: "引擎未接受该凭证（key 无效或格式不符）",
} as const;
