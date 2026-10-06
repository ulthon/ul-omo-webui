import { resolve } from "node:path";

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
