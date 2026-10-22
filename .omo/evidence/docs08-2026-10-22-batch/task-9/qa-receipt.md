# 任务 9 QA 回执：右栏成本全景卡片（docs08-2026-10-22-batch）

- 分支 docs08-r7-wave1-t9（worktree /data/projects/senpi-webui-wt/docs08-r7-wave1-t9），基点 main@784a209
- 实例：worktree 隔离实例 http://127.0.0.1:8959（UL_OMO_WEBUI_PORT/DATA_DIR/AGENT_DIR/META_DB/PASSWORD 全指向 /tmp/t9-qa/*）；根构建 `npm run build` 后 `node server/dist/index.js`
- 伺服 bundle：index-mGUPGGLd.js；线上字节 sha256 = 磁盘 sha256 = `436906f83d222b8a94bd83851eb5ecc65086478641cb31a289dbe50eb8f10add`（stale_state 防陈旧产物证明，PASS bundle 新鲜）
- fixture 注入：CDP 级路由拦截（playwright-core context.route）——`/api/usage*` 返回真实形态 usage 快照（tokens 57k 分项 + cost 1.5 + turnSpeed 45.6 tok/s）；`/api/sessions/*/messages*` 返回真实形态 MessagesPage（assistant 条目带 per-entry usage.cost.total/model/toolCall，task 子代理 toolResult 带 run_stats.cost_usd=0.1486）；会话为 fixture jsonl（`--tmp-t9-qa-proj--` 双横线尾缀目录 + `{"type":"session","version":3}` 头）；无新端点、无组件 mock，与 web/tests/stat-panel-panorama.test.tsx 同构
- 视口：桌面 1920x1080 与手机 390x844（iPhone 档，playwright viewport + isMobile/hasTouch）
- 断言：26/26 PASS（results.json 全量；含双档各 12 项 + 项目注册 + bundle 新鲜）
  - 成本双数字：累计 $1.5000 / 今日 $0.3500（stat-cost-value 仍为快照累计——既有行零漂移）
  - 按模型拆分降序两行：glm-5.3-4k $0.2500 / glm-4.6v $0.1000（320px 抽屉内两行齐）
  - 缓存命中率 16%（9000/57000）；末回合 45.6 tok/s
  - 耗时估算：模型（估）2m 0s / 工具 1m 0s（toolCall→toolResult 配对 60s + 后继窗 60s）
  - 子代理花费：扫描目录 $0.1486 + 合计 $0.1486
  - 区块无 NaN；390 无横向溢出（scrollWidth=390=clientWidth；桌面 1920=1920）
- 截图：desktop-1920.png（全卡六分区实拍）；mobile-390.png（390 抽屉上半：双数字+模型拆分+命中率）；mobile-390-2.png（390 抽屉下半：耗时估算+子代理合计）
- 浏览器坑位实测（对 quirk 12/13 补充）：右栏抽屉为 fixed 平移隐藏（关态 left≈390 越界）——getClientRects 非空/offsetParent 判定均失效，须验包围盒与视口相交；320px 抽屉页签条横向溢出，Stats 页签被裁出视口，须 scrollIntoView 后 DOM 点击；页面同时挂载桌面右栏与手机抽屉双副本（一套 CSS 隐藏），querySelectorAll 断言须按分区作用域化
- 单测：web vitest 799/799（基线 786 净增 13：stat-panel-data.test.ts 10 项含跨日界/零 usage 非 NaN/单条目/大额累计/负跨度丢弃，stat-panel-panorama.test.tsx 3 项含 fallback 零值与区块隐藏）；tsc -b exit 0；oxlint 全仓 7 警告 = 基线 0 增（渲染期 Date.now 纯度问题以快照时刻 usageAt 状态化解决）；i18n zh+en 键同步（chat.statPanel.{costToday,cacheRate,lastTurn,timeTitle,timeModel,timeTool,subagentsTitle,subagentTotal}）
- 清理收据：隔离实例 server 进程 SIGTERM 已退（端口 8959 释放实查 ss）；浏览器实例 close；/tmp/t9-qa 与 /tmp/t9-build.log、/tmp/t9-npm-install.log 全部删除；worktree 内无临时文件残留（git status 仅 6 个任务文件）；并行任务 t11 的实例（port 8961）非本任务产物未触碰
