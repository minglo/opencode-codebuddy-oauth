import { describe, it, expect, vi } from "vitest";
import { remoteModelToConfig, mergeModelEntry, fetchRemoteModels, DiscoveryCache, DEFAULT_MODEL } from "../src/models.js";

describe("models mapping", () => {
  it("N1 tool_call:false 落盘", () => {
    const c = remoteModelToConfig({ id:"x", name:"X", supportsToolCall:false } as any);
    expect(c.tool_call).toBe(false);
  });
  it("N1 undefined 视为 true（craft 纳入）", () => {
    const c = remoteModelToConfig({ id:"x", name:"X" } as any);
    expect(c.tool_call).toBe(true);
  });
  it("N2 手工 reasoning:false 不被翻转且 interleaved 不残留", () => {
    const auto = { reasoning:true, interleaved:{field:"reasoning_content"}, options:{ reasoningEffort:"high" } };
    const existing = { reasoning:false };
    const m = mergeModelEntry(auto as any, existing as any);
    expect(m.reasoning).toBe(false);
    expect(m.interleaved).toBeUndefined();
    expect(m.options).toBeUndefined();
  });
  it("limit 皆0 时不落盘", () => {
    const c = remoteModelToConfig({ id:"x", name:"X" } as any);
    expect(c.limit).toBeUndefined();
  });
  it("limit 有值时落盘", () => {
    const c = remoteModelToConfig({ id:"x", name:"X", maxInputTokens:1000, maxOutputTokens:200 } as any);
    expect(c.limit).toEqual({ context:1000, output:200 });
  });
  it("supportsReasoning 映射 interleaved/variants", () => {
    const c = remoteModelToConfig({ id:"x", name:"X", supportsReasoning:true, reasoning:{ supportedEfforts:["low","high"] } } as any);
    expect(c.reasoning).toBe(true);
    expect(c.interleaved).toEqual({ field:"reasoning_content" });
    expect((c.variants as any).low).toEqual({ reasoningEffort:"low" });
  });
});

describe("DiscoveryCache", () => {
  it("TTL 命中直接返回（不拉网）", async () => {
    const fetch = vi.fn().mockResolvedValue([{ id:"m1", name:"M1" }]);
    const cache = new DiscoveryCache({ ttlMs: 5*60*1000, fetchFn: fetch, server:{ url:"https://x", domain:"d" } } as any);
    await cache.get("token", { signal: undefined });
    await cache.get("token", { signal: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("过期后台 revalidate", async () => {
    const fetch = vi.fn().mockResolvedValueOnce([{ id:"m1", name:"M1" }]).mockResolvedValueOnce([{ id:"m2", name:"M2" }]);
    const cache = new DiscoveryCache({ ttlMs: 10, fetchFn: fetch, server:{ url:"https://x", domain:"d" } } as any);
    const first = await cache.get("token", { signal: undefined });
    expect(first[0].id).toBe("m1");
    await new Promise(r => setTimeout(r, 20));
    await cache.get("token", { signal: undefined });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("单飞去重：并发 get 仅拉一次", async () => {
    let calls = 0;
    const fetch = vi.fn().mockImplementation(async () => { calls++; await new Promise(r=>setTimeout(r,20)); return [{ id:"m1", name:"M1" }]; });
    const cache = new DiscoveryCache({ ttlMs: 5*60*1000, fetchFn: fetch, server:{ url:"https://x", domain:"d" } } as any);
    await Promise.all([cache.get("tok", { signal: undefined }), cache.get("tok", { signal: undefined })]);
    expect(calls).toBe(1);
  });
  it("401/403 不进缓存", async () => {
    const fetch = vi.fn().mockRejectedValue(Object.assign(new Error("401"), { status:401 }));
    const cache = new DiscoveryCache({ ttlMs: 5*60*1000, fetchFn: fetch, server:{ url:"https://x", domain:"d" } } as any);
    await expect(cache.get("tok", { signal: undefined }).catch(()=>[])).resolves.toBeDefined();
    const fetch2 = vi.fn().mockResolvedValue([{ id:"m1", name:"M1" }]);
    (cache as any).fetchFn = fetch2;
    await cache.get("tok", { signal: undefined });
    expect(fetch2).toHaveBeenCalled();
  });
  it("SWR 过期分支 401 不产生 unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onU = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onU);
    try {
      const fetch = vi.fn()
        .mockResolvedValueOnce([{ id:"m1", name:"M1" }])
        .mockRejectedValueOnce(Object.assign(new Error("401"), { status:401 }));
      const cache = new DiscoveryCache({ ttlMs: 10, fetchFn: fetch, server:{ url:"https://x", domain:"d" } } as any);
      const first = await cache.get("tok", { signal: undefined });
      expect(first[0].id).toBe("m1");
      await new Promise(r => setTimeout(r, 20));
      const second = await cache.get("tok", { signal: undefined });
      expect(second[0].id).toBe("m1");
      await new Promise(r => setTimeout(r, 50));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.removeListener("unhandledRejection", onU);
    }
  });
  it("DEFAULT_MODEL 字段定稿", () => {
    expect(DEFAULT_MODEL).toEqual({ id:"auto", name:"Auto", maxInputTokens:168000, maxOutputTokens:32000, supportsToolCall:true });
  });
});

describe("fetchRemoteModels 真实实现", () => {
  it("走 /v3/config + craft 过滤 + !==false", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code:0, data:{ agents:[{ name:"craft", models:["m1","m2"] }], models:[{ id:"m1", name:"M1", supportsToolCall:false }, { id:"m2", name:"M2" }] } }), { status:200 }));
    globalThis.fetch = fetch;
    const res = await fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined);
    expect(fetch.mock.calls[0][0]).toBe("https://x/v3/config");
    expect(fetch.mock.calls[0][1].headers["Authorization"]).toBe("Bearer tok");
    expect(fetch.mock.calls[0][1].headers["X-Domain"]).toBe("d");
    // m1 tool_call:false 被过滤，m2 undefined 视为纳入
    expect(res.map(m=>m.id)).toEqual(["m2"]);
  });
  it("craftIds 为空 → [DEFAULT_MODEL]", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code:0, data:{ agents:[], models:[{ id:"m1", name:"M1" }] } }), { status:200 }));
    const res = await fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined);
    expect(res).toEqual([DEFAULT_MODEL]);
  });
  it("401/403 原样抛出（不进缓存降级）", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("unauth", { status:401 }));
    await expect(fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined)).rejects.toThrow(/401/);
  });
  it("网络失败/5xx 返回 []（降级由上层 DEFAULT_MODEL）", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status:500 }));
    const res = await fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined);
    expect(res).toEqual([]);
  });
});