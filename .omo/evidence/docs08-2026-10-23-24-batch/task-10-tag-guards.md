# 任务 10 标签守卫三件套 - 证据笔记

worktree: `/data/projects/senpi-webui-wt/docs08-batch-w1-t10`（branch `docs08-batch/w1-t10`，基于 main@98242cc）
日期：2026-10-25

## 三件套行为摘要

1. **失败保留 null（防误判孤儿）** `session-list.tsx` `reloadTagDefs` 非 401 失败分支不再写空定义集
   `{global:[],project:[]}`；tagDefs 维持 null（未就绪）。孤儿判定消费方链路核查：
   - `TagBadges`（tag-badge.tsx）：`definedKeys === null` 整体 return null（不渲染、不判定）；
   - `session-item.tsx` 透传 `definedKeys ?? null`；
   - `topbar.tsx` SessionSwitcherSheet 自有加载，失败分支本就 `setTagDefs(null)`（未改动，语义一致）；
   - 打标/管理入口 `disabled={!tagDefs}`；本任务新增的 `orphanCleanups` 也以 `definedKeys` 为 null 时返回 null（定义未知不判定孤儿，更不提供删除）。
2. **清理入管理弹框 + 两段式确认** `tag-badge.tsx` 色格（原 :82）与文字徽标（原 :131）两处点按
   `cleanOrphans()` 直删全部移除；孤儿仍灰显（dashed/X 图标保留），点按无删除副作用（色格移动端点按保留 toast 显名）。
   清理入口移入 `tag-manage-dialog.tsx` 新增「失效标签挂载（孤儿）」区：逐会话列出本 scope 相关孤儿，点「清理」→ 出现
   「确认清理」按钮（第一段，不发请求）→ 再点确认才整替删除（第二段）。清单由 session-list 按 definedKeys 算好传入。
3. **挂载删除审计行** 服务端唯一挂载写入缝隙 `PUT /api/sessions/:id/tags`（routes-tags.ts）整替前后做差，
   被移除的挂载逐条写入新表 `meta_tag_mount_audit`（schema.ts `CREATE TABLE IF NOT EXISTS`，幂等、无迁移框架依赖，
   不改既有表）：`session_id / tag_scope / tag_name / source / created_at`。source = 触发删除的 UI 动作标识，由前端随整替
   请求下发（`api.setSessionTags` 新增可选第三参）：`tag-manage-dialog:orphan-clean`（管理弹框确认清理）、
   `tag-dropdown`（选择器取消勾选），缺省 `api`。db 层新增 `appendTagMountAudit` / `listTagMountAudit`（meta.ts）。

## 测试命令与结果（本 worktree 实跑）

- server 全量：`cd server && npx vitest run`
  ```
  Test Files  43 passed (43)
       Tests  548 passed (548)
  ```
  其中新增 `PUT /api/sessions/:id/tags 挂载删除审计`（routes-tags.test.ts，3 例）：
  - 整替移除逐条写审计行（会话 id、tag、时间、source）；
  - 审计行落库持久：close 后重开 openMetaDb 仍可读（stale state 对抗类）；
  - 无 source 缺省 api；仅新增/幂等同内容不产生审计行。
- web 全量：`cd web && npx vitest run`
  ```
  Test Files  104 passed (104)
       Tests  974 passed (974)
  ```
  其中新增/改写：
  - `web/tests/tag-guards.test.tsx`（4 例，新增）：QA1 `/api/tags` 500 → tagDefs null、无徽标无 data-orphan
    （不写空集）；对照：定义加载成功 → 孤儿灰显在且点按不触发 setSessionTags；QA2 管理弹框两段式确认
    （第一段零请求、确认后以 keep + source="tag-manage-dialog:orphan-clean" 调 setSessionTags 并 patchSession）；
    无孤儿清单不渲染清理区。
  - `web/tests/tags-badge-grid.test.tsx`：原「点孤儿格清理走整替」用例按新语义改写为「点格不再触发清理」，
    另加文字徽标孤儿点按不触发清理 1 例。
- web lint：`npm run lint` → 0 error（仅既有 warning）。

## 对抗类覆盖

- malformed-input（null tagDefs 全消费方）：grep 全部 definedKeys/tagDefs 消费点核查（tag-badge / session-item /
  topbar / session-list 三入口 + disabled 门），null 均为「跳过判定」语义。
- stale_state：审计行经重开库断言持久；行内挂载经 patchSession 断言清空孤儿。
- flaky-tests：全部确定性（无计时/轮询等待；flush 为微任务排空）。
- misleading_success_output：以上计数均为完整套件实跑粘贴，非子集。

## 范围与排除

- 未动批量整替守卫（计划 Must NOT，留台账后续）；未改 tags.json 格式；无新依赖；未改既有表结构（仅新增审计表）。
- 真实浏览器截图未做（任务说明 F3 后续覆盖 UI 表面）；以组件级渲染测试（真实组件 + happy-dom）替代。
