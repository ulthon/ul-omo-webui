// REST 路由依赖注入面（todo 9）
import type { MetaDb } from "../db/meta";
import type { EngineGateway } from "./engine-runtime";
import type { ConfigStore } from "../conf/config-store";

export interface ApiDeps {
  meta: MetaDb;
  engines: EngineGateway;
  /**
   * 配置存储（todo 4）：组合根 openConfigStore()（无参，全局目录取
   * SENPI_WEBUI_CONFIG_DIR / ~/.config/senpi-webui/）注入。仅常用语/标签
   * 配置面路由要求——工厂以 ApiDeps & { configs: ConfigStore } 收紧类型，
   * 其余路由与既有测试装配不受影响。
   */
  configs?: ConfigStore;
}
