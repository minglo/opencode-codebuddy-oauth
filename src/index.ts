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
    // definite assignment：fetchFn 只在请求发生时读取 state.server（此时已赋值），
    // 闭包保证 provider 覆写 state.server 后同源（live）
    let state!: PluginState;
    const discoveryCache = new DiscoveryCache({
      ttlMs: DISCOVERY_CACHE_TTL_MS,
      fetchFn: (token, signal) => fetchRemoteModels(token, state.server, signal),
    });
    state = {
      cfg,
      logger: createLogger(),
      server: resolveServerUrl(cfg),
      conversationIds: new LRUMap<string, string>(cfg.conversationMapMax),
      discoveryCache,
      discovered: null,
      requestSnapshots: new LRUMap<string, RequestSnapshot>(32),
    };

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
