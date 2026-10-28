# r10-2026-10-27-batch - Work Plan

> 本文件是 /data/projects/senpi-webui/.omo/plans/r10-2026-10-27-batch.md 的逐字摘录
> （Todos 10-18 + 终验波次节选），作计划 todo 行语法的真实测试 fixture：
> 覆盖未勾选行、已勾选行（16）、缩进续行（嵌套行须被忽略）、非数字行（F1-F4 须被忽略）。

## Todos

- [ ] 10. 帧桥接 spike：引擎事件帧可达性探查
  What to do / Must NOT do: 起引擎实例触发后台任务/子代理，抓 stdout JSON-RPC 通知帧（omo.task.updated 等），记录帧形态/频率/字段/可达性；结论（可行→桥接设计要点；不可行→降级 JSONL 磁盘派生）写 spike 报告。Must NOT：不写任何生产代码；探针脚本放临时目录不入仓。
  Closes: GAP-1（spike 部分）
  Parallelization: Wave 3 | Blocked by: 无 | Blocks: 11
  References: 引擎 spawn/bridge 现有实现（stdout JSON-RPC 解析处）；omo.task.updated 事件源；memory: subagent-panel-gap（今日核实缺口）
  Acceptance criteria: spike 报告落盘含帧样本 JSON 或不可达结论+降级建议（证据即报告）
  QA scenarios: 证据即报告。Evidence <attemptDir>/task-10-r10-2026-10-27-batch.md
  Commit: N | spike 无代码入仓
  Recommended task executor category: deep-low（探查性调试，可自行从运行证据定结论）
- [ ] 11. 后台活动条+子代理进度
  What to do / Must NOT do: 依 10 结论——可行：bridge 转发事件帧进 zustand store，会话页面板常驻活动条（后台任务 N 个，点开列表含任务行 label+状态，spike 证实帧含 title/activity 摘要字段则一并展示）；不可行：降级 JSONL 磁盘派生粗粒度（进行中/已完成列表）。docs/08:76 子代理面板信息面加强另立项不在本批。Must NOT：不轮询高频拉取；不改引擎。
  Closes: GAP-1（后台任务+子代理部分）
  Parallelization: Wave 4 | Blocked by: 10 | Blocks: 无
  References: task-10 spike 报告；bridge（spawn stdout 解析）；zustand store；会话页布局；docs/08 第 36 行条目
  Acceptance criteria: 后台任务运行时活动条可见含任务行；全部完成隐藏无残留；单测 store 状态转换；若走降级分支，降级形态同样满足出现/推进/消失三断言
  QA scenarios: happy—以低成本确定性任务（如 shell 短命令后台任务）触发，活动条出现并推进；failure—任务全部结束后活动条消失。Evidence <attemptDir>/task-11-r10-2026-10-27-batch.png
  Commit: Y | feat(visibility): 后台活动条与子代理进度
  Recommended task executor category: unspecified-high（桥接+store+UI 跨面多文件）
