// 英文目录聚合：satisfies 锁定与 zh 完全相同的键集（值可不同，键不可增删）。
// 各域拆分至 en/ 目录下独立文件；此处仅组装，键形状与拆分前一致。
import type { MessageCatalogShape } from "./i18n";
import { common } from "./en/common";
import { login } from "./en/login";
import { shortcuts } from "./en/shortcuts";
import { chat } from "./en/chat";
import { composer } from "./en/composer";
import { sessionList } from "./en/sessionList";
import { notes } from "./en/notes";
import { diff } from "./en/diff";
import { fileTree } from "./en/fileTree";
import { schedule } from "./en/schedule";
import { errors } from "./en/errors";

export const en = {
  common,
  login,
  shortcuts,
  chat,
  composer,
  sessionList,
  notes,
  diff,
  fileTree,
  schedule,
  errors,
} satisfies MessageCatalogShape;
