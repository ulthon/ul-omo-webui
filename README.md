# ul-omo-webui

senpi/omo 引擎的 Web 工作台。自托管、单用户，功能集对标 opencode v1 TUI，兼容手机浏览器。

[English](README.en.md)

## 项目是什么

这是一个跑在引擎旁边的 Web 客户端：Hono Node 服务器托管一个 React 19 + Vite 构建的 SPA，通过 REST 上行、SSE 下行与引擎通信。会话在服务端运行，手机锁屏或杀掉浏览器都不影响执行，回来刷新即见结果。

主要功能：

- 多会话管理：侧栏会话列表，新建、切换、删除、搜索、置顶、归档、排序，未读计数与运行状态标识
- 对话流：SSE 增量渲染、Markdown 与代码高亮（Shiki）、thinking 折叠、虚拟列表支撑长会话
- 工具调用卡片：名称、参数摘要、运行状态、结果折叠，diff 视图（react-diff-view）
- 权限确认：卡片式 允许/拒绝/总是允许，触控友好
- todo 任务结构化渲染、子代理面板、问题卡片、记忆面板、统计面板
- 文件树 + 只读预览，@引用进对话；内置文件管理（上传/下载/编辑）
- Git 只读视图：未提交变更总览（git status/diff 渲染）
- 项目管理：按工作目录分组会话，项目级偏好（记住 agent/模型），引擎 systemd 生命周期托管（按项目 spawn、重启、空闲回收）
- 自动会话命名、输入草稿跨设备续写、基础命令（/compact /clear /new /undo）、中断按钮

## 快速上手

前置条件：

- Node.js >= 24（服务器使用 node:sqlite，package.json engines 强制 >=24）
- omo/senpi 引擎可用（`@code-yeongyu/senpi` 等引擎包为 external 依赖，运行时从 node_modules 解析）

安装与构建（仓库为 npm workspace，根目录执行）：

```bash
npm install
npm run build   # 构建 web 前端并打包 server/dist/index.js（esbuild 单文件 bundle，静态资产内嵌）
```

启动服务器：

```bash
node server/dist/index.js
# 或开发模式（只构建 server，跳过前端）：
cd server && npm run dev
```

默认监听 `0.0.0.0:7788`，浏览器打开 <http://localhost:7788>。首次启动若未设置 `UL_OMO_WEBUI_PASSWORD`，服务器会生成随机密码打印到控制台并写入数据目录的 `password` 文件，用它登录即可。

### 生产部署（systemd）

推荐直接用内置 CLI 生成服务（快照当前环境变量进服务定义，改环境后需重新 enable）：

```bash
ul-omo-webui startup enable [--system]
```

也可手写单元，形如（对应 `server/src/startup.ts` 生成的格式）：

```ini
[Unit]
Description=ul-omo-webui (senpi/omo web workbench)
After=network-online.target

[Service]
ExecStart=/usr/bin/node /usr/lib/node_modules/@ulthon/ul-omo-webui/server/dist/index.js
Restart=on-failure
RestartSec=3
Environment=UL_OMO_WEBUI_PORT=7788
Environment=UL_OMO_WEBUI_PASSWORD=你的密码
Environment=UL_OMO_WEBUI_DATA_DIR=/var/lib/ul-omo-webui

[Install]
WantedBy=multi-user.target
```

用户级服务（`--user`）需要 `loginctl enable-linger` 才能不登录常驻；系统级服务（`--system`）无此依赖，单元文件会收紧到 600 权限。详见 docs/09-自启动与更新立项.md。

## 环境变量全表

以下为服务器代码实际读取的全部环境变量（来源：`server/src/config.ts`、`obs/logger.ts`、`auth/password.ts`、`api/perf.ts`、`api/http.ts`、`conf/config-store.ts`、`title-gen.ts`、`engine/schedule-runner.ts`、`engine/process-manager.ts`、`api/routes-memory.ts`）。

