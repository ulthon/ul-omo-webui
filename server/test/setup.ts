/**
 * vitest 全局 setup：就绪试写门禁（docs08-2026-10-23-24-batch 任务 7）默认关。
 * 存量套件因此与 main 行为完全一致（门禁的开关语义由 process-manager.test.ts
 * 显式驱动）；也避免存量用例的 fake 引擎在默认 agentDir 下触发探针写盘。
 */
process.env.SENPI_ENGINE_PROBE_GATE = "0"
