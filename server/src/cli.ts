/**
 * CLI 入口分发。
 *
 * 用法：
 *   ul-omo-webui                 —— 不带参数，启动 web 服务器（默认行为，与历史一致）
 *   ul-omo-webui startup <cmd>   —— 自启动服务管理（enable / disable / status）
 *
 * startup 子命令在加载服务器组合根之前短路返回，避免触碰 DATA_DIR/meta 库；
 * 服务器主体仍在 ./index.ts（模块副作用启动监听）。
 */
const args = process.argv.slice(2);

if (args[0] === "startup") {
  const { runStartup } = await import("./startup");
  await runStartup(args.slice(1));
  // runStartup 自带 process.exit；兜底退出
  process.exit(0);
}

await import("./index");
