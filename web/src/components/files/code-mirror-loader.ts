// CodeMirror 6 动态加载器（builtin-file-management 任务 8）。
// 本体（codemirror 包）与语言包全部经本模块动态 import，不进首屏分包
// （vite 自动按动态 import 切 chunk）；组件只依赖本模块的 createEditor 契约，
// vitest 组件测试 mock 本模块，happy-dom 不真实加载编辑器。
import type { EditorView } from "codemirror";
import type { Extension } from "@codemirror/state";

export interface EditorHandle {
  destroy(): void;
  getText(): string;
}

let editorModPromise: Promise<typeof import("codemirror")> | null = null;

function editorMod(): Promise<typeof import("codemirror")> {
  return (editorModPromise ??= import("codemirror"));
}

/** 按扩展名动态加载语言包；不认识的扩展名/加载失败返回 null（纯文本编辑不阻断） */
async function loadLanguage(path: string): Promise<Extension | null> {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  try {
    switch (ext) {
      case "js":
      case "mjs":
      case "cjs":
        return (await import("@codemirror/lang-javascript")).javascript();
      case "jsx":
        return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
      case "ts":
      case "mts":
      case "cts":
        return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
      case "tsx":
        return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
      case "json":
        return (await import("@codemirror/lang-json")).json();
      case "md":
      case "markdown":
        return (await import("@codemirror/lang-markdown")).markdown();
      case "css":
        return (await import("@codemirror/lang-css")).css();
      case "html":
      case "htm":
        return (await import("@codemirror/lang-html")).html();
      case "py":
      case "pyw":
        return (await import("@codemirror/lang-python")).python();
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** 创建编辑器实例：语法高亮 + 行号（basicSetup 含行号/历史等基础面）；
 * docChanged 经 onDocChanged 上报（脏态契约：组件写宿主传入的 dirtyRef） */
export async function createEditor(
  host: HTMLElement,
  doc: string,
  path: string,
  onDocChanged: () => void,
): Promise<EditorHandle> {
  const { basicSetup, EditorView } = await editorMod();
  const language = await loadLanguage(path);
  const view: EditorView = new EditorView({
    doc,
    parent: host,
    extensions: [
      basicSetup,
      language ?? [],
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onDocChanged();
      }),
    ],
  });
  return {
    destroy: () => view.destroy(),
    getText: () => view.state.doc.toString(),
  };
}
