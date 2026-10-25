import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // server 测试全部为纯逻辑/集成（无 DOM），node 环境即可
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    // 就绪试写门禁（docs08 任务 7）：存量套件一律以「门禁关」运行，行为与 main
    // 完全一致；门禁自身的开/关语义由 process-manager.test.ts 显式驱动
    setupFiles: ["test/setup.ts"],
  },
});