| 变量名 | 默认值 | 作用 |
|---|---|---|
| UL_OMO_WEBUI_HOST | 0.0.0.0 | 监听地址 |
| UL_OMO_WEBUI_PORT | 7788 | 监听端口，非法值启动即退出 |
| UL_OMO_WEBUI_DATA_DIR | 源码形态 server/data；npm 安装形态平台数据目录（Linux 按 XDG_DATA_HOME，缺省 ~/.local/share/ul-omo-webui；macOS Library/Application Support；Windows 按 APPDATA） | 运行数据目录（元数据库、日志、PID 登记表、密码文件等） |
| UL_OMO_WEBUI_STATIC_DIR | 源码形态 web/dist | 磁盘静态资源目录，仅源码形态与显式覆盖时读取，安装形态走内嵌资产 |
| UL_OMO_WEBUI_META_DB | DATA_DIR/meta.db | 元数据库（sqlite）路径 |
| UL_OMO_WEBUI_AGENT_DIR | ~/.omo/agent | 引擎 agent 目录（凭证、自定义模型、会话库），spawn 与 SDK 路径推导同源 |
| UL_OMO_WEBUI_SITE_NAME | 未设置 | 自定义站点名，注入标签页标题与顶栏/登录页呈现；空串视为未设置 |
| UL_OMO_WEBUI_PASSWORD | 未设置时首次随机生成，写入 DATA_DIR/password | 登录密码 |
| UL_OMO_WEBUI_LOG_LEVEL | info | 观测日志级别（trace/debug/info/warn/error） |
| UL_OMO_WEBUI_LOG_FILE | 开启 | 日志文件落盘开关（0/false/no/off 关闭）；目录随 DATA_DIR/logs，按天滚动保留 7 天 |
| UL_OMO_WEBUI_DEBUG_SSE | 关闭 | SSE 链路诊断日志（连接建立/状态迁移/帧写出） |
| UL_OMO_WEBUI_DEBUG_PERF | 关闭 | 性能埋点日志（切换链路四层耗时归因） |
| UL_OMO_WEBUI_SLOW_MS | 1000 | 慢请求告警阈值（毫秒） |
| UL_OMO_WEBUI_FS_UPLOAD_MAX_BYTES | 1073741824（1 GiB） | 内置文件管理上传上限，非法值告警后回退默认 |
| UL_OMO_WEBUI_CONFIG_DIR | ~/.config/ul-omo-webui | 全局配置存储目录 |
| UL_OMO_WEBUI_TITLE_BASEURL | https://api.z.ai/api/coding/paas/v4/chat/completions | 会话自动命名调用的 API 端点 |
| UL_OMO_WEBUI_TITLE_MODEL | zai-coding-cn/glm-5.3-flash | 自动命名使用的模型 |
| UL_OMO_WEBUI_TITLE_LANG | 缺省随设置（zh） | 自动命名语言，仅接受 zh/en |
| UL_OMO_WEBUI_SCHEDULE_DELIVER_URL | 未设置 | 计划任务结果投递的 Webhook 地址 |
| UL_OMO_WEBUI_SCHEDULE_DELIVER_TOKEN | 未设置 | 投递 Webhook 的 Bearer Token |
| SENPI_ENGINE_PROBE_GATE | 关闭 | 引擎进程探针门控开关（引擎子进程管理器读取） |
| OMO_MEMORY_HOME | ~/.omo/memory | 记忆目录（记忆路由读取） |

另：`XDG_DATA_HOME`（Linux）与 `APPDATA`（Windows）会间接影响数据目录默认值；systemd 用户单元会显式带入 enable 时的 `PATH`（引擎子进程 spawn node 需要）。

## 目录结构

```
senpi-webui/
├── server/            # Hono Node 服务器
│   ├── src/           # 入口 cli.ts/index.ts、config.ts、engine/（子进程管理）、api/（REST+SSE 路由）、auth/、db/、obs/
│   ├── test/          # vitest 测试套件
│   └── dist/          # 构建产物（gitignore）
├── web/               # React + Vite SPA
│   ├── src/components/chat/   # 会话、消息流、工具卡片、权限、todo、子代理等聊天界面组件
│   ├── tests/         # vitest 测试套件
│   └── dist/          # 构建产物（gitignore）
├── docs/              # 设计文档
├── scripts/           # 构建脚本（build-package.mjs：esbuild 打包；build-binary.ts）
└── deploy/            # 部署辅助
```

## 文档索引

- [01-功能清单.md](docs/01-功能清单.md)：功能范围与边界
- [02-技术选型.md](docs/02-技术选型.md)：技术栈与理由
- [03-架构设计.md](docs/03-架构设计.md)：总体架构与引擎适配
- [09-自启动与更新立项.md](docs/09-自启动与更新立项.md)：自启动服务与更新机制

## 截图

<!-- TODO: 真图后补，放到 docs/screenshots/ 下 -->

<!--
<img src="docs/screenshots/desktop-session.png" alt="桌面端会话" width="800">
<img src="docs/screenshots/mobile-session.png" alt="手机端会话" width="390">
<img src="docs/screenshots/permission-card.png" alt="权限确认卡片" width="390">
-->

## 开发指南

```bash
npm test                          # 根目录跑全部 workspace 测试（vitest）
cd web && npm run dev             # 前端开发服务器（Vite HMR）
cd server && npm run dev          # 只构建 server 后启动（跳过前端构建）
cd web && npm run build           # tsc -b 类型检查 + vite build
cd web && npm run lint            # oxlint
cd web && npm run scan:cn         # 硬编码中文扫描
```

- 测试：server 与 web 各有 vitest 套件（`server/test`、`web/tests`），根目录 `npm test` 一键运行
- 类型检查：web 构建含 `tsc -b` 门禁；server 构建由 esbuild 打包
- 提交代码前建议跑一遍 `npm test` 与 web 的 `tsc -b`
