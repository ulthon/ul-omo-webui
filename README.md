# senpi-webui

给 senpi/omo 引擎做的 web 工作台：功能集对标 opencode v1 TUI，兼容手机浏览器，自托管单用户。

自用阶段内部也可称 omo-webui；若将来开源发布，建议保持 senpi-webui（引擎层 senpi 是 MIT，名字无归属风险；omo 是 code-yeongyu 的项目名，官方自己有 senpi-desktop 桌面版，冒名易混淆）。

## 三条核心理念

1. **同一引擎的第二前端**。web 版不是独立产品，而是 senpi 引擎的第二个 UI。会话数据、agent 配置、凭证、工作产出与命令行版完全同一份（关键保证：宿主 spawn 引擎子进程时继承相同的 HOME 与项目 cwd）。终端 TUI 聊到一半，手机浏览器打开同一个会话接着聊，零迁移。
2. **薄壳**。引擎不动，web 只做宿主：事件桥 + UI。不做 Electron、不做多服务器聚合、不做账号系统。单 Node/Bun 进程 + 一个 sqlite 元数据库。
3. **phpMyAdmin 模式**。核心只做"对话 + 会话 + 与对话直接联动的东西"。Git 历史浏览、文件管理等专门能力外链独立自托管工具（cgit / filebrowser），反代按路径挂载，不自己实现。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-功能清单.md](docs/01-功能清单.md) | 已冻结的功能集、明确不做的事、手机适配要求 |
| [docs/02-技术选型.md](docs/02-技术选型.md) | 全栈技术栈与理由、部署形态 |
| [docs/03-架构设计.md](docs/03-架构设计.md) | 总体架构、EngineAdapter 接口、数据一致性模型 |
| [docs/04-引擎与生态调研.md](docs/04-引擎与生态调研.md) | senpi/pi/omo/opencode v2/OpenChamber 的调研结论与竞品 |
| [docs/05-数据层实证.md](docs/05-数据层实证.md) | 本机 opencode 数据库分析（产品行为参照） |
| [docs/06-技术验证清单.md](docs/06-技术验证清单.md) | 实施前必须实测的验证项 |
| [docs/07-待定问题.md](docs/07-待定问题.md) | 尚未最终拍板的三个问题 |
| [docs/08-产品待办.md](docs/08-产品待办.md) | 功能设想与待拍板方案（会话标签、项目笔记、标题生成、手机输入区等），只记录不实施 |

## 当前状态

**已实现。** 31 个实现任务全部完成，通过稳定性验收（引擎崩溃自动恢复、断网重连不丢消息、30 分钟浸泡三源一致）与单二进制冷启动冒烟。这是一个可自用的 senpi/omo 引擎 web 工作台：手机浏览器连上局域网即可与终端 TUI 共用同一份会话——对话、流式输出、工具调用卡片、权限确认、todo、diff 总览、模型切换、会话管理（置顶/归档/搜索/批量/fork/导出）、token 用量统计都在；Git 历史与文件管理按 phpMyAdmin 模式外链 cgit / filebrowser。

### 快速开始

构建（需要 bun；产出 `dist/senpi-webui` 单二进制 + `dist/engine/` 引擎闭包目录）：

```
bun run build:binary
```

运行（要求 PATH 上有 node；数据目录缺省落在可执行文件旁 `data/`）：

```
cd dist
./senpi-webui
```

首次启动自动生成随机密码打印在 stdout 并写入 `data/password`，之后每次启动直接读取该文件。浏览器打开 `http://<主机>:7788` 登录（缺省监听 `0.0.0.0:7788`，`SENPI_WEBUI_HOST`/`SENPI_WEBUI_PORT` 可改）。命令行验证登录：

```
curl -X POST http://127.0.0.1:7788/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"<你的密码>"}'
```

环境变量一览（详见 `server/src/config.ts` 与 `deploy/备份.md`）：`SENPI_WEBUI_HOST`/`PORT`/`DATA_DIR`/`META_DB`/`AGENT_DIR`/`STATIC_DIR`/`PASSWORD`。

### 部署参考件

`deploy/` 目录提供参考配置（均为参考件，不承担编排验收）：`Caddyfile.example`（反代 + /git /files 路径分发，含 SSE 长连接防缓冲配置）、`docker-compose.example.yml`（cgit + filebrowser 外链编排示例）、`备份.md`（备份对象与恢复步骤）。

### 部署安全说明

缺省 `HOST=0.0.0.0` 是为了手机在局域网内直连，但请清楚这意味着什么：

- 应用为**纯 HTTP**——登录口令与会话 cookie 明文传输，局域网内可被嗅探。
- server 持有**可执行任意命令的引擎凭证**（引擎以你的用户身份跑 agent，能读写文件、执行命令），拿到登录态等于拿到这个能力。

因此：**仅在信任的局域网内使用**（家庭/个人内网）。需要暴露到更强对抗环境时，自行把 `SENPI_WEBUI_HOST=127.0.0.1` 绑定回环，再由反代做 TLS 终结对外（见 `deploy/Caddyfile.example`）。
