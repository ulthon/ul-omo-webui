#!/usr/bin/env node
/**
 * 长会话复现台架 · 种子脚本（webui-refetch-storm 计划任务 6，阶段 A）。
 *
 * 按引擎会话 JSONL 真实形态生成 17k 条目种子会话：混合 message（user/assistant 多腿
 * 含 toolResult 长工具环）/custom 簿记/custom_message（display=true/false 两形）/记忆
 * （四前缀命名空间）/压缩条目，parentId 线性链真实，并覆盖准入白名单边界两侧形态
 * （白名单内：compaction、omo-senpi:wake、记忆前缀、user/assistant message；白名单外：
 * toolResult 多腿、pi-rules.scan 等簿记、display:false 非记忆 custom_message——正是
 * 增量悬空风暴的驱动形态）。
 *
 * 配比锁定生产样本实证值（~/.omo/agent/sessions/--data-projects-ul-omo-webui--/
 * 1a0aea95-*.jsonl，2802 条：message 21.1%（user/assistant/toolResult = 1.5%/54%/44%）、
 * custom 73.7%、custom_message 5.0%），配额制装配保证精确达标；条目形态逐字段镜像
 * 生产样本与 web/src/stores/messages.ts entry_appended 白名单面，不造失真简化条目。
 *
 * 种子落点：<out>/sessions/<encodeCwdToSessionDirName(projectPath)>/<sessionId>.jsonl。
 * 编码算法与 server/src/adapter/senpi-adapter.ts:192 encodeCwdToSessionDirName 完全一致
 * （去前导 /，/ 换 -，包 --...--）；--out 即 UL_OMO_WEBUI_AGENT_DIR 将指向的临时根，
 * 缺省落仓库 .omo/tmp/ 专用子目录（绝不进仓库根、绝不写真实 ~/.omo/agent）。
 *
 * 用法：
 *   node scripts/seed-large-session.mjs [--out <agentRoot>] [--entries 17000]
 *        [--project <dir>] [--session-id <uuid>] [--seed <n>] [--quiet]
 *
 * 输出：stdout 末行打印 machine-readable stats JSON（seed_stats 键）；断言失败非零退出。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(import.meta.dirname, "..");

// ---- 形态常量（与生产样本逐字段对齐） ----
const PROVIDER = "zai-coding-cn";
const MODEL_MAIN = "glm-5.3";
const MODEL_FLASH = "glm-5.3-flash";
const API_FLAVOR = "openai-completions";

// 记忆命名空间前缀白名单（web/src/lib/memory-entries.ts MEMORY_NAMESPACE_PREFIXES）。
// 种子只用已知可渲染类（markerMeta 覆盖面），保证阶段 B 浏览器断言有真实标记可数。
const MEMORY_TYPES = {
  sessionBinding: "senpi-memory.session-binding",
  acceptedTurns: "omo-memory:accepted-turns",
  projectionPin: "omo-memory:projection-pin",
  kibitzerRecall: "omo-kibitzer:recall",
  memorianNudged: "omo-memorian:nudged",
};

// ---- 确定性 PRNG（mulberry32）：同 --seed 完全可复现 ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 模块级单一随机流：id/文本长度/usage 数值全部同源，同 --seed 逐字节可复现 */
let rng = mulberry32(1);

/** cwd -> 会话库目录名（与 senpi-adapter.ts:192 同算法，勿改） */
export function encodeCwdToSessionDirName(cwd) {
  return `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`;
}

