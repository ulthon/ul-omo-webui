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
  ...apiProxy,
})
