// 草稿钩子（todo 21）：输入防抖 1s PUT /api/sessions/:id/draft；会话打开时 GET 回填；
// 保存失败写 localStorage 兜底（输入不丢），恢复优先服务端草稿、失败用本地。
// 竞态防护：回填仅在「输入框为空或非焦点」时进行——用户已经开始打字的内容
// 永不被异步到达的服务端草稿覆盖（canRestoreRef 由组件按最新状态判定）。
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api } from "@/lib/api";
import {
  DRAFT_DEBOUNCE_MS,
  clearLocalDraft,
  readLocalDraft,
  resolveDraftSource,
  writeLocalDraft,
} from "./composer-logic";

export function useDraft(sessionId: string, canRestoreRef: RefObject<() => boolean>) {
  const [text, setText] = useState("");
  /** 组件事件（keydown 等）需要同步读最新文本，绕开 setState 闭包过期 */
  const textRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 是否有未落库的修改（成功落库/清空后复位；卸载 flush 只在 dirty 时发 PUT） */
  const dirtyRef = useRef(false);

  const save = useCallback(
    async (content: string) => {
      try {
        await api.putDraft(sessionId, content);
        // 服务端已接住：本地兜底不再需要（保持「本地兜底 = 仅服务端保存失败期间存在」）
        clearLocalDraft(sessionId);
      } catch {
        // 保存失败输入不丢：localStorage 兜底，下次打开会话优先服务端、失败用本地
        writeLocalDraft(sessionId, content);
      } finally {
        dirtyRef.current = false;
      }
    },
    [sessionId],
  );

  const scheduleSave = useCallback(
    (content: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void save(content), DRAFT_DEBOUNCE_MS);
    },
    [save],
  );

  /** 输入入口：更新状态 + 标脏 + 防抖落库 */
  const update = useCallback(
    (content: string) => {
      textRef.current = content;
      dirtyRef.current = true;
      setText(content);
      scheduleSave(content);
    },
    [scheduleSave],
  );

  // 恢复（会话打开/切换/刷新后重挂载时执行一次）：服务端优先，失败用本地。
  // 回填受 canRestoreRef 竞态防护约束（见文件头注释）。
  useEffect(() => {
    let cancelled = false;
    const local = readLocalDraft(sessionId);
    const apply = (content: string, sync: boolean) => {
      if (cancelled || !content) return;
      // 竞态防护：仅输入框为空或非焦点时回填，绝不覆盖用户正在输入的内容
      if (!canRestoreRef.current()) return;
      textRef.current = content;
      setText(content);
      if (sync) scheduleSave(content); // 本地兜底内容异步补同步到服务端
    };
    api
      .getDraft(sessionId)
      .then((res) => {
        const resolved = resolveDraftSource(res.draft, local);
        // 本地兜底胜出（较新）时该内容尚未落服务端，恢复即补同步
        apply(resolved.content, resolved.source === "local");
      })
      .catch(() => {
        const localContent = local?.content ?? "";
        apply(localContent, Boolean(localContent)); // 服务端不可达 → 全靠本地兜底，恢复即补同步
      });
    return () => {
      cancelled = true;
    };
    // canRestoreRef 是 ref，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, scheduleSave]);

  // 卸载（切会话）兜底 flush：未落库的修改立即直发，失败落 localStorage
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (!dirtyRef.current) return;
      const pending = textRef.current;
      void api
        .putDraft(sessionId, pending)
        .then(() => clearLocalDraft(sessionId))
        .catch(() => writeLocalDraft(sessionId, pending));
    },
    [sessionId],
  );

  /** 发送成功后清空：组件状态、防抖定时、服务端草稿（空内容）与本地兜底一并清 */
  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    dirtyRef.current = false;
    textRef.current = "";
    setText("");
    clearLocalDraft(sessionId);
    void api.putDraft(sessionId, "").catch(() => {});
  }, [sessionId]);

  return { text, textRef, update, clear };
}
