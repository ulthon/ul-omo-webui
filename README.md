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

## 当前状态

讨论阶段完成，功能集基本冻结（余三个待定问题见 docs/07）。本目录初始化 git 后由实施会话接管，建议先跑 docs/06 的验证清单再动工。
