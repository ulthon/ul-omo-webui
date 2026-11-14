// 会话分支路径派生（session-branching todo 4）：webui 渲染层按当前叶路径过滤消息流。
// 引擎把会话存成树（每条 entry 记 parentId），此前渲染层从未消费 parentId——CLI 端
// 分过的支在 webui 全分支平铺混显（IS-1）。本模块是纯数据层：
//   derivePathEntryIds —— 从叶沿 parentId 回溯到根得路径 id 集（visited 防环、
//     孤儿/无 parentId 根处理、空叶→空集），消费侧按 entries 文件序过滤；
//   filterEntriesToPath —— chat-view messageEntries 的计算体：先以全类型条目推导
//     路径集（parentId 链要穿过 tool/custom 等不可见条目，类型过滤必须在路径推导
//     之后），路径集为空（空会话/悬空叶）时不启用过滤——平铺兜底，绝不因缺叶空屏；
//   advanceLeaf / lastEntryId —— stores/messages 各变更点共用的叶推进与尾条口径
//     （F5 关键坑：合成孪生/乐观占位创建时不挂 parentId 且不即时成为当前叶，就会
//     掉出路径=消息消失）。
import type { WireEntry } from "@/lib/api";

/** 一次路径派生的结果 */
export interface BranchPath {
  /** 路径条目 id 集（叶→根回溯收集，无序；消费侧按 entries 文件序过滤） */
  ids: Set<string>;
  /** 路径头落在未加载区（尾窗分页更早窗未拉/被压缩不可达）：回溯撞到不在 entries
   *  中的 parentId。真值由触顶翻页/全量重取补齐后消除。 */
  hasPartialPath: boolean;
  /** 起点 leafId 是否在 entries 中命中（false=悬空叶：吸收竞态残留/契约缺席，
   *  消费侧回落全量平铺） */
  leafFound: boolean;
}

/** 条目的有效 parentId（非空字符串才算，其余视为根/缺席） */
function parentIdOf(entry: WireEntry): string | null {
  const p = entry.parentId;
  return typeof p === "string" && p !== "" ? p : null;
}

/** entries 中最后一条携带有效 id 的条目 id（无则 null）——合成孪生/乐观占位创建时
 *  的 parentId 注入源；excludeId 跳过自身（同一条目重复定格时防 parentId 自环）。 */
export function lastEntryId(
  entries: ReadonlyArray<WireEntry>,
  excludeId?: string | null,
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const id = entries[i].id;
    if (typeof id === "string" && id !== "" && id !== excludeId) return id;
  }
  return null;
}

/** 叶推进统一口径（session-branching todo 4）：新条目入列后的 store.leafId 维护。
 *  推进仅四种情形：叶为空（会话首条）；新条目 parentId 即当前叶（延伸当前路径）；
 *  当前叶引用随本次变更被移除（listAfterRemovals 为移除后的列表——乐观占位被吸收/
 *  合成孪生被真值收敛，新条目即真值继任）；新条目即当前叶（幂等）。其余不拽：
 *  离径追加（他端分支操作，视图保持当前分支，等 setEntries 全量整替对齐）、
 *  existed（新条目此前已在列——重放幂等回填）永不推进。 */
export function advanceLeaf(
  currentLeafId: string | null,
  listAfterRemovals: ReadonlyArray<WireEntry>,
  entryId: string,
  parentId: string | null,
  existed: boolean,
): string | null {
  if (existed || currentLeafId === entryId) return currentLeafId;
  if (currentLeafId === null) return entryId;
  if (parentId === currentLeafId) return entryId;
  return listAfterRemovals.some((e) => e.id === currentLeafId) ? currentLeafId : entryId;
}

/** 从叶沿 parentId 回溯到根的路径派生。leafId null/空 → 空集（空叶边界）；
 *  leafId 不在 entries 中 → 空集 + leafFound=false（悬空叶，消费侧平铺兜底）；
 *  回溯撞到不在 entries 中的 parentId → 停走并置 hasPartialPath（路径头在未加载区）；
 *  visited 集合防环（坏数据 parentId 环/自环收敛不死循环）。 */
export function derivePathEntryIds(
  entries: ReadonlyArray<WireEntry>,
  leafId: string | null,
): BranchPath {
  if (leafId === null || leafId === "") {
    return { ids: new Set<string>(), hasPartialPath: false, leafFound: false };
  }
  const byId = new Map<string, WireEntry>();
  for (const e of entries) {
    const id = e.id;
    if (typeof id === "string" && id !== "" && !byId.has(id)) byId.set(id, e);
  }
  if (!byId.has(leafId)) {
    return { ids: new Set<string>(), hasPartialPath: false, leafFound: false };
  }
  const ids = new Set<string>();
  const visited = new Set<string>();
  let hasPartialPath = false;
  let cur: string | null = leafId;
  while (cur !== null) {
    if (visited.has(cur)) break; // 环守卫
    visited.add(cur);
    const entry = byId.get(cur);
    if (entry === undefined) {
      // 上一跳的 parentId 不在场：路径头在未加载区/被压缩不可达
      hasPartialPath = true;
      break;
    }
    ids.add(cur);
    cur = parentIdOf(entry);
  }
  return { ids, hasPartialPath, leafFound: true };
}

/** filterEntriesToPath 的结果：过滤后的窗口条目（文件序）与路径派生结果 */
export interface PathWindow {
  windowEntries: WireEntry[];
  path: BranchPath;
}

/** chat-view messageEntries 的计算体：先用全类型 entries 推导路径集（类型过滤在路径
 *  推导之后），再过滤 typeOk && 在路径。路径集为空（空会话 leafId null / 悬空叶）时
 *  不启用过滤——全量平铺兜底（宁可短暂混显也不空屏，缺叶由下次 setEntries 对齐）。
 *  无 id 条目防御保留（挂不上树，但也不可能是兄弟分支泄漏，不因过滤丢数据）。 */
export function filterEntriesToPath(
  entries: ReadonlyArray<WireEntry>,
  viewLeafId: string | null,
  storeLeafId: string | null,
  typeOk: (entry: WireEntry) => boolean,
): PathWindow {
  const path = derivePathEntryIds(entries, viewLeafId ?? storeLeafId);
  if (path.ids.size === 0) {
    return { windowEntries: entries.filter(typeOk), path };
  }
  const windowEntries = entries.filter(
    (e) =>
      typeOk(e) &&
      (typeof e.id !== "string" || e.id === "" || path.ids.has(e.id)),
  );
  return { windowEntries, path };
}
