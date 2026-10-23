// 源语言字典（zh-CN）聚合：唯一事实来源，其他语言用 satisfies 锁定相同键集。
// 各域拆分至 zh/ 目录下独立文件，便于按域并行编辑；此处仅组装，键形状与拆分前一致。
import { common } from "./zh/common";
import { login } from "./zh/login";
import { shortcuts } from "./zh/shortcuts";
import { chat } from "./zh/chat";
import { composer } from "./zh/composer";
import { sessionList } from "./zh/sessionList";
import { notes } from "./zh/notes";
import { diff } from "./zh/diff";
import { fileTree } from "./zh/fileTree";
import { schedule } from "./zh/schedule";
import { extensions } from "./zh/extensions";
import { models } from "./zh/models";
import { stats } from "./zh/stats";
import { errors } from "./zh/errors";

export const zh = {
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
  extensions,
  models,
  stats,
  errors,
} as const;
