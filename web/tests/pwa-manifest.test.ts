import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import path from "node:path";

// PWA 打包层校验：manifest 合法性与图标资产落位（源文件态，dist 落位由构建流程保证）
const publicDir = path.resolve(__dirname, "../public");

describe("PWA manifest 与图标", () => {
  const manifestPath = path.join(publicDir, "manifest.webmanifest");

  it("manifest 是合法 JSON", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.display).toBe("standalone");
    expect(typeof manifest.theme_color).toBe("string");
    expect(typeof manifest.background_color).toBe("string");
  });

  it("index.html viewport 含 viewport-fit=cover 与 interactive-widget=resizes-content", () => {
    const html = readFileSync(path.resolve(__dirname, "../index.html"), "utf-8");
    expect(html).toContain("viewport-fit=cover");
    expect(html).toContain("interactive-widget=resizes-content");
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('rel="manifest"');
  });

  it("manifest 引用的每个图标文件都存在且 purpose 合法", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.icons.length).toBeGreaterThanOrEqual(4);
    for (const icon of manifest.icons) {
      const file = path.join(publicDir, icon.src.replace(/^\//, ""));
      expect(existsSync(file), `${icon.src} 应存在`).toBe(true);
      expect(["any", "maskable"]).toContain(icon.purpose);
    }
    const appleIcon = path.join(publicDir, "apple-touch-icon.png");
    expect(existsSync(appleIcon)).toBe(true);
  });
});
