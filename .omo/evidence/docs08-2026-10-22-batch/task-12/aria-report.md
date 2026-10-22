# 任务 12 aria 覆盖报告(docs08-2026-10-22-batch)

- 判据(计划原文):固定清单八文件(topbar/sidebar/composer/message-bubble/message-list/session-item/question-card/queue-bar)内,**纯图标 Button 的 aria-label 空值为零**;扫描手段固定 `grep aria-label`(未新增 axe-core 依赖);aria 修复不改视觉。
- 扫描时点:本分支实现完成后(worktree docs08-r7-wave1-t12,基线 main@073a588)。
- 扫描命令:`grep -n "aria-label" web/src/components/<file>`(八文件逐个)。

## 修前清单(grep aria-label,基线 main@073a588 等价态)

| 文件 | aria-label 处数 | 纯图标按钮清点 | 结论 |
| --- | --- | --- | --- |
| layout/topbar.tsx | 8 | 汉堡(openSidebar)、todo 入口、设置钮 ×2 档、会话身份区(aria-label 承载) | 全部有标签,零空白 |
| layout/sidebar.tsx | 1 | 抽屉关闭钮(closeDrawer + title) | 有标签 |
| composer/composer.tsx | 14 | 历史上下翻、图片移除、粘贴 chip 勾选/移除、附件、文件引用、图片添加、常用语、排队档位、停止、更多、发送 ×2 档 | 全部有标签,零空白 |
| chat/message-bubble.tsx | 0 | 无纯图标按钮(两处按钮均带可见文本:折叠/展开文案、loop-guard 标题徽标) | 判据满足(无目标对象) |
| chat/message-list.tsx | 0 | 无纯图标按钮(marker 折叠钮、压缩标记钮均带可见文本;jump-bottom 钮带「回到底部」文本) | 判据满足(无目标对象) |
| session-list/session-item.tsx | 3 | 行选中区、展开/折叠子会话、行菜单(MoreVertical) | 全部有标签 |
| chat/question-card.tsx | 0 | 无纯图标按钮(选项钮带文本、忽略钮带文本、提交钮带文本) | 判据满足(无目标对象) |
| chat/queue-bar.tsx | 2 | 两条目操作钮(立即发送/移除,SendHorizontal/X 纯图标) | 全部有标签 |

## 修后 diff

- 既有八文件:无需修复(修前已零空白),零改动——满足「aria 修复不改视觉」(无事可改)。
- 本任务新增面(自带可达名,不引入新空白):
  - topbar.tsx 桌面/手机两簇新增帮助钮各一枚(`data-testid="shortcuts-help-button"`,`aria-label={t("shortcuts.title")}` + title,Keyboard 图标,44px 触控)。
  - shortcuts-dialog.tsx 对话框:复用 ui/dialog.tsx radix 语义——`role="dialog"`、`aria-labelledby`(DialogTitle)、Escape 关闭、焦点圈(实测 Tab 只在关闭钮上循环不逃逸);描述文本挂 DialogDescription。
- 修后 grep 总数:topbar 10(8→10,新增两枚帮助钮)、其余文件不变;清单内纯图标 Button aria-label 空白值 **0(修前 0 → 修后 0)**。

## 实测佐证

- 桌面 1920:帮助钮 aria-label=「键盘快捷键」;对话框 role=dialog + aria-labelledby 在场(见 desktop-1920-help-open.png)。
- 手机 390:帮助钮 44×44、aria-label 同上,点击开对话框(见 mobile-390-help-open.png)。
