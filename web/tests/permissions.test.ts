// 权限卡片单测（todo 18）：extension_ui_request 四型载荷入队路由、fire-and-forget 不入队、
// 回合落定清队、队列去重；auto-answer 纯函数（标题解析工具名 / kv 键形态）。
import { beforeEach, describe, expect, test } from "vitest";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import {
  autoAllowKey,
  parsePermissionTool,
  usePermissionsStore,
  type PermissionRequest,
} from "@/stores/permissions";
import { useUiStore } from "@/stores/ui";

const SID = "sess-perm-1";

/** 构造并分发一帧 extension_ui_request */
function dispatchRequest(id: string, method: string, extra: Record<string, unknown> = {}): void {
  dispatchSseEvent(
    "extension_ui_request",
    JSON.stringify({ projectPath: "/p", event: { type: "extension_ui_request", sessionId: "rpc-9", id, method, ...extra }, durableSessionId: SID }),
    1,
  );
}

function queue(): PermissionRequest[] {
  return usePermissionsStore.getState().bySession[SID] ?? [];
}

beforeEach(() => {
  resetDispatchState();
  usePermissionsStore.setState({ bySession: {}, autoAllow: {} });
  useUiStore.setState({ toast: null });
});

describe("extension_ui_request 分发路由", () => {
  test("select 载荷完整入队（标题/选项原文保留）", () => {
    dispatchRequest("id-1", "select", {
      title: "Permission required: bash\n\nCommand: $ ls -la\n\nPatterns:\n  - ls",
      options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
    });
    const q = queue();
    expect(q.length).toBe(1);
    expect(q[0].id).toBe("id-1");
    expect(q[0].method).toBe("select");
    expect(q[0].options).toEqual(["Allow once", "Allow always", "Deny", "Deny with feedback"]);
    expect(q[0].title).toContain("Command: $ ls -la");
  });

  test("confirm/input/editor 三型字段映射", () => {
    dispatchRequest("id-c", "confirm", { title: "timed", message: "View source path?" });
    dispatchRequest("id-i", "input", { title: "Feedback", placeholder: "Why are you denying this permission? (optional)" });
    dispatchRequest("id-e", "editor", { title: "Edit some text", prefill: "Line 1\nLine 2" });
    const q = queue();
    expect(q.map((r) => r.method)).toEqual(["confirm", "input", "editor"]);
    expect(q[0].message).toBe("View source path?");
    expect(q[1].placeholder).toContain("denying");
    expect(q[2].prefill).toBe("Line 1\nLine 2");
  });

  test("同会话堆叠多请求按 FIFO 排队（run1 双 select 实证形态）", () => {
    dispatchRequest("id-1", "select", { title: "Permission required: bash", options: ["Allow once"] });
    dispatchRequest("id-2", "select", { title: "Permission required: read", options: ["Allow once"] });
    expect(queue().map((r) => r.id)).toEqual(["id-1", "id-2"]);
  });

  test("同 id 重复投递去重（SSE 重连重放）", () => {
    dispatchRequest("id-1", "select", { title: "Permission required: bash", options: ["Allow once"] });
    dispatchRequest("id-1", "select", { title: "Permission required: bash", options: ["Allow once"] });
    expect(queue().length).toBe(1);
  });

  test("缺 id 的帧不入队（容错）", () => {
    dispatchSseEvent(
      "extension_ui_request",
      JSON.stringify({ projectPath: "/p", event: { type: "extension_ui_request", sessionId: "rpc-9", method: "select" } }),
      1,
    );
    expect(queue().length).toBe(0);
  });

  test("fire-and-forget 型（notify/setStatus/setWidget）不入队；notify 走 toast 轻提示", () => {
    dispatchRequest("id-n", "notify", { message: "Editor submitted (4 lines)" });
    dispatchRequest("id-s", "setStatus", { statusText: "busy" });
    dispatchRequest("id-w", "setWidget", {});
    expect(queue().length).toBe(0);
    expect(useUiStore.getState().toast?.text).toBe("Editor submitted (4 lines)");
  });

  test("回合落定（agent_end）整队清空", () => {
    dispatchRequest("id-1", "select", { title: "Permission required: bash", options: ["Allow once"] });
    dispatchRequest("id-2", "input", { title: "Feedback" });
    dispatchSseEvent(
      "agent_end",
      JSON.stringify({ projectPath: "/p", event: { type: "agent_end", sessionId: "rpc-9" }, durableSessionId: SID }),
      2,
    );
    expect(usePermissionsStore.getState().bySession[SID]).toBeUndefined();
  });

  test("应答后出队不影响其余排队请求", () => {
    dispatchRequest("id-1", "select", { title: "Permission required: bash", options: ["Allow once"] });
    dispatchRequest("id-2", "select", { title: "Permission required: read", options: ["Allow once"] });
    usePermissionsStore.getState().removeRequest(SID, "id-1");
    expect(queue().map((r) => r.id)).toEqual(["id-2"]);
  });

  test("clearSession 只清目标会话", () => {
    dispatchRequest("id-1", "select", { title: "Permission required: bash", options: ["Allow once"] });
    usePermissionsStore.getState().pushRequest("sess-other", { id: "x", method: "input", title: "t" });
    usePermissionsStore.getState().clearSession(SID);
    expect(queue().length).toBe(0);
    expect(usePermissionsStore.getState().bySession["sess-other"]?.length).toBe(1);
  });
});

describe("auto-answer 纯函数", () => {
  test("权限型标题解析工具名", () => {
    expect(parsePermissionTool("Permission required: bash\n\nCommand: $ ls -la")).toBe("bash");
    expect(parsePermissionTool("Permission required: read\n\nPath: /x")).toBe("read");
    expect(parsePermissionTool("Permission required:")).toBeNull();
  });

  test("非权限型 select（/commands 列表）不解析出工具名——不参与自动放行", () => {
    expect(parsePermissionTool("Available Commands\n\n/timed - Show a timed confirmation dialog")).toBeNull();
    expect(parsePermissionTool("")).toBeNull();
  });

  test("kv 键形态：permission-auto-allow:<sessionId>:<tool>", () => {
    expect(autoAllowKey("sess-1", "bash")).toBe("permission-auto-allow:sess-1:bash");
  });

  test("markAutoAllow 登记缓存命中", () => {
    usePermissionsStore.getState().markAutoAllow(SID, "bash");
    expect(usePermissionsStore.getState().autoAllow[autoAllowKey(SID, "bash")]).toBe(true);
  });
});
