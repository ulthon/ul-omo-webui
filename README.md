# ul-omo-webui

senpi/omo 引擎的 web 工作台：功能集对标 opencode v1 TUI，兼容手机浏览器，自托管单用户。

## 三条核心理念

1. **同一引擎的第二前端**。web 版不是独立产品，而是 senpi 引擎的第二个 UI。会话数据、agent 配置、凭证、工作产出与命令行版完全同一份（关键保证：宿主 spawn 引擎子进程时继承相同的 HOME 与项目 cwd）。终端 TUI 聊到一半，手机浏览器打开同一个会话接着聊，零迁移。
2. **薄壳**。引擎不动，web 只做宿主：事件桥 + UI。不做 Electron、不做多服务器聚合、不做账号系统。单 Node/Bun 进程 + 一个 sqlite 元数据库。
3. **phpMyAdmin 模式**。核心只做"对话 + 会话 + 与对话直接联动的东西"。Git 历史浏览、文件管理等专门能力外链独立自托管工具（cgit / filebrowser），反代按路径挂载，不自己实现。

## 功能一览

**对话**
- 流式输出、工具调用卡片（按工具语义结构化摘要）、权限确认、todo 快照、diff 总览
- 提问卡片：助手发起的结构化提问（单选/多选/自由文本）交互卡——含倒计时与跨回合存活（不阻塞式提问在回合结束后仍可回答，答案作为新消息送达）；刷新/断线重连自动恢复未决问题
- 模型与思考级别切换（Ctrl+P 快捷、随 prompt 注入引擎、可存为项目偏好，切换回执回显实际生效模型、排队期显示待生效徽标）；新会话默认模型取引擎配置默认（回退链：项目偏好 > 引擎默认 > 列表首项）
- 思考块可设默认展开（跨设备设置，展开态滚动跟随、手滑即停）
- 回合进行中可继续输入排队发送（followUp/steer 可切，待发列表可整队撤销与重排，等待提问/权限应答时输入区明示等待提示）
- 大段文本粘贴可转附件按需占用上下文；消息流模型切换点标记；右缘导航轨快速跳转历史输入
- 断线重连全量对账（心跳具名帧 + 客户端滚动看门狗，实测断网零丢消息）

**会话与项目**
- 多项目注册（目录树浏览添加）、侧栏平铺全部项目会话（分组折叠记忆）、跨项目最近会话直达
- 置顶/归档/搜索/批量/fork/导出；标签（全局与项目两级）；首回合后自动生成短标题
- URL `?session=` 恢复选中会话；项目可隐藏/恢复/移除/排序

**效率与记忆**
- 常用语（全局与项目两级，可从输入历史导入）；斜杠命令提示（引擎命令/技能/用户提示），/compact 压缩上下文；移动端斜杠提示内联展示不遮挡输入框
- 项目笔记页签（markdown 渲染、标签分类、回收站软删除 + 版本恢复）
- 只读"记忆"页签（项目记忆库 facts 按月分组，与 CLI 共库，页签头部只读遥测卡：今日条数/库总量与文件数/最近落条/system 体积）；会话内记忆写入/召回标记

**统计与手机端**
- token 用量统计、回合速度 tok/s、上下文水位指示；右栏“子代理”页签聚合呈现 task 子代理的运行/终态
- 手机端整体适配：全屏会话抽屉、上下结构输入区（上行整行宽输入、下行功能钮与发送，命令按钮行已退役）、底部上拉浮层避开键盘、44px 触控底线

## 快速开始

### 安装（npm，要求 node >= 24）

```
npm install -g @ulthon/ul-omo-webui
ul-omo-webui
```

首次启动自动生成随机密码打印在 stdout 并写入数据目录的 `password` 文件，之后每次启动直接读取该文件。浏览器打开 `http://<主机>:7788` 登录（缺省监听 `0.0.0.0:7788`）。