/** 从种子化 PRNG 派生 uuid 形态（8-4-4-4-12），保证同 --seed 全文件逐字节可复现 */
function uuidFromRng() {
  const h = randomBytesHex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${["8", "9", "a", "b"][h.charCodeAt(16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function randomBytesHex(n) {
  let s = "";
  const alphabet = "0123456789abcdef";
  for (let i = 0; i < n * 2; i += 1) {
    s += alphabet[Math.floor(rng() * 16)];
  }
  return s;
}

// ---- 生成器：线性链推进 + 配额簿记 ----
class Gen {
  constructor(opts) {
    this.project = opts.project;
    this.sessionId = opts.sessionId;
    this.model = opts.model;
    this.entries = [];
    this.lastId = null;
    this.clock = Date.parse(opts.baseTime);
    this.turn = 0;
    this.identity = `qa-large-${opts.seed.toString(16)}`;
    // 预初始化全部计数键：任何读取路径都拿到数字（undefined 首读会让 delta 变 NaN、
    // 追赶条件 undefined < N 恒假——两类静默退化都源于此）
    this.counts = {
      type: { session: 0, model_change: 0, thinking_level_change: 0, custom: 0, custom_message: 0, message: 0, session_info: 0, compaction: 0 },
      role: { user: 0, assistant: 0, toolResult: 0 },
      customType: {},
      cmType: {},
    };
    this.turnState = { legsLeft: 0 };
  }

  nextId() {
    return randomBytesHex(4);
  }

  /** 条目通用装配：线性链推进（parentId = 前一条目 id；首条内容条目 parentId=null，
   * 与生产样本一致：session 头不进链）。时间戳严格单调递增。 */
  push(entry) {
    this.clock += 60 + Math.floor(rng() * 620);
    const id = this.nextId();
    const stamped = { ...entry, id, parentId: this.lastId ?? null, timestamp: new Date(this.clock).toISOString() };
    this.lastId = id;
    this.entries.push(stamped);
    const t = stamped.type;
    this.counts.type[t] = (this.counts.type[t] ?? 0) + 1;
    if (t === "message") {
      const r = stamped.message.role;
      this.counts.role[r] = (this.counts.role[r] ?? 0) + 1;
    }
    if (t === "custom") this.counts.customType[stamped.customType] = (this.counts.customType[stamped.customType] ?? 0) + 1;
    if (t === "custom_message") this.counts.cmType[stamped.customType] = (this.counts.cmType[stamped.customType] ?? 0) + 1;
    return id;
  }

  header() {
    // session 头不进 parentId 链（样本实证：下一内容条目 parentId=null）
    this.clock += 100;
    this.entries.push({
      type: "session",
      version: 3,
      id: this.sessionId,
      timestamp: new Date(this.clock).toISOString(),
      cwd: this.project,
    });
    this.counts.type.session = (this.counts.type.session ?? 0) + 1;
    this.lastId = null;
  }

  modelChange() {
    this.push({ type: "model_change", provider: PROVIDER, modelId: this.model });
  }

  thinkingLevelChange(level) {
    this.push({
      type: "thinking_level_change",
      thinkingLevel: level,
      thinkingSelection: { level, source: "explicit" },
      provider: PROVIDER,
      modelId: this.model,
    });
  }

  custom(customType, data, opts = {}) {
    const e = { type: "custom", customType, data };
    if (opts.startup) e.startupBookkeeping = true;
    this.push(e);
  }

  customMessage(customType, content, display, details = {}) {
    this.push({ type: "custom_message", customType, content, display, details });
  }

  sessionInfo(name) {
    this.push({ type: "session_info", name });
  }

  compaction(summary) {
    this.push({ type: "compaction", summary });
  }

  /** 下一个 message 条目（回合状态机）：user 起头 → [assistant(toolCall)+toolResult]* →
   * assistant(思考+文本) 收尾。每用户回合工具腿数 24..48，镜像生产样本的低用户占比
   * 长自主环形态。 */
  nextMessage(shortTail = false) {
    if (this.turnState.legsLeft <= 0 && !this.turnState.finale) {
      // 开新用户回合
      this.turn += 1;
      this.turnState = { legsLeft: 24 + Math.floor(rng() * 25), finale: true, toolIdx: this.turn };
      this.push({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: userPromptFor(this.turn) }] },
      });
      return;
    }
    if (this.turnState.legsLeft > 0) {
      const spec = TOOL_SPECS[this.turnState.toolIdx % TOOL_SPECS.length];
      this.turnState.toolIdx += 1;
      this.turnState.legsLeft -= 1;
      this.push({
        type: "message",
        message: {
          role: "assistant",
          content: [
            ...(this.turnState.legsLeft % 6 === 0
              ? [{ type: "thinking", thinking: thinkingText(shortTail ? 300 : 400 + Math.floor(rng() * 2600), this.turn, this.turnState.legsLeft) }]
              : []),
            { type: "toolCall", id: `call_${randomBytesHex(12)}`, name: spec.name, arguments: spec.args(), runtimeItemKey: `blk:${randomBytesHex(8)}:0` },
          ],
          api: API_FLAVOR,
          provider: PROVIDER,
          model: this.model,
          usage: usageOf(),
          stopReason: "toolUse",
          timestamp: this.clock,
        },
      });
      this.push({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: `call_${randomBytesHex(12)}`,
          toolName: spec.name,
          content: [{ type: "text", text: toolResultText(spec.name, this.turn, shortTail) }],
          details: { kind: "text", lines: 1 + (this.turnState.legsLeft % 40) },
        },
      });
      return;
    }
    // 收尾腿：思考块 + 最终文本（长文镜像生产样本的数 KB 思考段）
    this.turnState.finale = false;
    this.push({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: thinkingText(shortTail ? 400 : 1200 + Math.floor(rng() * 2400), this.turn, 0) },
          { type: "text", text: assistantTextFor(this.turn) },
        ],
        api: API_FLAVOR,
        provider: PROVIDER,
        model: this.model,
        usage: usageOf(),
        stopReason: "endTurn",
        timestamp: this.clock,
      },
    });
  }

  /** 下一个 custom 簿记条目（按生产观测频率加权抽取类型） */
  nextCustom(inTail) {
    const customType = weightedPick(CUSTOM_POOL);
    this.custom(customType, customDataFor(customType, this, inTail), { startup: false });
  }

  /** 下一个 custom_message 条目（display 两形 + 记忆召回 + wake 按配额池抽取） */
  nextCustomMessage() {
    const kind = weightedPick(CM_POOL);
    if (kind === "usage") {
      this.customMessage("senpi-task.usage",
        "<omo-senpi-task>\nBackground task results are automatically delivered: an idle session is always woken, and a running turn receives them at its next tool boundary.\n- /tasks shows this session's children; task_output is for one midpoint status or transcript peek.\nIf no independent work remains, end your turn.\n</omo-senpi-task>",
        false, {});
    } else if (kind === "loopGuard") {
      this.customMessage("loop-guard:notice",
        "<system-reminder>\nLOOP GUARD - IDENTICAL TOOL CALLS: you called `bash_output` 3 times in a row with the EXACT same arguments. Snap out of it: reuse the result you already received, or change one parameter deliberately.\n</system-reminder>",
        true);
    } else if (kind === "kibitzerRecall") {
      this.customMessage(MEMORY_TYPES.kibitzerRecall,
        `<recalled-memory source="[[notes/facts/qa-large-turn-${this.turn}]]">种子召回条目：形态镜像生产样本 custom_message display:false 容器，content 为 recalled-memory 包裹文本。</recalled-memory>`,
        false);
    } else if (kind === "memorianRecall") {
      this.customMessage("omo-memorian:recall",
        `<recalled-memory source="[[people/qa-${this.turn}]]">种子召回条目（memorian 形态）。</recalled-memory>`,
        false);
    } else {
      const taskId = `st_${randomBytesHex(8)}-${randomBytesHex(4)}-${randomBytesHex(4)}-${randomBytesHex(4)}-${randomBytesHex(12)}`;
      this.customMessage("omo-senpi:wake",
        `task completion name:qa-seed-${this.turn} id:${taskId} category:quick(${PROVIDER}/${MODEL_FLASH}) status:completed duration:1m 12s tokens:12345 tools:3 tps:58\nresult:"种子任务完成回执（形态镜像生产样本）。"`,
        false,
        {
          producerDetails: [{
            customType: "senpi-task.completion",
            details: [{ runRef: { kind: "task", id: taskId }, task_id: taskId, name: `qa-seed-${this.turn}`, status: "completed" }],
          }],
        });
    }
  }

  /** 记忆簇（custom 通道，镜像生产聚簇形态：binding/accepted-turns/projection-pin/nudged） */
  memoryCluster() {
    this.custom(MEMORY_TYPES.sessionBinding, {
      identity: this.identity,
      repoPathHash: randomBytesHex(32),
      boundAt: this.clock,
    });
    this.custom(MEMORY_TYPES.acceptedTurns, {
      version: 1,
      sessionId: this.sessionId,
      priorUserTurns: this.turn,
      sessionBaselineTurns: 0,
    });
    if (rng() < 0.5) {
      this.custom(MEMORY_TYPES.projectionPin, {
        version: 1,
        sessionId: this.sessionId,
        revision: null,
        noticedThrough: null,
        compactionId: null,
        pinnedAtMs: this.clock,
      });
    } else {
      this.custom(MEMORY_TYPES.memorianNudged, { sessionId: this.sessionId, nudgedAtMs: this.clock });
    }
  }
}

