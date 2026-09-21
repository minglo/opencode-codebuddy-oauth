// src/requests.ts — V2 session hooks + 事件订阅
import type { Plugin } from "@opencode/plugin";
import { buildRequestHeaders, buildAuthHeaders } from "./headers.js";
import { resolveIdentity, decodeJwtPayload } from "./jwt.js";
import { PROVIDER_ID } from "./config.js";
import { resolveCredential } from "./credentials.js";
import type { PluginState, RequestSnapshot } from "./state.js";

type AnyEvent = any;

export async function registerRequests(ctx: Plugin.Context, state: PluginState): Promise<() => void> {
  const hooks = buildHooks(ctx, state);
  await ctx.session.hook("http.request", hooks.onRequest, { providerID: PROVIDER_ID });
  return () => {};
}

/** 供测试与非注册路径复用 */
export function buildHooks(ctx: Plugin.Context, state: PluginState) {
  return {
    onRequest: (event: AnyEvent) => handleHttpRequest(ctx, event, state),
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
