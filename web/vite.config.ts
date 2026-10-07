import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// QA/dev 专用：设 SENPI_WEBUI_QA_TARGET 时把 /api 代理到隔离后端（默认不影响 dev）
const apiProxy = process.env.SENPI_WEBUI_QA_TARGET
  ? { server: { proxy: { '/api': { target: process.env.SENPI_WEBUI_QA_TARGET, changeOrigin: false } } } }
  : {}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // ES worker：Shiki worker 内按需动态 import 语言/主题 grammar 需要 code splitting（iife 不支持）
  worker: {
    format: 'es',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // W5-27 bundle 拆分：vendor 按域分包（缓存稳定 + 首屏并行加载），
        // react-diff-view 另经组件层 lazy() 做到首屏零加载（ ChangesView/工具卡 diff 按需）。
        advancedChunks: {
          groups: [
            {
              name: 'react-vendor',
              test: /[\\/]node_modules[\\/]\.bun[\\/](react|react-dom|react-reconciler|scheduler|zustand|@tanstack)@/,
            },
            {
              name: 'markdown-vendor',
              test: /[\\/]node_modules[\\/]\.bun[\\/](unified|remark-|rehype-|micromark|mdast-|hast-|unist-|vfile|devlop|zwitch|bail|trough|is-plain-obj|property-information|space-separated-tokens|comma-separated-tokens|web-namespaces|ccount|html-url-attributes|decode-named|character-entities|markdown-|shiki)@/,
            },
            {
              name: 'diff-vendor',
              test: /[\\/]node_modules[\\/]\.bun[\\/](react-diff-view|gitdiff-parser)@/,
            },
            {
              name: 'ui-vendor',
              test: /[\\/]node_modules[\\/]\.bun[\\/](radix-ui|@radix-ui\+|lucide-react|class-variance-authority|clsx|tailwind-merge)@/,
            },
          ],
        },
      },
    },
  },
  ...apiProxy,
})
