# 任务 19：图片按模型能力自动分流 + 历史引用化（attempt 2）

worktree: `docs08-batch-w3-t19`（base main@dfc7186，t17 附件双通道 + t18 chip UI 已落地）

## 前任 worker 部分工作 triage

死掉的 worker（21 分钟，rate-limit 终止）留下 +133/-13 的未提交改动与 3 个新文件。逐文件审读后判定**完整自洽、与任务意图一一对应，全部保留续用**：

| 文件 | 判定 |
|---|---|
| `server/src/api/image-routing.ts`（新） | 能力判定 + 分流 + 引用化核心，保守口径正确，保留 |
| `server/test/image-routing.test.ts`（新） | 覆盖 a–e 五场景 + stale_state + 清扫豁免，保留 |
| `web/tests/image-part-ref.test.tsx`（新） | 双形态渲染 + 失败占位，保留 |
| routes-session / attachments / engine-runtime / engine-adapter | 挂接路由、img-* 清扫豁免、supportsImages 透传，保留 |
| web: image-lightbox / message-bubble / api.ts / i18n zh+en | 按需取渲染 + blob 下载 + 文案，保留 |
| `web/tests/i18n-errors.test.ts` | 86→87 码（image_attachment_failed），保留 |
| `package-lock.json` | 噪音，已 `git checkout --` 还原 |

无需返工项：所有依赖符号（`requireSessionProject` / `deps.modelsPath` / `deps.attachmentsRoot` / `resolveSessionRow`）均已存在，t17/t18 API 零改动复用。

## 决策表（能力判定，`modelSupportsImages`）

| models.json 状态 / 条目 | 结果 |
|---|---|
| 条目 `supportsImages === true`（显式） | inline（唯一内联口径） |
| `false` / 缺席 / 垃圾值（"yes"） | 附件回退 |
| 文件缺失 / JSON 损坏 / 结构异常 | 附件回退（绝不误内联） |
| model 无 provider 斜杠 / 未携带 model / 条目不存在 | 附件回退 |

判定为同步 `readFileSync`（models.json 本地小文件，无 hung 风险）；逐次发送重新判定，已发条目不回改（stale_state 测试覆盖）。

## 分流（发送时，POST /api/sessions/:id/prompt）

不支持读图且携带图片 → base64 落 `DATA_DIR/attachments/<projectHash>/img-<sha256(data)前16hex>.<ext>`（内容寻址 dedup、扩展名白名单、realpath 防越界、symlink 拒写），prompt 拼路径行 `[图片已保存为附件：<abs path>（按需读取）]`（B10 铁律），`images` 置空。写盘失败 → 500 `image_attachment_failed`，绝不静默内联。

## 引用化（历史下发，GET /api/sessions/:id/messages）

条目下发前 user image part 的 base64 换成引用形态（落同一 img-* 边车）：

- 磁盘：`<attachmentsRoot>/<projectHash>/img-<hash>.<ext>`（绝对路径）
- 下发 part：`{"type":"image","ref":{"path":<abs>,"name":<basename>},"mimeType":"image/png"}`（无 data）
- 按需流：客户端 `ImagePart` 见 ref.path → `api.fetchAttachmentBlob` → `GET /api/sessions/:id/attachments?path=`（t17 既有路由）→ Blob → objectURL 渲染；失败/410 → 过期占位（`chat.lightbox.refExpired`），不阻塞气泡
- `purgeStaleAttachments` 豁免仅认严格内容寻址正则 `^img-[0-9a-f]{16}\.(png|jpg|jpeg|gif|webp|svg|bmp|bin)$`（历史长存），paste-/upload- 及仿冒 img- 前缀的临时上传照常 48h 清
- 兼容：会话项目不可解析（resolveSessionRow null）/单条目处理失败 → base64 原样下发；legacy 内嵌 base64 part 客户端仍走 `data:` src 渲染，均未删除

## MANUAL-QA（node 级，bun 直驱源码 `.omo/tmp-task19/qa.mjs`，已清理）

```
BEFORE(base64 entry) bytes: 133146        # ~100KB 图 base64 内嵌
AFTER(reference entry) bytes: 248         # 引用形态
ref part: {"type":"image","ref":{"path":"/tmp/qa-img-.../img-207fa4d194ba7aed.png","name":"img-207fa4d194ba7aed.png"},"mimeType":"image/png"}
sidecar files: [ "img-207fa4d194ba7aed.png" ]      # 边车确实落盘
payload reduction: 99.8137%                        # 约 130KB base64 → 248 字节引用
routed prompt path line: ["[图片已保存为附件：.../img-929e08d597feae56.png（按需读取）]"]
models.json missing -> supportsImages: false       # 能力源不可用 → 保守附件
```

路由级（Hono app.request，见测试 d）：ref 下发后 `GET /attachments?path=` 取回字节与原图 `Buffer` 全等；重复拉取历史边车仅 1 个文件（内容寻址去重）。

## 测试

- `server`: `npx vitest run test/image-routing.test.ts` 12 passed（能力矩阵 4 / 分流 a+b+c+stale 4 / 历史引用化 d+e+零改动 3 / 清扫豁免 1）；全量 `npm test` 47 files 605 passed
- `web`: `npx vitest run tests/image-part-ref.test.tsx` 4 passed（legacy 内联零请求 / ref blob 渲染 / 410 占位 / 无 sessionId 静默）；全量 `npm test` 112 files 1041 passed（含 i18n-errors 87 码计数）
- 根构建 `npm run build`：成功（server/dist/index.js 12.2mb）

## 风险

- capabilities 缺 supportsImages 的存量模型一律走附件（保守口径是有意为之；用户可在 models.json 显式标注 true 恢复内联）
- server `tsc --noEmit` 有若干与本次无关的既有报错（background-state.test / meta.ts 等，主路径靠 vitest+build 门禁，未改动）

## 验证审查收口（low，已闭合）

上传通道仿冒探针：`validateAttachmentName` 只拒路径分隔符与 `..`，用户可 POST `name=img-evil.txt` 骗取清扫豁免无限留存。收紧为方案 (b)（向后兼容更安全，不动上传校验面）：`purgeStaleAttachments` 豁免仅认严格内容寻址正则 `HISTORY_IMAGE_NAME = ^img-[0-9a-f]{16}\.(png|jpg|jpeg|gif|webp|svg|bmp|bin)$`。新增探针测试：`img-evil.txt` 超龄 100h 照清、`img-0123456789abcdef.png` 保留。复验：server 全量 47 文件 606 用例绿、根构建成功。
