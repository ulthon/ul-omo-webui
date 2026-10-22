# 任务 18 证据:模型变体名时间线对齐显示

日期:2026-10-22 | 分支:docs08-r7-wave3-t18(worktree,基线 main@0067c25,含任务 16/17)

## 实现

### server(增量兼容,GET /api/models 行新增字段)

- `server/src/adapter/engine-adapter.ts`:`EngineModelInfo` 加 `upstreamId?`(变体上游
  模型 id,如 glm-5.3-4k → glm-5.3;缺席 = 非变体)。
- `server/src/api/engine-runtime.ts`:
  - `readCustomModels`(:276 一带)解析 models.json 条目的 `upstreamModelId`
    (非空字符串收下,非法形态视同缺失);
  - `mergeUpstreamIds(rows, agentDir)`(导出供单测):协议面模型行按 provider/id 从
    models.json 自定义合并 upstreamId,仅补缺失字段不改写行;
  - `modelsList()` 三路径统一携带:引擎未就绪/无活跃会话两条降级路径经
    `readModelsFallback`(自定义覆盖目录项)自然携带;活跃会话路径经
    `mergeUpstreamIds` 补齐。

### web(时间线优先 + 5 级回退,绝不猜)

- `web/src/components/chat/message-items.ts`:
  - `resolveVariantName(raw, asOf, registry, appliedModel)` 纯函数,5 级回退:
    1 时间线+注册表确证(upstreamId===raw)→ 变体名;2 时间线命中但注册表无法确证
    (变体已删/基础模型无映射)且裸 id 一致 → 时间线 modelId;3 appliedModels;4 注册表
    唯一反查(upstreamId===raw 恰一行);5 裸名+歧义注记(注册表内多变体共用上游时
    `ambiguous:true`,title 提示,绝不猜);
  - `resolveTimelineModels(entries, registry, appliedModel)` 单遍时间线纯函数:
    model_change 更新 current(provider/modelId),assistant 记 as-of appliedAt;
  - `ChatListItem` entry 变体加 `model: ResolvedModelName | null`;
    `buildMessageItems` opts 加 `modelRegistry`/`appliedModel`(未传时 model 恒 null,
    旧调用方回落裸 message.model 不丢显示)。
- `web/src/components/chat/chat-view.tsx`:messageEntries 过滤加 `model_change` 条目
  (不入列渲染,仅供时间线解析);items useMemo 依赖加 ui.models 与
  appliedModels[sessionId](计划条款逐字落地)。
- `web/src/components/chat/message-bubble.tsx`:EntryBubble 加 model props 消费
  (缺席回落裸 message.model);BubbleShell 模型短名 span 歧义时挂 title 注记;
  StreamingBubble 模型名改 appliedModels 优先(缺席回落 message_start 裸名)。
