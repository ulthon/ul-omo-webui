# task-25 手动 QA 走查（隔离实例 :7791，伺服 bundle assets/index-BlxEQTYp.js = 磁盘最终构建 sha16 b9d1cd17（关闭派生重构后重建；全部截图摄于重构前 bundle index-mzzUDyFH.js，行为一致，重构为 lint 净化的等价实现，冒烟复核通过））

前置：fixture 空会话（每次打开前重置为纯头行，保证真空态；应用打开会话时引擎侧会追加条目属正常行为）；GET /api/tips 与 CLI --list-tips 对拍 124 条逐一相等（见 cli-vs-api.txt）。

1. login ok（桌面 1920x1080）
2. zh 空态 tip 卡（换一条）显示 CLI tip[0]
3. shot desktop-zh-tip.png
4. 换一条轮换 -> Use /efforts <level> to set the reasoning effort for th
5. shot desktop-zh-tip-rotated.png
6. 关闭后本会话不再显：干净空态下刷新仍无卡（localStorage=1）
7. shot desktop-zh-dismissed-after-reload.png
8. 设置「提示」分区在场且默认开（会话空态显示用法提示卡（内容来自 omo CLI）；关闭…）；定时任务/标签/语言分区同屏（回归 t22/t20）
9. shot desktop-zh-settings.png
10. 开关关 -> 无 tip 区
11. shot desktop-zh-toggle-off.png
12. 开关重开 -> 卡恢复（重开清除关闭记忆，修复后行为）
13. shot desktop-zh-toggle-on-restored.png
14. 会话中途切 en：next=Show another，label=Tip
15. shot desktop-en-tip.png
16. 切回 zh 即时生效
17. 接口断供 -> 无 tip 区无报错 toast（clean）
18. shot desktop-zh-api-failure.png
19. 恢复供给 -> 卡回来
20. 600+ 字 tip 折行无溢出（{"overflowText":false,"cardInViewport":true,"w":384}）
21. shot desktop-zh-long-tip.png
22. patch 移除，真实 tips 回归
23. shot desktop-zh-shortcuts.png
24. 快捷键面板开合正常（t12 回归）
25. 手机 390x844 tip 卡完整可视（{"inViewport":true,"w":318,"vw":390}）
26. shot mobile-zh-tip.png
