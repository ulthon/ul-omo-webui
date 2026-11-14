// 引擎能力位（web 侧单一来源，session-branching todo 8）：与 server 适配层
// EngineCapabilities 默认对齐（senpi-adapter：treeNavigation=true——本仓自带引擎
// 已有 navigate_tree/get_tree 协议面）。消费点：消息菜单「从此处分支」「编辑重发」
// 门控与「重试」双路径分流（IS-4/IS-5/IS-8）；server 端 capabilities 下发端点建立后
// 由 bootstrap 接读改写此处（当前无下发通道，静态默认）。测试直接赋值翻转位。
export const capabilities: { treeNavigation: boolean } = {
  treeNavigation: true,
};
