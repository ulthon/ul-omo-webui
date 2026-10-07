// 测试 preload（web/bunfig.toml [test].preload 挂载，先于所有测试文件执行）：
// zustand v5 的 useSyncExternalStore 在服务端渲染（react-dom/server renderToStaticMarkup）
// 走 getServerSnapshot = api.getInitialState()——即建库瞬间的初始状态。组件单测若在
// react-dom/server 下断言"事件写入 store 后的渲染结果"，会永远读到空初始态。
// 此 shim 把 vanilla api.getInitialState 对齐为 getState（服务端快照 = 实时状态），
// 仅测试进程生效，应用代码零改动。非 React 渲染的单测（events/session-runstate）不受影响。
import { mock } from "bun:test";
import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";

// 与 zustand react 入口同构的 create（支持 create(fn) 与 create<T>()(fn) 两种形态）
function createPatched(arg) {
  const createImpl = (initializer) => {
    const api = createStore(initializer);
    api.getInitialState = () => api.getState();
    const useBoundStore = (selector) => useStore(api, selector);
    Object.assign(useBoundStore, api);
    return useBoundStore;
  };
  if (typeof arg === "function") return createImpl(arg);
  return (initializer) => createImpl(initializer);
}

mock.module("zustand", () => ({ create: createPatched }));
