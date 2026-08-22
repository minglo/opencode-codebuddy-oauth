// src/index.ts — 薄胶水，禁止模块级 let
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import * as fs from "fs";
import { getConfig, resolveServerUrl, getAuthJsonPath, domainForHost, PROVIDER_ID, CHAT_COMPLETIONS_PATH, DEFAULT_EXPIRES_MS, DISCOVERY_CACHE_TTL_MS, POLL_TOTAL_TIMEOUT_MS } from "./config.js";
import { createLogger } from "./log.js";
import { LRUMap } from "./lru.js";
import { parseStoredAuth, effectiveAuth, pickAuthMode } from "./auth-state.js";
import { DiscoveryCache, DEFAULT_MODEL, mergeModelEntry, remoteModelToConfig, fetchRemoteModels } from "./models.js";
import { createAuthFetch } from "./auth-fetch.js";
import { buildRequestHeaders, resolveModel, buildAuthHeaders } from "./headers.js";
import { resolveIdentity, decodeJwtPayload } from "./jwt.js";
import { createSSEBufferedStream } from "./sse-buffer.js";
import { refreshAccessToken, requestAuthState, pollForToken, RefreshLock } from "./auth-flow.js";

export const CodeBuddyAuthPlugin: Plugin = async (input: PluginInput) => {
  const cfg = getConfig();
  let server = resolveServerUrl(cfg);          // 闭包 let：config hook 内 baseURL 兜底覆写
  const conversationIds = new LRUMap<string,string>(cfg.conversationMapMax);
  const logger = createLogger(input.client as any);
  const refreshLock = new RefreshLock();
  const discoveryCache = new DiscoveryCache({
    ttlMs: DISCOVERY_CACHE_TTL_MS,
    // fetchFn 闭包捕获 live server（let）：config hook 覆写 baseURL 后 discovery 与 loader 打同一 host
    fetchFn: (token, signal) => fetchRemoteModels(token, server, signal),
  });

  return {
    async config(config: any) {
      // baseURL 兜底覆写（设计 5.1 优先级链：ENDPOINT > NETWORK > baseURL > 默认）
      // 仅当 ENDPOINT 未设置且 NETWORK 缺省（internal）时才用 provider.options.baseURL 覆写 server
      // （NETWORK=internet/ioa 时 NETWORK 优先于 baseURL，不覆写；NETWORK 缺省即 internal，无法区分显式设置）
      const opts = (config.provider?.[PROVIDER_ID]?.options || {}) as Record<string, unknown>;
      const configuredBase = typeof opts.baseURL === "string" ? opts.baseURL : undefined;
      if (!cfg.endpoint && cfg.network === "internal") {
        if (configuredBase) {
          try {
            const u = new URL(configuredBase);
            server = { url: `${u.protocol}//${u.host}`, domain: domainForHost(u.host) };
          } catch {}
        }
      }
      if (!config.provider) config.provider = {};
      if (!config.provider[PROVIDER_ID]) {
        config.provider[PROVIDER_ID] = {
          npm: "@ai-sdk/openai-compatible",
          name: "CodeBuddy",
          options: { baseURL: `${server.url}/v2`, setCacheKey: true },
          models: {},
        };
      }
      const provider = config.provider[PROVIDER_ID] as Record<string, unknown>;
      if (!provider.options) provider.options = {};
      const popts = provider.options as Record<string, unknown>;
      // env 优先（或 baseURL 反向覆写后）同步 options.baseURL，AI SDK 请求路径单一来源
      popts.baseURL = `${server.url}/v2`;
      if (!provider.models) provider.models = {};
      const models = provider.models as Record<string, unknown>;

      // auth.json 容错（fs.promises，D1）
      let stored: unknown;
      try {
        const raw = await fs.promises.readFile(getAuthJsonPath(), "utf8");
        const all = JSON.parse(raw) as Record<string, unknown>;
        stored = parseStoredAuth(all[PROVIDER_ID]);
      } catch (e) {
        logger.warn(`auth.json read failed: ${(e as Error).message}`);
      }

      // A2：api 模式无 key 打警告而非静默 fallback
      const mode = pickAuthMode(cfg, stored as any);
      if (mode === "api" && !cfg.apiKey && !(stored && (stored as any).type === "api" && (stored as any).key)) {
        logger.warn("api key mode requested but no key found — set CODEBUDDY_API_KEY env or run `/connect codebuddy`");
      }

      // discovery：惰性 TTL + 单飞（DiscoveryCache），401/403 原样抛（走刷新提示），网络/5xx 降级
      let discovered: any[] = [];
      let authExpired = false;
      if (mode === "api") {
        discovered = [];
        logger.info("api key mode — using models from opencode.json config");
      } else if (stored && (stored as any).type === "oauth" && (stored as any).access) {
        try {
          discovered = await discoveryCache.get((stored as any).access, { signal: undefined });
        } catch (e) {
          const status = (e as any)?.status;
          if (status === 401 || status === 403) {
            logger.warn(`discovery 401/403 — auth may be expired, run \`/connect codebuddy\` to re-authenticate`);
            // 设计 5.9：401/403 不进缓存降级 DEFAULT_MODEL，走提示重连
            authExpired = true;
          } else {
            logger.warn(`discovery failed: ${(e as Error).message}`);
          }
          discovered = [];
        }
      }
      if (discovered.length === 0 && Object.keys(models).length === 0 && !authExpired) discovered = [DEFAULT_MODEL];
      for (const m of discovered) {
        const auto = remoteModelToConfig(m);
        const existing = models[m.id] as Record<string, unknown> | undefined;
        models[m.id] = existing ? mergeModelEntry(auto, existing) : auto;
      }
      return config;
    },
    async event({ event }: any) {
      if (event.type === "session.compacted") {
        const sid = event.properties?.sessionID;
        if (sid) conversationIds.delete(sid);
      } else if (event.type === "session.deleted") {
        const sid = event.properties?.info?.id;
        if (sid) conversationIds.delete(sid);
      }
    },
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth: any) {
        return {
          apiKey: "cli-proxy",
          baseURL: server.url,
          fetch: createAuthFetch({
            getAuth, client: input.client as any, server,
            buildAuthHeaders: buildAuthHeaders as any,
            resolveIdentity: resolveIdentity as any,
            decodeJwtPayload: decodeJwtPayload as any,
            createSSEBufferedStream: createSSEBufferedStream as any,
            refreshLock, cfg: cfg as any, logger,
            effectiveAuth: ((stored: unknown) => effectiveAuth(stored as any, cfg as any)) as any,
            pickAuthMode: ((stored: unknown) => pickAuthMode(cfg, stored as any)) as any,
            refreshAccessToken,
            chatCompletionsPath: CHAT_COMPLETIONS_PATH,     // 单一来源，不硬拼
          }),
        };
      },
      methods: [
        { label: "IOA 登录 (浏览器)", type: "oauth" as const, async authorize() {
          const state = await requestAuthState(server.url);
          const expiresAt = Date.now() + POLL_TOTAL_TIMEOUT_MS;
          return { url: state.url, instructions: "请在浏览器中完成 IOA 登录", method: "auto" as const,
            async callback() {
              const tok = await pollForToken(server.url, state.state, expiresAt);
              if (!tok) return { type:"failed" as const };
              return { type:"success" as const, access: tok.accessToken, refresh: tok.refreshToken || "", expires: tok.expiresIn ? Date.now()+tok.expiresIn*1000 : Date.now()+DEFAULT_EXPIRES_MS };
            } };
        }},
        { label: "API Key 登录", type: "api" as const, prompts:[{ type:"text", key:"key", message:"请输入 CodeBuddy API Key（ck_xxx）", placeholder:"ck_xxxxxxxxxxxxxxxx.xxxxx" }], async authorize(inputs: any) {
          const key = inputs?.key?.trim(); if (!key) return { type:"failed" as const }; return { type:"success" as const, key }; } },
      ],
    },
    async "chat.headers"(input: any, output: any) {
      if (input.model.providerID !== PROVIDER_ID) return;
      const modelId = resolveModel(input.model.id, cfg as any);
      const headers = buildRequestHeaders(input.sessionID, modelId, { cfg: cfg as any, server, lru: conversationIds });
      for (const [k,v] of Object.entries(headers)) output.headers[k]=v;
    },
  } as any;
};

export default { id: "codebuddy-plugin", server: CodeBuddyAuthPlugin };