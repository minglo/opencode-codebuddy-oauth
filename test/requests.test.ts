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

function sseLine(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}

describe("http.response", () => {
  it("SSE 流被合并（threshold 触发）", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState({ cfg: { ...makeTestState().cfg, sse: { enabled: true, threshold: 100, maxDelayMs: 50 } } });
    await registerRequests(ctx, state);
    const payload = sseLine({ reasoning_content: "你好。" }) + sseLine({ content: "世界。" }) + "data: [DONE]\n\n";
    const res = new Response(payload, { headers: { "content-type": "text/event-stream" } });
    const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x"), response: res };
    await triggerHook("http.response", e);
    const text = await e.response.text();
    expect(text).toContain("你好。");
    expect(text).toContain("世界。");
    expect(text).toContain("[DONE]");
  });

  it("SSE 被禁用时原样返回", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState({ cfg: { ...makeTestState().cfg, sse: { enabled: false, threshold: 100, maxDelayMs: 50 } } });
    await registerRequests(ctx, state);
    const payload = sseLine({ content: "a" });
    const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x"), response: new Response(payload, { headers: { "content-type": "text/event-stream" } }) };
    await triggerHook("http.response", e);
    expect(await e.response.text()).toBe(payload);
  });

  it("11133 用快照重发，成功后替换响应", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
      const state = makeTestState();
      await registerRequests(ctx, state);
      const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
        request: chatRequest({ stream: true, messages: [] }) };
      await triggerHook("http.request", e);   // 建立快照
      const fetches: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: any) => {
        fetches.push(String(input));
        return new Response(JSON.stringify({ code: 0, ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }));
      e.response = new Response(JSON.stringify({ code: 11133 }), { status: 400, headers: { "content-type": "application/json" } });
      const pending = triggerHook("http.response", e);
      await vi.runAllTimersAsync();
      await pending;
      expect(fetches).toHaveLength(1);
      expect(e.response.status).toBe(200);
      expect(await e.response.text()).toContain('"ok":true');
    } finally {
      vi.useRealTimers();
    }
  });

  it("非 JSON 的 400 原样返回（HTML 网关错误页）", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const html = "<html>Bad Gateway</html>";
    const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x"), response: new Response(html, { status: 400, headers: { "content-type": "text/html" } }) };
    await triggerHook("http.response", e);
    expect(e.response.status).toBe(400);
    expect(e.response.headers.get("content-type")).toBe("text/html");
    expect(await e.response.text()).toBe(html);
  });

  it("SSE 流被提前取消后定时 flush 不崩", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
      const state = makeTestState({ cfg: { ...makeTestState().cfg, sse: { enabled: true, threshold: 100, maxDelayMs: 50 } } });
      await registerRequests(ctx, state);
      const payload = sseLine({ reasoning_content: "碎片" });   // 未达 threshold、无标点 → 只能靠 timer flush
      const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
        request: new Request("https://x"), response: new Response(payload, { headers: { "content-type": "text/event-stream" } }) };
      await triggerHook("http.response", e);
      const reader = e.response.body!.getReader();
      await reader.cancel();                     // 不 read：timer flush 尚未产出，直接取消
      await vi.advanceTimersByTimeAsync(200);    // timer 在已取消的流上触发，必须有 try/catch 兜住
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retry + 事件订阅", () => {
  it("retry hook 注册且仅记录日志", async () => {
    const { ctx, calls } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    expect(calls.hooks.has("retry")).toBe(true);
    const err = { error: { type: "provider.invalid-request", status: 400, message: "x" }, attempt: 2, decision: { retry: false } };
    await calls.hooks.get("retry")!(err);
    expect(state.logger.warn).toHaveBeenCalled();
  });

  it("session.compacted 清 conversationIds", async () => {
    let pushEvent: ((e: any) => void) | null = null;
    const { ctx, triggerHook } = createMockCtx({
      credential: { type: "key", key: "k" },
      subscription: () => (async function* () {
        while (true) {
          const next = await new Promise<any>((resolve) => { pushEvent = resolve; });
          yield next;
        }
      })(),
    });
    const state = makeTestState();
    await registerRequests(ctx, state);

    const e: any = { sessionID: "sess-x", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ messages: [] }) };
    await triggerHook("http.request", e);
    expect(state.conversationIds.get("sess-x")).toBeTruthy();

    pushEvent!({ type: "session.compacted", data: { sessionID: "sess-x" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(state.conversationIds.get("sess-x")).toBeUndefined();
  });

  it("cleanup 中止订阅", async () => {
    let aborted = false;
    const { ctx } = createMockCtx({
      subscription: (signal: AbortSignal) => (async function* () {
        if (signal.aborted) { aborted = true; return; }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
        });
      })(),
    });
    const state = makeTestState();
    const cleanup = await registerRequests(ctx, state);
    await new Promise((r) => setTimeout(r, 0));   // 让消费循环进入首次 next()
    cleanup();
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toBe(true);
  });
});

