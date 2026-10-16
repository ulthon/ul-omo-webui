// 存量项目偏好迁移与合并读取单测（W1 todo 6）：
// - config-store readProjectRaw：原文键存在性（区分「文件无该字段」与「文件显式 null」）
// - effectivePreference 过渡态判定：文件缺字段且库值未迁清 → 库值（迁移未完成语义）
// - readProjectPreferences 合并读取 + 损坏降级（configError）
// - migrateProjectPreferences：两步中断安全（写文件成功后才清库）、幂等、失败保留库值、
//   逐项目隔离（单项目失败不影响其余项目、整体 promise 不 reject）
// - permissionPresetSpawnArgs：文件来源 + 损坏降级
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConfigStore, type ConfigStore } from "../src/conf/config-store";
import { openMetaDb } from "../src/db/meta";
import {
  createProjectConfigStores,
  effectivePreference,
  migrateProjectPreferences,
  permissionPresetSpawnArgs,
  readProjectPreferences,
} from "../src/api/config-migration";
import { permissionPresetArgs, permissionPresetKey } from "../src/api/engine-runtime";

// 每用例独立临时目录（learnings：bun test 同文件各 test 必须隔离文件系统状态）
function makeCase(): { root: string; globalDir: string; project: string; metaPath: string } {
  const root = mkdtempSync(join(tmpdir(), "cfg-mig-"));
  return {
    root,
    globalDir: join(root, "global"),
    project: join(root, "proj"),
    metaPath: join(root, "meta.db"),
  };
}

interface Case {
  root: string;
  globalDir: string;
  project: string;
  metaPath: string;
  configs: ConfigStore;
  stores: (projectRoot: string) => ConfigStore;
  meta: ReturnType<typeof openMetaDb>;
}

function setup(withProjectDir = true): Case {
  const c = makeCase();
  if (withProjectDir) mkdirSync(c.project, { recursive: true });
  const configs = openConfigStore({ globalDir: c.globalDir, projectRoot: c.project });
  return {
    ...c,
    configs,
    stores: createProjectConfigStores(configs),
    meta: openMetaDb({ path: c.metaPath }),
  };
}

const cleanup = (c: Case): void => rmSync(c.root, { recursive: true, force: true });

function registerLegacy(c: Case, projectPath: string, model: string | null, preset: string | null): void {
  c.meta.updateProjectMeta(projectPath, {
    ...(model !== null ? { preferredModel: model } : {}),
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  });
  if (preset !== null) c.meta.setKv(permissionPresetKey(projectPath), preset);
}

// ---------------------------------------------------------------- readProjectRaw

describe("config-store readProjectRaw（原文键存在性，加法只读）", () => {
  test("文件不存在 → null；无字段文件 → 空对象", () => {
    const c = setup();
    try {
      expect(c.stores(c.project).readProjectRaw()).toBeNull();
      writeFileSync(join(c.project, ".ul-omo-webui.json"), "{}\n");
      expect(c.stores(c.project).readProjectRaw()).toEqual({});
    } finally {
      cleanup(c);
    }
  });

  test("显式 null 与字段缺失可区分（过渡态判定的前提）", () => {
    const c = setup();
    try {
      writeFileSync(
        join(c.project, ".ul-omo-webui.json"),
        JSON.stringify({ version: 1, preferredModel: null }),
      );
      const raw = c.stores(c.project).readProjectRaw();
      expect(raw).not.toBeNull();
      expect(Object.prototype.hasOwnProperty.call(raw, "preferredModel")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(raw, "permissionPreset")).toBe(false);
    } finally {
      cleanup(c);
    }
  });

  test("损坏 JSON 抛错且 message 含文件路径；非对象同样抛错", () => {
    const c = setup();
    try {
      const file = join(c.project, ".ul-omo-webui.json");
      writeFileSync(file, "{broken");
      expect(() => c.stores(c.project).readProjectRaw()).toThrow(/\.ul-omo-webui\.json/);
      writeFileSync(file, "[1,2]");
      expect(() => c.stores(c.project).readProjectRaw()).toThrow(/JSON 对象/);
    } finally {
      cleanup(c);
    }
  });
});

// ---------------------------------------------------------------- effectivePreference

