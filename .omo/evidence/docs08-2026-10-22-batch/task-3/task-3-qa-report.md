# 任务 3 QA 证据：大段粘贴零点击三态改造与占位符语法教学

- 实例：worktree docs08-r7-wave1-t3 隔离实例 http://127.0.0.1:8952（UL_OMO_WEBUI_DATA_DIR=/tmp/t3-qa-data，UL_OMO_WEBUI_AGENT_DIR=/tmp/t3-qa-agent，UL_OMO_WEBUI_PASSWORD 注入；server/dist 内嵌资产伺服）
- 伺服 bundle：index-BqhaOkG8.js；sha256 磁盘与线上字节一致：
  - dist:   `c5607672ce553ed09afc7ac2429ba9fa617b77acc1fa5e85935e7b00aa4357e8`
  - served: `c5607672ce553ed09afc7ac2429ba9fa617b77acc1fa5e85935e7b00aa4357e8`
- 视口：桌面 1920x1080（CDP 设备模拟），移动 390x844 iPhone-14 档（innerWidth 实测 390）
- 断言结果：17/17 PASS（results.json 全量明细；progress.log 含每步网络回执）
- 用例覆盖：
  - 零点击：粘贴 7.5KB（CJK）不出选择条、chip 即挂且勾选框默认勾选（D2a/D2b）
  - 上传落定：POST 201 → chip 由加载态转就绪显示服务端文件名（D2c）
  - 取消勾选：文本立即入输入框（UTF-8 7500 字节精确断言）、chip 消失、best-effort DELETE 200（D3a/D3b）
  - 叉除：移除 + DELETE 200（D4）
  - POST 500（路由拦截 mock）：chip 不出现、原文完整回插输入框、toast 弹出（D5）——内容永不丢
  - 边界：恰 4096 字节不拦截不出 chip（D6a）；4097 字节出 chip（D6b）
  - 在途取消（对抗项）：POST 延迟 2.5s 期间取消勾选——加载 spinner 可见（D7-pre）、chip 一致消失、文本回插（D7a）、落定后孤儿文件 DELETE 200（D7b）
  - 占位符教学：桌面「@ 引用文件 / 斜杠命令 / # 代码片段」（D1）；移动精简「@ 文件 / 命令 / # 片段」（M0，innerWidth=390）
  - 移动全链路：chip 勾选（M1）→ 取消勾选文本入框 + DELETE（M2）
- 截图：desktop-0-initial / desktop-1-chip-checked / desktop-2-uncheck-inserted / desktop-3-x-removed / desktop-4-post-500-fallback / boundary-4096-no-chip / boundary-4097-chip / desktop-5-uncheck-inflight / mobile-1-placeholder / mobile-2-chip-checked / mobile-3-uncheck-inserted
- 环境备注：desktop-0-initial.png 底部深色 toast 为共享 /root/.omo omo.json 弃用告警（引擎环境噪声，与本任务无关）；D5 的 toast 断言以 [role=status] 元素存在判定。
