# 任务 23:models discover(OpenAI 兼容 provider 模型发现与导入)

日期:2026-10-23 | 分支:docs08-r7-wave7-t23

## QA 环境

- 隔离实例:`UL_OMO_WEBUI_PORT=7823 UL_OMO_WEBUI_DATA_DIR=/tmp/t23-qa/data UL_OMO_WEBUI_AGENT_DIR=/tmp/t23-qa/agent node server/dist/index.js`(根构建后重启,bundle 见下)。
- 桩 OpenAI 兼容 provider:真实 HTTP 服务器(127.0.0.1:8899,`/tmp/t23-qa/models-stub.mjs`),`GET /v1/models` 返回 `{data:[{id:preexisting},{id:qa-model-a},{id:qa-model-b}]}`;应用内零 mock,全链路走真实 fetch。
- fixture models.json:`qa-stub` 配 baseUrl+apiKey,预置一条既有模型 `preexisting`(验证保留既有)。
- **bundle 哈希**:web/dist/assets/index-DqbBACEE.js sha256 `9626d000b9610e7438a4891bcc27ff1d3eebd6746caebfd785c9d75c4471c60d`;实例 `GET /` 伺服同名 bundle(内嵌与磁盘一致,非旧产物)。

## happy 全链路(真实浏览器,双档截图)

- desktop(1920x1080):desktop-1-section.png(分区+provider 选择)→ desktop-2-preview.png(预览:Discovered 3 models · 1 already configured (kept as-is),新增两项默认全选)→ desktop-3-imported.png(Imported 2 new models)→ desktop-4-repeat-empty.png(重复发现无新增空态)。
- mobile(390x844):mobile-1..4 同流程,选择器/按钮全宽触控形态,导入成功文案绿色可见(mobile-3-imported.png)。
- 实例级 GET 可见性:导入后 `GET /api/models?project=…`(真实引擎链路)返回 qa-stub 三条:`preexisting(contextWindow:128000,reasoning:true)` + `qa-model-a` + `qa-model-b`。

## API 迹(curl,cookie 会话)

- 预览不落盘:POST {provider} → `imported:null, written:false`,models.json mtime 不变。
- 导入写回:POST {provider,import:"all"} → `imported:[qa-model-a,qa-model-b], written:true`;落盘文件既有条目字节不变,新增仅 `{id}` 默认形态,零 .tmp 残留。
- 重复发现不重复:再次 import all → `added:[], written:false`,mtime 不变。
- 失败路径(文件 mtime 均零改):
  - 未知 provider → 400 `provider_not_found`
  - 不可达 baseUrl(127.0.0.1:8898)→ 502 `discover_upstream_failed`(fetch failed)
  - 服务端单测另覆盖:401 鉴权失败 502(且错误信息不含 apiKey)、非 JSON 502、无模型列表形态 502 discover_bad_listing、baseUrl 缺失/非法 400、非 OpenAI 兼容 api 400、import 子集/非法选择、并发导入模块级串行零交错。

## 结论

验收标准逐条满足:mock provider 发现→确认导入→models.json 新增且 GET 可见;重复 discover 不重复;fetch 失败文件零改;并发串行;测试 server 16 + web 5 全绿。