describe("effectivePreference 过渡态判定", () => {
  test("文件有字段（含显式 null）→ 文件为准", () => {
    expect(effectivePreference(true, "m-file", "m-db")).toBe("m-file");
    expect(effectivePreference(true, null, "m-db")).toBeNull();
  });

  test("文件缺字段且库值未迁清 → 库值（迁移未完成）", () => {
    expect(effectivePreference(false, null, "m-db")).toBe("m-db");
  });

  test("文件缺字段且库已清空 → 文件值（null）", () => {
    expect(effectivePreference(false, null, null)).toBeNull();
    expect(effectivePreference(true, "m-file", null)).toBe("m-file");
  });
});

// ---------------------------------------------------------------- readProjectPreferences

describe("readProjectPreferences 合并读取", () => {
  test("无文件 + 库有值（迁移前形态）→ 库值生效", () => {
    const c = setup();
    try {
      registerLegacy(c, c.project, "zai-coding-cn/glm-5.3", "read-only");
      const view = readProjectPreferences(c.stores, c.meta, c.project);
      expect(view).toEqual({
        preferredModel: "zai-coding-cn/glm-5.3",
        permissionPreset: "read-only",
        preferredThinkingLevel: null,
        configError: false,
      });
    } finally {
      cleanup(c);
    }
  });

  test("文件有 preferredModel、缺 permissionPreset + kv 有值 → 模型取文件、预设取 kv（混合过渡态）", () => {
    const c = setup();
    try {
      registerLegacy(c, c.project, "zai-coding-cn/glm-5.3", "read-only");
      writeFileSync(
        join(c.project, ".ul-omo-webui.json"),
        JSON.stringify({ version: 1, preferredModel: "zai-coding-cn/glm-5.3-flash" }),
      );
      const view = readProjectPreferences(c.stores, c.meta, c.project);
      expect(view.preferredModel).toBe("zai-coding-cn/glm-5.3-flash");
      expect(view.permissionPreset).toBe("read-only");
      expect(view.configError).toBe(false);
    } finally {
      cleanup(c);
    }
  });

  test("文件损坏 → 字段降级 null + configError 标志（决策 10b）", () => {
    const c = setup();
    try {
      registerLegacy(c, c.project, "zai-coding-cn/glm-5.3", "read-only");
      writeFileSync(join(c.project, ".ul-omo-webui.json"), "{broken");
      const view = readProjectPreferences(c.stores, c.meta, c.project);
      expect(view).toEqual({ preferredModel: null, permissionPreset: null, preferredThinkingLevel: null, configError: true });
    } finally {
      cleanup(c);
    }
  });

  test("preferredThinkingLevel 文件值直读；非法档位同损坏降级（W2 todo 7，无库源）", () => {
    const c = setup();
    try {
      const file = join(c.project, ".ul-omo-webui.json");
      writeFileSync(file, JSON.stringify({ version: 1, preferredThinkingLevel: "max" }));
      utimesSync(file, new Date(2000), new Date(2000));
      const ok = readProjectPreferences(c.stores, c.meta, c.project);
      expect(ok.preferredThinkingLevel).toBe("max");
      expect(ok.configError).toBe(false);

      // 非法档位在规范化层抛错 → 合并读按项目降级 null + configError
      // （同尺寸改写必须显式换 mtime，否则 mtime+size 缓存命中旧文档）
      writeFileSync(file, JSON.stringify({ version: 1, preferredThinkingLevel: "off" }));
      utimesSync(file, new Date(3000), new Date(3000));
      const degraded = readProjectPreferences(c.stores, c.meta, c.project);
      expect(degraded).toEqual({ preferredModel: null, permissionPreset: null, preferredThinkingLevel: null, configError: true });
    } finally {
      cleanup(c);
    }
  });

  test("stores 未注入（部分测试装配）→ 等价迁移前纯库读", () => {
    const c = setup();
    try {
      registerLegacy(c, c.project, "zai-coding-cn/glm-5.3", null);
      const view = readProjectPreferences(null, c.meta, c.project);
      expect(view.preferredModel).toBe("zai-coding-cn/glm-5.3");
      expect(view.permissionPreset).toBeNull();
      expect(view.configError).toBe(false);
    } finally {
      cleanup(c);
    }
  });
});

// ---------------------------------------------------------------- permissionPresetSpawnArgs

