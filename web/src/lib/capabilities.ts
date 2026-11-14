// 引擎能力位（web 侧单一来源，session-branching todo 8 → todo 9）：与 server 适配层
// EngineCapabilities 对齐。todo 8：treeNavigation=true（senpi-adapter 默认，本仓自带
// 引擎已有 navigate_tree/get_tree 协议面），消费点=消息菜单「从此处分支」「编辑重发」
// 门控与「重试」双路径分流（IS-4/IS-5/IS-8）。todo 9：editResend=true——todo-1 实调
// 结论成立（edit_assistant_message 副本成新叶 + continue_from_leaf 从 assistant 叶
// 真实续跑成功，task-1 证据 §5），「编辑回复」走 edit→continue→刷新链（F12/D12）；
// 实调环境差异需回退时置 false，菜单降级「复制到新会话续跑」（fork at，功能不砍）。
// server 端 capabilities 下发端点建立后由 bootstrap 接读改写此处（当前无下发通道，
// 静态默认）。测试直接赋值翻转位。
export const capabilities: { treeNavigation: boolean; editResend: boolean } = {
  treeNavigation: true,
  editResend: true,
};
