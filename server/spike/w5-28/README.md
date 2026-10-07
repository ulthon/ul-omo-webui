# W5 todo 28 稳定性浸泡验证脚本

三项场景的可复跑驱动脚本（playwright 本地脚本模式，chrome executablePath + --no-sandbox）。

## 运行前置

- 服务：`SENPI_WEBUI_PORT=17962 SENPI_WEBUI_DATA_DIR=/tmp/opencode/w5-28-data SENPI_WEBUI_PASSWORD=w5soak-qa`（隔离 DATA_DIR，后台 setsid 起）
- 项目：`/tmp/opencode/w5-28-proj`（git init 的隔离目录）
- 模型：`zai-coding-cn/glm-5.3-flash` thinking low
- playwright-core 不在依赖清单（docs/02）内：脚本运行目录需临时提供可解析的 playwright-core（QA 惯例：临时目录 node_modules 链接，或 `bun --cwd <有 playwright-core 的目录> run <脚本>`），不进入任何 package.json
- iptables 断网（net-cut.ts）需 root；规则用完即删（脚本内含兜底清理）

## 脚本与场景对应

| 脚本 | 场景 | 判据 |
|---|---|---|
| soak.ts | (c) 30 分钟长会话 soak | 12 条短 prompt 串行、min-10/20/28 三次刷新、终态三源比对 |
| kill-engine.ts | (a) 流式中 kill -9 引擎主进程 | /proc 精确定位（cwd+cmdline 单字段 "senpi"）、重启耗时、composer 解锁、历史完整、可继续 |
| net-cut.ts | (b) 流式中断网 10s | iptables OUTPUT REJECT tcp-reset、传输路径 hook（EventSource/fetch）、END-MARKER 完整性 |
| soak-verify.ts | (c) 终态比对 | REST messages/usage vs jsonl 磁盘 vs 页面状态条 + 内存采样（CDP Performance.enable） |

执行记录（2026-10-07）：`.omo/qa/W5/soak.md`；原始日志/截图留存 `/tmp/opencode/w5-28-qa/` 与 `/tmp/opencode/w5-28-data/`。
