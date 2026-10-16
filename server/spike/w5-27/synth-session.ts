// W5 todo 27：超长会话合成脚本（性能基准用）。
// 方法：只读扫描真实会话库 ~/.pi/agent/sessions（原库零写入），按 type=message 条目数
// 挑最大会话作素材；把其条目按原顺序复制 N 遍（id/parentId/timestamp 重生成，线性链），
// 并穿插"大 markdown 消息"（正文取自本仓库真实文档与源码，重组为 markdown/代码块），
// 写入隔离 agent 目录（UL_OMO_WEBUI_AGENT_DIR 指向的副本）的测试项目 sessions 目录。
// 真实性标注：结构与小文本条目 = 真实会话原样复制（仅换 id/时间）；大 markdown 正文 =
// 本仓库真实文件内容重组，非模型生成。全部合成痕迹见 .omo/qa/W5/perf/ 报告。
//
// 用法：bun server/spike/w5-27/synth-session.ts [--agent-dir <dir>] [--project <dir>] [--repeat 5] [--big 20]
import { mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

interface Args {
  agentDir: string;
  project: string;
  repeat: number;
  big: number;
  limit: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    agentDir: get("--agent-dir", "/tmp/opencode/w5-27-agent"),
    project: get("--project", "/tmp/opencode/w5-27-proj"),
    repeat: Number(get("--repeat", "5")),
    big: Number(get("--big", "20")),
    limit: Number(get("--limit", "0")),
  };
}

function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
}

function randomId8(): string {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 8; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

function randomUuid(): string {
  const h = "0123456789abcdef";
  const seg = (n: number) => Array.from({ length: n }, () => h[Math.floor(Math.random() * 16)]).join("");
  return `${seg(8)}-${seg(4)}-4${seg(3)}-a${seg(3)}-${seg(12)}`;
}

/** 只读扫描会话库，返回按 message 条目数排序的会话文件列表 */
function scanSessions(sessionsRoot: string): { file: string; messages: number }[] {
  const out: { file: string; messages: number }[] = [];
  for (const dir of readdirSync(sessionsRoot)) {
    const dirPath = join(sessionsRoot, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = join(dirPath, f);
      let messages = 0;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) if (line.includes('"type":"message"')) messages++;
      out.push({ file, messages });
    }
  }
  return out.sort((a, b) => b.messages - a.messages);
}

/** 大 markdown 素材源：本仓库真实文档与源码（只读引用） */
const BIG_SOURCES = [
  "README.md",
  "docs/01-功能清单.md",
  "docs/02-技术选型.md",
  "docs/03-架构设计.md",
  "docs/04-引擎与生态调研.md",
  "docs/05-数据层实证.md",
  "docs/06-技术验证清单.md",
  "docs/07-待定问题.md",
  "web/src/components/chat/message-list.tsx",
  "web/src/components/chat/markdown.tsx",
  "web/src/components/chat/tool-card.tsx",
  "web/src/lib/events.ts",
  "web/src/stores/messages.ts",
  "server/src/api/engine-runtime.ts",
  "server/src/api/sse.ts",
  "server/src/process/process-manager.ts",
];

