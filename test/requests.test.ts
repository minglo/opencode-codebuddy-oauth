import { describe, it, expect, afterEach, vi } from "vitest";
import { registerRequests } from "../src/requests.js";
import { createMockCtx, makeTestState } from "./helpers/mock-ctx.js";

const b64url = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const fakeJwt = `${b64url({ alg: "none" })}.${b64url({ tenant_id: "t1", enterprise_id: "e1", user_id: "u1" })}.x`;

function chatRequest(body: unknown) {
  return new Request("https://copilot.tencent.com/v2/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("http.request", () => {
  it("api key 凭证注入双头 + CodeBuddy 头 + conversation 稳定", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "ck_test" } });
    const state = makeTestState();
    await registerRequests(ctx, state);

    const e1: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ stream: false, messages: [] }) };
    await triggerHook("http.request", e1);
    expect(e1.request.headers.get("Authorization")).toBe("Bearer ck_test");
    expect(e1.request.headers.get("X-API-Key")).toBe("ck_test");
    expect(e1.request.headers.get("X-Agent-Intent")).toBeTruthy();
    expect(e1.request.headers.get("X-Conversation-ID")).toBeTruthy();

    const e2: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ stream: false, messages: [] }) };
    await triggerHook("http.request", e2);
    expect(e2.request.headers.get("X-Conversation-ID")).toBe(e1.request.headers.get("X-Conversation-ID"));
  });

  it("oauth 凭证从 JWT 解析 identity 注入租户头", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "oauth", access: fakeJwt, refresh: "r", expires: Date.now() + 3600_000 } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s2", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ stream: false, messages: [] }) };
    await triggerHook("http.request", e);
    expect(e.request.headers.get("Authorization")).toBe(`Bearer ${fakeJwt}`);
    expect(e.request.headers.get("X-Tenant-Id")).toBe("t1");
    expect(e.request.headers.get("X-Enterprise-Id")).toBe("e1");
    expect(e.request.headers.get("X-User-Id")).toBe("u1");
  });

  it("stream:true 注入 stream_options，assistant 补 reasoning_content", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s3", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: chatRequest({ stream: true, messages: [{ role: "assistant", content: "hi" }, { role: "user", content: "yo" }] }) };
    await triggerHook("http.request", e);
    const body = JSON.parse(await e.request.text());
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[0].reasoning_content).toBe("");
    expect(body.messages[1].reasoning_content).toBeUndefined();
  });

  it("非 JSON body 原样透传且不抛", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s4", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x/v2/chat/completions", { method: "POST", headers: { "content-type": "text/plain" }, body: "not json" }) };
    await triggerHook("http.request", e);
    expect(await e.request.text()).toBe("not json");
  });

  it("无 body 的 GET 请求不抛且仍注入头", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s5", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x/v2/models") };
    await triggerHook("http.request", e);
    expect(e.request.headers.get("Authorization")).toBe("Bearer k");
  });

  it("凭证缺失时不抛、不注鉴权头", async () => {
    const { ctx, triggerHook } = createMockCtx();
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s6", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ messages: [] }) };
    await expect(triggerHook("http.request", e)).resolves.toBeUndefined();
    expect(e.request.headers.get("Authorization")).toBeNull();
  });

  it("写入请求快照（key = X-Request-Trace-Id）", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s7", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ stream: true, messages: [] }) };
    await triggerHook("http.request", e);
    const traceId = e.request.headers.get("X-Request-Trace-Id");
    const snap = state.requestSnapshots.get(traceId!);
    expect(snap).toBeDefined();
    expect(snap!.method).toBe("POST");
    expect(JSON.parse(snap!.body).stream_options).toEqual({ include_usage: true });
  });
});