- [ ] 12. 计划执行进度面板
  What to do / Must NOT do: 直读 todoState/boulder-plans 存储（.omo/plans 目录+todo 状态），会话页面板显示绑定当前会话的 goal（boulder active_work 绑定语义，避免多会话/多项目串台）的 todo 勾选态 N/M+当前步；状态变更实时更新（事件或轻量监听）；无绑定 goal 隐藏。Must NOT：不新建计划管理功能（仅展示）。
  Closes: GAP-1（计划进度部分）
  Parallelization: Wave 2 | Blocked by: 无 | Blocks: 无
  References: boulder.json active_work（会话绑定字段，docs/08:40）；todoState/boulder-plans 存储（.omo/plans/*.md todo 行结构，现仅历史 spike 测试 fixture 无现成解析实现）；会话页面板挂载点；docs/08 第 39 行条目
  Acceptance criteria: 有绑定 goal 的会话面板显示勾选态与当前步；无绑定 goal 不渲染；todo 行 md 解析单测（勾选态/标题/嵌套行）
  QA scenarios: happy—执行中计划面板进度推进；failure—无计划时不显示空面板；另一会话绑另一 goal 时互不串台。Evidence <attemptDir>/task-12-r10-2026-10-27-batch.png
  Commit: Y | feat(visibility): 计划执行进度面板
  Recommended task executor category: unspecified-high（解析+面板+实时更新）
- [ ] 13. 认证 UI：API key 粘贴+auth check 集成
  What to do / Must NOT do: settings 页加认证区（未认证时顶栏提示条引导进入）：provider 选择+API key 粘贴表单+测试按钮；写入引擎认证配置（按现有认证存储机制）；接 server/src/api/extensions-store.ts auth check（checkAuthStatus:223）逻辑展示已认证/未认证/失败原因。Must NOT：不做 OAuth；key 不入前端日志、不回显明文、不落 localStorage。
  Closes: GAP-2
  Parallelization: Wave 3 | Blocked by: 无 | Blocks: 无
  References: server/src/api/extensions-store.ts:215-260（auth check 块，checkAuthStatus:223）；settings 页；引擎认证配置写入路径（执行时以 grep auth 模型配置定位）；docs/08 第 28 行条目（已拍板）
  Acceptance criteria: 端到端（测试凭证策略：本地 mock OpenAI 兼容端点或环境变量注入，不依赖真实付费 key）——粘 key→测试通过→状态已认证；无效 key 显示失败原因；安全断言：API 响应体/localStorage/控制台均无明文 key；key 输入框 type=password 不回显
  QA scenarios: happy—mock 凭证全流程状态变已认证；failure—无效 key 错误展示不崩不写入；明文 key 不出现在网络响应与存储。Evidence <attemptDir>/task-13-r10-2026-10-27-batch.png
  Commit: Y | feat(auth): API key 粘贴认证与状态展示
  Recommended task executor category: unspecified-high（表单+写入+状态集成跨面）
- [ ] 14. 修复切页回来流式滞后
  What to do / Must NOT do: 修复回前台流式从旧位置逐帧重播——回前台校准：跳最新状态+积压快进渲染（不逐帧动画）；先复现钉根因（消息 append 队列/渲染节流）。Must NOT：不牺牲前台流式正常逐字效果。
  Closes: GAP-9
  Parallelization: Wave 3 | Blocked by: 无 | Blocks: 无
  References: 消息流 store 流式 append 路径；回前台 focus/visibilitychange 路径；docs/08 第 67-70 行条目
  Acceptance criteria: 复现与根因记录；修复后回前台即渲染最新（断言无逐帧回放序列）；前台流式仍逐字（回归断言）；验证以桌面 Playwright 仿真为准（page.evaluate 派发 visibilitychange hidden→注入积压 text_delta 帧→visible，断言最终渲染=最新且中间 delta 未逐帧应用）；真实移动端 webview 行为超出本批验证边界，注明
  QA scenarios: happy—仿真切页回来即见最新帧；failure—非流式静态会话切回无变化无抖动。Evidence <attemptDir>/task-14-r10-2026-10-27-batch.png
  Commit: Y | fix(stream): 回前台校准快进至最新
  Recommended task executor category: deep-low（时序根因定位）
- [ ] 15. 修复输出重复复发（对照 b6d3df4）
  What to do / Must NOT do: git show b6d3df4 对照找回归点；长会话多轮复现钉根因；修复+消息追加去重防线（gap 对账：追加前比对最后消息标识）；复现用例固化为回归测试。Must NOT：不为去重牺牲正常重复语义（如用户重发）。
  Closes: GAP-10
  Parallelization: Wave 3 | Blocked by: 无 | Blocks: 无
  References: git show b6d3df4（上次修复）；消息追加路径（append/concat 处）；docs/08 第 82-85 行条目
  Acceptance criteria: 复现步骤+根因记录；复现场景修复后无重复；去重防线单测；现有消息流测试全绿
  QA scenarios: happy—复现场景无重复输出；failure—同会话连续两回合产生相同 assistant 文本，两条 entry 均保留（docs/08:83 反例钉死，不误杀）；正常重发/重试仍工作。Evidence <attemptDir>/task-15-r10-2026-10-27-batch.txt
  Commit: Y | fix(stream): 修复输出重复复发并加去重防线
  Recommended task executor category: deep-low（历史对照+根因复发定位）
- [x] 16. 工具启停 spike：引擎能力面探查
  What to do / Must NOT do: spike 两路：spawn 期 --tools/--exclude-tools 参数透传可行性（CLI 同源参数）vs 运行时 RPC 动态启停；结论定实现路径（含降级：项目级配置+重启引擎生效）并明确判定会话级差异化是否可达（引擎按项目路径键控一进程，spawn 期透传无法会话级差异化，运行时面才可能）；报告落盘。Must NOT：不写生产代码；不改引擎。
  Closes: GAP-14（spike 部分）
  Parallelization: Wave 2 | Blocked by: 无 | Blocks: 17
  References: 引擎 spawn 参数构造处（bridge 进程启动，process-manager 项目路径键控）；CLI 工具启停同源参数（执行时 grep tools 参数）；docs/08 第 42 行条目
  Acceptance criteria: spike 报告落盘：可行面+参数样例+生效时机（spawn 期/运行时/重启）+会话级差异化可达性四项结论
  QA scenarios: 证据即报告。Evidence <attemptDir>/task-16-r10-2026-10-27-batch.md
  Commit: N | spike 无代码入仓
  Recommended task executor category: deep-low（探查性结论可自行验证）
- [ ] 17. 工具启停实现：项目级保底+会话级条件交付
  What to do / Must NOT do: 依 16 结论——保底交付项目级：settings 项目级逐工具开关+配置写入+生效路径（运行时即时或提示重启）；会话级差异化仅当 16 证实运行时 RPC 面可达才交付（否则记 docs/08 后续批，UI 不留半成品开关）；工具列表来源复用现有工具枚举。Must NOT：不造新配置文件格式（沿用项目现有配置面）。
  Closes: GAP-14（实现部分）
  Parallelization: Wave 4 | Blocked by: 16 | Blocks: 无
  References: task-16 spike 报告；settings 页；工具枚举（现有工具列表源）；配置写入路径；docs/08 第 42 行条目
  Acceptance criteria: 项目级：关闭某工具→新请求该工具不被调用（工具列表或行为验证）；重开恢复；配置持久化（重启后保持）。会话级（条件分支）：仅当 16 判可达时——会话级开关覆盖项目级，验收同上
  QA scenarios: happy—关某工具后引擎不调用；failure—全部关闭时空工具集不崩（明确降级提示）。Evidence <attemptDir>/task-17-r10-2026-10-27-batch.txt
  Commit: Y | feat(tools): 项目级工具启停（会话级依 spike 条件交付）
  Recommended task executor category: unspecified-high（依 spike 跨 UI+配置+生效链路）
- [ ] 18. 会话 rebind：旧目录会话导入重绑
  What to do / Must NOT do: settings 加"导入旧目录会话"入口——选旧仓库目录→扫描其会话存储（JSONL+meta）→路径重绑后入当前列表；导入会话可打开续聊消息完整。Must NOT：不移动/复制源目录文件（仅登记引用）；不做批量目录监控。
  Closes: GAP-15
  Parallelization: Wave 2 | Blocked by: 无 | Blocks: 无
  References: meta.db（会话登记）；会话存储路径解析；settings 页；docs/08 第 46 行条目
  Acceptance criteria: 指向旧目录→旧会话出现在列表→打开消息完整→续聊正常；无效路径/无会话目录报错不崩
  QA scenarios: happy—移动后目录 rebind 找回续聊；failure—选空目录/无效路径报错不崩。Evidence <attemptDir>/task-18-r10-2026-10-27-batch.png
  Commit: Y | feat(sessions): 旧目录会话导入重绑
  Recommended task executor category: unspecified-high（目录扫描+路径重绑+入口跨面）

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit
- [ ] F2. Code quality review
- [ ] F3. Real manual QA
- [ ] F4. Ideal-state fidelity

## Commit strategy
- 每实施 todo 一个提交（16 个代码提交；spike 10/16 无提交）；提交信息中文、type(scope): summary 格式，不加署名尾注
