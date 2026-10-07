import { resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

// 配置读取：SENPI_WEBUI_* 环境变量 > 代码默认值。
// 路径以 import.meta.dir（= server/src）为锚点：
// - 源码形态：src/../data = server/data，src/../../web/dist = 仓库 web/dist
// - bun compile 单文件形态：import.meta.dir 指向可执行文件所在目录，
//   数据/静态目录随二进制便携（W6 打包时实测复核，静态目录届时改为内嵌资产）。
function requirePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`SENPI_WEBUI_PORT 无效："${raw}"（需要 1-65535 的整数）`);
    process.exit(1);
  }
  return port;
}

export const HOST = process.env.SENPI_WEBUI_HOST ?? "0.0.0.0";
export const PORT = requirePort(process.env.SENPI_WEBUI_PORT, 7788);
export const DATA_DIR =
  process.env.SENPI_WEBUI_DATA_DIR ?? resolve(import.meta.dir, "../data");
export const STATIC_DIR =
  process.env.SENPI_WEBUI_STATIC_DIR ??
  resolve(import.meta.dir, "../../web/dist");

/** 元数据库路径：显式 SENPI_WEBUI_META_DB 最高优先；缺省随 DATA_DIR（运行数据目录统一语义）。
 * 函数形态便于测试（env 调用时读取）。 */
export function metaDbPath(): string {
  return process.env.SENPI_WEBUI_META_DB ?? resolve(DATA_DIR, "meta.db");
}

/** 引擎子进程 PID 登记表路径（孤儿清扫的跨重启记录），同属运行数据目录。 */
export function engineRegistryPath(): string {
  return resolve(DATA_DIR, "engine-processes.json");
}

/** 引擎 agent 目录（W2 spawn 规范：显式 OMO_CODING_AGENT_DIR，缺省 ~/.pi/agent）。
 * spawn 与 SDK 侧路径推导（models-store 直读、会话库 sessionDir）必须同源。 */
export function agentDir(): string {
  return process.env.SENPI_WEBUI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
