// 存量项目偏好迁移与合并读取（W1 todo 6，Scope 决策 8/10）。
//
// 迁移（组合根在 Bun.serve 监听就绪后 fire-and-forget 调用）：对全部注册项目逐项执行——
// .senpi-webui.json 无 preferredModel 字段而 meta_project.preferred_model 有值 → 写文件
// 成功后 UPDATE 置 NULL；meta_kv permission-preset:<path> 同理迁为文件 permissionPreset
// 后删 kv。两步（写文件成功后才清库）保证中断安全：任一步失败/中断，下次启动按同一
// 判定补迁。文件已有字段（含显式 null）= 文件为准，库值丢弃。
// per-project 失败仅 warn + 保留库值（偏好不静默丢失），allSettled 隔离单项目挂死/只读
// 目录，不阻塞其余项目，更不阻塞监听。
//
// 合并读（过渡态回退）：文件可解析但缺字段且库值未迁清 → 以库值为准（视同迁移未完成，
// 下次启动继续补迁——迁移写文件持续失败时 GET 也不误显 null）；文件已有字段（含显式
// null）或库值已清空 → 以文件为准。
// 分层失败（决策 10）：合并读路径（spawn args、模型缺省、GET/POST /api/projects、PATCH
// 响应）文件损坏 → 按项目降级 null + configError 标志，单项目损坏不炸整页；显式写偏好
// （PATCH preferredModel/permissionPreset）损坏 → 500 带文件路径（route 包装透传
// config-store 错误消息，绝不静默吞）。
import { openConfigStore, type ConfigStore, type PreferredThinkingLevel, type ProjectConfig } from "../conf/config-store";
import type { MetaDb } from "../db/meta";
import { permissionPresetArgs, permissionPresetKey } from "./engine-runtime";

/**
 * 按项目根解析项目配置 store。组合根创建一次并全链共用（extraSpawnArgs、路由工厂、
 * 迁移）：config-store 的写串行化是 per-instance 的，同一项目的所有读写必须走同一
 * 实例才共用一条 promise 链，避免并发读-改-写互相覆盖。
 */
export type ProjectConfigStores = (projectRoot: string) => ConfigStore;

export function createProjectConfigStores(base: ConfigStore): ProjectConfigStores {
  const cache = new Map<string, ConfigStore>();
  return (projectRoot) => {
    let store = cache.get(projectRoot);
    if (!store) {
      store = openConfigStore({ globalDir: base.globalDir, projectRoot });
      cache.set(projectRoot, store);
    }
    return store;
  };
}

/**
 * 过渡态合并：文件已有字段（含显式 null）或库值已清空 → 文件为准；
 * 文件缺字段且库值未迁清 → 库值（迁移未完成语义）。
 */
export function effectivePreference(
  fileHasField: boolean,
  fileValue: string | null,
  dbValue: string | null,
): string | null {
  if (fileHasField || dbValue === null) return fileValue;
  return dbValue;
}

function hasField(raw: Record<string, unknown> | null, field: string): boolean {
  return raw !== null && Object.prototype.hasOwnProperty.call(raw, field);
}

export interface ProjectPreferenceView {
  preferredModel: string | null;
  permissionPreset: string | null;
  /** W2 todo 7 新增偏好：无迁移前库源，恒取文件值（缺字段/损坏降级为 null） */
  preferredThinkingLevel: PreferredThinkingLevel | null;
  /** 项目配置文件损坏时的降级标志（决策 10b：字段置 null，不炸整页、不误报写失败） */
  configError: boolean;
}

/**
 * 合并读取单项目偏好（过渡态回退 + 损坏降级）。stores 为 null = 测试装配未注入
 * 组合根解析器的兼容形态，等价迁移前的纯库读（生产组合根恒注入）。
 */
export function readProjectPreferences(
  stores: ProjectConfigStores | null,
  meta: MetaDb,
  projectPath: string,
): ProjectPreferenceView {
  if (!stores) {
    return {
      preferredModel: meta.getProjectMeta(projectPath)?.preferredModel ?? null,
      permissionPreset: meta.getKv(permissionPresetKey(projectPath)),
      preferredThinkingLevel: null,
      configError: false,
    };
  }
  let raw: Record<string, unknown> | null;
  let doc: ProjectConfig;
  try {
    const store = stores(projectPath);
    doc = store.readProjectConfig();
    raw = store.readProjectRaw();
  } catch {
    // 文件损坏（解析失败/字段形状非法）→ 按项目降级，单项目不炸整页（决策 10b）
    return { preferredModel: null, permissionPreset: null, preferredThinkingLevel: null, configError: true };
  }
  return {
    preferredModel: effectivePreference(
      hasField(raw, "preferredModel"),
      doc.preferredModel,
      meta.getProjectMeta(projectPath)?.preferredModel ?? null,
    ),
    permissionPreset: effectivePreference(
      hasField(raw, "permissionPreset"),
      doc.permissionPreset,
      meta.getKv(permissionPresetKey(projectPath)),
    ),
    preferredThinkingLevel: doc.preferredThinkingLevel,
    configError: false,
  };
}