// ---- custom 类型池（频率权重取自生产样本分布直觉：状态机类簿记高频、工具类低频） ----
const CUSTOM_POOL = [
  ["session-lifecycle", 17],
  ["senpi.hooks.stop-state", 15],
  ["turn-end-liveness", 11],
  ["work-custody", 8],
  ["rule-activation", 6],
  ["engine-turn-start", 6],
  ["senpi.todo-state", 5],
  ["goal-cache-warmup", 3],
  ["senpi.context-reduction.v1", 2.5],
  ["ask-user:question", 1.5],
  ["session-hold", 2],
  ["pi-rules.scan", 1.5],
  ["repository-identity", 1],
  ["omo-model-profile:applied", 1.5],
  ["permission_mode", 1],
  ["claude-sdk-oauth-binding", 1],
  ["harness-detect-cache", 1],
  ["MEMORY", 12], // 记忆簇槽位（四种记忆 custom 条目轮换）
];

// custom_message 配额池（比例对齐生产：usage 占大头、display:true 占约 7%）
const CM_POOL = [
  ["usage", 48],
  ["kibitzerRecall", 30],
  ["memorianRecall", 4],
  ["wake", 11],
  ["loopGuard", 7],
];

function weightedPick(pool) {
  const total = pool.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of pool) {
    r -= w;
    if (r <= 0) return v;
  }
  return pool[pool.length - 1][0];
}

