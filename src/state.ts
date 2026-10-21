// src/state.ts — V2 插件共享状态（setup 闭包），纯类型 + 容器，不 import 宿主包
import type { CodeBuddyConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { LRUMap } from "./lru.js";
import type { DiscoveryCache, RemoteModel } from "./models.js";

export interface RequestSnapshot {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface PluginState {
  cfg: CodeBuddyConfig;
  logger: Logger;
  /** live 引用：provider 注册时可能被 configuredBase 覆写 */
  server: { url: string; domain: string };
  conversationIds: LRUMap<string, string>;
  discoveryCache: DiscoveryCache;
  discovered: RemoteModel[] | null;
  /**
   * 凭证代次：每次 credential.switched / credential.updated 递增。
   * load() 在 await 前捕获、await 后比对，过期结果（旧账号的慢请求）整体丢弃，
   * 防止 A 的在途发现覆盖 B 的目录。
   */
  epoch: number;
  /**
   * 11133 重发快照，key = X-Request-Trace-Id。
   * 生命周期仅覆盖「请求发出 → 响应处理结束」：handleHttpResponse 的每条终点路径都显式 delete，
   * 不在响应结束后常驻（快照含完整 body 与 Authorization）。LRU 上限只是泄漏兜底。
   */
  requestSnapshots: LRUMap<string, RequestSnapshot>;
}
