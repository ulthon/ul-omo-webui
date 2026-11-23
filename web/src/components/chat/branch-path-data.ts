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
 *  existed（新条目此前已在列——重放幂等回填）永不推进。
 *  悬空父重链（webui-refetch-storm 任务 7，F3 stage-B 实锤）：relinkDanglingParent
 *  开启时，第五种情形——新条目 parentId 为非空串且不在 listAfterRemovals 中（父节点
 *  不在本地图谱）→ 视为当前路径的延伸（叶推进）。依据：活回合增量按追加式文件语义
 *  只会续在文件尾，父缺席是准入缺口而非分支分叉（分叉点的父必在图谱内）；引擎叶
 *  解析同口径沿 parentId 上溯穿过 session-lifecycle/work-custody/child-lifecycle
 *  簿记条目——这些条目经 wire type "session_lifecycle" 发布（载荷为运行快照，不携
 *  磁盘条目 id/parentId），store 永不准入，不改叶将永久冻在上一次可见条目处，叶→根
 *  路径投影把本轮全部后代排除（F3：用户消息+助手回复 live 不可见，重载才见）。
 *  仅活回合增量调用点（entry_appended 全族/消息通道）开启；REST 窗口增量
 *  （appendEntries：首条父在本窗外的悬空是常态）与本地乐观占位不开启，既有四情形
 *  与其余不拽契约完全不变。 */
export function advanceLeaf(
  currentLeafId: string | null,
  listAfterRemovals: ReadonlyArray<WireEntry>,
  entryId: string,
  parentId: string | null,
  existed: boolean,
  relinkDanglingParent = false,
): string | null {
  if (existed || currentLeafId === entryId) return currentLeafId;
  if (currentLeafId === null) return entryId;
  if (parentId === currentLeafId) return entryId;
  if (relinkDanglingParent && parentId !== null && !listAfterRemovals.some((e) => e.id === parentId)) {
    return entryId;
  }
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

/** 兄弟序位（session-branching todo 5）：路径条目在同类兄弟中的位置与前后兄弟 id。
 *  index 0 基；prevId/nextId 为 null 表示到头（对应箭头禁用）。 */
export interface SiblingPosition {
  index: number;
  count: number;
  prevId: string | null;
  nextId: string | null;
}

/** 气泡级可渲染判定（message-bubble.tsx isRenderableEntry 同口径）：type="message"
 *  且 message.role 为字符串。‹n/m› 只渲染在 user/assistant 气泡下缘，兄弟序位的
 *  合格成员也只认消息条目——引擎嫁接的 custom 簿记、tool 调用、model_change 时间线
 *  条目既不出序位，也不计入兄弟计数（task-10 缺陷 B：若簿记入组，fork 位的兄弟数
 *  会被嫁接链污染）。 */
function isBubbleEntry(entry: WireEntry): boolean {
  if (entry.type !== "message") return false;
  const msg = entry.message as { role?: unknown } | undefined;
  return typeof msg?.role === "string";
}

/** 生效父归一（task-10 缺陷 B）：引擎 navigate_tree(select) 在目标父位嫁接簿记条目
 *  （custom 型、不可渲染），新分支的 user 消息挂嫁接链之下而非直连同 fork——实测
 *  拓扑（QA 证据 §2）：u1.parent=fork（3 子）而 u2/u3.parent=各自嫁接节点（单子），
 *  裸 parentId 分组时分支二/三各自单子，‹n/m› 不渲染。归一：沿 parentId 上溯穿过
 *  不可渲染条目到最近的气泡级祖先（与 derivePathEntryIds 路径回溯穿过 tool/custom
 *  不可见条目、routes-session 树端点按 parentId 链构建同构）；祖先不在场（未加载窗/
 *  压缩剪除）以该悬空 parentId 为组键（同悬空键仍聚同组，与旧口径一致）；无父 →
 *  "" 根组；visited 防环（坏数据收敛）。 */
function effectiveParentId(entry: WireEntry, byId: Map<string, WireEntry>): string {
  const visited = new Set<string>();
  let cur = parentIdOf(entry);
  while (cur !== null) {
    if (visited.has(cur)) break; // 环守卫
    visited.add(cur);
    const parent = byId.get(cur);
    if (parent === undefined) return cur; // 悬空：以该 id 为组键
    if (isBubbleEntry(parent)) return cur;
    cur = parentIdOf(parent);
  }
  return "";
}

/** 兄弟序位派生（todo 5；task-10 缺陷 B 归一）：全量 entries 一次遍历——仅气泡级
 *  条目入组，组键为生效父（effectiveParentId 簿记压缩后的最近可渲染祖先），同组
 *  >=2 条时按 entries 文件序记每位兄弟的 index/前后 id。消费侧（chat-view）每份
 *  entries 只算一次往下传，绝不在每个气泡内重算（计划 F4 反 slop 线）。 */
export function deriveSiblingPositions(
  entries: ReadonlyArray<WireEntry>,
): Map<string, SiblingPosition> {
  const byId = new Map<string, WireEntry>();
  for (const e of entries) {
    const id = e.id;
    if (typeof id === "string" && id !== "" && !byId.has(id)) byId.set(id, e);
  }
  const childrenByParent = new Map<string, Array<WireEntry & { id: string }>>();
  for (const e of entries) {
    const id = e.id;
    if (typeof id !== "string" || id === "") continue;
    if (!isBubbleEntry(e)) continue; // 簿记/工具/时间线条目不入兄弟组（也不出序位）
    const key = effectiveParentId(e, byId);
    const arr = childrenByParent.get(key);
    if (arr) arr.push(e as WireEntry & { id: string });
    else childrenByParent.set(key, [e as WireEntry & { id: string }]);
  }
  const positions = new Map<string, SiblingPosition>();
  for (const siblings of childrenByParent.values()) {
    if (siblings.length < 2) continue;
    for (let i = 0; i < siblings.length; i++) {
      positions.set(siblings[i].id, {
        index: i,
        count: siblings.length,
        prevId: i > 0 ? siblings[i - 1].id : null,
        nextId: i < siblings.length - 1 ? siblings[i + 1].id : null,
      });
    }
  }
  return positions;
}

/** 切视图目标叶解析（task-10 缺陷 E-1）：pager 兄弟（user 消息 id）→ 目标分支
 *  的叶。引擎协议（2026-11-12 实证备忘）：navigate_tree select 命中 user 条目 =
 *  编辑位语义（叶移到该消息的父位 + 回传 editorText），切视图绝不能拿 user 消息
 *  id 作 select 目标（视图会落到零消息的空编辑位）。解析规则（确定性）：seed 子树
 * （全类型，含引擎嫁接簿记链）内最后一条 assistant 消息（分支当前终点）；子树无
 *  assistant（未获回复的分支）回退子树最后一条条目（文件序，可能是 user 消息自身
 *  或簿记尾条）；消费侧一律以 resume 意图导航（叶=条目本身，与角色无关，不存在
 *  编辑位陷阱）。seed 不在场返回 null（调用方回退原 id——resume 语义下仍安全）。
 *  visited 防环（坏数据 parentId 环收敛不死循环）。 */
export function resolveBranchLeaf(
  entries: ReadonlyArray<WireEntry>,
  seedId: string,
): string | null {
  const byId = new Map<string, WireEntry>();
  const childrenByParent = new Map<string, Array<string>>();
  for (const e of entries) {
    const id = e.id;
    if (typeof id !== "string" || id === "") continue;
    if (!byId.has(id)) byId.set(id, e);
    const pid = parentIdOf(e);
    if (pid !== null) {
      const arr = childrenByParent.get(pid);
      if (arr) arr.push(id);
      else childrenByParent.set(pid, [id]);
    }
  }
  if (!byId.has(seedId)) return null;
  // 子树 id 集：seed 起沿 children 边收集（全类型；visited 防环）
  const subtree = new Set<string>([seedId]);
  const visited = new Set<string>([seedId]);
  const queue: Array<string> = [seedId];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    for (const child of childrenByParent.get(cur) ?? []) {
      if (visited.has(child)) continue; // 环守卫
      visited.add(child);
      subtree.add(child);
      queue.push(child);
    }
  }
  // 文件序单遍：子树内最后一条 assistant 消息 ?? 子树最后一条条目 ?? seed 自身
  let lastAssistant: string | null = null;
  let lastEntry: string | null = null;
  for (const e of entries) {
    const id = e.id;
    if (typeof id !== "string" || id === "" || !subtree.has(id)) continue;
    lastEntry = id;
    if (
      e.type === "message" &&
      (e.message as { role?: unknown } | undefined)?.role === "assistant"
    ) {
      lastAssistant = id;
    }
  }
  return lastAssistant ?? lastEntry ?? seedId;
}

