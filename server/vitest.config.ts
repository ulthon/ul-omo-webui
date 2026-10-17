import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // server 测试全部为纯逻辑/集成（无 DOM），node 环境即可
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
