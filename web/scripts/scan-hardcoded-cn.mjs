#!/usr/bin/env node
// 硬编码中文扫描器（i18n 任务3；GAP-2 的唯一权威对照数）。零依赖纯 node 单文件脚本，
// 禁止 lint 插件化。规则定死入库如下：
//
//   范围    web/src 下全部 .ts/.tsx 非测试文件（排除 *.test.* / *.spec.* 文件名与
//           __tests__ 目录；fixtures 目录随 __tests__ 一并排除）。
//   匹配    剥离注释后残留的中文字符（Han 区 U+4E00-U+9FFF）——字符串字面量与 JSX 文本
//           一律计数。注释剥离规则：// 行注释、/* */ 块注释（JSX 内 {/* */} 尾随注释
//           即块注释形态）。字符串含转义；模板串含 ${} 插值（栈式回代码态，终止 } 不
//           侵占花括号深度）；正则字面量按表达式位置启发式识别（含 [] 类与转义），正文
//           整体跳过，避免正文内引号诱发状态失步。
//   排除    web/src/i18n/ 目录（键定义处）；scan-cn-whitelist.json 白名单清单
//           （整文件级，每项必须带 reason；禁止为清零而扩大）。
//   基线    --baseline 写 web/scripts/.scan-cn-baseline.json；默认运行与基线对照：
//           新增硬编码中文退出码 1，持平或减少退出码 0（减少时提示可刷新基线）。
//
// 已知边界：正则起始判定为启发式（操作数位置的 / 按除号处理）；极端书写（如语句起始
// 的 /正则/ 跟在 } 之后）可能误判为除号，此时正文按普通代码计数，只影响个别行的口径，
// 不影响基线对照的确定性。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(SCRIPT_DIR, "..");
const SRC_ROOT = path.join(WEB_ROOT, "src");
const BASELINE_FILE = path.join(SCRIPT_DIR, ".scan-cn-baseline.json");
const WHITELIST_FILE = path.join(SCRIPT_DIR, "scan-cn-whitelist.json");
const CJK = /[\u4e00-\u9fff]/;
const WORD_CHAR = /[A-Za-z0-9_$]/;
const FLAG_CHAR = /[a-z]/;

/** 这些关键字之后，词字符收尾的 / 仍可能是正则起始（return /re/ 等） */
const KEYWORD_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete",
  "void", "case", "do", "else", "yield", "await", "throw",
]);

/** 正则起始判定（表达式位置启发式）：前导为空/符号/箭头 =>/关键字时允许正则；
 *  标识符、数字、字符串与 ) ] 收尾后的 / 按除号处理 */
function regexAllowedAt(sig1, sig2, word) {
  if (sig1 === null) return true;
  if (sig1 === "=" && sig2 === ">") return true;
  if ("([{,;:=?*&|^!+-~%".includes(sig1)) return true;
  if (!WORD_CHAR.test(sig1)) return false;
  return KEYWORD_BEFORE_REGEX.has(word);
}

/** 白名单：整文件级排除，路径相对 web/src，逐项带 reason */
function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_FILE)) return new Set();
  const entries = JSON.parse(fs.readFileSync(WHITELIST_FILE, "utf8"));
  const set = new Set();
  for (const e of entries) {
    const full = path.join(SRC_ROOT, e.path);
    if (!fs.existsSync(full)) {
      console.warn(`[scan-cn] 警告：白名单路径不存在 ${e.path}（${e.reason}）`);
      continue;
    }
    set.add(full);
  }
  return set;
}

/** 递归收集扫描目标：src 下 .ts/.tsx 非测试文件 */
function collectFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue; // 测试与 fixtures 不在范围
      if (dir === SRC_ROOT && name === "i18n") continue; // i18n 目录为键定义处，整体排除（与头注释规则一致）
      collectFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(name)) continue; // 非测试文件范围
    out.push(full);
  }
  return out;
}

/**
 * 注释剥离状态机：注释字符替换为空格、换行原样保留（行号对齐），字符串/模板串/正则
 * 字面量内容原样保留。modes 栈：code / squote / dquote / template；template 遇 ${ 压入
 * code 态并记录进入时花括号深度基线，遇到深度回到基线的 } 即插值终止（弹出且不减深度）。
 */
