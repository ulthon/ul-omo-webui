import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { isCompiledBinary, releaseRoot } from "./runtime-paths";

// 配置读取：SENPI_WEBUI_* 环境变量 > 代码默认值。
// 锚点语义（W6 todo 29 实测复核，取代 W0 备注）：
// - 源码形态：releaseRoot() = 仓库根；DATA_DIR = server/data，STATIC_DIR = web/dist
// - bun compile 编译形态：import.meta.dir 是虚拟 FS（/$bunfs/root），不可用作路径锚点；
//   releaseRoot() = 可执行文件所在目录。静态资源已内嵌进二进制（embedded-static），
//   磁盘 STATIC_DIR 仅作源码形态与显式 env 覆盖（逃生口）用；
//   DATA_DIR 缺省落在可执行文件旁的 data/（发行包目录用户可控，备份口径见 todo 30）。
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
// 编译形态缺省 <可执行文件目录>/data：与二进制同处一个发行包目录，cwd 无关（从任意
// 目录启动语义一致）；SENPI_WEBUI_DATA_DIR 仍可显式指到别处（如 home 下数据盘）
export const DATA_DIR =
  process.env.SENPI_WEBUI_DATA_DIR ??
  (isCompiledBinary() ? join(releaseRoot(), "data") : resolve(import.meta.dir, "../data"));
// 磁盘静态目录：源码形态语义（web/dist）。编译形态静态资源走内嵌资产
// （embedded-static.ts），此值仅当 env 显式覆盖或嵌入资产缺失时才会被读取
export const STATIC_DIR =
  process.env.SENPI_WEBUI_STATIC_DIR ??
  (isCompiledBinary() ? join(releaseRoot(), "web/dist") : resolve(import.meta.dir, "../../web/dist"));

/** 元数据库路径：显式 SENPI_WEBUI_META_DB 最高优先；缺省随 DATA_DIR（运行数据目录统一语义）。
 * 函数形态便于测试（env 调用时读取）。 */
export function metaDbPath(): string {
  return process.env.SENPI_WEBUI_META_DB ?? resolve(DATA_DIR, "meta.db");
}

/** 引擎子进程 PID 登记表路径（孤儿清扫的跨重启记录），同属运行数据目录。 */
export function engineRegistryPath(): string {
  return resolve(DATA_DIR, "engine-processes.json");
}

/** 引擎 agent 目录（缺省 ~/.omo/agent——2026-10-15 由 ~/.pi/agent 改锚：与命令行版 omo
 * 同一份数据面（凭证 / models.json 自定义模型 / 会话库），修复模型下拉缺自定义模型；
 * W1 阶段借 pi 目录属零拷贝权宜。显式 SENPI_WEBUI_AGENT_DIR 可覆盖（QA 隔离实例必注入
 * 临时目录，防测试会话写进真实 omo 会话库）。spawn 与 SDK 侧路径推导（models-store
 * 直读、会话库 sessionDir）必须同源。 */
export function agentDir(): string {
  return process.env.SENPI_WEBUI_AGENT_DIR ?? join(homedir(), ".omo", "agent");
}

/** SSE 链路诊断日志开关（D18 排查）：SENPI_WEBUI_DEBUG_SSE truthy 时服务端 stdout 输出
 * 连接建立/状态迁移/帧写出/durableLookup miss 日志；关闭时零输出零行为差异。 */
export const DEBUG_SSE = /^(1|true|yes|on)$/i.test(process.env.SENPI_WEBUI_DEBUG_SSE ?? "");
