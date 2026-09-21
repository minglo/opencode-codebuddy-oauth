// src/index.ts — V2 入口（薄胶水）
import { Plugin } from "@opencode/plugin";
import { getConfig, resolveServerUrl, DISCOVERY_CACHE_TTL_MS } from "./config.js";
import { createLogger } from "./log.js";
import { LRUMap } from "./lru.js";
import { DiscoveryCache, fetchRemoteModels } from "./models.js";
import type { PluginState, RequestSnapshot } from "./state.js";
import { registerIntegration } from "./integration.js";
import { registerProvider } from "./provider.js";
import { registerRequests } from "./requests.js";

export default Plugin.define({
  id: "codebuddy",
  async setup(ctx) {
    const cfg = getConfig();
    const state: PluginState = {
      cfg,
      logger: createLogger(),
      server: resolveServerUrl(cfg),
      conversationIds: new LRUMap<string, string>(cfg.conversationMapMax),
      discoveryCache: null as unknown as DiscoveryCache,
      discovered: null,
      requestSnapshots: new LRUMap<string, RequestSnapshot>(32),
    };
    // fetchFn 闭包读 state.server 属性（live），provider 覆写后同源
    state.discoveryCache = new DiscoveryCache({
      ttlMs: DISCOVERY_CACHE_TTL_MS,
      fetchFn: (token, signal) => fetchRemoteModels(token, state.server, signal),
    });

    const cleanups: Array<() => void> = [];
    const domain = async (name: string, fn: () => Promise<void | (() => void)>) => {
      try {
        const c = await fn();
        if (typeof c === "function") cleanups.push(c);
      } catch (e) {
        console.error(`[codebuddy] ${name} 注册失败:`, e);
      }
    };
    await domain("integration", () => registerIntegration(ctx, state));
    await domain("provider", () => registerProvider(ctx, state));
    await domain("requests", () => registerRequests(ctx, state));
    return () => { for (const c of cleanups) c(); };
  },
});