describe("permissionPresetArgs 纯函数与 spawn 参数适配", () => {
  test("值去空白、无值空数组", () => {
    expect(permissionPresetArgs("  read-only  ")).toEqual(["--permission-preset", "read-only"]);
    expect(permissionPresetArgs(null)).toEqual([]);
    expect(permissionPresetArgs(undefined)).toEqual([]);
  });

  test("文件有 preset → 参数含 --permission-preset；损坏 → 空数组（降级）", () => {
    const c = setup();
    try {
      writeFileSync(
        join(c.project, ".ul-omo-webui.json"),
        JSON.stringify({ version: 1, permissionPreset: "read-only" }),
      );
      expect(permissionPresetSpawnArgs(c.stores, c.meta, c.project)).toEqual([
        "--permission-preset",
        "read-only",
      ]);
      writeFileSync(join(c.project, ".ul-omo-webui.json"), "{broken");
      expect(permissionPresetSpawnArgs(c.stores, c.meta, c.project)).toEqual([]);
    } finally {
      cleanup(c);
    }
  });
});

// ---------------------------------------------------------------- migrateProjectPreferences

describe("migrateProjectPreferences 迁移", () => {
  test("legacy 库 → 文件生成两字段、库置 NULL、kv 删除", async () => {
    const c = setup();
    try {
      registerLegacy(c, c.project, "zai-coding-cn/glm-5.3", "read-only");
      const summary = await migrateProjectPreferences(c.stores, c.meta);
      expect(summary).toEqual({ migrated: 1, failed: 0 });

      const doc = JSON.parse(readFileSync(join(c.project, ".ul-omo-webui.json"), "utf8"));
      expect(doc.preferredModel).toBe("zai-coding-cn/glm-5.3");
      expect(doc.permissionPreset).toBe("read-only");

      expect(c.meta.getProjectMeta(c.project)?.preferredModel).toBeNull();
      expect(c.meta.getKv(permissionPresetKey(c.project))).toBeNull();

      // 迁移后合并读以文件为准
      const view = readProjectPreferences(c.stores, c.meta, c.project);
      expect(view.preferredModel).toBe("zai-coding-cn/glm-5.3");
      expect(view.permissionPreset).toBe("read-only");
    } finally {
      cleanup(c);
    }
  });

  test("幂等：第二次运行零变更（文件字节不变、库保持清空）", async () => {
    const c = setup();
    try {
      registerLegacy(c, c.project, "zai-coding-cn/glm-5.3", "read-only");
      await migrateProjectPreferences(c.stores, c.meta);
      const file = join(c.project, ".ul-omo-webui.json");
      const first = { bytes: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs };

      const second = await migrateProjectPreferences(c.stores, c.meta);
      expect(second.migrated).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(first.bytes);
      expect(statSync(file).mtimeMs).toBe(first.mtimeMs);
      expect(c.meta.getProjectMeta(c.project)?.preferredModel).toBeNull();
      expect(c.meta.getKv(permissionPresetKey(c.project))).toBeNull();
    } finally {
      cleanup(c);
    }
  });

  test("文件已有字段 = 文件为准：库值丢弃（清库）、文件不被改写", async () => {
    const c = setup();
    try {
      // 预设无 kv 存量：隔离出纯「文件为准、库值丢弃」路径（预设迁入见下一用例）
      registerLegacy(c, c.project, "zai-coding-cn/glm-5.3", null);
      const file = join(c.project, ".ul-omo-webui.json");
      writeFileSync(file, JSON.stringify({ version: 1, preferredModel: "user/file-model" }) + "\n");

      const summary = await migrateProjectPreferences(c.stores, c.meta);
      expect(summary.migrated).toBe(1);
      expect(readFileSync(file, "utf8")).toBe(JSON.stringify({ version: 1, preferredModel: "user/file-model" }) + "\n");
      expect(c.meta.getProjectMeta(c.project)?.preferredModel).toBeNull();
      // 库值被丢弃后以文件为准（不被旧库值回显）
      expect(readProjectPreferences(c.stores, c.meta, c.project).preferredModel).toBe("user/file-model");
    } finally {
      cleanup(c);
    }
  });

  test("混合形态：文件已有 preferredModel + kv 待迁移 → 只迁预设不动模型字段", async () => {
    const c = setup();
    try {
      registerLegacy(c, c.project, "zai-coding-cn/glm-5.3", "read-only");
      const file = join(c.project, ".ul-omo-webui.json");
      writeFileSync(file, JSON.stringify({ version: 1, preferredModel: "user/file-model" }) + "\n");

      // 第一轮：模型分支清库、预设分支迁入文件
      await migrateProjectPreferences(c.stores, c.meta);
      const doc = JSON.parse(readFileSync(file, "utf8"));
      expect(doc.preferredModel).toBe("user/file-model");
      expect(doc.permissionPreset).toBe("read-only");
      expect(c.meta.getProjectMeta(c.project)?.preferredModel).toBeNull();
    } finally {
      cleanup(c);
    }
  });

  test("写文件失败（项目根指向普通文件）→ 不清库 + failed 计数 + warn", async () => {
    const c = setup(false);
    try {
      // 项目根是一个普通文件：readProjectRaw 的 statSync(ENOTDIR) 即失败，
      // 等价「目录不可写/写失败」构造（root 下 chmod 失效的替代形态）
      writeFileSync(c.project, "i-am-a-file");
      registerLegacy(c, c.project, "zai-coding-cn/glm-5.3", "read-only");
      const warns: string[] = [];
      const summary = await migrateProjectPreferences(c.stores, c.meta, {
        warn: (m) => warns.push(m),
      });
      expect(summary).toEqual({ migrated: 0, failed: 1 });
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(c.project);
      // 库值保留：迁移未静默丢偏好
      expect(c.meta.getProjectMeta(c.project)?.preferredModel).toBe("zai-coding-cn/glm-5.3");
      expect(c.meta.getKv(permissionPresetKey(c.project))).toBe("read-only");
    } finally {
      cleanup(c);
    }
  });

  test("文件损坏 → 迁移失败保留库值、损坏文件不被覆盖", async () => {
    const c = setup();
    try {
      registerLegacy(c, c.project, "zai-coding-cn/glm-5.3", null);
      const file = join(c.project, ".ul-omo-webui.json");
      writeFileSync(file, "{broken");
      const summary = await migrateProjectPreferences(c.stores, c.meta, { warn: () => {} });
      expect(summary).toEqual({ migrated: 0, failed: 1 });
      expect(readFileSync(file, "utf8")).toBe("{broken");
      expect(c.meta.getProjectMeta(c.project)?.preferredModel).toBe("zai-coding-cn/glm-5.3");
    } finally {
      cleanup(c);
    }
  });

  test("逐项目隔离：一个项目失败不影响其余项目迁移，整体 promise 不 reject", async () => {
    const c = setup();
    try {
      const good = join(c.root, "good-proj");
      mkdirSync(good, { recursive: true });
      const bad = join(c.root, "bad-proj");
      writeFileSync(bad, "i-am-a-file");
      registerLegacy(c, good, "zai-coding-cn/glm-5.3", null);
      registerLegacy(c, bad, "zai-coding-cn/glm-5.3-flash", null);
      const summary = await migrateProjectPreferences(c.stores, c.meta, { warn: () => {} });
      expect(summary).toEqual({ migrated: 1, failed: 1 });
      expect(JSON.parse(readFileSync(join(good, ".ul-omo-webui.json"), "utf8")).preferredModel).toBe(
        "zai-coding-cn/glm-5.3",
      );
      expect(c.meta.getProjectMeta(good)?.preferredModel).toBeNull();
      // 失败项目库值保留
      expect(c.meta.getProjectMeta(bad)?.preferredModel).toBe("zai-coding-cn/glm-5.3-flash");
    } finally {
      cleanup(c);
    }
  });

  test("无注册项目 → 零迁移不抛错", async () => {
    const c = setup();
    try {
      expect(await migrateProjectPreferences(c.stores, c.meta)).toEqual({ migrated: 0, failed: 0 });
    } finally {
      cleanup(c);
    }
  });

  test("迁移完成后文件不存在于非注册项目（不越权创建）", async () => {
    const c = setup();
    try {
      registerLegacy(c, c.project, null, null);
      const other = join(c.root, "other");
      mkdirSync(other, { recursive: true });
      await migrateProjectPreferences(c.stores, c.meta);
      expect(existsSync(join(other, ".ul-omo-webui.json"))).toBe(false);
    } finally {
      cleanup(c);
    }
  });
});
