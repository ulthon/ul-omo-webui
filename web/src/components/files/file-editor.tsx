// 在线文本编辑器（builtin-file-management 任务 8）：从预览面板「编辑」钮进入。
// 资格三条件（与服务端 FILE_MAX_BYTES=2MB 契约对齐）：size≤2MB 且 truncated=false
// 且 binary=false；不满足时入口钮置灰并给原因提示（isEditableFile/editBlockReasonKey
// 供宿主 files.tsx 消费）。
// CodeMirror 经 code-mirror-loader 动态加载（本体与语言包均不进首屏分包）。
// 脏态守卫沿 right-rail NotesView 先例：组件写宿主传入的 dirtyRef，切走前由
// 宿主/本组件 confirm（窗口级离开由宿主守护，编辑器内返回钮自带确认）。
// 任务 9 保存接线：打开时捕获 GET 回传的 mtimeNs/size 作期望值（乐观锁前置，
// 随保存回执滚动更新）；Ctrl+S/保存钮经 onSave 透传（files.tsx 调 fsSaveFile），
// 409 file_changed（FileConflictError）→ 按计划契约「重载/覆盖」两选弹窗：
// 重载=重拉内容与期望值并作废本地脏态；覆盖=以 409 载荷当前 mtimeNs/size 直接
// 重存本地修改（丢弃磁盘上另一来源的改动，回执滚动期望值；覆盖再撞 409 则弹窗
// 以新载荷重开）。X 关闭钮维持本地内容继续编辑（不静默覆盖，不做自动合并）。
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, FileWarning, LoaderCircle, Save } from "lucide-react";
import { api, FileConflictError, type FsFileResponse } from "@/lib/api";
import { t as tSnap, useT } from "@/i18n/i18n";
import { useUiStore } from "@/stores/ui";
import { SaveConflictDialog } from "./fs-dialogs";
import type { EditorHandle } from "./code-mirror-loader";

/** 编辑资格大小上限（对齐 server/src/api/routes-fs.ts FILE_MAX_BYTES） */
export const FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024;

/** 编辑资格三条件（计划口径）：2MB 内、未截断、非二进制 */
export function isEditableFile(data: Pick<FsFileResponse, "size" | "truncated" | "binary">): boolean {
  return data.size <= FILE_EDIT_MAX_BYTES && !data.truncated && !data.binary;
}

/** 不可编辑原因词条键（binary 优先——二进制时 size/truncated 不构成真实障碍） */
export function editBlockReasonKey(
  data: Pick<FsFileResponse, "size" | "truncated" | "binary">,
): "files.edit.reasonBinary" | "files.edit.reasonTruncated" | "files.edit.reasonTooLarge" {
  if (data.binary) return "files.edit.reasonBinary";
  if (data.truncated) return "files.edit.reasonTruncated";
  return "files.edit.reasonTooLarge";
}

/** 保存期望值（乐观锁前置）：mtimeNs 为服务端 bigint 纳秒十进制字符串 */
export type SaveExpectations = { mtimeNs: string; size: number };

type SaveStatus = "idle" | "saving" | "saved" | "failed" | "unavailable";

const STATUS_KEY: Record<Exclude<SaveStatus, "idle">, "files.edit.statusSaving" | "files.edit.statusSaved" | "files.edit.statusFailed" | "files.edit.statusUnavailable"> = {
  saving: "files.edit.statusSaving",
  saved: "files.edit.statusSaved",
  failed: "files.edit.statusFailed",
  unavailable: "files.edit.statusUnavailable",
};

type EditorState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: FsFileResponse };

