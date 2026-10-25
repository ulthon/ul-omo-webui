// JSONL 完整性校验器：逐行 JSON.parse，报告坏行号与统计
// 用法：node validate-jsonl.js <file>
const fs = require("fs");
const file = process.argv[2];
if (!file) { console.log(JSON.stringify({ error: "usage: node validate-jsonl.js <file>" })); process.exit(1); }
let raw;
try { raw = fs.readFileSync(file, "utf8"); } catch (e) { console.log(JSON.stringify({ error: "read_failed", message: e.message })); process.exit(1); }
const lines = raw.split("\n");
let bad = 0, empty = 0, ok = 0;
lines.forEach((l, i) => {
  if (l.trim() === "") { if (i !== lines.length - 1) empty++; return; }
  try { JSON.parse(l); ok++; } catch (e) { bad++; console.log("BAD_LINE " + (i + 1) + " " + e.message + " :: " + l.slice(0, 160)); }
});
console.log(JSON.stringify({ file, totalSplitParts: lines.length, jsonLines: ok, emptyMiddle: empty, badLines: bad, verdict: bad === 0 ? "ALL_LINES_VALID_JSON" : "CORRUPT" }));
