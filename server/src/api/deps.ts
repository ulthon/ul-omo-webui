// REST 路由依赖注入面（todo 9）
import type { MetaDb } from "../db/meta";
import type { EngineGateway } from "./engine-runtime";
import type { ProjectConfigStores } from "./config-migration";
import type { ConfigStore } from "../conf/config-store";

export interface ApiDeps {
  meta: MetaDb;
  engines: EngineGateway;
  /**
   * 配置存储（todo 4）：组合根 openConfigStore()（无参，全局目录取
   * UL_OMO_WEBUI_CONFIG_DIR / ~/.config/ul-omo-webui/）注入。仅常用语/标签
   * 配置面路由要求——工厂以 ApiDeps & { configs: ConfigStore } 收紧类型，
   * 其余路由与既有测试装配不受影响。
   */
  configs?: ConfigStore;
  /**
   * 按项目根解析的项目配置 store（todo 6）：组合根 createProjectConfigStores(configs)
   * 创建一次全链共用（同项目写共用一条 promise 链）。routes-project 要求注入；
   * routes-session 缺省时模型缺省回退纯库读（部分测试装配的兼容形态）。
   */
  projectConfigs?: ProjectConfigStores;
  /**
   * schedule 会话删除钩子（docs08 任务 21c）：删除会话后把该会话 pending 定时
   * 任务标 invalid（abandoned 语义）。缺省时无操作（测试装配兼容）。
   */
  schedule?: { onSessionDeleted(sessionId: string): Promise<unknown> };
  /**
   * 附件临时区根（docs08-r3 任务 17）：缺省 DATA_DIR/attachments（api/attachments.ts）。
   * 测试注入临时目录，端点写入/校验/删除全部以它为界。
   */
  attachmentsRoot?: string;
}
