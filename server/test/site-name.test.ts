// 站点名（engine-upgrade 2026-10-30 批次 todo3）纯函数级单测：
// ① config.siteName() 两态（未设置/空串 → null；设置 → 原值逐字）；
// ② injectSiteName() 注入硬化（title 替换 + <head> 载荷 + 畸形值转义 + 未设置恒等
//    + 畸形 HTML 兜底）。对齐 static-fallback.test.ts 先例：纯函数可测，双路装配
//    由构建产物真机 curl 探针验证（证据 .omo/evidence/engine-upgrade-2026-10-30/）。
import { afterEach, describe, expect, test } from "vitest";
import { siteName } from "../src/config";
import { injectSiteName } from "../src/embedded-static";

const ENV = "UL_OMO_WEBUI_SITE_NAME";

afterEach(() => {
  delete process.env[ENV];
});

describe("config.siteName（env 单源）", () => {
  test("未设置 → null", () => {
    delete process.env[ENV];
    expect(siteName()).toBeNull();
  });

  test("空串 → null（按未设置处理）", () => {
    process.env[ENV] = "";
    expect(siteName()).toBeNull();
  });

  test("设置 → 原值逐字返回", () => {
    process.env[ENV] = "测试站";
    expect(siteName()).toBe("测试站");
  });
});

// web/index.html 的结构样本（字段面一致：head + title）
const BASE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>ul-omo webui</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

describe("injectSiteName（内嵌/磁盘双路共用注入函数）", () => {
  test("siteName=null 原样返回同一引用（未设置逐字节一致的实现锚点）", () => {
    const html = BASE_HTML;
    expect(injectSiteName(html, null)).toBe(html);
  });

  test("设置后：title 替换 + <head> 起始注入 window.__SITE_NAME__ 载荷", () => {
    const out = injectSiteName(BASE_HTML, "测试站");
    expect(out).toContain("<title>测试站</title>");
    expect(out).not.toContain("ul-omo webui</title>");
    expect(out).toContain('<script>window.__SITE_NAME__="测试站"</script>');
    expect(out.indexOf("window.__SITE_NAME__")).toBeGreaterThan(out.indexOf("<head>"));
  });

  test("畸形值（引号/&/<>）硬编码：title 实体转义，载荷防破壳且 JSON.parse 还原原值", () => {
    const malicious = '测试"站&<名>';
    const out = injectSiteName(BASE_HTML, malicious);
    expect(out).toContain("<title>测试&quot;站&amp;&lt;名&gt;</title>");
    const m = out.match(/<script>window\.__SITE_NAME__=([^<]*)<\/script>/);
    expect(m).toBeTruthy();
    // 载荷内不得出现原始 < 字面量（</script> 破壳面），且 JSON 解析后等于原值
    expect(m![1]).not.toContain("<");
    expect(m![1]).not.toContain(">");
    expect(m![1]).not.toContain("&");
    expect(JSON.parse(m![1])).toBe(malicious);
  });

  test("无 <title> 的畸形产物：head 内补 title + 载荷", () => {
    const noTitle = '<!doctype html><html><head><meta charset="UTF-8"></head><body></body></html>';
    const out = injectSiteName(noTitle, "甲站");
    expect(out).toContain("<title>甲站</title>");
    expect(out).toContain('<script>window.__SITE_NAME__="甲站"</script>');
  });

  test("无 <head> 的畸形产物：载荷前置不抛错，原尾部保留", () => {
    const noHead = "<html><body>x</body></html>";
    const out = injectSiteName(noHead, "乙站");
    expect(out).toContain("<title>乙站</title>");
    expect(out).toContain("window.__SITE_NAME__");
    expect(out.endsWith("<html><body>x</body></html>")).toBe(true);
  });
});
