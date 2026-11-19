// 桌面拖放上传共享逻辑（files-ux-revamp 任务 10 / IS-7）：文件页与右栏文件面板共用。
// 宿主根容器挂 dragHandlers：dragenter/dragover 时 dataTransfer.types 含 "Files" 才
// 显示全屏覆盖层；dragleave 用深度计数守卫防子元素进出闪烁误隐；drop 收尾并分流。
// 目录条目（从系统文件管理器拖入文件夹，webkitGetAsEntry kind=directory）整批忽略，
// 由宿主上抛提示——不做递归上传（计划 Must NOT）。窄档/触屏不启用由宿主 enabled 保证。
import { useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";

export interface DropExtract {
  files: File[];
  /** 拖入项包含目录条目：整批忽略（宿主 toast） */
  hasDirEntry: boolean;
}

/** 同步抽取拖放数据：webkitGetAsEntry 的条目在任何 await 之后失效，必须同步调用 */
export function extractDropFiles(dt: DataTransfer | null): DropExtract {
  const files = Array.from(dt?.files ?? []);
  let hasDirEntry = false;
  const items = dt?.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const entry = (
        items[i] as DataTransferItem & { webkitGetAsEntry?: () => { kind?: string } | null }
      ).webkitGetAsEntry?.() as { kind?: string } | null | undefined;
      if (entry?.kind === "directory") {
        hasDirEntry = true;
        break;
      }
    }
  }
  return { files, hasDirEntry };
}

export interface DragDropUploadOptions {
  /** 窄档/触屏语义不启用（宿主按布局档保证） */
  enabled: boolean;
  /** 落点分流：dir 为 null 表示宿主默认目录（当前目录），非 null 为命中的目录行路径 */
  onDropFiles: (files: File[], dir: string | null) => void;
  /** 拖入包含目录条目时的提示回调（宿主 toast） */
  onDirUnsupported: () => void;
}

export function useDragDropUpload(options: DragDropUploadOptions) {
  const [showOverlay, setShowOverlay] = useState(false);
  // dragenter/dragleave 在子元素间穿梭会成对多发：深度计数保证只在真正离开容器时收尾
  const dragDepthRef = useRef(0);
  // 事件处理器身份稳定，经 ref 读最新回调（避免宿主闭包时序依赖）；副作用阶段同步，
  // 不在渲染期写 ref（oxlint set-state-in-render 族）；事件均在提交后触发，时序等价
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const carriesFiles = (e: ReactDragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (e: ReactDragEvent) => {
    if (!optionsRef.current.enabled || !carriesFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setShowOverlay(true);
  };
  const onDragOver = (e: ReactDragEvent) => {
    if (!optionsRef.current.enabled || !carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: ReactDragEvent) => {
    if (!optionsRef.current.enabled || !carriesFiles(e)) return;
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setShowOverlay(false);
    }
  };
  const onDrop = (e: ReactDragEvent) => {
    if (!optionsRef.current.enabled || !carriesFiles(e)) return;
    e.preventDefault();
    // 深度为 0 = 拖拽会话已结束（dragleave 已收尾）：忽略迟到/重复的 drop，不重复上传
    if (dragDepthRef.current <= 0) return;
    dragDepthRef.current = 0;
    setShowOverlay(false);
    const { files, hasDirEntry } = extractDropFiles(e.dataTransfer);
    if (hasDirEntry) {
      optionsRef.current.onDirUnsupported();
      return;
    }
    // 空拖放（如拖选非文件内容）：无上传无提示
    if (files.length === 0) return;
    optionsRef.current.onDropFiles(files, null);
  };

  /** 目录行 drop 命中后由宿主调用：行内 onDrop 会 stopPropagation，容器收尾逻辑不再执行 */
  const hideOverlay = () => {
    dragDepthRef.current = 0;
    setShowOverlay(false);
  };

  return { showOverlay, hideOverlay, dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