/** filterEntriesToPath 的结果：过滤后的窗口条目（文件序）与路径派生结果 */
export interface PathWindow {
  windowEntries: WireEntry[];
  path: BranchPath;
}

/** chat-view messageEntries 的计算体：先用全类型 entries 推导路径集（类型过滤在路径
 *  推导之后），再过滤 typeOk && 在路径。路径集为空（空会话 leafId null / 悬空叶）时
 *  不启用过滤——全量平铺兜底（宁可短暂混显也不空屏，缺叶由下次 setEntries 对齐）。
 *  无 id 条目防御保留（挂不上树，但也不可能是兄弟分支泄漏，不因过滤丢数据）。
 *  中段缺口平铺兜底（webui-refetch-storm 任务 7，F3 同源）：hasPartialPath 时回溯
 *  在缺口处停走，缺口以上的祖先段不可判支——将文件序上首个路径条目之前的段落一并
 *  放行（typeOk 过滤不变，混显由全量对齐收敛）。边界不变量：窗口头缺口（触顶翻页
 *  形态，缺口=已加载窗外）首个路径条目即 entries[0]，前缀为空，输出与原过滤完全
 *  一致——本分支仅对中段缺口（准入缺口，叶侧在缺口下方）生效。 */
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
  if (path.hasPartialPath) {
    let firstIdx = entries.length;
    for (let i = 0; i < entries.length; i++) {
      const id = entries[i].id;
      if (typeof id === "string" && path.ids.has(id)) {
        firstIdx = i;
        break;
      }
    }
    return {
      windowEntries: entries.filter(
        (e, i) =>
          typeOk(e) && (i < firstIdx || (typeof e.id === "string" && path.ids.has(e.id))),
      ),
      path,
    };
  }
  const windowEntries = entries.filter(
    (e) =>
      typeOk(e) &&
      (typeof e.id !== "string" || e.id === "" || path.ids.has(e.id)),
  );
  return { windowEntries, path };
}