/** 收集仓库真实文档/源码文本，拼成大 markdown 正文（真实内容重组） */
function buildBigTexts(repoRoot: string, count: number): string[] {
  const sources = BIG_SOURCES;
  const texts: string[] = [];
  let i = 0;
  while (texts.length < count) {
    const rel = sources[i % sources.length];
    i++;
    let body: string;
    try {
      body = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const isCode = rel.endsWith(".ts") || rel.endsWith(".tsx");
    const fence = isCode ? "ts" : "markdown";
    const header = `## 附录素材 ${texts.length + 1}：${rel}\n\n以下是本仓库文件 \`${rel}\` 的完整内容（性能基准用长文本素材，真实文件内容原样引用）：\n\n`;
    const codeBlock = isCode
      ? "```" + fence + "\n" + body + "\n```\n\n"
      : body + "\n\n---\n\n";
    // 代码块再补一段：把该文件的行数统计也写进去，增加 markdown 结构多样性
    const lines = body.split("\n").length;
    const tail = `该文件共 ${lines} 行、${body.length} 字符。\n\n> 引用块：长会话渲染基准需要接近真实 agent 输出的长 markdown（标题/列表/表格/代码块混合）。本条目为文件内容重组，非模型生成。\n`;
    texts.push(header + codeBlock + tail);
  }
  return texts;
}

function main() {
  const { agentDir, project, repeat, big, limit } = parseArgs();
  const repoRoot = "/data/projects/ul-omo-webui";
  const sessionsRoot = join(agentDir, "sessions");

  console.log(`[synth] 扫描隔离库 ${sessionsRoot} ...`);
  const ranked = scanSessions(sessionsRoot);
  if (ranked.length === 0) throw new Error("隔离库无会话文件");
  const top = ranked[0];
  console.log(`[synth] 素材会话（消息数最多）：${top.file}（${top.messages} 条 message）`);

  const raw = readFileSync(top.file, "utf8").split("\n").filter((l) => l.trim() !== "");
  const header = JSON.parse(raw[0]);
  if (header.type !== "session") throw new Error("首行不是 session header");
  const templateEntries = raw.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);
  const capped = limit > 0 ? templateEntries.slice(0, limit) : templateEntries;
  const templateMessages = capped.filter((e) => e.type === "message");
  console.log(`[synth] 模板块目：${capped.length}（message ${templateMessages.length}）`);

  // 大 markdown 消息：assistant 长文 + 前置 user 提问，成对插入
  const bigTexts = buildBigTexts(repoRoot, big);
  const bigPairs: Record<string, unknown>[] = bigTexts.map((text, i) => {
    const shortName = BIG_SOURCES[i % BIG_SOURCES.length];
    return [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `请完整讲解/引用 ${shortName} 的内容，附代码块。` }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          api: "openai-completions",
          provider: "zai-coding-cn",
          model: "glm-5.3-flash",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
        },
      },
    ];
  }).flat() as unknown as Record<string, unknown>[];

  // 条目排布：每重复一轮真实条目后插 2 对大消息（均匀分布）
  const perRound = Math.max(1, Math.floor(bigPairs.length / repeat));
  const plan: Record<string, unknown>[] = [];
  for (let r = 0; r < repeat; r++) {
    plan.push(...capped);
    plan.push(...bigPairs.slice(r * perRound, r === repeat - 1 ? bigPairs.length : (r + 1) * perRound));
  }
  const msgCount = plan.filter((e) => e.type === "message").length;
  console.log(`[synth] 合成条目：${plan.length}（message ${msgCount}），其中大 markdown 对 ${bigPairs.length / 2}`);

  // id/parentId/timestamp 重生成（线性链）
  const sessionId = randomUuid();
  const now = Date.now() - plan.length * 900;
  let prevId: string | null = null;
  const lines: string[] = [];
  const encodedProject = encodeCwd(project);
  const outHeader = { type: "session", version: 3, id: sessionId, timestamp: new Date(now).toISOString(), cwd: project };
  lines.push(JSON.stringify(outHeader));
  let ts = now;
  for (const entry of plan) {
    ts += 900;
    const id = randomId8();
    const out: Record<string, unknown> = { ...entry, id, parentId: prevId, timestamp: new Date(ts).toISOString() };
    if (out.message && typeof out.message === "object") {
      const m = out.message as Record<string, unknown>;
      m.timestamp = ts;
    }
    prevId = id;
    lines.push(JSON.stringify(out));
  }

  mkdirSync(join(sessionsRoot, encodedProject), { recursive: true });
  const fileName = `${new Date(now).toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
  const outPath = join(sessionsRoot, encodedProject, fileName);
  writeFileSync(outPath, lines.join("\n") + "\n");
  const sizeKB = Math.round(statSync(outPath).size / 1024);
  console.log(`[synth] 写入 ${outPath}`);
  console.log(`[synth] header.id=${sessionId} cwd=${project} 文件 ${sizeKB}KB message=${msgCount} 条`);
  console.log(`[synth] session id（测试用）: ${sessionId}`);
}

main();
