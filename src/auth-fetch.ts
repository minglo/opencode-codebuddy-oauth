// src/auth-fetch.ts
import type { AuthState } from "./auth-state.js";
import { needsRefresh } from "./auth-state.js";
import { DEFAULT_EXPIRES_MS } from "./config.js";
import type { Logger } from "./log.js";
export type AuthFetchDeps = {
  getAuth: () => Promise<unknown>;
  client: { auth: { set: (args: unknown) => Promise<void> } };
  server: { url: string; domain: string };
  buildAuthHeaders: (auth: AuthState, identity: { tenantId:string; enterpriseId:string; userId:string }) => Record<string,string>;
  resolveIdentity: (payload: unknown, cfg: unknown) => { tenantId:string; enterpriseId:string; userId:string };
  decodeJwtPayload: (token:string) => unknown;
  createSSEBufferedStream: (body: ReadableStream<Uint8Array>, opts: { threshold:number; maxDelayMs:number }) => ReadableStream<Uint8Array>;
  refreshLock: { run: <T>(key:string, fn:()=>Promise<T>)=>Promise<T> };
  cfg: { sse: { enabled:boolean; threshold:number; maxDelayMs:number } };
  fetchImpl?: typeof fetch;
  logger?: Logger;
  effectiveAuth: (stored: unknown) => AuthState | null;
  pickAuthMode: (stored: unknown) => "api"|"oauth";
  refreshAccessToken: (refresh:string, serverUrl:string) => Promise<{ accessToken:string; refreshToken?:string; expiresIn?:number } | null>;
  chatCompletionsPath: string;  // CHAT_COMPLETIONS_PATH 单一来源，禁止硬拼 "/v2/chat/completions"
};
export function createAuthFetch(deps: AuthFetchDeps) {
  const { getAuth, client, server, buildAuthHeaders, resolveIdentity, decodeJwtPayload, createSSEBufferedStream, refreshLock, cfg, fetchImpl, chatCompletionsPath } = deps;
  const doFetch = () => fetchImpl ?? globalThis.fetch;
  const logError = (e: unknown) => deps.logger ? deps.logger.error(`auth.json write-back failed: ${(e as Error).message}`) : console.error(`[codebuddy] error: auth.json write-back failed:`, e);
  let lastRefreshFailedAt = 0;
  const COOLDOWN_MS = 15_000;
  const inCooldown = () => Date.now() - lastRefreshFailedAt < COOLDOWN_MS;
  const applyRefresh = async (prev: AuthState & { type:"oauth" }, refreshed: { accessToken:string; refreshToken?:string; expiresIn?:number }): Promise<AuthState> => {
    const newExpires = refreshed.expiresIn ? Date.now() + refreshed.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS;
    const nextState = { type: "oauth" as const, access: refreshed.accessToken, refresh: refreshed.refreshToken || prev.refresh, expires: newExpires };
    const writeBody = { ...nextState };  // C6 共用来源：持久化 body 与 activeAuth 同源，字段不各自构造
    try { await client.auth.set({ path: { id: "codebuddy" }, body: writeBody }); } catch (e) { logError(e); }
    return nextState;
  };
  // 预刷新/401 兜底共用：RefreshLock 单飞 + 写回收进 lock，失败记录冷却
  const tryRefresh = async (oauthAuth: AuthState & { type:"oauth" }): Promise<AuthState | null> => {
    return refreshLock.run("codebuddy", async () => {
      const r = await deps.refreshAccessToken(oauthAuth.refresh, server.url);
      if (r?.accessToken) return await applyRefresh(oauthAuth, r);
      lastRefreshFailedAt = Date.now();
      return null;
    });
  };
  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    // 单一来源：判定与拼接共用 chatCompletionsPath，不硬编码路径
    if (!urlStr.includes(chatCompletionsPath)) return doFetch()(url, init);
    const stored = await getAuth();
    const auth = deps.effectiveAuth(stored);
    if (!auth) {
      const mode = deps.pickAuthMode(stored);
      throw new Error(mode === "api" ? "codebuddy: missing API key — set CODEBUDDY_API_KEY env or run `/connect codebuddy`" : "codebuddy: missing oauth access token — run `/connect codebuddy` to log in");
    }
    if (!init?.body) return new Response(JSON.stringify({ error: "Missing request body" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const doRequest = async (a: AuthState) => {
      const headers = new Headers(init.headers as HeadersInit);
      const identity = a.type === "oauth" ? resolveIdentity(decodeJwtPayload(a.access), cfg) : { tenantId:"", enterpriseId:"", userId:"" };
      for (const [k,v] of Object.entries(buildAuthHeaders(a, identity as any))) headers.set(k, v);
      let body: BodyInit | null | undefined = init.body as BodyInit;
      // 仅处理字符串 JSON body（opencode 实际场景）；其他类型（Stream/FormData/Blob）跳过解析直接透传
      if (typeof body === "string") {
        try {
          const parsed = JSON.parse(body);
          if (parsed.stream === true && !parsed.stream_options) { parsed.stream_options = { include_usage: true }; body = JSON.stringify(parsed); }
        } catch {}
      }
      return doFetch()(`${server.url}${chatCompletionsPath}`, { method: "POST", headers, body: body as BodyInit, signal: init.signal });
    };
    let activeAuth: AuthState = auth;
    // A4 预刷新：过期前 REFRESH_SKEW_MS 内先刷新（RefreshLock 单飞，避免并发），失败则沿用旧 token；失败后 15s 冷却期内不再试
    // 写回收进 lock 内部，并发请求共享同一 refresh + 单次 client.auth.set，避免幂等双写
    if (activeAuth.type === "oauth" && activeAuth.refresh && needsRefresh(activeAuth, Date.now()) && !inCooldown()) {
      const next = await tryRefresh(activeAuth);
      if (next) activeAuth = next;
    }
    let response = await doRequest(activeAuth);
    if (activeAuth.type === "oauth" && (response.status === 401 || response.status === 403) && activeAuth.refresh && !inCooldown()) {
      // 401/403 兜底：RefreshLock 单例 + 冷却期内跳过；写回收进 lock 单次执行
      const next = await tryRefresh(activeAuth);
      if (next) {
        activeAuth = next;
        response = await doRequest(activeAuth);
      }
    }
    if (!response.ok) {
      const text = await response.text();
      const h = new Headers(response.headers);
      h.set("Content-Type", "application/json");
      return new Response(text, { status: response.status, headers: h });
    }
    if (cfg.sse.enabled && response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
      const buffered = createSSEBufferedStream(response.body as ReadableStream<Uint8Array>, { threshold: cfg.sse.threshold, maxDelayMs: cfg.sse.maxDelayMs });
      return new Response(buffered as unknown as BodyInit, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return response;
  };
}