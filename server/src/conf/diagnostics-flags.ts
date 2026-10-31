// 诊断开关运行时态（2026-10-31）：面板可开可关、免重启免改 systemd 单元。
// env（UL_OMO_WEBUI_DEBUG_PERF/DEBUG_SSE）保留为启动默认；数据目录 diagnostics.json
// 持久化面板态。生效值 = env 或 面板持久态任一为真。单例：server 启动时
// initDiagnosticsFlags(dataDir) 一次，消费方直接调 debugPerfOn()/debugSseOn()。
// 读写纪律同 config-store：mtime 缓存 + tmp+rename 原子写；单用户单实例假设。
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** env 启动默认（与 config.ts DEBUG_SSE / perf.ts DEBUG_PERF 同真值集合；自读自持免跨层依赖） */
const ENV_PERF = /^(1|true|yes|on)$/i.test(process.env.UL_OMO_WEBUI_DEBUG_PERF ?? "");
const ENV_SSE = /^(1|true|yes|on)$/i.test(process.env.UL_OMO_WEBUI_DEBUG_SSE ?? "");

export interface DiagnosticsFlags { perf: boolean; sse: boolean; }

let file: string | null = null;
let cached: { mtimeMs: number; size: number; flags: DiagnosticsFlags } | null = null;

/** server 启动时调用一次；重复调用以最新路径重置缓存 */
export function initDiagnosticsFlags(dataDir: string): void {
  file = join(dataDir, "diagnostics.json");
  cached = null;
}

function persisted(): DiagnosticsFlags {
  if (file === null) return { perf: false, sse: false };
  try {
    const st = statSync(file);
    if (cached !== null && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.flags;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { perf?: unknown; sse?: unknown };
    const flags = { perf: raw.perf === true, sse: raw.sse === true };
    cached = { mtimeMs: st.mtimeMs, size: st.size, flags };
    return flags;
  } catch {
    return { perf: false, sse: false };
  }
}

/** 生效值（env 启动默认 OR 面板持久态） */
export function getDiagnosticsFlags(): DiagnosticsFlags {
  const p = persisted();
  return { perf: ENV_PERF || p.perf, sse: ENV_SSE || p.sse };
}

export function debugPerfOn(): boolean { return getDiagnosticsFlags().perf; }
export function debugSseOn(): boolean { return getDiagnosticsFlags().sse; }

/** 面板写入口：tmp+rename 原子写，返回生效值（env 为真的项不可关） */
export function setDiagnosticsFlags(patch: Partial<DiagnosticsFlags>): DiagnosticsFlags {
  if (file === null) return getDiagnosticsFlags();
  const next = { ...persisted(), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), ".diagnostics.json.tmp");
  writeFileSync(tmp, JSON.stringify(next) + "\n", "utf8");
  renameSync(tmp, file);
  cached = null;
  return getDiagnosticsFlags();
}