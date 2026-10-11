// 标签 UI 纯逻辑（todo 11）：徽标截断、孤儿判定、选择器整替载荷、过滤选项合并、
// 管理弹层整替列表生成。抽成纯函数便于单测（web/tests/tags-ui.test.ts）；
// 组件层（tag-badge/tag-selector/tag-manage-dialog）只做渲染与请求接线。
// 键约定与服务端一致：挂载与定义都以 (scope, name) 为键，scope 取 "global"|"project"。

/** 挂载引用（与服务端 SessionTagRef 同形；createdAt 在列表传输中被裁掉） */
export interface TagRef {
  scope: string;
  name: string;
}

/** 定义条目（GET /api/tags 的 global/project 列表项） */
export interface TagDefinition {
  name: string;
  sort: number;
}

/** 两源定义集合形状（GET /api/tags 响应的 global+project 字段） */
export interface TagDefs {
  global: TagDefinition[];
  project: TagDefinition[];
}

/** 行内徽标最多显示的标签数（计划：3 个以内全显，超出折叠为 +N） */
export const TAG_BADGE_LIMIT = 3;

/** (scope,name) 唯一键（与 routes-tags 服务端去重键同形） */
export function tagKey(ref: TagRef): string {
  return `${ref.scope}\u0000${ref.name}`;
}

/** 两源定义集唯一键集合（孤儿判定基准） */
export function definedTagKeys(defs: TagDefs): Set<string> {
  const out = new Set<string>();
  for (const d of defs.global) out.add(`global\u0000${d.name}`);
  for (const d of defs.project) out.add(`project\u0000${d.name}`);
  return out;
}

/** 徽标显示截断：前 TAG_BADGE_LIMIT 个全显，其余折叠计数 */
export function visibleTags(tags: TagRef[] | undefined): { shown: TagRef[]; extra: number } {
  const list = tags ?? [];
  return { shown: list.slice(0, TAG_BADGE_LIMIT), extra: Math.max(0, list.length - TAG_BADGE_LIMIT) };
}

/** 孤儿挂载：挂载的 (scope,name) 不在两源定义集中（定义已删/改名） */
export function isOrphanTag(ref: TagRef, keys: Set<string>): boolean {
  return !keys.has(tagKey(ref));
}

/** 会话挂载中属于孤儿的部分（灰显徽标的"清理"载荷 = 当前挂载 − 孤儿） */
export function orphanTags(tags: TagRef[] | undefined, keys: Set<string>): TagRef[] {
  return (tags ?? []).filter((t) => isOrphanTag(t, keys));
}

/** 过滤下拉选项：全局 + 项目级标签合并去重，显示纯名（跨 scope 同名只留一个，全局优先） */
export function mergeTagOptions(defs: TagDefs): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of defs.global) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    out.push(d.name);
  }
  for (const d of defs.project) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    out.push(d.name);
  }
  return out;
}

/** 多项目合并定义去重：项目级按名去重保留首现（不同项目同名标签在选择器中
 * 挂载键同为 (project,name)，重复渲染会造成歧义）；global 恒单源原样保留 */
export function dedupeTagDefs(defs: TagDefs): TagDefs {
  const seen = new Set<string>();
  const project: TagDefinition[] = [];
  for (const d of defs.project) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    project.push(d);
  }
  return { global: defs.global, project };
}

/** 选择器勾选 → 单会话整替载荷：on 追加（已存在则保持原序），off 移除（不存在则原样） */
export function nextSessionTags(current: TagRef[] | undefined, toggle: TagRef, on: boolean): TagRef[] {
  const list = current ?? [];
  const rest = list.filter((t) => !(t.scope === toggle.scope && t.name === toggle.name));
  if (!on) return rest;
  return [...rest, toggle];
}

/** 管理弹层·新增：追加到 scope 列表尾部（sort 取现有最大值 +1，服务端按 sort 升序稳定） */
export function appendTagEntry(entries: TagDefinition[], name: string): TagDefinition[] {
  const maxSort = entries.reduce((m, e) => Math.max(m, e.sort), 0);
  return [...entries, { name, sort: maxSort + 1 }];
}

/** 管理弹层·重命名：定义改名（挂载记录以 (scope,name) 为键不跟随 → 存量挂载成为孤儿） */
export function renameTagEntries(entries: TagDefinition[], from: string, to: string): TagDefinition[] {
  return entries.map((e) => (e.name === from ? { ...e, name: to } : e));
}

/** 管理弹层·删除：定义删除（挂载成孤儿，前端灰显可清理） */
export function removeTagEntry(entries: TagDefinition[], name: string): TagDefinition[] {
  return entries.filter((e) => e.name !== name);
}

/** 管理弹层·上移/下移：相邻两项交换后 sort 按 index 重排（整替列表，连续移动稳定）；
 * 目标越界或条目不存在时原样返回 */
export function reorderTagEntries(entries: TagDefinition[], name: string, dir: -1 | 1): TagDefinition[] {
  const idx = entries.findIndex((e) => e.name === name);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= entries.length) return entries;
  const next = entries.slice();
  [next[idx], next[target]] = [next[target], next[idx]];
  return next.map((e, i) => ({ ...e, sort: i }));
}
