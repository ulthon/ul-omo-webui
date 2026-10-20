// 笔记 REST 封装（todo 15）。
// api.ts（lib）在本任务禁改名单内，故在此自建 request——错误形状与 401 跳转
// 复用 lib/api 已导出的 ApiError / redirectToLogin，行为与其 request 一致
// （网络错 code=network、401 跳 /login、{error:{code,message}} 解析、非 JSON 保留 HTTP 文案）。
// 端点契约见 server/src/api/routes-notes.ts（todo 5）：列表 {notes:[...]} 无 content、
// 创建 201、详情 {note:{...}}（projectPath 以 project 键输出）、updatedAt/createdAt 可 null。
import { ApiError, redirectToLogin } from "@/lib/api";
import { t } from "@/i18n/i18n";

export interface NoteListItem {
  id: string;
  title: string;
  tags: string[];
  updatedAt: string | null;
  deletedAt: string | null;
}

export interface NoteData {
  id: string;
  project: string;
  title: string;
  content: string;
  tags: string[];
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface NoteVersionInfo {
  id: string;
  savedAt: string;
  preview: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(0, "network", err instanceof Error ? err.message : String(err));
  }
  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError(401, "unauthorized", t("common.lib.unauthorized"));
  }
  if (!res.ok) {
    let code = "unknown";
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } | string };
      if (typeof body.error === "string") {
        code = body.error;
        message = body.error;
      } else if (body.error && typeof body.error === "object") {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      }
    } catch {
      // 非 JSON 错误体，保留 HTTP 状态默认文案
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export const notesApi = {
  /** 列表（无 content）：deleted=0 活动 |1 回收站；tag 服务端包含过滤 */
  async list(project: string, opts?: { deleted?: boolean; tag?: string }): Promise<{ notes: NoteListItem[] }> {
    const q = new URLSearchParams({ project });
    if (opts?.deleted) q.set("deleted", "1");
    if (opts?.tag) q.set("tag", opts.tag);
    return request(`/api/notes?${q.toString()}`);
  },
  async get(id: string): Promise<{ note: NoteData }> {
    return request(`/api/notes/${encodeURIComponent(id)}`);
  },
  async create(body: { project: string; title: string; content: string; tags?: string[] }): Promise<{ note: NoteData }> {
    return request("/api/notes", jsonInit("POST", body));
  },
  async update(
    id: string,
    patch: { title?: string; content?: string; tags?: string[] },
  ): Promise<{ note: NoteData }> {
    return request(`/api/notes/${encodeURIComponent(id)}`, jsonInit("PUT", patch));
  },
  /** 删除：缺省软删；purge=true 彻底删除（仅软删状态允许，否则 409） */
  async remove(id: string, purge?: boolean): Promise<{ ok: boolean; deleted?: string; purged?: string }> {
    const qs = purge ? "?purge=1" : "";
    return request(`/api/notes/${encodeURIComponent(id)}${qs}`, { method: "DELETE" });
  },
  async restore(id: string): Promise<{ note: NoteData }> {
    return request(`/api/notes/${encodeURIComponent(id)}/restore`, jsonInit("POST", {}));
  },
  async versions(id: string): Promise<{ versions: NoteVersionInfo[] }> {
    return request(`/api/notes/${encodeURIComponent(id)}/versions`);
  },
  async restoreVersion(id: string, versionId: string): Promise<{ note: NoteData }> {
    return request(`/api/notes/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`, jsonInit("POST", {}));
  },
};
