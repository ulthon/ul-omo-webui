# 任务 13 忙碌动画族四位置接入 QA 报告（docs08-2026-10-22-batch）

- 实例：worktree docs08-r7-wave1-t13 隔离实例 http://127.0.0.1:8953（UL_OMO_WEBUI_DATA_DIR=/tmp/t13-qa-data，UL_OMO_WEBUI_AGENT_DIR=/tmp/t13-qa-agent（播种生产 models/auth/settings 等配置 json），UL_OMO_WEBUI_PASSWORD 注入；server/dist 内嵌资产伺服）
- 陈旧产物防线（F3 教训）：QA 前根构建 `npm run build` 重建内嵌资产并重启实例；curl 探针核对线上 bundle 与磁盘一致
- bundle：磁盘 web/dist/assets/index-tDzYj7go.js = 线上伺服 assets/index-tDzYj7go.js（一致）
- 视口：桌面 1920x1080（omowright.emulate，goto 后重打）；手机 390x844（mobile+hasTouch，状态点经「打开侧栏」抽屉捕获）
- 真实引擎：计数回合（请从 1 数到 3000）经 composer 实发，状态点/排队条在真实回合中采样

## 四位置忙碌态证据（动画态）

| 位置 | 截图 | 数值证据 |
| --- | --- | --- |
| 1 composer 发送钮 | desktop-3-send-busy.png | POST 在途 send-btn 挂 animate-busy-pulse（DOM 类由 busy-motion.test.tsx「POST 在途发送钮呼吸」断言），无 animate-spin，disabled 保持 |
| 2 QueueBar 排队条 | desktop-2-queue-wave.png | 3 行排队各行 [data-testid=queue-item-wave] 内 busy-wave-bar×3（截图中 \|\|\| 波形可见），无 animate-spin/animate-pulse |
| 3 会话行状态点 | desktop-1-dot-running.png | 侧栏两点 bg-sky-500 + animate-busy-pulse（真实回合 agent_start 后） |
| 4 chat 首载骨架 | desktop-4-skeleton.png | [role=status] img[src=/favicon.svg] animationName=busy-pulse + busy-dot×3（竞速轮询实测值） |

## reduced-motion 降级（--force-prefers-reduced-motion 启动参数；matchMedia reduce 实测 true）

omowright 管道 CDP 不暴露 Emulation/Network 域（setEmulatedMedia/setCPUThrottlingRate 均 -32601），降级验证改用浏览器启动参数，等效命中同一 CSS 媒体查询。

| 位置 | 截图 | 实测值 |
| --- | --- | --- |
| 状态点 | desktop-5-rm-dot-static.png | animationName=none，backgroundColor=oklch(0.685 0.169 237.323)（sky-500 保持可辨） |
| QueueBar | desktop-6-rm-queue-static.png | 波形条 animationName=none（等高三竖线静态形态） |
| 发送钮 | desktop-7-rm-send-static.png | animate-busy-pulse 类仍在，animationName=none |
| 骨架 | desktop-8-rm-skeleton-static.png | img animationName=none、busy-dot animationName=none、src=/favicon.svg |

（results-rm.json：matchMediaReduce=true，rmDot/rmQueue/rmSend/rmSkeleton 全 anim=none）

## 手机档 390x844

mobile-1-dot-running.png（抽屉内运行中点）、mobile-2-queue-wave.png（排队条波形）、mobile-3-send-busy.png（发送钮呼吸）、mobile-4-skeleton.png（首载骨架）。

## 回归

- 真实引擎回合跑通：发送→流式（计数）→排队 3 条→QueueBar 显示→abort 收尾；发送钮动画包装未破坏发送链路（单测「POST 在途发送钮呼吸，回执后恢复直发」+ 浏览器实发均验证）
- vitest：77 文件 738 用例全绿（基线 731 → 738，净增 7）
- tsc -b 干净；oxlint 变更文件 0 警告 0 错误
- 位置无 spinner 残留 grep：四位置文件中 send-btn/queue-bar/StatusDot/ChatLoadSkeleton 无 animate-spin、无通用 animate-pulse（session-item StatusDot 两处 animate-pulse 已替换为 animate-busy-pulse；composer 权限锁提示点与模型徽标非本任务目标位，保持原样）

## 环境注记（非产品缺陷）

- 隔离实例新 agentDir 首会话触发引擎 onboarding 回合时，QA 脚本经 UI 逐张应答（跳过）后再发正式 prompt
- greeting 回合若在页面水合前已发 agent_start，SSE runState 错过则状态点在 SSE 帧活动前保持灰——生产路径（用户点击发送触发回合）不受影响（会话列表服务端探询 runState 为兜底）
- omowright 管道 CDP 仅 Emulation.setDeviceMetricsOverride 可用；Network/CPU 节流与 setEmulatedMedia 不可达——骨架窗用 newTab 竞速轮询（80ms/40ms 步进）捕获，reduced-motion 用启动参数
