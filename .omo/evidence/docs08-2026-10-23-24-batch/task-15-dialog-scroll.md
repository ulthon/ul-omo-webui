# 任务 15：DialogContent 通用滚动修复（docs08-2026-10-23-24 批次）

worktree：`docs08-batch-w2-t15`（基于 main@25d71da）。单提交。

## 变更

`web/src/components/ui/dialog.tsx` DialogContent 基础类：

- 改前：`fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 …`
- 改后：`fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] min-w-0 w-full max-w-[calc(100%-2rem)] overflow-y-auto -translate-x-1/2 …`

三个新增类：`max-h-[calc(100dvh-2rem)]`（高度约束，100dvh 而非 100vh——iOS Safari 动态视口语义）、`overflow-y-auto`（内部滚动）、`min-w-0`（Radix grid 轨道被长 truncate 行撑爆的防护）。所有 DialogContent 消费点（topbar 设置/快捷键/模型、snippet-panel、file-picker、directory-tree、add-project、schedule、session-list 三处、tag-manage 共 16 处）自动受益。

附带：`web/src/components/session-list/tag-manage-dialog.tsx:406` 去掉自带 `max-h-[85vh] overflow-y-auto`。原因：本仓 `cn` 是纯类名拼接（无 tailwind-merge），保留会与基础类形成双 `max-h` 冲突（CSS 顺序不定）；基础类已覆盖其需求。

不做：全屏 sheet、分区折叠（按任务边界）。

## 单元测试

新增 `web/tests/dialog-content-scroll.test.tsx`（happy-dom + createRoot/act，Radix 真实原语）：
1. 基础类含 `max-h-[calc(100dvh-2rem)]` / `overflow-y-auto` / `min-w-0`；
2. 消费者自定义 className 正常拼接（宽度覆盖场景，高度约束仍在）。

## 套件与构建

- `npx vitest run`（web）：首跑冷启动 1 例偶发失败（1009/1010），随后 3 次全量 108 文件 / 1010 用例全绿；新测试单跑 5/5 稳定。
- 根 `npm run build`：EXIT=0（web 构建 2.68s + 内嵌资产 + server/dist/index.js 12.2mb）。

## 截图证据（手工 QA，先 390x844 后 1920x1080）

隔离实例（worktree 构建 + `UL_OMO_WEBUI_PORT=7801` 独立数据目录，QA 后已杀进程清目录），headless Chrome 153 CDP 设备模拟：

- `task15-mobile-390x844-settings-top.png`：手机档弹层顶部，Settings→Sidebar 分区，弹层 16~828px（812px 高，scrollHeight 3741px），宽度 16~374px 未撑爆视口（min-w-0 生效，truncate 行无 grid 爆轨）。
- `task15-mobile-390x844-settings-bottom.png`：同一弹层 scrollTop 滚到底（3074px），最后分区 Language + Close 钮可见。
- `task15-desktop-1920x1080-settings.png`：桌面档居中（left 736/right 1184，top 16/bottom 1064，maxHeight 计算值 1048px = 1080-32），中部滚动态布局无回归。

## sticky 保存钮核验

设置弹层内 `position: sticky` 元素实测为 0（滚动 scrollTop=500/1000 两次核验）——本弹层本就没有 sticky 保存钮，底部动作区随内容滚动，底部截图可见 Close 在内容末尾，行为与改前一致，无回归。max-h + overflow 生效后内容不再被视口裁切。

## 计算样式实测

- 手机 390x844：maxHeight=812px（=100dvh-2rem）、overflowY=auto、scrollHeight 3741 > clientHeight 812 → 可滚。
- 桌面 1920x1080：maxHeight=1048px、overflowY=auto。
