// i18n 完整性五断言（任务3）：目录完整性用结构断言锁死，渲染只做冒烟不锁语言内容
// （Wave 2 接线前组件仍为硬编码中文，语言内容锁定由接线后的任务强化）。
// 全部断言为静态结构或确定性 SSR 渲染，无时间、随机或网络因素，按构造无抖动。
import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { zh } from "@/i18n/zh";
import { en } from "@/i18n/en";
import { useLocaleStore } from "@/i18n/i18n";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Catalog = Record<string, unknown>;

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Wave 2 接线后的死键豁免清单：仅剩仍无调用点的 common.loadFailed / common.loading。
// 接线一个移除一个；清单清空后保留空数组，本断言继续守抚未来新出现的死键。
const EXPECTED_UNWIRED: string[] = [
  "common.loadFailed",
  "common.loading",
];

/** 复数形叶子判定：{ one, other } 双字符串形态视为叶子，不再下钻 */
function isPluralLeaf(v: unknown): v is { one: string; other: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "one" in v &&
    "other" in v &&
    typeof (v as { one: unknown }).one === "string" &&
    typeof (v as { other: unknown }).other === "string"
  );
}

/** 收集全部叶子键的点分路径（复数形对象是叶子；函数词条是叶子） */
function leafPaths(node: Catalog, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null && !isPluralLeaf(v)) {
      out.push(...leafPaths(v as Catalog, p));
    } else {
      out.push(p);
    }
  }
  return out;
}

/** 按点分路径取目录叶子值 */
function leafAt(root: Catalog, keyPath: string): unknown {
  let node: unknown = root;
  for (const part of keyPath.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Catalog)[part];
  }
  return node;
}

/** 提取插值参数名集合（复数形合并 one/other 两形；函数词条无法静态提取，返回空集并跳过比较） */
function placeholderNames(v: unknown): Set<string> | null {
  if (typeof v === "function") return null;
  const out = new Set<string>();
  const collect = (s: string) => {
    for (const m of s.matchAll(/\{(\w+)\}/g)) out.add(m[1]);
  };
  if (typeof v === "string") collect(v);
  else if (isPluralLeaf(v)) {
    collect(v.one);
    collect(v.other);
  }
  return out;
}

/** 递归收集 src 与 tests 下全部 .ts/.tsx 文件 */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

/** 死键检测：键的字面量（带引号的点分路径）在 src 与 tests 全部源文件中零引用。
 *  排除目录定义处（zh.ts/en.ts）与本测试文件自身（EXPECTED_UNWIRED 字面量不得自证其用）。 */
function findDeadCatalogKeys(): string[] {
  const skip = new Set([
    path.join(WEB_ROOT, "src", "i18n", "zh.ts"),
    path.join(WEB_ROOT, "src", "i18n", "en.ts"),
    path.join(WEB_ROOT, "tests", "i18n.test.ts"),
  ]);
  const files = [
    ...collectSourceFiles(path.join(WEB_ROOT, "src")),
    ...collectSourceFiles(path.join(WEB_ROOT, "tests")),
  ].filter((f) => !skip.has(f));
  const contents = files.map((f) => fs.readFileSync(f, "utf8"));
  return leafPaths(zh as Catalog).filter(
    (k) => !contents.some((c) => c.includes(`"${k}"`) || c.includes(`'${k}'`)),
  );
}

describe("i18n 目录完整性（任务3 五断言）", () => {
  test("(a) en 键集与 zh 键集完全一致（兑运行时 satisfies/as 的静态复核）", () => {
    expect(leafPaths(en as Catalog).sort()).toEqual(leafPaths(zh as Catalog).sort());
  });

  test("(b) 计数类键（复数形）在 en 目录下 one/other 形完备", () => {
    const issues: string[] = [];
    const check = (from: Catalog, fromName: string, to: Catalog, toName: string) => {
      for (const p of leafPaths(from)) {
        const v = leafAt(from, p);
        if (!isPluralLeaf(v)) continue;
        if (!v.one || !v.other) issues.push(`${p}: ${fromName} one/other 存在空值`);
        const w = leafAt(to, p);
        if (!isPluralLeaf(w)) {
          issues.push(`${p}: ${fromName} 为复数形而 ${toName} 缺失或非复数形`);
          continue;
        }
        if (!w.one || !w.other) issues.push(`${p}: ${toName} one/other 存在空值`);
      }
    };
    check(zh as Catalog, "zh", en as Catalog, "en");
    check(en as Catalog, "en", zh as Catalog, "zh");
    expect(issues).toEqual([]);
  });

  test("(c) en 每个值的插值参数名集合与 zh 对应值一致（防 en 含未插值 {var}）", () => {
    const issues: string[] = [];
    for (const p of leafPaths(zh as Catalog)) {
      const a = placeholderNames(leafAt(zh as Catalog, p));
      const b = placeholderNames(leafAt(en as Catalog, p));
      if (a === null || b === null) continue; // 函数词条无法静态提取，跳过
      const missing = [...a].filter((x) => !b.has(x));
      const extra = [...b].filter((x) => !a.has(x));
      if (missing.length > 0 || extra.length > 0) {
        issues.push(`${p}: zh{${[...a].join(",")}} vs en{${[...b].join(",")}}`);
      }
    }
    expect(issues).toEqual([]);
  });

  test("(d) en locale 下代表性组件 SSR 渲染冒烟（不抛错且产出非空标记）", async () => {
    // Wave 2 接线前组件仍渲染硬编码中文：本断言只锁"en 档渲染通路不抛错、非空"，
    // 不锁渲染语言内容；接线后由后续任务强化为内容断言。
    useLocaleStore.setState({ locale: "en" });
    const { ToolCard } = await import("@/components/chat/tool-card");
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        sessionId: "s-smoke",
        toolCallId: "tc-smoke-1",
        name: "bash",
        args: { command: "ls -la" },
        live: false,
      }),
    );
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('data-tool-call="tc-smoke-1"');
  });

  test("(e) catalog 死键检测：既定未接线清单之外无零引用键", () => {
    const dead = findDeadCatalogKeys();
    const unexpected = dead.filter((k) => !EXPECTED_UNWIRED.includes(k));
    expect(unexpected).toEqual([]);
  });
});
