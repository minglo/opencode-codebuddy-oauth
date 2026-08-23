import { describe, it, expect, vi } from "vitest";
import { createAuthFetch } from "../src/auth-fetch.js";
import { RefreshLock } from "../src/auth-flow.js";
import type { AuthFetchDeps } from "../src/auth-fetch.js";

function makeDeps(overrides: Partial<AuthFetchDeps> = {}): AuthFetchDeps {
  return {
    getAuth: async () => ({ type: "api", key: "k" }),
    client: { auth: { set: async () => {} } },
    server: { url: "https://x", domain: "d" },
    buildAuthHeaders: () => ({}),
    resolveIdentity: () => ({ tenantId: "", enterpriseId: "", userId: "" }),
    decodeJwtPayload: () => null,
    createSSEBufferedStream: (body) => body,
    refreshLock: new RefreshLock(),
    cfg: { sse: { enabled: false, threshold: 24, maxDelayMs: 40 } },
    effectiveAuth: (stored) => (stored ?? null) as any,
    pickAuthMode: () => "api",
    refreshAccessToken: async () => null,
    chatCompletionsPath: "/v2/chat/completions",
    ...overrides,
  };
}

describe("auth-fetch", () => {
  it("非 chat/completions 透传", async () => {
    const fetch = createAuthFetch({ getAuth: async()=>({type:"api",key:"k"}), client:{}, server:{url:"https://x",domain:"d"}, buildAuth:()=>({}), sse:()=>null } as any);
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));
    await fetch("https://x/other", { method:"GET" } as any);
    expect(globalThis.fetch).toHaveBeenCalled();
    globalThis.fetch=orig;
  });
  it("!body 400", async () => {
    const af = createAuthFetch(makeDeps({ getAuth: async () => ({ type: "api", key: "k" }) }));
    const res = await af("https://x/v2/chat/completions", { method: "POST" } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing request body" });
  });
  it("!ok 透传并保留 Content-Type: application/json", async () => {
    (globalThis as any).fetch = async () => new Response("bad", { status: 500, headers: { "Content-Type": "text/plain" } });
    const af = createAuthFetch(makeDeps());
    const res = await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
  it("effectiveAuth null 抛 /connect 指引（区分 api/oauth）", async () => {
    const afApi = createAuthFetch(makeDeps({ getAuth: async () => null, effectiveAuth: () => null, pickAuthMode: () => "api" } as any));
    await expect(afApi("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any)).rejects.toThrow(/missing API key/);
    const afOauth = createAuthFetch(makeDeps({ getAuth: async () => null, effectiveAuth: () => null, pickAuthMode: () => "oauth" } as any));
    await expect(afOauth("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any)).rejects.toThrow(/\/connect/);
  });
  it("signal 透传至 doRequest", async () => {
    const spy = async (u: any, init: any) => { expect(init.signal).toBeDefined(); return new Response("ok", { status: 200 }); };
    (globalThis as any).fetch = spy;
    const af = createAuthFetch(makeDeps());
    const ac = new AbortController();
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}), signal: ac.signal } as any);
  });
  it("stream:true 缺 stream_options 注入 {include_usage:true}", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as any).fetch = spy;
    const af = createAuthFetch(makeDeps());
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true, messages:[]}) } as any);
    const sent = JSON.parse(spy.mock.calls[0][1].body);
    expect(sent.stream_options).toEqual({ include_usage:true });
  });
  it("已含 stream_options 不覆写", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as any).fetch = spy;
    const af = createAuthFetch(makeDeps());
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true, stream_options:{ include_usage:false }}) } as any);
    const sent = JSON.parse(spy.mock.calls[0][1].body);
    expect(sent.stream_options).toEqual({ include_usage:false });
  });
  it("非流式原样透传（不注入 stream_options）", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as any).fetch = spy;
    const af = createAuthFetch(makeDeps());
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:false, messages:[]}) } as any);
    const sent = JSON.parse(spy.mock.calls[0][1].body);
    expect(sent).toEqual({ stream:false, messages:[] });
    expect(sent.stream_options).toBeUndefined();
  });
  it("SSE 包装保留原头：content-type text/event-stream 存活", async () => {
    (globalThis as any).fetch = async () => new Response(new ReadableStream({ start(c){ c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const af = createAuthFetch(makeDeps({ cfg: { sse: { enabled: true, threshold: 24, maxDelayMs: 40 } } } as any));
    const res = await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });
  it("请求路径用 chatCompletionsPath 而非硬拼 /v2/chat/completions", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as any).fetch = spy;
    const af = createAuthFetch(makeDeps({ chatCompletionsPath: "/custom/path" } as any));
    await af("https://x/custom/path", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(spy.mock.calls[0][0]).toBe("https://x/custom/path");
  });
  it("RefreshLock key 用 PROVIDER_ID（codebuddy）单例", async () => {
    let calls = 0;
    const lock = new RefreshLock();
    (globalThis as any).fetch = async () => new Response("unauth", { status: 401 });
    const af = createAuthFetch(makeDeps({
      getAuth: async () => ({ type:"oauth", access:"a", refresh:"r", expires: Date.now() + 3600*1000 }),
      refreshLock: lock,
      refreshAccessToken: async () => { calls++; return { accessToken:"new", refreshToken:"r2", expiresIn:3600 }; },
    } as any));
    await Promise.all([
      af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any).catch(()=>{}),
      af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any).catch(()=>{}),
    ]);
    expect(calls).toBe(1);
  });
  it("A4 预刷新：expires 逼近（skew 内）时请求前刷新并用新 token", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as any).fetch = fetchSpy;
    const refreshSpy = vi.fn().mockResolvedValue({ accessToken:"pre-new", refreshToken:"r2", expiresIn:3600 });
    const setSpy = vi.fn().mockResolvedValue(undefined);
    const af = createAuthFetch(makeDeps({
      getAuth: async () => ({ type:"oauth", access:"old", refresh:"r", expires: Date.now() - 1000 }),
      client: { auth: { set: setSpy } },
      buildAuthHeaders: (a: any) => ({ Authorization: `Bearer ${a.access}` }),
      refreshAccessToken: refreshSpy,
    } as any));
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ access:"pre-new" }) }));
    const sent = new Headers(fetchSpy.mock.calls[0][1].headers);
    expect(sent.get("Authorization")).toBe("Bearer pre-new");
  });
  it("A4 预刷新失败（refresh 返回 null）时沿用旧 token 发起请求（不阻断）", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as any).fetch = fetchSpy;
    const refreshSpy = vi.fn().mockResolvedValue(null);
    const af = createAuthFetch(makeDeps({
      getAuth: async () => ({ type:"oauth", access:"old", refresh:"r", expires: Date.now() - 1000 }),
      buildAuthHeaders: (a: any) => ({ Authorization: `Bearer ${a.access}` }),
      refreshAccessToken: refreshSpy,
    } as any));
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const sent = new Headers(fetchSpy.mock.calls[0][1].headers);
    expect(sent.get("Authorization")).toBe("Bearer old");
  });
  it("A4 预刷新：expires 未逼近（skew 外）不刷新", async () => {
    const refreshSpy = vi.fn().mockResolvedValue({ accessToken:"new", expiresIn:3600 });
    (globalThis as any).fetch = async () => new Response("ok", { status: 200 });
    const af = createAuthFetch(makeDeps({
      getAuth: async () => ({ type:"oauth", access:"a", refresh:"r", expires: Date.now() + 24*60*60*1000 }),
      refreshAccessToken: refreshSpy,
    } as any));
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
  it("client.auth.set 写回失败记 error 日志（logger 注入）", async () => {
    const errorSpy = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: errorSpy };
    (globalThis as any).fetch = async () => new Response("ok", { status: 200 });
    const af = createAuthFetch(makeDeps({
      getAuth: async () => ({ type:"oauth", access:"old", refresh:"r", expires: Date.now() - 1000 }),
      client: { auth: { set: async () => { throw new Error("write denied"); } } },
      logger: logger as any,
      refreshAccessToken: async () => ({ accessToken:"new", expiresIn:3600 }),
    } as any));
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("write-back failed"));
  });
  describe("瞬时 400（11133）重试", () => {
    const err11133 = JSON.stringify({ code:11133, msg:"Invalid request parameters", extError:{ code:"invalid_parameter_value" } });

    it("首次 400+11133 重试后成功：fetch 共调用 2 次，最终 200", async () => {
      vi.useFakeTimers();
      try {
        const fetchSpy = vi.fn()
          .mockResolvedValueOnce(new Response(err11133, { status: 400, headers: { "Content-Type": "application/json" } }))
          .mockResolvedValueOnce(new Response("ok", { status: 200 }));
        (globalThis as any).fetch = fetchSpy;
        const af = createAuthFetch(makeDeps());
        const p = af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
        await vi.advanceTimersByTimeAsync(40000);
        const res = await p;
        expect(res.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      } finally { vi.useRealTimers(); }
    });
    it("连续 11133 耗尽重试（共 5 次请求，退避 1/4/10/25s）后原样返回 400", async () => {
      vi.useFakeTimers();
      try {
        const mk400 = () => new Response(err11133, { status: 400, headers: { "Content-Type": "application/json" } });
        const fetchSpy = vi.fn().mockImplementation(async () => mk400());
        (globalThis as any).fetch = fetchSpy;
        const warnSpy = vi.fn();
        const af = createAuthFetch(makeDeps({ logger: { debug:vi.fn(), info:vi.fn(), warn:warnSpy, error:vi.fn() } as any }));
        const p = af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
        await vi.advanceTimersByTimeAsync(40000);
        const res = await p;
        expect(res.status).toBe(400);
        expect(fetchSpy).toHaveBeenCalledTimes(5);
        expect(warnSpy).toHaveBeenCalledTimes(4);
        const body = await res.json();
        expect(body.code).toBe(11133);
      } finally { vi.useRealTimers(); }
    });
    it("非 11133 的 400 不重试（如 11101），一次返回", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code:11101, msg:"Non-stream chat request is currently not supported" }), { status: 400, headers: { "Content-Type": "application/json" } }));
      (globalThis as any).fetch = fetchSpy;
      const af = createAuthFetch(makeDeps());
      const res = await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe(11101);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    it("非 JSON 的 400 body 不重试", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response("plain bad request", { status: 400 }));
      (globalThis as any).fetch = fetchSpy;
      const af = createAuthFetch(makeDeps());
      const res = await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("plain bad request");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});