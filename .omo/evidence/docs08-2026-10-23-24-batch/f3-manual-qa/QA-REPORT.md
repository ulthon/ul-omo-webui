# F3 真实手动 QA 终验报告（docs08-2026-10-23-24-batch）

执行时间：2026-10-25 09:18–10:05 UTC。执行方式：仓库根 `npm run build`（EXIT=0）→ 隔离实例
（`UL_OMO_WEBUI_PORT=7799`、`UL_OMO_WEBUI_DATA_DIR=/tmp/f3-qa/data`、`UL_OMO_WEBUI_AGENT_DIR=/tmp/f3-qa/agent`、
密码 env 登录；后半程补 `UL_OMO_WEBUI_CONFIG_DIR=/tmp/f3-qa/config` 隔离全局配置），
headless Chrome 153 CDP（`--headless=new --no-sandbox`，`Emulation.setDeviceMetricsOverride` 390x844 / 1920x1080），
真实鼠标/键盘事件 + DataTransfer 粘贴，每步截图。

fixtures：隔离 agent 目录自造 5 个会话 jsonl（260 帧回放会话 / 含未终局后台回执会话 /
含 base64 图片历史会话 / 两个普通会话）+ 合成 models.json（真实 provider + supportsImages 双态开关）。
引擎侧为真实 omo 引擎（补齐 auth/models-store 后 spawn 成功，真实模型往返）。

## 逐项结论

| # | 项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 会话列表加载 + 发消息上浮 | PASS | 列表 5 会话全载（f3-01/f3-01b）。真实发送「请只回复两个字：收到」到列表末位会话，回合落定（回执）后 t+20s 列表无刷新上浮至顶：`Recent sessions > look at this > …`（f3-02b）。注：上浮时点=回执时刻（`api.prompt` 的 POST 在回合完成后才 resolve，流式长回合期间不上浮——与服务端 receipt 语义一致，行为符合任务 13「回执时刻乐观上浮」设计） |
| 2 | SSE 首连回放收敛（无 1000 帧全量回放） | PASS | 无 Last-Event-ID 新连接 `curl -N /api/events`：`replay_begin → hb×5 → replay_done`，6s 内仅 6 帧（心跳），零历史帧回放（旧版为 replay(0) 全量 1000 帧环缓）。260 帧 fixture 会话首载：`GET /messages` 恰 216 条（尾窗 200+16 重叠）、hasMore=true、oldestId=e0045；浏览器渲染尾帧 #260（f3-03） |
| 3 | 第四态「后台运行中」 | PASS | 无引擎依赖即验证：fixture jsonl 含 `run_in_background:true,status:running,task_id` 未终局回执 → `GET /api/sessions` 下发 `runState:"background_running"`；会话行状态点 `bg-violet-500 animate-busy-pulse` + `title="Background running"`（f3-01/f3-09，DOM 断言） |
| 4 | 标签管理弹框两段确认 + 失败保底 | PASS | 孤儿挂载清理两段式：点「Clean stale tags」→ 变「Confirm cleanup」且挂载仍在（f3-04f）→ 二次确认才执行（f3-04g），meta_tag_mount_audit 落审计行 `source:"tag-manage-dialog:orphan-clean"`。徽标点按不再触发删除（点按无整替请求、无 toast）。失败保底：CDP Fetch.failRequest 拦截 `/api/tags` 后刷新页面，挂载库未被动（f3-04h；DB 核对 mounts 原样），无孤儿误判/误清 UI |
| 5 | 通用附件：粘贴 zip → chip → 发送 → 路径行（B10） | PASS | 粘贴真实 zip（python zipfile 生成 145B）→ composer 出现 chip（f3-05）→ 发送 → 消息含 `[已附加文件：/tmp/f3-qa/data/attachments/de2fe205b3004221/qa-attachment.zip（按需读取）]`，内容不进 prompt（f3-05b，网络仅见 prompt/draft/sessions 三请求） |
| 6 | 图片路由双态（supportsImages true/false） | PASS | attach 态（删除 supportsImages）：粘贴 png → 消息为 `[图片已保存为附件：…/img-*.png（按需读取）]`，引擎按路径 read 按需取图（f3-06a）；inline 态（glm-5.3-4k 标 true）：粘贴另一 png → 无路径行、chat 内联渲染 2 个 img（f3-06b/06c）。历史引用化：含 base64 图的历史会话 `GET /messages` 下发 `ref:{path,name}` 引用形态（不再 base64），按需取图接口 `GET /api/sessions/:id/attachments?path=` 返回 200 + PNG magic（89504e47） |
| 7 | 弹层滚动 390 档滚到底 | PASS | 设置弹层 maxHeight=812px（100dvh-2rem）、overflowY=auto、scrollHeight 2473 > clientH 797；scrollTop 2309/2309 滚到底，末分区 Language + Close 可见（f3-07a/07b）；1920x1080 无回归（居中 736/736、maxH 1048=1080-32，f3-07c） |
| 8 | 手机档无快捷键图标 | PASS | 390x844：`shortcuts-help-button` 计数 0、`settings-button` 1（f3-08）；1920x1080：计数 1 保留（f3-08b） |

## DEFERRED-TO-DEPLOY

- 无。原预判需真实引擎的项目（上浮、附件路径行、图片分流）均在隔离实例以真实引擎完成；
  生产 deploy 后的复检项仅为 IS-1 新建会话端到端（F1 已裁定随部署进行，非本批 F3 范围）。

## 环境备注与观察项（非阻塞）

1. 引擎就绪探针门禁在裸 agent 目录下失败（open_session 探针不落盘，`probe_gate_failed` 连续 5 次 →
   unavailable）。补齐 `auth.json/models-store.json/settings.json` + 合法 models.json 后真实引擎 spawn 与
   prompt 往返正常。QA 期间以 `SENPI_ENGINE_PROBE_GATE=0` 关门禁完成真实发送（只影响 QA 实例）。
2. 污染事故（已恢复）：隔离实例初期未设 `UL_OMO_WEBUI_CONFIG_DIR`，全局 tags.json 落在了真实
   `~/.config/ul-omo-webui/tags.json`。核实该文件 Birth=2026-10-25 09:53:08（本 QA 创建，此前不存在，
   生产 meta_session_tag 亦为空 → 无用户数据损失），已删除恢复原状；后半程已用独立 CONFIG_DIR 重启。
3. 观察项（建议跟进，不阻塞）：上述 tags.json 在「CDP 拦截 /api/tags 失败 + 页面刷新」窗口内被写入为
   空定义集（09:53:08）。代码层面全局定义唯一写入口是 PUT /api/tags（tag-manage 弹框 putScope），
   该窗口内无用户删除操作，写入触发链未定位；因文件本不存在、无数据影响，仅记录现象。
4. 预存残留（非本 QA 产生）：worktree `docs08-batch-w2-t15` 名下 4 个 schedule runner 进程自 04:59 存活
   （t15 证据声称已杀但未杀净），未处置，留用户决断。

## 清理回执

- server（node dist/index.js）、Chrome（--headless CDP 9333）全部终止；`ss -ltn` 7799/9333 端口空闲。
- `/tmp/f3-qa`（数据目录、agent 目录、chrome profile、截图原件）已删除；`~/.config/ul-omo-webui/` 恢复为
  仅含原有 snippets.json。
- 仓库唯一写入：本证据目录（截图 + 本报告）。
