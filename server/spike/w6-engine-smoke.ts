/**
 * W6 todo 29：发行包引擎闭包 spawn 冒烟（todo 31 复验可复跑）。
 *
 * 用法：bun server/spike/w6-engine-smoke.ts [发行包根，默认 <repo>/dist]
 * 验证 dist/engine/node_modules 布局下真实引擎 RPC 可达（get_protocol_info ping），
 * 不发 prompt、零 token。运行要求：PATH 上有 node（RpcClient 固定 spawn node）。
 */
import { RpcClient } from "@code-yeongyu/senpi"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

const releaseRoot = resolve(process.argv[2] ?? join(import.meta.dir, "..", "..", "dist"))
const engineNm = join(releaseRoot, "engine", "node_modules")
const cliPath = join(engineNm, "@code-yeongyu", "senpi", "dist", "bundle", "cli.js")
const pluginDir = join(engineNm, "omo-ai", "plugin")
if (!existsSync(cliPath) || !existsSync(pluginDir)) {
  console.error(`发行包引擎闭包缺失：${cliPath} / ${pluginDir}`)
  process.exit(1)
}

const client = new RpcClient({
  cliPath,
  cwd: process.env.SENPI_WEBUI_SMOKE_CWD ?? process.cwd(),
  args: ["--extension", pluginDir, "--multi-session"],
  env: {
    OMO_CODING_AGENT_DIR: "/root/.pi/agent",
    SENPI_CODING_AGENT_DIR: "/root/.pi/agent",
    OMO_NATIVE: "1",
    PI_OFFLINE: "1",
  } as Record<string, string>,
})
await client.start()
for (let i = 0; i < 15; i++) {
  try {
    const info = await client.send({ type: "get_protocol_info" })
    console.log("PING-OK", JSON.stringify(info).slice(0, 120))
    await client.stop()
    process.exit(0)
  } catch {
    await new Promise((r) => setTimeout(r, 1000))
  }
}
console.error("PING-FAIL（15 次轮询未就绪）")
await client.stop()
process.exit(1)