function stripComments(text) {
  const res = [];
  const modes = ["code"];
  const tBrace = []; // 进入模板插值时该层 code 的花括号深度基线
  let depth = 0;
  let sig1 = null; // 最近一个非空白代码字符
  let sig2 = null; // 倒数第二个非空白代码字符
  let word = ""; // 标识符累积（sig1 收尾于词字符时有效）
  const bumpSig = (ch) => {
    if (ch === " " || ch === "\t") return;
    if (WORD_CHAR.test(ch)) {
      word += ch;
    } else {
      word = "";
    }
    sig2 = sig1;
    sig1 = ch;
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      res.push("\n");
      i++;
      continue;
    }
    const mode = modes[modes.length - 1];
    if (mode === "code") {
      if (c === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") i++; // 行注释吞到行尾（换行由主循环保留）
        res.push(" ");
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
          if (text[i] === "\n") res.push("\n");
          i++;
        }
        i++; // 跳过结尾 '/'
        res.push(" ");
        continue;
      }
      if (c === "/" && text[i + 1] !== "/" && text[i + 1] !== "*" && regexAllowedAt(sig1, sig2, word)) {
        // 正则字面量：行内扫描闭合 /（含 [] 字符类与 \ 转义）；行尾前未闭合按除号回退
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n) {
          const rc = text[j];
          if (rc === "\n") break;
          if (rc === "\\") {
            j += 2;
            continue;
          }
          if (inClass) {
            if (rc === "]") inClass = false;
            j++;
            continue;
          }
          if (rc === "[") {
            inClass = true;
            j++;
            continue;
          }
          if (rc === "/") {
            closed = true;
            j++;
            break;
          }
          j++;
        }
        if (closed) {
          while (j < n && FLAG_CHAR.test(text[j])) j++; // flags
          for (let k = i; k < j; k++) res.push(" ");
          bumpSig("/");
          i = j;
          continue;
        }
      }
      if (c === "'") {
        modes.push("squote");
        res.push(" ");
        bumpSig(c);
        i++;
        continue;
      }
      if (c === '"') {
        modes.push("dquote");
        res.push(" ");
        bumpSig(c);
        i++;
        continue;
      }
      if (c === "`") {
        modes.push("template");
        res.push(" ");
        bumpSig(c);
        i++;
        continue;
      }
      if (c === "{") depth++;
      if (c === "}" && tBrace.length > 0 && depth === tBrace[tBrace.length - 1]) {
        // 模板插值终止：该 } 属于模板而非代码，弹出回 template 态且不侵占深度
        tBrace.pop();
        modes.pop();
        res.push(" ");
        i++;
        continue;
      }
      if (c === "}") depth--;
      res.push(c);
      bumpSig(c);
      i++;
      continue;
    }
    if (mode === "squote" || mode === "dquote") {
      if (c === "\\") {
        res.push(" ", text[i + 1] === "\n" ? "\n" : " ");
        i += 2;
        continue;
      }
      if ((mode === "squote" && c === "'") || (mode === "dquote" && c === '"')) {
        modes.pop();
        res.push(" ");
        i++;
        continue;
      }
      res.push(c);
      i++;
      continue;
    }
    // template 态
    if (c === "\\") {
      res.push(" ", text[i + 1] === "\n" ? "\n" : " ");
      i += 2;
      continue;
    }
    if (c === "`") {
      modes.pop();
      res.push(" ");
      i++;
      continue;
    }
    if (c === "$" && text[i + 1] === "{") {
      modes.push("code");
      tBrace.push(depth);
      res.push("  ");
      i += 2;
      continue;
    }
    res.push(c);
    i++;
  }
  return res.join("");
}

/** 扫描全部目标文件，返回 [{file, line, text}]（file 为相对 web 的 posix 路径） */
function scan() {
  const whitelist = loadWhitelist();
  const files = collectFiles(SRC_ROOT).filter((f) => !whitelist.has(f));
  const hits = [];
  for (const full of files) {
    const rel = path.relative(WEB_ROOT, full).split(path.sep).join("/");
    const stripped = stripComments(fs.readFileSync(full, "utf8"));
    const lines = stripped.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!CJK.test(lines[i])) continue;
      const text = lines[i].trim().slice(0, 120);
      hits.push({ file: rel, line: i + 1, text });
    }
  }
  hits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return hits;
}

function printHits(hits) {
  for (const h of hits) console.log(`${h.file}:${h.line}: ${h.text}`);
  const fileCount = new Set(hits.map((h) => h.file)).size;
  console.log(`\n共 ${hits.length} 处硬编码中文（${fileCount} 个文件）`);
}

function main() {
  const args = process.argv.slice(2);
  const hits = scan();
  if (args.includes("--baseline")) {
    const payload = {
      generatedAt: new Date().toISOString(),
      total: hits.length,
      entries: hits,
    };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(payload, null, 2) + "\n");
    console.log(`基线已写入 ${path.relative(WEB_ROOT, BASELINE_FILE)}`);
    printHits(hits);
    return;
  }
  if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`未找到基线文件 ${path.relative(WEB_ROOT, BASELINE_FILE)}，请先运行 --baseline 生成对照数。`);
    printHits(hits);
    process.exit(2);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  printHits(hits);
  if (hits.length > baseline.total) {
    const baseKeys = new Set(baseline.entries.map((e) => `${e.file}:${e.line}`));
    const added = hits.filter((h) => !baseKeys.has(`${h.file}:${h.line}`));
    console.error(`\n[scan-cn] 新增 ${added.length} 处硬编码中文，超出基线（${baseline.total}）：新增清单如上标注。`);
    console.error("[scan-cn] 新增条目须接入 i18n 目录或更新白名单 reason，不得直接刷新基线掩盖。");
    process.exit(1);
  }
  const reduced = baseline.total - hits.length;
  console.log(`\n[scan-cn] 与基线对照通过：当前 ${hits.length} 处 <= 基线 ${baseline.total} 处。`);
  if (reduced > 0) {
    console.log(`[scan-cn] 较基线减少 ${reduced} 处；接线推进后可用 --baseline 刷新权威对照数。`);
  }
}

main();
