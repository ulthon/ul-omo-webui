# 任务 17 证据：通用附件服务端（二进制载荷 + 任意格式 + 10MB 上限）

worktree: `docs08-batch-w3-t17`（branch `docs08-batch/w3-t17`，基于 main@a36c7fa）

## API 面（会话级附件路由，content-type 分流）

| 端点 | 载荷 | 限制 | 成功 | 错误 |
|---|---|---|---|---|
| POST `/api/sessions/:id/attachments`（application/json，既有文本通道，行为不变） | JSON `{content, name?}` | content ≤1MB UTF-8 | 201 `{path,name,bytes}` | 400 `invalid_json` / `invalid_content` / `content_too_large` / `invalid_name`；403 `attachment_escape`；404 会话不存在 |
| POST `/api/sessions/:id/attachments`（其他 content-type，建议 `application/octet-stream`，二进制通道，任意格式） | 原始 body + `?name=` 查询参数（纯文件名） | ≤10MB（content-length 头预检 413 前置 + 流式计数双保险，超限即在缓冲前/计数越限时拒绝并 cancel 流） | 201 `{path,name,bytes}`（name 缺省自生成 `upload-<ts>.bin`） | 413 `attachment_too_large`；400 `invalid_name`（含 `../` 穿越、`/`、`\`）/ `invalid_content`（空 body、零字节）；403 `attachment_escape` |
| GET `/api/sessions/:id/attachments?path=`（新增，服务端点） | — | 项目内 realpath 校验 | 200 原始字节（`application/octet-stream` + content-length + content-disposition） | **410 `attachment_expired`（死链显式化：路径词法上在本项目附件目录内但文件已被 48h 清扫/删除）**；403 `attachment_escape`（越界/符号链接逃逸）；404 `attachment_not_found`（项目附件目录不存在）；400 `invalid_path`（非文件）/ `invalid_request`（path 缺失） |
| DELETE（既有，不变） | `?path=` | 同 GET 越界口径 | 200 | 403 / 404 / 400 |

- 48h 清扫 `purgeStaleAttachments` 原样复用（启动挂点不变）；清扫后 GET 返回 410 即死链语义。
- 上限常量：`ATTACHMENT_BINARY_MAX_BYTES = 10MB`（新增），`ATTACHMENT_MAX_BYTES = 1MB` 仅属 JSON 文本通道，未动。

## B10 铁律合规声明

附件内容（文本或二进制）只落盘 `DATA_DIR/attachments/<projectHash>/` 并在响应中返回绝对路径；服务端任何代码路径都不把附件内容拼进 prompt —— 引擎仅按路径行按需读取（与既有 r3 任务 17 口径一致，本次未新增任何 prompt 组装路径）。grep 复核：`routes-session.ts` 附件路由无 prompt 相关调用。

## 测试（tests-after，`server/test/attachments.test.ts`）

新增三组 describe（二进制 POST 5 例 + GET 服务 3 例 + 清扫二进制扩展 1 例），既有 13 例未改：

- (a) 二进制上传 happy：伪 zip 字节（PK\x03\x04）→ 201、磁盘字节一致、绝对路径返回
- (b) 恰好 10MB 通过 / 10MB+1 → 413 `attachment_too_large`（流式计数路径，不依赖头）
- (c) `?name=` 注入矩阵（`../evil.zip`、`a/b.zip`、`..\evil`、`..`）→ 400 `invalid_name`
- (d) 清扫扩展：在窗二进制保留、49h 超龄删除（复用既有 sweep 测试形态）
- (e) 1MB 文本通道回归：既有 4 例原样保留并通过（含恰好 1MB/1MB+1）
- (f) 死链：目录在、文件被删 → GET 410 `attachment_expired`；越界 → 403；目录不存在 → 404
- 附加：空载荷/零字节 → 400；name 缺省自生成 `.bin`；GET 存在 → 200 字节一致 + content-length

全套：`cd server && npx vitest run` → **Test Files 46 passed (46)，Tests 593 passed (593)**
根构建：`npm run build` → 构建完成 server/dist/index.js（web esbuild ✓ + 内嵌资产 + server bundle ✓）

## 手工 QA（curl × 真实 HTTP，@hono/node-server :8791，脚本 `.omo/tmp-qa-t17/qa-server.mjs`，事后已删）

```
===== 1. zip upload =====
{"path":"/tmp/qa-t17-6iHqhW/291d4b581f44d6c7/bundle.zip","name":"bundle.zip","bytes":11}
HTTP 201
===== 2. on disk =====
-rw-r--r-- 1 root root 11 Oct 25 05:17 .../291d4b581f44d6c7/bundle.zip
00000000: 504b 0304 5a49 5044 4154 41              PK..ZIPDATA
===== 3. retrieve =====
PKZIPDATA
HTTP 200
===== 4. 11MB rejection =====
{"error":{"code":"attachment_too_large","message":"附件超过 10MB 上限（content-length 11534336 字节）"}}
HTTP 413
===== 5. traversal rejection =====
{"error":{"code":"invalid_name","message":"name 只能是纯文件名（不得含路径分隔符或 ..）"}}
HTTP 400
===== 6. dead-link (after sweep/rm) =====
{"error":{"code":"attachment_expired","message":"附件已过期（48h 清理）或不存在"}}
HTTP 410
```

## 对抗类处置

- malformed-input：空 body/零字节 → 400；`name` 穿越 → 400（同口径 a）；content-length 撒谎 → 流式计数为准（测试覆盖无头超限）；截断 body → 流式读取自然得到实际字节
- hung_commands：content-length 头超限在缓冲前 413；流式越限即 cancel reader（无 10MB+1 全量缓冲）
- stale_state：清扫与上传竞态沿用 r3 既有 per-file try/catch 跳过语义；GET 对竞态缺失路径词法判定为 410 死链而非 500
- flaky-tests：全部确定性（固定字节/固定时间戳 utimes，无 sleep/竞态）