/** 组合根 extraSpawnArgs 适配：合并读取项目权限预设 → spawn 附加参数。
 * 无预设/文件损坏返回空数组，spawn 行为与从前完全一致（决策 10b 降级）。 */
export function permissionPresetSpawnArgs(
  stores: ProjectConfigStores | null,
  meta: MetaDb,
  projectPath: string,
): string[] {
  return permissionPresetArgs(readProjectPreferences(stores, meta, projectPath).permissionPreset);
}

export interface MigrationSummary {
  /** 完成了任一迁移动作（写文件或清库）的项目数 */
  migrated: number;
  /** 迁移失败（保留库值，下次启动补迁）的项目数 */
  failed: number;
}

/** 单项目迁移（两步中断安全：写文件成功后才清库）。抛错由 migrateProjectPreferences
 * 逐项目捕获。 */
async function migrateOne(
  stores: ProjectConfigStores,
  meta: MetaDb,
  projectPath: string,
): Promise<boolean> {
  const store = stores(projectPath);
  const raw = store.readProjectRaw();
  const dbModel = meta.getProjectMeta(projectPath)?.preferredModel ?? null;
  const dbPreset = meta.getKv(permissionPresetKey(projectPath));

  const filePatch: { preferredModel?: string; permissionPreset?: string } = {};
  let clearModel = false;
  let clearPreset = false;
  // 文件缺字段且库有值 → 迁入文件（第一步）
  if (!hasField(raw, "preferredModel") && dbModel !== null) {
    filePatch.preferredModel = dbModel;
    clearModel = true;
  }
  if (!hasField(raw, "permissionPreset") && dbPreset !== null) {
    filePatch.permissionPreset = dbPreset;
    clearPreset = true;
  }
  if (Object.keys(filePatch).length > 0) {
    // updateProjectConfig 内部：文件损坏在此抛错（拒写不覆盖），库未被触碰
    await store.updateProjectConfig(filePatch);
    // 第二步：文件已原子落盘才清库（中断在两步之间 → 下次启动按
    // 「文件已有字段 = 库值丢弃」分支收敛，偏好不丢失）
    if (clearModel) meta.updateProjectMeta(projectPath, { preferredModel: null });
    if (clearPreset) meta.deleteKv(permissionPresetKey(projectPath));
  }
  // 文件已有字段（含显式 null）= 文件为准，库值丢弃（幂等：库已清时为 no-op）
  let dropped = false;
  if (hasField(raw, "preferredModel") && dbModel !== null) {
    meta.updateProjectMeta(projectPath, { preferredModel: null });
    dropped = true;
  }
  if (hasField(raw, "permissionPreset") && dbPreset !== null) {
    meta.deleteKv(permissionPresetKey(projectPath));
    dropped = true;
  }
  return Object.keys(filePatch).length > 0 || dropped;
}

/**
 * 启动迁移：对全部注册项目逐项执行。逐项目隔离（失败 warn + 保留库值）、
 * allSettled 并发（单项目挂死——网络盘语义——不拖累其余项目）。整体 promise
 * 不 reject（单项目失败已折入 failed 计数）；挂死项目会让 await 悬置，
 * 调用方必须 fire-and-forget（监听已就绪，不受影响，幂等下次补迁）。
 */
export async function migrateProjectPreferences(
  stores: ProjectConfigStores,
  meta: MetaDb,
  options: { warn?: (message: string) => void } = {},
): Promise<MigrationSummary> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const projects = meta.listProjectMeta().map((p) => p.projectPath);
  const settled = await Promise.allSettled(projects.map((projectPath) => migrateOne(stores, meta, projectPath)));
  let migrated = 0;
  let failed = 0;
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      if (result.value) migrated += 1;
    } else {
      failed += 1;
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      warn(`项目偏好迁移失败（保留库值，下次启动补迁）：${projects[i]}（${reason}）`);
    }
  });
  return { migrated, failed };
}
