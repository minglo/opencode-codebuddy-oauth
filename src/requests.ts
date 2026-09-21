// src/requests.ts — V2 session hooks + 事件订阅
import type { Plugin } from "@opencode/plugin";
import type { SessionHooks } from "@opencode/plugin/promise/session";
import { buildRequestHeaders, buildAuthHeaders } from "./headers.js";
import { resolveIdentity, decodeJwtPayload } from "./jwt.js";
import { PROVIDER_ID } from "./config.js";
import { resolveCredential } from "./credentials.js";
import { createSSEBufferedStream } from "./sse-buffer.js";
import { sleep } from "./auth-flow.js";
import type { PluginState, RequestSnapshot } from "./state.js";

type AnyEvent = any;
type HttpRequestEvent = SessionHooks["http.request"];
type HttpResponseEvent = SessionHooks["http.response"];
type RetryEvent = SessionHooks["retry"];

export async function registerRequests(ctx: Plugin.Context, state: PluginState): Promise<() => void> {
  const hooks = buildHooks(ctx, state);
  const registrations: Array<{ dispose: () => Promise<void> }> = [];
  registrations.push(await ctx.session.hook("http.request", hooks.onRequest, { providerID: PROVIDER_ID }));
  registrations.push(await ctx.session.hook("http.response", hooks.onResponse, { providerID: PROVIDER_ID }));
  registrations.push(await ctx.session.hook("retry", (event: RetryEvent) => {
    state.logger.warn(
      `codebuddy retry observed: type=${event.error.type} status=${event.error.status} attempt=${event.attempt}`,
    );
  }, { providerID: PROVIDER_ID }));

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const e = event as AnyEvent;
        if (e?.type === "session.compacted" || e?.type === "session.deleted") {
          const sid = e?.data?.sessionID;
          if (sid) state.conversationIds.delete(sid);
        }
      }
    } catch { /* abort 或流结束 */ }
  })();

  return () => {
    controller.abort();
    for (const r of registrations) void r.dispose();
  };
}

/** 供测试与非注册路径复用 */
export function buildHooks(ctx: Plugin.Context, state: PluginState) {
  return {
    onRequest: (event: HttpRequestEvent) => handleHttpRequest(ctx, event, state),
    onResponse: (event: HttpResponseEvent) => handleHttpResponse(event, state),
  };
}

async function handleHttpRequest(ctx: Plugin.Context, event: HttpRequestEvent, state: PluginState): Promise<void> {
  const headers: Headers = event.request.headers;

  const credential = await resolveCredential(ctx, state);
  if (credential) {
    const identity = credential.type === "oauth"
      ? resolveIdentity(decodeJwtPayload(credential.access ?? ""), state.cfg)
      : { tenantId: "", enterpriseId: "", userId: "" };
    const authHeaders = buildAuthHeaders(
      credential.type === "oauth"
        ? { type: "oauth", access: credential.access ?? "", refresh: credential.refresh ?? "", expires: credential.expires ?? 0 }
        : { type: "api", key: credential.key ?? "" },
      identity as any,
    );
    for (const [k, v] of Object.entries(authHeaders)) headers.set(k, v);
  } else {
    state.logger.warn("codebuddy: 无凭证，跳过鉴权头注入（请 /connect codebuddy）");
  }

  const reqHeaders = buildRequestHeaders(event.sessionID, event.model.id, {
    cfg: state.cfg, server: state.server, lru: state.conversationIds,
  });
  for (const [k, v] of Object.entries(reqHeaders)) {
    // Review Focus #2：不改写请求已有的 content-type（FormData boundary 等编码在头里）
    if (k.toLowerCase() === "content-type" && headers.has("content-type")) continue;
    headers.set(k, v);
  }

  let bodyText: string | undefined;
  let bodyReadFailed = false;
  try { bodyText = await event.request.clone().text(); } catch { bodyText = undefined; bodyReadFailed = true; }

  let nextBody: string | undefined;
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      let changed = false;
      if (parsed?.stream === true && !parsed.stream_options) {
        parsed.stream_options = { include_usage: true };
        changed = true;
      }
      if (Array.isArray(parsed?.messages)) {
        for (const m of parsed.messages) {
          if (m?.role === "assistant" && m.reasoning_content === undefined) {
            m.reasoning_content = "";
            changed = true;
          }
        }
      }
      if (changed) nextBody = JSON.stringify(parsed);
    } catch { /* 非 JSON：原样透传 */ }
  }

  if (nextBody !== undefined) {
    event.request = new Request(event.request, { body: nextBody, duplex: "half" } as RequestInit);
  }

  const traceId = headers.get("X-Request-Trace-Id");
  if (traceId && !bodyReadFailed) {
    // body 不可读时不写快照，11133 将走"无快照 → 原样返回"安全路径（M2）
    const snapshot: RequestSnapshot = {
      url: event.request.url,
      method: event.request.method,
      headers: Object.fromEntries(headers.entries()),
      body: nextBody ?? bodyText ?? "",
    };
    state.requestSnapshots.set(traceId, snapshot);
  }
}

const RETRY_DELAYS_MS = [1000, 4000, 10000, 25000];
const RETRY_TIMEOUT_MS = 30_000;

function withSseBuffer(response: Response, state: PluginState): Response {
  const { sse } = state.cfg;
  if (!sse.enabled || !response.body) return response;
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const buffered = createSSEBufferedStream(response.body as ReadableStream<Uint8Array>, {
    threshold: sse.threshold, maxDelayMs: sse.maxDelayMs,
  });
  return new Response(buffered as unknown as BodyInit, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

async function handleHttpResponse(event: HttpResponseEvent, state: PluginState): Promise<void> {
  const response: Response = event.response;

  if (response.status === 400) {
    let text: string | undefined;
    try { text = await response.clone().text(); } catch { text = undefined; }
    if (text !== undefined) {
      let code: unknown;
      try { code = (JSON.parse(text) as any)?.code; } catch { /* 非 JSON */ }

      if (code === 11133) {
        const traceId = event.request.headers.get("X-Request-Trace-Id");
        const snapshot = traceId ? state.requestSnapshots.get(traceId) : undefined;
        if (!snapshot) {
          state.logger.warn("codebuddy: 11133 但无请求快照，原样返回");
          return;
        }        const signal: AbortSignal = event.request.signal;
        const retrySignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(RETRY_TIMEOUT_MS)])
          : AbortSignal.timeout(RETRY_TIMEOUT_MS);
        let last: Response = response;
        for (const delay of RETRY_DELAYS_MS) {
          if (retrySignal.aborted) { event.response = response; return; }
          await sleep(delay);
          if (retrySignal.aborted) { event.response = response; return; }
          let retryRes: Response;
          try {
            retryRes = await fetch(snapshot.url, {
              method: snapshot.method, headers: snapshot.headers, body: snapshot.body, signal: retrySignal,
            });
          } catch {
            state.logger.warn("codebuddy: 11133 重发失败（网络错误或超时），回退原响应");
            event.response = response;
            return;
          }
          if (retryRes.ok) {
            event.response = withSseBuffer(retryRes, state);
            return;
          }
          last = retryRes;
          const retryText = await retryRes.clone().text();
          let retryCode: unknown;
          try { retryCode = (JSON.parse(retryText) as any)?.code; } catch { /* 非 JSON */ }
          if (retryCode !== 11133) break;
        }
        event.response = last;
        return;
      }
      // 非 11133 的 400：clone 读取不破坏原响应，原样返回（M1）
      event.response = response;
      return;
    }
  }

  event.response = withSseBuffer(response, state);
}