function customDataFor(customType, g, inTail) {
  const sid = g.sessionId;
  const turn = g.turn;
  switch (customType) {
    case "MEMORY":
      g.memoryCluster();
      return null; // 已在 memoryCluster 内入列
    case "session-lifecycle":
      return {
        state: inTail ? "idle" : "running",
        seq: turn + 1,
        epoch: 1,
        epochOrigin: "human",
        humanInputRevision: turn + 1,
        selfSettleEligible: true,
        restoring: false,
        persisted: true,
        runPaused: false,
        since: new Date(g.clock).toISOString(),
        role: "root",
        rootSessionId: sid,
        waitingOn: { children: 0, background: [], human: [] },
        holds: [],
        runId: randomBytesHex(12),
        sessionId: sid,
        attentionSeq: turn,
        synthetic: [],
        epochSealed: false,
        runActive: !inTail,
      };
    case "senpi.hooks.stop-state":
      return { count: 0, sessionId: sid, turnKey: `${turn + 1}:${randomBytesHex(4)}` };
    case "turn-end-liveness":
      return { verdict: { kind: "settled", reason: "turn-end" }, openWork: { kind: "open-todos", count: turn % 4 } };
    case "work-custody":
      return { id: randomBytesHex(12), key: `delivery:senpi.todo-owed:${randomBytesHex(12)}`, kind: "background", state: turn % 2 ? "open" : "closed", sessionId: sid };
    case "rule-activation":
      return { kind: "ttsr", owner: "collapse-repetition", rules: ["collapse-repetition"], remediation: "nudge" };
    case "engine-turn-start":
      return { customType: "ttsr-injection" };
    case "senpi.todo-state":
      return {
        schema: "v2",
        phases: [
          { name: "排查", tasks: [{ content: "定位增量悬空根因", status: "completed" }, { content: "设计台架断言", status: turn % 2 ? "in_progress" : "completed" }] },
          { name: "验证", tasks: [{ content: "真引擎回合断言", status: "pending" }] },
        ],
      };
    case "goal-cache-warmup":
      return { phase: "scheduled", goalId: randomBytesHex(12), delayMs: 270000, dueAtMs: g.clock + 270000, iteration: 1, activeMonitorCount: 2, wakeSources: { "omo-wake-queue": 0, "senpi-codemode": 1, "senpi-task": 1 }, cache: { cachedTokens: 60000 + turn * 7, ttlSeconds: 300, estimatedSavedUsd: 0.08 } };
    case "senpi.context-reduction.v1":
      return { engaged: true, cutIndex: 40 + (turn % 90), prefixHash: randomBytesHex(32) };
    case "ask-user:question":
      return { requestId: `call_${randomBytesHex(12)}`, headers: ["口径", "范围"] };
    case "session-hold":
      return { op: "add", kind: "session_hold", key: "interrupted-run", pauseSeq: turn % 5, at: new Date(g.clock).toISOString() };
    case "pi-rules.scan":
      return { cwd: g.project, reason: inTail ? "post-compaction" : "startup" };
    case "repository-identity":
      return { rootCommits: [randomBytesHex(20)] };
    case "omo-model-profile:applied":
      return { content: `OmO Native: model profile "daily-normal" selected ${PROVIDER}/${g.model}`, details: { profile: "daily-normal", model: `${PROVIDER}/${g.model}` } };
    case "permission_mode":
      return { preset: "full-access", source: "client" };
    case "claude-sdk-oauth-binding":
      return { schemaVersion: 1, invalidated: turn % 3 === 0, reason: "compaction" };
    case "harness-detect-cache":
      return { provider: PROVIDER, modelId: g.model, detectedAt: g.clock };
    default:
      return { note: `unmapped:${customType}` };
  }
}

