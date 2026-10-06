// REST 路由依赖注入面（todo 9）
import type { MetaDb } from "../db/meta";
import type { EngineGateway } from "./engine-runtime";

export interface ApiDeps {
  meta: MetaDb;
  engines: EngineGateway;
}