- `web/src/components/chat/message-list.tsx`:Row 把 item.model 传给 EntryBubble。
- `web/src/lib/api.ts`:`ModelInfo` 加 `upstreamId?`(旧服务端不下发,增量兼容)。
- i18n zh/en:`chat.messageBubble.modelAmbiguous`(「多个模型变体共用此上游名,显示
  记录的原始名」/ "Multiple model variants share this upstream name; showing the
  recorded raw name")。

## 实证形态(设计输入)

- assistant 消息只记裸上游名:真实库 grep 3282 条 `"model":"glm-5.3"` vs 2 条变体 id
  ——引擎侧不记变体 id(计划 Must NOT 前提成立);
- model_change 条目记变体 id:`{"type":"model_change",provider,modelId}`(jsonl 实录);
- models.json 变体条目:`{"id":"glm-5.3-4k","upstreamModelId":"glm-5.3",...}`,双变体
  glm-5.3-4k/-2k 同上游 glm-5.3(歧义场景的真实形态);models-store.json(目录缓存)
  实测 0 处 upstreamModelId——upstreamId 唯一权威源是 models.json 自定义。

## 服务端核验(隔离实例 curl)

- GET /api/models 引擎未就绪路径:glm-5.3-4k←glm-5.3、glm-5.3-2k←glm-5.3、基础模型
  无该字段 ✓;
- 引擎目录缓存路径(readModelsFallback 合并):同上 ✓;协议面路径(引擎存活)经
  mergeUpstreamIds 补齐亦核验 ✓(QA 过程中引擎存活窗口实测)。

## QA 实例与 bundle 哈希(陈旧产物防线)

- 隔离实例:`UL_OMO_WEBUI_PORT=7813`,`UL_OMO_WEBUI_DATA_DIR=/tmp/t18-qa/data`,
  `UL_OMO_WEBUI_AGENT_DIR=/tmp/t18-qa/agent`,密码走 env;根 `npm run build` 重建
  web/dist 后启动。
- fixture:`/tmp/t18-qa/agent/models.json`(双变体同上游 + 基础模型,字段集对齐真实
  schema)+ 两个会话 jsonl(`--tmp-t18-qa-project--/`,session 头 v3):
  - fixvar01:u1 → model_change(glm-5.3-4k) → a1(model=glm-5.3) → model_change
    (glm-5.3-2k) → a2(model=glm-5.3);
  - fixamb02:b1 → a0(model=glm-5.3,无任何 model_change 先行,多变体歧义样本)→
    a3(model=glm-4.7,零命中对照)。
- bundle 拼接 sha256(index.html+assets/*.js)=
  `c4b67bc2573d0d9f9e518da85c9bd3c2891087f1949b99e10fe3431df65f46ca`;
  dist 全量 sha256=`ccdc1f64ae9bb9c54e40186f6779f34b40cf01febc7d6d24d1c1a3035c49c35c`
  (330 files);QA 实例即伺服该构建。

## 浏览器断言(裸 CDP 无头 chromium --no-sandbox,真实 DOM 读取;双档)

| 断言 | desktop 1920x1080 | mobile 390x844(390x844 档) |
| --- | --- | --- |
| 4k 段气泡头部显 glm-5.3-4k(非裸名) | 通过 | 通过 |
| 切 2k 后时段显 glm-5.3-2k(历史各时段正确) | 通过 | 通过 |
| 无会话态+多变体:裸名+title 注记 | 通过 | 通过 |
| 无变体对照 glm-4.7:裸名无注记(零命中不误报) | 通过 | 通过 |
| t17 溯源行回归(用时+时间 span 保留) | 通过 | 通过 |
| 无 undefined 泄漏 | 通过 | 通过 |

- 断言明细:qa-assertions.json;截图:desktop-1920-fixvar01.png /
  mobile-390-fixvar01.png / desktop-1920-fixamb02.png / mobile-390-fixamb02.png。
- 注记语言说明:QA 浏览器 app locale 为 en,注记渲染英文文案;中文文案由 vitest
  (setup-locale 锁 zh-CN)锁定。i18n 双语均验证。

## 测试与门禁

- 新增测试 18 例(`web/tests/model-variant-name.test.tsx`:5 级回退逐级 8 + 时间线
  4 + buildMessageItems 集成 2 + EntryBubble 渲染 3 + StreamingBubble appliedModels
  契约 1);server 侧 `server/test/models-fallback.test.ts` 加 upstreamId 解析与
  mergeUpstreamIds 合并 2 例(5 断言)。
- 本树全量 web vitest:**875 passed(93 files)**,基线 858,净增 +17;server vitest
  **477 passed(38 files)**。
- `npx tsc -b`(web)rc=0;server tsc --noEmit 的 31 处错误为 main 同款预存
  (FakeGateway 缺 commandsList 族,main 实测同为 31,本任务 0 新增);oxlint 变更
  11 文件仅 1 warning(message-list.tsx useVirtualizer,main 同款预存);`npm run
  scan:cn` 0 处(基线 0)。

## 边界对抗核查

- 未知变体字符串(注册表零命中):裸名直显不吞没、不误挂注记(glm-4.7 测试+浏览器
  断言);
- 歧义绝不猜:多变体共用上游且无会话态 → 裸名+title 注记(QA failure 场景逐字);
  单变体唯一反查才直出变体名;
- 变体删除走梯级 2:注册表缺行且裸 id 在册 → 时间线 modelId 照显(测试锁定);
- 畸形 model_change(缺 provider/modelId)不污染时间线;resolve 纯函数无副作用
  (frozen 入参 + 重复调用一致性测试);
- 回归:t17 溯源行(agent+用时)浏览器与全量测试双确认;t26 域
  (subagent-data/subagent-panel/task-completion)零改动(git status 核对);
  StreamingBubble 老数据回落路径由既有 model-visibility 测试覆盖不受影响。
- QA 环境注:隔离实例引擎存活时协议面返回空行的现象为 fixture provider 可用性
  所致(引擎侧语义),与本任务改动无关;QA 以引擎未就绪/目录缓存路径(生产重启后
  同款路径)取得稳定注册表完成,该路径服务端行为即本任务 server 侧改动的直接面。

## 清场

- QA 实例(7813)、无头 chromium(9224)、mock provider(7911)进程全停;
- 工作树引擎 bundle 的 QA 临时禁用已还原(cli.js 改名复位);
- /tmp/t18-* 全部删除。