describe("fix pass 回归", () => {
  it("非 JSON 请求的 content-type 不被改写", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x/v2/chat/completions", { method: "POST", headers: { "content-type": "text/plain" }, body: "not json" }) };
    await triggerHook("http.request", e);
    expect(e.request.headers.get("content-type")).toBe("text/plain");
  });

  it("11133 重发时 fetch 失败：回退原 400 不抛", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
      const state = makeTestState();
      await registerRequests(ctx, state);
      const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
        request: chatRequest({ stream: true, messages: [] }) };
      await triggerHook("http.request", e);
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
      e.response = new Response(JSON.stringify({ code: 11133 }), { status: 400, headers: { "content-type": "application/json" } });
      const pending = triggerHook("http.response", e);
      await vi.runAllTimersAsync();
      await pending;
      expect(e.response.status).toBe(400);
      expect(JSON.parse(await e.response.text()).code).toBe(11133);
    } finally {
      vi.useRealTimers();
    }
  });

  it("11133 重发时请求已 abort：不重发、回退原 400", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
      const state = makeTestState();
      await registerRequests(ctx, state);
      const ac = new AbortController();
      const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
        request: new Request("https://copilot.tencent.com/v2/chat/completions", {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: ac.signal,
        }) };
      await triggerHook("http.request", e);
      ac.abort();
      const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);
      e.response = new Response(JSON.stringify({ code: 11133 }), { status: 400, headers: { "content-type": "application/json" } });
      const pending = triggerHook("http.response", e);
      await vi.runAllTimersAsync();
      await pending;
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(e.response.status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleanup 释放所有 registration dispose", async () => {
    const { ctx, calls } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    const cleanup = await registerRequests(ctx, state);
    cleanup();
    expect(calls.disposals.length).toBeGreaterThan(0);
    expect(calls.disposals.every((d) => d.mock.calls.length > 0)).toBe(true);
  });

  it("body 不可读时不写请求快照（M2）", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const stream = new ReadableStream({ start(c) { c.error(new Error("boom")); } });
    const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x/v2/chat/completions", { method: "POST", body: stream, duplex: "half" }) };
    await triggerHook("http.request", e);
    expect(state.requestSnapshots.size).toBe(0);
  });

  it("FormData 请求 content-type 含 boundary 不被改写（M5）", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const fd = new FormData();
    fd.append("file", "hello");
    const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x/v2/chat/completions", { method: "POST", body: fd }) };
    const original = e.request.headers.get("content-type");
    await triggerHook("http.request", e);
    expect(e.request.headers.get("content-type")).toBe(original);
    expect(e.request.headers.get("content-type")).toContain("multipart/form-data");
    expect(e.request.headers.get("content-type")).toContain("boundary=");
  });

  it("11133 重试耗尽：返回最后一次响应（M5）", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
      const state = makeTestState();
      await registerRequests(ctx, state);
      const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
        request: chatRequest({ stream: true, messages: [] }) };
      await triggerHook("http.request", e);
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ code: 11133 }), { status: 400, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", fetchSpy);
      e.response = new Response(JSON.stringify({ code: 11133 }), { status: 400, headers: { "content-type": "application/json" } });
      const pending = triggerHook("http.response", e);
      await vi.runAllTimersAsync();
      await pending;
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(e.response.status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SSE timer flush 实际产出缓冲内容（M5）", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
      const state = makeTestState({ cfg: { ...makeTestState().cfg, sse: { enabled: true, threshold: 100, maxDelayMs: 50 } } });
      await registerRequests(ctx, state);
      const payload = sseLine({ reasoning_content: "碎片" });   // 无标点无换行 → 只能靠 timer flush
      const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
        request: new Request("https://x"), response: new Response(payload, { headers: { "content-type": "text/event-stream" } }) };
      await triggerHook("http.response", e);
      const reader = e.response.body!.getReader();
      const readPromise = reader.read();
      await vi.advanceTimersByTimeAsync(60);
      const { value } = await readPromise;
      expect(new TextDecoder().decode(value)).toContain("碎片");
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