export function FileEditor({
  project,
  path,
  dirtyRef,
  onBack,
  onSave,
}: {
  project: string;
  path: string;
  /** 脏态上报（宿主持有，切走前 confirm 的依据；NotesView dirtyRef 同款契约） */
  dirtyRef: { current: boolean };
  /** 返回预览（宿主先过脏态守卫；本组件返回钮亦自带确认） */
  onBack: () => void;
  /** 保存回调（任务 9 接入后由 files.tsx 提供 fsSaveFile 透传）：携带编辑器持有的
   * 期望值，成功回 {mtimeNs,size} 作下轮期望值；409 file_changed 由本组件捕获
   * （调用方透传 FileConflictError 即可）；null = 保存不可用（端点未接入形态） */
  onSave: ((content: string, expectations: SaveExpectations) => Promise<{ mtimeNs: string; size: number }>) | null;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [state, setState] = useState<EditorState>({ kind: "loading" });
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [dirty, setDirty] = useState(false);
  // 保存冲突态（409 file_changed）：服务端当前值仅作弹窗信息，重载走全量重拉
  const [conflict, setConflict] = useState<{ mtimeNs: string | null; size: number | null } | null>(null);
  // 重载令牌：+1 触发装载 effect 重拉内容与期望值（同 project/path 复用同一 effect）
  const [reloadToken, setReloadToken] = useState(0);
  // 乐观锁期望值：打开时由 GET 回传捕获，保存成功后随回执滚动（跨渲染用 ref）
  const expectedRef = useRef<SaveExpectations | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<EditorHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fsFile(project, path)
      .then((data) => {
        if (cancelled) return;
        // mtimeNs 缺失（旧服务端）时回退空串：保存将由服务端 400 拦下，不静默错存
        expectedRef.current = {
          mtimeNs: typeof data.mtimeNs === "string" ? data.mtimeNs : "",
          size: data.size,
        };
        setState({ kind: "ready", data });
        // 重载路径：内容以服务端为准，本地脏态作废（首次装载无脏态，同置无副作用）
        dirtyRef.current = false;
        setDirty(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : tSnap("files.edit.loadFailed");
        setState({ kind: "error", message });
        showToast(message, "error");
      });
    return () => {
      cancelled = true;
    };
  }, [project, path, reloadToken, showToast, dirtyRef]);

  // 编辑器挂载：内容就绪后动态加载 CodeMirror；卸载/重挂载销毁实例
  useEffect(() => {
    if (state.kind !== "ready") return;
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    void import("./code-mirror-loader")
      .then(({ createEditor }) =>
        createEditor(host, state.data.content ?? "", path, () => {
          dirtyRef.current = true;
          setDirty(true);
        }),
      )
      .then((handle) => {
        if (cancelled) {
          handle.destroy();
          return;
        }
        handleRef.current = handle;
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : tSnap("files.edit.loadFailed") });
      });
    return () => {
      cancelled = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content 随 ready 态一次性给定，重开文件由 key 重挂载承担
  }, [state]);

  const runSave = async () => {
    const handle = handleRef.current;
    if (!onSave || !handle || !expectedRef.current) return;
    setStatus("saving");
    try {
      const receipt = await onSave(handle.getText(), expectedRef.current);
      // 回执滚动期望值：下一轮保存以新 mtimeNs/size 为前置（连续保存不自冲突）
      expectedRef.current = { mtimeNs: receipt.mtimeNs, size: receipt.size };
      setStatus("saved");
      dirtyRef.current = false;
      setDirty(false);
    } catch (err) {
      setStatus("failed");
      // 409 file_changed：弹「重载/取消」（不静默覆盖；重载后以服务端内容为基准）
      if (err instanceof FileConflictError) {
        setConflict({ mtimeNs: err.current.mtimeNs, size: err.current.size });
      }
    }
  };

  // 保存触发（Ctrl+S / 保存钮共用）：无保存回调时不发起，状态条提示保存不可用
  const triggerSave = () => {
    if (!onSave) {
      setStatus("unavailable");
      return;
    }
    void runSave();
  };

  const saveRef = useRef(triggerSave);
  saveRef.current = triggerSave;

  // Ctrl+S / Cmd+S 拦截（阻止浏览器保存对话框），触发保存回调
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 冲突弹窗两选（计划契约）：重载 = 重拉内容与期望值（编辑器随 ready 态重建，
  // 本地脏态作废）；覆盖 = 以 409 载荷当前 mtimeNs/size 直接重存本地修改（回执滚动
  // 期望值；覆盖再撞 409 弹窗以新载荷重开）；X 关闭 = 维持本地内容继续编辑
  const reloadFromServer = () => {
    setConflict(null);
    setStatus("idle");
    setReloadToken((n) => n + 1);
  };
  const dismissConflict = () => setConflict(null);
  const overwriteServerFile = async () => {
    const handle = handleRef.current;
    if (!onSave || !handle || !conflict) return;
    if (conflict.mtimeNs === null || conflict.size === null) {
      // 载荷缺当前值（畸形 409）：无法构造覆盖前置，退回重载全量重建期望值
      reloadFromServer();
      return;
    }
    setStatus("saving");
    try {
      const receipt = await onSave(handle.getText(), { mtimeNs: conflict.mtimeNs, size: conflict.size });
      expectedRef.current = { mtimeNs: receipt.mtimeNs, size: receipt.size };
      setStatus("saved");
      dirtyRef.current = false;
      setDirty(false);
      setConflict(null);
    } catch (err) {
      setStatus("failed");
      if (err instanceof FileConflictError) {
        // 覆盖本身再撞并发：弹窗停留在新载荷上（当前值滚动，可再选）
        setConflict({ mtimeNs: err.current.mtimeNs, size: err.current.size });
        return;
      }
      setConflict(null);
    }
  };

  const back = () => {
    if (dirtyRef.current) {
      // 脏态确认放行后清脏标记再交宿主 onBack（files.tsx leaveEdit 内 guardDirty
      // 复读同一 ref，不重复弹窗）；取消则停留原地
      if (!window.confirm(tSnap("files.edit.confirmLeave"))) return;
      dirtyRef.current = false;
    }
    onBack();
  };

  const t = useT();

  return (
    <div data-testid="file-editor" className="flex min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2 border-b pb-2">
        <button
          type="button"
          data-testid="file-editor-back"
          aria-label={t("files.edit.backAria")}
          title={t("files.edit.backAria")}
          onClick={back}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span data-testid="file-editor-path" className="truncate font-mono text-xs" title={path}>
            {path}
          </span>
          {dirty && (
            <span data-testid="file-editor-dirty" className="text-xs text-amber-600 dark:text-amber-400">
              {t("files.edit.dirtyMarker")}
            </span>
          )}
        </div>
        <button
          type="button"
          data-testid="file-editor-save"
          onClick={triggerSave}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs text-primary-foreground transition-colors hover:bg-primary/80"
        >
          <Save className="size-4" aria-hidden />
          {t("files.edit.saveButton")}
        </button>
      </div>

      {status !== "idle" && (
        <div
          data-testid="file-editor-status"
          data-status={status}
          role="status"
          className={`rounded-lg px-3 py-1.5 text-xs ${
            status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted/40 text-muted-foreground"
          }`}
        >
          {t(STATUS_KEY[status])}
        </div>
      )}

      {state.kind === "loading" && (
        <div className="flex h-24 items-center justify-center text-muted-foreground">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      )}
      {state.kind === "error" && (
        <div data-testid="file-editor-error" className="flex flex-col items-start gap-1 p-3 text-sm">
          <span className="flex items-center gap-1.5 text-destructive">
            <FileWarning className="size-4" />
            {t("files.edit.loadFailed")}
          </span>
          <span className="text-xs text-muted-foreground">{state.message}</span>
        </div>
      )}
      {state.kind === "ready" && (
        <>
          {!isEditableFile(state.data) ? (
            <div data-testid="file-editor-ineligible" className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
              <FileWarning className="size-8 text-muted-foreground/40" />
              {t(editBlockReasonKey(state.data))}
            </div>
          ) : (
            <div
              ref={hostRef}
              data-testid="file-editor-host"
              className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/20 text-sm"
            />
          )}
        </>
      )}
      {conflict && (
        <SaveConflictDialog
          busy={status === "saving"}
          onReload={reloadFromServer}
          onOverwrite={overwriteServerFile}
          onDismiss={dismissConflict}
        />
      )}
    </div>
  );
}