const USER_PROMPTS = [
  "帮我看下这个会话的渲染稳定性问题，滚动的时候列表会跳",
  "把刚才提到的修复方案整理成回归测试清单",
  "读一下 src/stores/messages.ts 里 entry_appended 的处理逻辑",
  "总结一下当前诊断行的计数口径",
  "这个全量拉取风暴的根因是什么，给我定位到具体代码行",
  "跑一下测试看看有没有回归",
  "把白名单外的簿记条目也入列为不可见图节点，避免增量悬空",
  "压缩总结之前先把分支树导出一份",
];

const ASSISTANT_TEXTS = [
  "定位到了：增量悬空是因为白名单外条目不入列，修复触发点每回合都重拉全量。下面分三步说明……",
  "回归测试覆盖三条路径：未知 customType 入列、display:true 占位行、真丢帧仍修复。",
  "滚动补偿要在落地前快照首个可见项的 key 与偏移，落地后 scrollToIndex 补差。",
  "诊断口径确认：graph-repair 每回合应为 0，session_open 每次打开仅 1 行。",
  "冷却放在触发点而不是 repairEntriesGraph 本体，迟滞落地路径完全豁免。",
];

const TOOL_SPECS = [
  { name: "read", args: () => ({ path: "/data/projects/qa-large/src/stores/messages.ts", offset: 1224, limit: 90 }) },
  { name: "bash_output", args: () => ({ bash_id: `out_${randomBytesHex(6)}`, filter: "^PASS" }) },
  { name: "todo", args: () => ({ op: "view" }) },
  { name: "grep", args: () => ({ pattern: "entry_appended", path: "/data/projects/qa-large/web/src" }) },
  { name: "eval", args: () => ({ language: "py", code: "print('probe')" }) },
];

function userPromptFor(turn) {
  return USER_PROMPTS[turn % USER_PROMPTS.length];
}

function assistantTextFor(turn) {
  return ASSISTANT_TEXTS[turn % ASSISTANT_TEXTS.length];
}

function toolResultText(toolName, turn, short) {
  if (short) return `工具回执（第 ${turn} 轮 ${toolName}）：尾部回合短回执。`;
  return `工具回执（第 ${turn} 轮 ${toolName}）：命中 ${1 + (turn % 5)} 处，已按偏移返回内容片段；` +
    `分段说明 ${"补充推演。".repeat(4 + (turn % 8))}`;
}

function thinkingText(size, turn, legsLeft) {
  const lines = [
    `先复述意图：用户要的是长会话（17k 条目）下滚动与全量拉取风暴的可复现台架（第 ${turn} 回合，工具腿 ${legsLeft}）。`,
    "逐层排除：白名单（compaction/wake/记忆前缀/message）、图节点入列、修复触发点、滚动锚点。",
    "对照生产样本形态：custom 簿记占七成，message 多腿含 toolResult，记忆条目四前缀命名空间。",
    "代价权衡：不做逐帧 O(N) 重建，沿用分页尾窗；冷却进触发点不进 repairEntriesGraph 本体。",
    "验证面：vitest 纯函数断言 + 本台架真引擎回合 + 浏览器几何双轨（happy-dom 无布局不做 scrollTop 断言）。",
  ];
  let text = "";
  let i = 0;
  while (text.length < size) {
    text += `${lines[i % lines.length]}（展开论证段 ${i}：${"细节推演。".repeat(3 + Math.floor(rng() * 6))}）\n`;
    i += 1;
  }
  return text;
}

function usageOf() {
  const input = 2200 + Math.floor(rng() * 9000);
  const output = 40 + Math.floor(rng() * 600);
  const cacheRead = 20000 + Math.floor(rng() * 120000);
  const reasoning = rng() < 0.6 ? 10 + Math.floor(rng() * 300) : 0;
  const cost = {
    input: Number((input * 1.4e-6).toFixed(7)),
    output: Number((output * 2.1e-6).toFixed(7)),
    cacheRead: Number((cacheRead * 2.3e-7).toFixed(7)),
    cacheWrite: 0,
  };
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    reasoning,
    totalTokens: input + output + cacheRead + reasoning,
    cost: { ...cost, total: Number((cost.input + cost.output + cost.cacheRead).toFixed(7)) },
  };
}

