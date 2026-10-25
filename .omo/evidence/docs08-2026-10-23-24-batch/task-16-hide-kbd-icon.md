# 任务 16：手机档隐藏快捷键帮助图标（docs08-2026-10-23-24 批次）

worktree：`docs08-batch-w2-t16`（基于 main@97a2b3c）。单提交。

## 变更

`web/src/components/layout/topbar.tsx` 手机档右簇（isMobile 分支）：移除快捷键帮助钮（`data-testid="shortcuts-help-button"`，Keyboard 图标），原位置留注释说明（docs08-2026-10-23-24 任务 16）。桌面档（else 分支）同款钮原样保留、行为不变。i18n 无变动——`shortcuts.title` 等词条桌面档仍在用，无孤儿词条。

不做：触屏手势说明；桌面档任何改动。

## 测试

新增 `web/tests/topbar-mobile-kbd-help.test.tsx`（happy-dom 全局注册 + createRoot/act 真实点击，matchMedia 探针控制 isMobile，惯例同 topbar-mobile-add-project.test.tsx）：

1. 手机档渲染：`shortcuts-help-button` 不存在（同时断言 `settings-button` 仍在，右簇未被误删）。
2. 桌面档渲染（回归）：钮存在，点击后 ui store `shortcutsHelpOpen=true` 且快捷键对话框真实挂载、文案含「快捷键」。

## 套件与构建

- `cd web && npx vitest run tests/topbar-mobile-kbd-help.test.tsx`：1 文件 / 2 用例全绿。
- `cd web && npx vitest run`：108 文件 / 1020 用例全绿（13.24s）。
- 根 `npm run build`：EXIT=0（内嵌资产 330 文件，server/dist/index.js 12.2mb）。

## 截图证据（手工 QA，CDP 真实渲染）

方法：隔离实例（worktree 构建 + `UL_OMO_WEBUI_PORT=7816`、独立数据目录 `/tmp/docs08-t16-qa-data`，会话 cookie 经 HMAC 直构 + 本地转发代理注入，chrome 无需登录），headless Chrome（`--headless=new --remote-debugging-port=9223`）CDP `Emulation.setDeviceMetricsOverride` 设定视口 → `Page.navigate` → 等首屏后 `Page.captureScreenshot`。QA 后已杀 server/chrome、清 profile 与数据目录。

- `task16-mobile-390x844-topbar.png`（390x844，10591 bytes）：手机档顶栏，DOM 断言同帧 `shortcuts-help-button` 计数 0、`settings-button`/`todo-panel-toggle` 各 1（右簇其余钮完好）。
- `task16-desktop-1920x1080-topbar.png`（1920x1080，35335 bytes）：桌面档顶栏，DOM 断言同帧 `shortcuts-help-button` 计数 1、`settings-button` 1（桌面档钮在，行为无回归）。

截图均为 PNG IHDR 实测尺寸（390x844 / 1920x1080），非缩放占位。

## 结论

手机档快捷键帮助图标已隐藏（DOM 级不存在），桌面档入口与对话框打开行为经单测 + 真浏览器双重回归通过。
