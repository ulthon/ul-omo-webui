# 任务 12:快捷键对话框与 aria 覆盖 — QA 实录(docs08-2026-10-22-batch)

- 实现:lib/shortcuts.ts 注册表(键位显示串唯一来源+触发谓词)、lib/use-shortcuts-help.ts(? / Ctrl+K 全局触发)、layout/shortcuts-dialog.tsx(注册表驱动渲染)、topbar 双簇帮助钮、i18n shortcuts.*(zh/en 齐键)、ui store shortcutsHelpOpen;shell useCtrlPModelPicker 与 composer Enter 发送改引注册表谓词(逐字等价,行为不变)。
- 快捷键清单(注册表 5 组 13 条,来源 grep keydown 全量枚举,双向核对):全局(Ctrl+P/⌘P 模型选择、?/Ctrl+K/⌘K 本帮助)、输入区(Enter 发送、Shift+Enter 换行、@ 文件引用)、输入历史(↑ 调出、↓ 回新、Esc 退出)、斜杠命令(/ 打开、↑↓ 高亮、Enter 选择、Esc 关闭回退)、弹层与面板(Esc 关闭)。

## 实例与新鲜度(stale_state 对抗)

- 隔离 QA 实例:UL_OMO_WEBUI_PORT=7793、DATA_DIR/AGENT_DIR 独立(/tmp/t12-qa),fixture 项目 /tmp/t12-qa/proj + 150 轮长会话(301 条目,滚动高 34684px)。
- QA 前全量重建:cd web && npm run build(tsc -b && vite build)后 node scripts/build-package.mjs --server-only。
- **bundle 哈希(伺服=磁盘核对一致)**:入口 `web/dist/assets/index-CWOrgMww.js`,sha256 = `23efb68edd433280`…(全表 bundle-hashes 同目录 json;index.html 引用同名,无陈旧产物)。

## 桌面 1920x1080(zh-CN,真实 Chrome headless + CDP 实键)

1. 登录页不挂(failure 场景):/login 渲染正常;密码框聚焦态实键 `?` → 字段值收 "?"(无劫持);登录成功进 shell(login-1920.png)。
2. `?` 键开对话框:role=dialog、aria-labelledby 在场;5 组 13 条逐条在场(与注册表双向一致);几何居中(x=736,w=448 @1920),scrollWidth=1920=innerWidth 零溢出(desktop-1920-help-open.png)。
3. 焦点圈:Tab 走查——对话框内唯一可聚焦元为关闭钮,焦点循环不逃逸;Escape 关闭复验(after-escape 截图 + DOM 断言)。
4. 长会话边界(boundary):fixture 长会话滚动至中部,`?` 开对话框悬浮居中,scrollWidth=1920 零横向溢出,消息流/composer 无布局破坏(desktop-1920-long-chat-dialog.png)。
5. 回归冒烟:composer 输入 `/` → 斜杠菜单开(引擎命令列表出),Escape 关闭且回退输入(值复原空,desktop-1920-slash-menu.png);Ctrl+P(实例无模型)→ 弹层不开、无崩溃(既有「无可用模型不开」防呆保持);页面存活。

## 手机 390x844(iphone-14 档)

- 帮助钮在顶栏右簇在场:44×44、aria-label「键盘快捷键」——无键盘档的 UI 入口(计划「顶栏帮助钮挂载」,非 desktop-only)。
- 点击开对话框:358px 宽居中,内滚生效(弹层与面板组在滚动区内),scrollWidth=390 零横向溢出;X 钮与 Escape 双路关闭复验(mobile-390-help-open.png)。
- 既有行为注记:会话打开时右栏抽屉自动展开为现状行为(记忆坑位 12,非本任务引入),关抽屉后重开对话框截图验证。

## 测试(vitest,基线 812 → 819)

- tests/shortcuts-dialog.test.tsx 7 条:注册表结构(≥5 组、id 唯一、双语词条键可解析)、对话框渲染双向核对(每条分组名/描述/键位串都在渲染结果)、开关态零漂移(open=false 不渲染/true 渲染标题壳——空注册表鲁棒形态)、`?` 触发、Ctrl/⌘+K 触发、非触发键+可编辑目标+IME 组合三重让路、[role=dialog] 目标守卫、radix Escape 关闭落回 store。
- 全量:`cd web && npx vitest run` → **87 文件 819/819 通过**(基线 812 净增 7);`npx tsc -b` 退出码 0;`npx oxlint` 全仓 7 警告(=基线,只减不增达标),变更文件 0 警告。
- scan:cn:仅剩 event-dispatch.ts:71/96 两处基线遗留(计划任务 29 领地,本任务变更文件零违规)。

## 清理

- QA 实例进程(kill 7793 监听)、owned Chrome 及 profile、/tmp/t12-qa 全部拆除;无 /tmp/t12-* 残留。
