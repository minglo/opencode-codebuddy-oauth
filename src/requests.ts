// src/requests.ts — V2 session hooks + 事件订阅
import type { Plugin } from "@opencode/plugin";
import { buildRequestHeaders, buildAuthHeaders } from "./headers.js";
import { resolveIdentity, decodeJwtPayload } from "./jwt.js";
import { PROVIDER_ID } from "./config.js";
import { resolveCredential } from "./credentials.js";
import { createSSEBufferedStream } from "./sse-buffer.js";
import { sleep } from "./auth-flow.js";
import type { PluginState, RequestSnapshot } from "./state.js";

type AnyEvent = any;

export async function registerRequests(ctx: Plugin.Context, state: PluginState): Promise<() => void> {
  const hooks = buildHooks(ctx, state);
  await ctx.session.hook("http.request", hooks.onRequest, { providerID: PROVIDER_ID });
  await ctx.session.hook("http.response", hooks.onResponse, { providerID: PROVIDER_ID });
  return () => {};
}

/** 供测试与非注册路径复用 */
export function buildHooks(ctx: Plugin.Context, state: PluginState) {
  return {
    onRequest: (event: AnyEvent) => handleHttpRequest(ctx, event, state),
    onResponse: (event: AnyEvent) => handleHttpResponse(event, state),
  };
}

async function handleHttpRequest(ctx: Plugin.Context, event: AnyEvent, state: PluginState): Promise<void> {
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

  const reqHeaders = buildRequestHeaders(event.sessionID, event.model?.id, {
    cfg: state.cfg, server: state.server, lru: state.conversationIds,
  });
  for (const [k, v] of Object.entries(reqHeaders)) headers.set(k, v);

  let bodyText: string | undefined;
  try { bodyText = await event.request.clone().text(); } catch { bodyText = undefined; }

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
  if (traceId) {
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

async function handleHttpResponse(event: AnyEvent, state: PluginState): Promise<void> {
  const response: Response = event.response;

  if (response.status === 400) {
    let text: string | undefined;
    try { text = await response.clone().text(); } catch { text = undefined; }
    if (text !== undefined) {
      let code: unknown;
      try { code = (JSON.parse(text) as any)?.code; } catch { /* 非 JSON */ }

      if (code === 11133) {
        const traceId = event.request?.headers?.get?.("X-Request-Trace-Id");
        const snapshot = traceId ? state.requestSnapshots.get(traceId) : undefined;
        if (!snapshot) {
          state.logger.warn("codebuddy: 11133 但无请求快照，原样返回");
          return;
        }
        let last: Response = response;
        for (const delay of RETRY_DELAYS_MS) {
          await sleep(delay);
          const retryRes = await fetch(snapshot.url, { method: snapshot.method, headers: snapshot.headers, body: snapshot.body });
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
    }
    if (text !== undefined) {
      const h = new Headers(response.headers);
      h.set("Content-Type", "application/json");
      event.response = new Response(text, { status: 400, headers: h });
      return;
    }
  }

  event.response = withSseBuffer(response, state);
}
