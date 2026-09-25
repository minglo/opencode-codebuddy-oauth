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
  /** 11133 重发快照，key = X-Request-Trace-Id */
  requestSnapshots: LRUMap<string, RequestSnapshot>;
}
