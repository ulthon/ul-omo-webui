// 手动 QA（docs08 2026-10-23/24 批次任务 14）：5 acceptedTurns + 1 交织 sessionBinding fixture
// node 级渲染：折叠行（×N 角标）renderToStaticMarkup；展开视图 happy-dom + createRoot + act 点击。
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { mergeMemoryItems } = await import("@/components/chat/message-items");
const { AcceptedTurnsClusterBlock } = await import("@/components/chat/message-list");
const { useLocaleStore } = await import("@/i18n/i18n");

useLocaleStore.setState({ locale: "zh-CN" });

const at = (id: string) => ({ type: "custom", id, customType: "omo-memory:accepted-turns", data: { version: 1 } });
const sb = (id: string, identity: string) => ({ type: "custom", id, customType: "senpi-memory.session-binding", data: { identity } });

const entries = [at("t1"), at("t2"), at("t3"), sb("b1", "lib-1"), at("t4"), at("t5")];
const merged = mergeMemoryItems([], entries);
console.log("merged rows:", JSON.stringify(merged.map((i) => i.kind === "memoryMarkerCluster" ? ["cluster", i.key, i.markers.length] : [i.kind, i.key])));

for (const item of merged) {
  if (item.kind !== "memoryMarkerCluster") continue;
  console.log("--- cluster", item.key, "collapsed ---");
  console.log(renderToStaticMarkup(createElement(AcceptedTurnsClusterBlock, { markers: item.markers })).replace(/<svg[\s\S]*?<\/svg>/g, "<svg…/>"));
}

// 展开视图：点击第一簇折叠行
const cluster = merged.find((i) => i.kind === "memoryMarkerCluster") as Extract<typeof merged[number], { kind: "memoryMarkerCluster" }>;
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
await act(async () => { root.render(createElement(AcceptedTurnsClusterBlock, { markers: cluster.markers })); });
const block = host.firstElementChild as HTMLElement;
await act(async () => { (block.querySelector("button") as HTMLButtonElement).click(); });
console.log("--- cluster", cluster.key, "expanded (marker rows:", block.querySelectorAll('[data-testid="memory-marker"]').length + ") ---");
console.log(block.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, "<svg…/>"));
await act(async () => { root.unmount(); });
