# 任务 18 证据：通用附件前端（粘贴/选择 → 三态 chip → 路径行）

计划 docs08-2026-10-23-24-batch 任务 18。worktree `docs08-batch/w3-t18`（实际目录
`/data/projects/senpi-webui-wt/docs08-batch-w3-t18`，分支 `docs08-batch/w3-t18`，基于 main@4564ef3）。

## 交互矩阵（输入通道 × 文件类型 × chip 态 × 发送输出）

| 输入通道 | 文件类型 | 行为 | chip 态序列 | 发送输出 |
|---|---|---|---|---|
| 粘贴（onPaste） | image/* | 内联图片链路，行为不变（分流是任务 19） | （image-thumb，非本任务） | body.images=[{data,mimeType}]，不变 |
| 粘贴 | 任意非图片（含无 type 文件） | preventDefault → 文件 chip → 二进制通道 POST | uploading → ready / failed | 路径行 `[已附加文件：<绝对路径>（按需读取）]` |
| 粘贴 | 混合（图片+文件） | 图片进内联、文件进 chip，两路并行 | 各自独立 | 两者叠加（images + 路径行） |
| 粘贴 | 空文件（0 字节） | 跳过 + toast「已跳过空文件」，无 chip | — | — |
| 粘贴 | >10MB 文件 | 跳过 + toast「文件超过 10MB 上限：{name}」，无 chip（重试也必败，不出 chip） | — | — |
| 文件选择器 | 任意（accept 已移除=全格式，仍 multiple） | 图片走内联；其余同粘贴 | 同粘贴 | 同粘贴 |
| chip | 上传中 | 发送门拦截：行内错误「附件上传中，请稍候再发送」，不排队不吞 chip（stale_state 钉死） | uploading | 落定后再发 |
| chip | 失败 | 行内错误文案 + 重试（复用原始 File 重新 POST）/移除双钮 | failed → (重试) uploading → ready | ready 后随发送 |
| chip | 就绪 | 文件名展示（title=服务端路径），叉=本地出列 + best-effort DELETE | ready | 路径行随 prompt |

B10 铁律：附件内容绝不进 prompt 正文，只带绝对路径行（引擎按需读取）；发送成功后
chip 仅本地清空绝不 DELETE（文件留存，48h 按龄清理兜底）。

## 消费的 t17 API 契约（worktree server/src/api/routes-session.ts:673 起）

- `POST /api/sessions/:id/attachments`，双通道按 content-type 分流：
  - `application/json`：文本通道（≤1MB，既有 B10 链路，未动）
  - 其他（本任务用 `application/octet-stream`）：原始 body 流式计数 ≤10MB，
    文件名经 `?name=` 查询参数（纯文件名白名单：含 `/`、`\`、`..` → 400 invalid_name）
- 错误面：413 attachment_too_large / 400 invalid_name、invalid_content / 403 attachment_escape；
  GET 死链 410 attachment_expired
- 响应：`{ path 绝对路径, name, bytes }`；落点 `DATA_DIR/attachments/<sha256(project)[:16]>/`
- DELETE：realpath 必须严格位于本项目附件目录内，越界 403
- 前端新增封装：`api.postBinaryAttachment(sessionId, file, name?)`（web/src/lib/api.ts）
- 补齐（t17 遗留）：错误码 `attachment_too_large`、`attachment_expired` 的 i18n 映射与
  zh/en 词条，i18n-errors 扫描锁从 84 → 86 码

## 关键实现

- `web/src/components/composer/composer-logic.ts`：FileChip 纯逻辑
  （appendFileAttachmentLines / start·settle·fail·reset·detachFileChip /
  sendableFileChips / hasUploadingFileChip / sendableFileChipCount），
  与文本 PasteChip 完全分离（无「取消勾选回插」语义，失败态=重试/移除）
- `web/src/components/composer/composer.tsx`：fileChips 状态 + fileSourcesRef（id→File，
  重试源）；onPaste 按类型分拆（图片链路原样）；文件选择器 accept 移除；发送时
  `appendFileAttachmentLines(appendAttachmentLines(text, 文本chip), 文件chip)`；
  uploading 在途发送门拦截；两分支（排队/直发）成功后同清 fileChips
- i18n（zh+en）：composer.fileUploadFailed / fileRetry / fileUploadInFlight /
  fileEmptySkipped / fileTooLarge；errors.attachmentTooLarge / attachmentExpired

## 测试

新增 `web/tests/composer-file-attachments.test.tsx`（9 用例，happy-dom + api 层 vi.spyOn，
无真实网络，上传 promise 受控/立即落定，确定性）：

- (a) 粘贴 zip → uploading chip → POST(sid, file, name) → ready 带回路径
- (b) 发送 → prompt 含 `[已附加文件：…（按需读取）]` 路径行、不含文件内容
  （SECRET-FILE-CONTENT 断言负例）；成功后 chip 清空
- (c) 413 → failed chip（重试/移除钮在、单独不使能发送）→ 重试重新 POST（复用原 File）
  → ready；(c2) 失败 chip 移除出列
- (d) 图片粘贴回归 → image-thumb 在、无文件 chip、二进制通道零调用；(d2) 混合剪贴板两路并行
- (e) accept 属性已移除（open format）+ 选择 zip 走 chip；change 分流
- stale_state：在途发送被拦截（errorLine 文案断言 + prompt 未调用），落定后可发
- malformed-input：空文件与 >10MB 跳过（无 chip、POST 零调用、toast 含 10MB）

`web/tests/composer-logic.test.ts` 追加纯逻辑 describe（8 用例：路径行拼装/组合、
settle/fail/reset/detach、sendable/hasUploading/count、orphan 语义）。
`web/tests/i18n-errors.test.ts` 留痕清单 84→86（t17 两码补映射）。

命令与结果：

- `npx vitest run`（web 全套）：**Test Files 111 passed (111)，Tests 1037 passed (1037)**
- `npm run lint`（web）：composer/新增文件零告警
- `npm run build`（根）：构建完成 server/dist/index.js（内嵌资产 330 文件）
- `tsc -b --noEmit`（web）：无输出（通过）

## 手动 QA（组件级 jsdom，fetch 层桩模拟 t17 服务端）

一次性脚本（跑完已删，receipt：web/tests/tmp-manual-qa.test.tsx unlink）。
真实 zip 字节（PK 头 12 字节）粘贴 → chip → 发送，捕获：

```
[QA] attachment POST /api/sessions/qa-manual-18/attachments?name=demo.zip
     content-type: application/octet-stream bytes: 12
[QA] chip after paste: ready
[QA] PROMPT PAYLOAD >>> {"text":"帮我看下这个压缩包内容\n[已附加文件：/root/.local/share/ul-omo-webui/attachments/ab12cd34ef56ab75/demo.zip（按需读取）]"}
[QA] chip cleared: true
```

验证点：请求头 octet-stream、?name= 携带原始文件名、body 12 字节即原文；prompt 体
只含路径行、不含 zip 字节；发送成功 chip 清空。