function compactionSummaryText() {
  return [
    "## 1. User Requests (Verbatim)",
    '- "帮我看下这个会话的渲染稳定性问题，滚动的时候列表会跳"',
    '- "全量拉取风暴的根因定位"',
    "",
    "## 2. Final Goal",
    "长会话（17k 条目）渲染稳定：回合中投影不振荡、修复稳态归零、记忆标记卡留存。",
    "",
    "## 3. Established Facts",
    "- 白名单外条目不入列导致增量悬空，每回合触发修复风暴。",
    "- 尾窗分页与上翻加载是既有机制，渲染口径 A 已拍板。",
    "",
    "## 9. Next Steps",
    "- 打开种子会话跑一轮真引擎回合，断言诊断行与视口几何。",
  ].join("\n");
}

// ---- 主体：配额制装配（比例锁定生产样本实证值），写盘后自断言 ----
export async function runSeed(options = {}) {
  const out = resolve(options.out ?? join(REPO_ROOT, ".omo", "tmp", "webui-refetch-storm", `seed-${Date.now()}`));
  const project = resolve(options.project ?? join(out, "projects", "qa-large-session"));
  const target = options.entries ?? 17000;
  const seed = options.seed ?? 20261123;
  rng = mulberry32(seed);
  const sessionId = options.sessionId ?? uuidFromRng();
  const model = options.model ?? MODEL_MAIN;

  // 配额表（镜像 2802 条生产样本的实证占比）
  const qMessage = Math.floor(target * 0.211);
  const qCustomMessage = Math.floor(target * 0.05);
  const qFixed = 26; // model_change 14 + thinking 6 + session_info 3 + compaction 1 + 收尾簿记 2
  const qCustom = target - qMessage - qCustomMessage - qFixed - 1; // -1 = session 头

  const g = new Gen({ project, sessionId, model, seed, baseTime: options.baseTime ?? "2026-11-20T00:00:00.000Z" });
  g.header();
  // 启动簿记（样本开场形态：model_change parentId=null 起链）
  g.modelChange();
  g.thinkingLevelChange("low");
  g.custom("pi-rules.scan", { cwd: project, reason: "startup" }, { startup: true });
  g.custom("repository-identity", { rootCommits: [randomBytesHex(20)] }, { startup: true });
  g.custom("omo-model-profile:applied", { content: `OmO Native: model profile "daily-normal" selected ${PROVIDER}/${model}`, details: { profile: "daily-normal", model: `${PROVIDER}/${model}` } }, { startup: true });
  g.memoryCluster();
  g.sessionInfo("QA 长会话复现台架种子");

  let msgBudget = qMessage - 0;
  let cmBudget = qCustomMessage;
  let customBudget = qCustom - 7; // 扣掉已发启动簿记中的 custom（pi-rules/repository/profile/记忆簇按簇计）
  customBudget -= 5; // 启动记忆簇按 3 custom 计，多扣 2 作安全裕度（终态以实际计数断言）
  // 稀疏固定条目调度（按自身配额均匀铺开，避免计数跳变漏发）
  const sparse = [
    { kind: "model_change", total: 13 },
    { kind: "thinking_level_change", total: 5 },
    { kind: "session_info", total: 2 },
  ];
  sparse.forEach((s) => {
    s.left = s.total;
    s.at = Math.floor((target * 1) / (s.total + 1));
  });
  let sparseIdx = 0;

  // 压缩点：93.5% 位置（生产形态：压缩靠后、尾段短）；尾段 message 上限受控（真回合成本护栏）
  const compactionAt = Math.floor(target * 0.935);
  let compacted = false;
  const TAIL_MESSAGE_CAP = Math.min(120, Math.max(40, Math.floor((target - compactionAt) * 0.11)));
  let tailMessages = 0;

  // 追赶式穿插：custom/cm 按目标密度插在 message 步进之间（生产形态：簿记密布于工具环）
  const catchUp = (inTail) => {
    // 追赶 custom：密度 = qCustom / target
    while (customBudget > 0 && g.counts.type.custom < Math.round((g.entries.length / target) * qCustom)) {
      g.nextCustom(inTail);
      customBudget -= 1;
    }
    // 追加 custom_message：密度 = qCustomMessage / target
    while (cmBudget > 0 && g.counts.type.custom_message < Math.round((g.entries.length / target) * qCustomMessage)) {
      g.nextCustomMessage();
      cmBudget -= 1;
    }
  };

  while (g.entries.length < target) {
    const idx = g.entries.length;
    if (!compacted && idx >= compactionAt) {
      catchUp(false);
      g.compaction(compactionSummaryText());
      g.custom("compaction.agent-checkpoint", {
        activeTools: ["read", "edit", "write", "todo", "bash_output", "task"],
        thinkingLevel: "low",
        modelId: model,
        agentName: null,
        timestamp: g.clock,
        model: { provider: PROVIDER, modelId: model },
        schema: "senpi.compaction.agent-checkpoint.v1",
      });
      g.custom("compaction.todo-snapshot", {
        schema: "senpi.compaction.todo-snapshot.v1",
        todos: [{ name: "台架验证", tasks: [{ content: "种子生成", status: "completed" }, { content: "真回合断言", status: "pending" }] }],
      });
      g.custom("claude-sdk-oauth-binding", { schemaVersion: 1, invalidated: true, reason: "compaction" });
      g.modelChange();
      g.thinkingLevelChange("low");
      compacted = true;
      msgBudget = Math.min(msgBudget, TAIL_MESSAGE_CAP);
      continue;
    }
    const inTail = compacted;
    // 稀疏固定条目（到点即发）
    if (sparseIdx < sparse.length && idx >= sparse[sparseIdx].at) {
      const s = sparse[sparseIdx];
      if (s.kind === "model_change") g.modelChange();
      else if (s.kind === "thinking_level_change") g.thinkingLevelChange(s.left % 2 ? "low" : "high");
      else g.sessionInfo(`QA 长会话台架（改名于条目 ${idx}）`);
      s.left -= 1;
      s.at = Math.floor((target * (s.total - s.left + 1)) / (s.total + 1));
      if (s.left <= 0) sparseIdx += 1;
      continue;
    }
    if (msgBudget > 0) {
      if (inTail && tailMessages >= TAIL_MESSAGE_CAP) {
        // 尾段 message 配额用尽：只补簿记
        g.nextCustom(true);
        customBudget -= 1;
        continue;
      }
      const before = g.counts.type.message ?? 0;
      g.nextMessage(inTail);
      const delta = g.counts.type.message - before;
      // 收尾腿后是一个完整用户回合的终点：补记忆簇/custom_message 高光位
      msgBudget -= delta;
      if (inTail) tailMessages += delta;
      catchUp(inTail);
      continue;
    }
    // message 配额用尽：纯簿记填充
    g.nextCustom(inTail);
    customBudget -= 1;
    catchUp(inTail);
  }

  // 收尾叶子（镜像生产回合末尾簿记链，给真引擎回合一个真实的追加锚点）
  g.custom("engine-turn-start", { customType: "ttsr-injection" });
  g.custom("senpi.hooks.stop-state", { count: 0, sessionId, turnKey: `final:${randomBytesHex(4)}` });

  // ---- 写盘：<out>/sessions/<encoded>/<sessionId>.jsonl ----
  const sessionsDir = join(out, "sessions", encodeCwdToSessionDirName(project));
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  const body = g.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(sessionFile, body, "utf8");

  // ---- 自断言：条目数 / 类型分布 / 链完整性 / 白名单边界覆盖 ----
  const asserts = [];
  const assertEq = (name, actual, expected) =>
    asserts.push({ name, pass: actual === expected, actual, expected });
  // 循环按 message 步进推进（assistant+toolResult 单步 2 条），跨界过冲有界；收尾另有
  // 两簿记条目。总数断言取区间而非硬编码期望。
  assertEq("entry_count", g.entries.length >= target && g.entries.length <= target + 10, true);
  asserts[asserts.length - 1].actual = g.entries.length;
  assertEq("compaction_count", g.counts.type.compaction ?? 0, 1);
  assertEq("session_header", g.entries[0].type, "session");

  // 链完整性：id 全唯一；首内容条目 parentId=null，其后严格指向前一条 id；时间戳严格递增
  const seen = new Set();
  let chainOk = true;
  let timeOk = true;
  let prevTs = 0;
  let expectedParent = null;
  for (let i = 0; i < g.entries.length; i += 1) {
    const e = g.entries[i];
    if (i === 0) {
      if (e.type !== "session") chainOk = false;
      expectedParent = null;
      continue;
    }
    if (seen.has(e.id)) chainOk = false;
    seen.add(e.id);
    if (e.parentId !== expectedParent) chainOk = false;
    expectedParent = e.id;
    const ts = Date.parse(e.timestamp);
    if (!(ts > prevTs)) timeOk = false;
    prevTs = ts;
  }
  asserts.push({ name: "parent_chain_linear", pass: chainOk });
  asserts.push({ name: "timestamps_monotonic", pass: timeOk });
  asserts.push({ name: "ids_unique", pass: seen.size === g.entries.length - 1 });

  // 配比断言（生产样本锚定 ±3 个百分点）与白名单边界覆盖
  const pct = (n) => (n / g.entries.length) * 100;
  const messagePct = pct(g.counts.type.message ?? 0);
  const customPct = pct(g.counts.type.custom ?? 0);
  const cmPct = pct(g.counts.type.custom_message ?? 0);
  asserts.push({ name: "message_ratio_near_production_21pct", pass: Math.abs(messagePct - 21.1) <= 3, actual: Number(messagePct.toFixed(2)) });
  asserts.push({ name: "custom_ratio_near_production_74pct", pass: Math.abs(customPct - 73.7) <= 3, actual: Number(customPct.toFixed(2)) });
  asserts.push({ name: "custom_message_ratio_near_production_5pct", pass: Math.abs(cmPct - 5.0) <= 2, actual: Number(cmPct.toFixed(2)) });

  const ct = g.counts.customType;
  const cmt = g.counts.cmType;
  const boundary = {
    message_user: g.counts.role.user ?? 0,
    message_assistant: g.counts.role.assistant ?? 0,
    message_toolResult: g.counts.role.toolResult ?? 0,
    custom_bookkeeping_offwhitelist: (ct["pi-rules.scan"] ?? 0) + (ct["session-lifecycle"] ?? 0)
      + (ct["senpi.hooks.stop-state"] ?? 0) + (ct["turn-end-liveness"] ?? 0),
    custom_message_display_true: cmt["loop-guard:notice"] ?? 0,
    custom_message_display_false_offlist: (cmt["senpi-task.usage"] ?? 0) + (cmt["omo-senpi:wake"] ?? 0),
    task_completion_wake: cmt["omo-senpi:wake"] ?? 0,
    memory_entries: Object.entries(ct).concat(Object.entries(cmt))
      .filter(([t]) => Object.values(MEMORY_TYPES).includes(t) || t === "omo-memorian:recall")
      .reduce((s, [, n]) => s + n, 0),
    model_change: g.counts.type.model_change ?? 0,
    session_info: g.counts.type.session_info ?? 0,
  };
  const boundaryAsserts = [
    ["message_toolResult >= 800", boundary.message_toolResult >= 800],
    ["message_user >= 30", boundary.message_user >= 30],
    ["message_assistant >= 900", boundary.message_assistant >= 900],
    ["custom_bookkeeping_offwhitelist >= 3000", boundary.custom_bookkeeping_offwhitelist >= 3000],
    ["custom_message_display_true >= 10", boundary.custom_message_display_true >= 10],
    ["custom_message_display_false_offlist >= 100", boundary.custom_message_display_false_offlist >= 100],
    ["task_completion_wake >= 20", boundary.task_completion_wake >= 20],
    ["memory_entries >= 100", boundary.memory_entries >= 100],
    ["post_compaction_messages_capped", tailMessages <= TAIL_MESSAGE_CAP],
  ];
  for (const [name, pass] of boundaryAsserts) asserts.push({ name, pass });

  const failed = asserts.filter((a) => !a.pass);
  const stats = {
    seed,
    model,
    sessionFile,
    sessionId,
    projectDir: project,
    agentRoot: out,
    entries: g.entries.length,
    fileBytes: Buffer.byteLength(body, "utf8"),
    typeCounts: g.counts.type,
    roleCounts: g.counts.role,
    customTypeCounts: ct,
    customMessageTypeCounts: cmt,
    boundary,
    compactionIndex: compactionAt,
    tailMessages,
    asserts,
    failedCount: failed.length,
    ok: failed.length === 0,
  };
  return stats;
}

// ---- CLI 入口 ----
function parseArgs(argv) {
  const args = { entries: 17000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--entries") args.entries = Number(argv[++i]);
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--session-id") args.sessionId = argv[++i];
    else if (a === "--seed") args.seed = Number(argv[++i]);
    else if (a === "--quiet") args.quiet = true;
    else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const stats = await runSeed(args);
    if (!args.quiet) {
      const { asserts, ...rest } = stats;
      console.error(`种子生成完成：${stats.entries} 条目 -> ${stats.sessionFile}`);
      console.error(`断言 ${stats.asserts.length - stats.failedCount}/${stats.asserts.length} 通过`);
      for (const a of asserts.filter((x) => !x.pass)) {
        console.error(`  FAIL ${a.name}${a.actual !== undefined ? ` (actual=${JSON.stringify(a.actual)}, expected=${JSON.stringify(a.expected)})` : ""}`);
      }
      console.log(JSON.stringify({ seed_stats: rest }));
    }
    process.exit(stats.ok ? 0 : 1);
  } catch (err) {
    console.error(`种子生成失败：${err && err.stack ? err.stack : err}`);
    process.exit(1);
  }
}
