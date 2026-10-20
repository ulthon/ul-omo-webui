import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // 与 vite.config.ts 保持一致（测试源码用 @/ 引用 src）
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // 承接原 bunfig.toml [test].preload：zustand 服务端快照 shim 先于所有测试文件生效；
    // setup-locale.ts 锁定全部测试运行语言 zh-CN（i18n 任务3），须排在 shim 之后
    setupFiles: ["./tests/helpers/zustand-server-snapshot.ts", "./tests/helpers/setup-locale.ts"],
    include: ["tests/**/*.test.*", "src/**/*.test.*"],
    // web 测试为纯逻辑 + renderToStaticMarkup 服务端渲染（含手写 window/localStorage
    // shim 与 @happy-dom/global-registrator 自注册），无需 DOM 测试环境
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
