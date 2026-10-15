// session-url 助手单测（B1）：
// - 助手本体：读 ?session= / 写入覆盖 / 清参，其余查询参数一律保留（replaceState 原地替换）
// - store 三接入点 URL 同步：select 真实 id 写入、select 别名 id 清参（N2）、
//   adoptSessionId 选中态换 key 换写真实 id 并移出别名集合、removeSession 选中清参
// happy-dom 提供 window/history（session-dialogs.test.tsx 同款注册基建）
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readSessionUrl, writeSessionUrl } from "@/lib/session-url";
import { useSessionsStore } from "@/stores/sessions";

// bun test 单进程跑多文件：其他测试文件可能已注册，双注册会抛错（command-bar 同款守卫）
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

// happy-dom 的 setURL 直改 frame URL，无导航无同源限制；history.replaceState 受同源
// 校验（缺省 about:blank 时改 URL 会抛 SecurityError），故 URL 夹具一律走 setURL
function setTestUrl(url: string): void {
  (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(url);
}

// bun test 文件执行顺序非字母序：本文件可能先于其他文件执行。location 必须还原到
// 模块加载时的初值，否则后续文件的相对 URL fetch（commands.test 的 network 断言）
// 会按残留 URL 解析打到真端口（本机 80 有反代，404 污染断言）
const INITIAL_HREF = window.location.href;

function resetUrl(): void {
  setTestUrl(INITIAL_HREF);
}

describe("readSessionUrl / writeSessionUrl", () => {
  beforeEach(resetUrl);

  test("无 ?session= 参数返回 null", () => {
    expect(readSessionUrl()).toBeNull();
  });

  test("读 ?session= 参数值", () => {
    setTestUrl("http://localhost/?session=abc");
    expect(readSessionUrl()).toBe("abc");
  });

  test("写入 ?session= 且保留其余查询参数", () => {
    setTestUrl("http://localhost/?foo=1&bar=2");
    writeSessionUrl("s1");
    expect(readSessionUrl()).toBe("s1");
    expect(window.location.search).toContain("foo=1");
    expect(window.location.search).toContain("bar=2");
  });

  test("写入覆盖旧值（原地替换不堆叠）", () => {
    setTestUrl("http://localhost/?session=old&foo=1");
    writeSessionUrl("new");
    expect(readSessionUrl()).toBe("new");
    expect(window.location.search).toContain("foo=1");
    expect(window.location.search).not.toContain("old");
  });

  test("清参保留其余查询参数", () => {
    setTestUrl("http://localhost/?foo=1&session=abc");
    writeSessionUrl(null);
    expect(readSessionUrl()).toBeNull();
    expect(window.location.search).toContain("foo=1");
  });
});

describe("store 三接入点 URL 同步", () => {
  beforeEach(() => {
    resetUrl();
    useSessionsStore.setState({
      byProject: {},
      runStates: {},
      runStateAt: {},
      selectedId: null,
      aliasIds: {},
    });
  });

  afterEach(() => {
    useSessionsStore.setState({
      byProject: {},
      runStates: {},
      runStateAt: {},
      selectedId: null,
      aliasIds: {},
    });
    resetUrl();
  });

  test("select 真实 id → URL 写入；select(null) → URL 清参", () => {
    useSessionsStore.getState().select("s-real");
    expect(readSessionUrl()).toBe("s-real");
    useSessionsStore.getState().select(null);
    expect(readSessionUrl()).toBeNull();
    expect(useSessionsStore.getState().selectedId).toBeNull();
  });

  test("select 别名 id → URL 清参不留陈旧选中（N2）", () => {
    useSessionsStore.getState().select("s-previous");
    expect(readSessionUrl()).toBe("s-previous");
    useSessionsStore.getState().markAliasId("s-alias");
    useSessionsStore.getState().select("s-alias");
    expect(useSessionsStore.getState().selectedId).toBe("s-alias");
    expect(readSessionUrl()).toBeNull();
  });

  test("adoptSessionId 选中态换 key → URL 换写真实 id，别名集合移除旧 id", () => {
    useSessionsStore.getState().markAliasId("alias-1");
    useSessionsStore.getState().select("alias-1");
    expect(readSessionUrl()).toBeNull();
    useSessionsStore.getState().adoptSessionId("alias-1", "real-1");
    expect(useSessionsStore.getState().selectedId).toBe("real-1");
    expect(readSessionUrl()).toBe("real-1");
    expect(useSessionsStore.getState().aliasIds["alias-1"]).toBeUndefined();
  });

  test("adoptSessionId 非选中会话换 key → URL 不变", () => {
    useSessionsStore.getState().select("s-x");
    useSessionsStore.getState().adoptSessionId("alias-2", "real-2");
    expect(readSessionUrl()).toBe("s-x");
    expect(useSessionsStore.getState().selectedId).toBe("s-x");
  });

  test("removeSession 选中会话 → URL 清参；删非选中 → URL 不变", () => {
    useSessionsStore.getState().select("s-a");
    useSessionsStore.getState().removeSession("s-a");
    expect(readSessionUrl()).toBeNull();
    useSessionsStore.getState().select("s-b");
    useSessionsStore.getState().removeSession("s-other");
    expect(readSessionUrl()).toBe("s-b");
  });

  test("markAliasId 幂等（重复记入不产生新引用）", () => {
    const store = useSessionsStore.getState();
    store.markAliasId("dup-1");
    const first = useSessionsStore.getState().aliasIds;
    store.markAliasId("dup-1");
    expect(useSessionsStore.getState().aliasIds).toBe(first);
  });
});
