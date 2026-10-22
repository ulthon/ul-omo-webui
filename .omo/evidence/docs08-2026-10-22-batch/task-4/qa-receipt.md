# 任务 4 手机档添加项目入口 QA 回执（docs08-2026-10-22-batch）

- 分支 docs08-r7-wave1-t4，基点 main@52ae0c5
- 伺服 bundle：index-BvVU3Hgu.js（sha256 0710bd73f17d64389cfaee826a219b8eb4dc27d86366cf7cec7dd0d0bda45e14），fresh root build（npm run build）后 node server/dist/index.js 启动，GET / 伺服哈希与磁盘一致（无内嵌陈旧）
- 实例：8914=本任务构建（隔离 DATA_DIR/AGENT_DIR/META_DB=/tmp/t4-qa/*）；8915=main@52ae0c5 基线实例（对齐同数据态后 diff）
- 组件测试：web 全量 vitest 751/751（基线 748 净增 3）；tsc -b exit 0；oxlint 变更文件 0 告警
- 断言：
  1. 390x844 手机菜单尾项 mobile-add-project「Add project…」在（mobile-menu-tail.png）
  2. 尾项点击 → AddProjectDialog 打开（mobile-add-dialog.png）
  3. 真实添加 /tmp/t4-qa/proj-a → 侧栏出现 proj-a（mobile-after-add.png）
  4. 重复添加同路径 → 走弹框自身既有校验通道，项目列表恒 1 条，无重复行（mobile-duplicate-blocked.png）
  5. 设置面板项目管理头部 project-add-button → 弹框打开（mobile-settings-add-button.png / mobile-settings-add-dialog.png）
  6. 桌面 1920x1080 与基线实例像素 diff = 0（1296000 px 全等；desktop-t4-top.png / desktop-base-top.png）
- 备注：桌面 diff 前先归一右栏开关态与 cookie（双实例同 127.0.0.1 共享 cookie，需逐实例重登）