数据目录缺省（npm 安装形态）：Linux `~/.local/share/ul-omo-webui/`、macOS `~/Library/Application Support/ul-omo-webui/`、Windows `%APPDATA%\ul-omo-webui\`；`UL_OMO_WEBUI_DATA_DIR` 可覆盖。命令行验证登录：

```
curl -X POST http://127.0.0.1:7788/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"<你的密码>"}'
```

### 从源码构建（开发）

```
git clone https://github.com/ulthon/ul-omo-webui.git
cd ul-omo-webui
npm install
npm run build      # web 构建 + 内嵌资产 + esbuild 打包 -> server/dist/index.js
node server/dist/index.js
```

测试：`npm test`（server 368 用例 + web 425 用例，vitest）。

### 环境变量

| 变量 | 作用 | 缺省 |
|---|---|---|
| `UL_OMO_WEBUI_HOST` | 监听地址 | `0.0.0.0` |
| `UL_OMO_WEBUI_PORT` | 监听端口 | `7788` |
| `UL_OMO_WEBUI_DATA_DIR` | 运行数据目录 | npm 安装形态：平台数据目录；源码形态：`server/data/` |
| `UL_OMO_WEBUI_META_DB` | 元数据库路径 | `<DATA_DIR>/meta.db` |
| `UL_OMO_WEBUI_AGENT_DIR` | 引擎 agent 目录 | `~/.omo/agent` |
| `UL_OMO_WEBUI_STATIC_DIR` | 磁盘静态目录（逃生口） | 内嵌资产 |
| `UL_OMO_WEBUI_PASSWORD` | 登录密码 | 自动生成随机密码 |
| `UL_OMO_WEBUI_CONFIG_DIR` | 全局配置目录 | `~/.config/ul-omo-webui/` |
| `UL_OMO_WEBUI_TITLE_BASEURL` | 标题生成 API 端点 | zai coding 端点 |
| `UL_OMO_WEBUI_TITLE_MODEL` | 标题生成模型 | glm-5.3-flash |
| `UL_OMO_WEBUI_DEBUG_SSE` | SSE 诊断日志开关 | 关 |

详见 `server/src/config.ts` 与 `deploy/备份.md`。

### 配置文件与多机同步

标签与常用语的定义以文本文件形态存在，git 管理即备份与多机同步：

- 全局：`~/.config/ul-omo-webui/`（`tags.json` 全局标签集、`snippets.json` 全局常用语集）。把它放进你的 dotfiles git 仓库，新机器 clone 后配置即就位；目录位置可用 `UL_OMO_WEBUI_CONFIG_DIR` 覆盖。文件是外部改动（如 git pull）后下一次读取自动生效，无需重启。
- 项目级：项目根下 `.ul-omo-webui.json`（项目级标签、常用语、preferredModel、permissionPreset），随项目仓库走。

注意：`.ul-omo-webui.json` 在提交之前会以未跟踪文件出现在 `git status` 与"未提交变更"页签里，属预期行为。提交它才能获得多机同步；把它加进 `.gitignore` 会静默破坏同步。

标题生成是服务端对模型 API 的独立调用（与引擎同源凭证，读引擎 agent 目录的 auth.json），可用 `UL_OMO_WEBUI_TITLE_BASEURL` 与 `UL_OMO_WEBUI_TITLE_MODEL` 换端点或模型。

## 部署参考件

`deploy/` 目录提供参考配置（均为参考件，不承担编排验收）：`Caddyfile.example`（反代 + /git /files 路径分发，含 SSE 长连接防缓冲配置）、`docker-compose.example.yml`（cgit + filebrowser 外链编排示例）、`备份.md`（备份对象与恢复步骤）。

## 部署安全说明

缺省 `HOST=0.0.0.0` 是为了手机在局域网内直连，但请清楚这意味着什么：

- 应用为**纯 HTTP**——登录口令与会话 cookie 明文传输，局域网内可被嗅探。
- server 持有**可执行任意命令的引擎凭证**（引擎以你的用户身份跑 agent，能读写文件、执行命令），拿到登录态等于拿到这个能力。

因此：**仅在信任的局域网内使用**（家庭/个人内网）。需要暴露到更强对抗环境时，自行把 `UL_OMO_WEBUI_HOST=127.0.0.1` 绑定回环，再由反代做 TLS 终结对外（见 `deploy/Caddyfile.example`）。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-功能清单.md](docs/01-功能清单.md) | 已冻结的功能集、明确不做的事、手机适配要求 |
| [docs/02-技术选型.md](docs/02-技术选型.md) | 全栈技术栈与理由、部署形态 |
| [docs/03-架构设计.md](docs/03-架构设计.md) | 总体架构、EngineAdapter 接口、数据一致性模型 |
| [docs/04-引擎与生态调研.md](docs/04-引擎与生态调研.md) | senpi/pi/omo/opencode v2/OpenChamber 的调研结论与竞品 |
| [docs/05-数据层实证.md](docs/05-数据层实证.md) | 本机 opencode 数据库分析（产品行为参照） |
| [docs/06-技术验证清单.md](docs/06-技术验证清单.md) | 实施前必须实测的验证项 |
| [docs/07-待定问题.md](docs/07-待定问题.md) | 尚未最终拍板的问题 |
| [docs/08-产品待办.md](docs/08-产品待办.md) | 功能设想与待拍板方案，只记录不实施 |

## 许可证

[MIT](LICENSE)。引擎层 senpi 同为 MIT。
