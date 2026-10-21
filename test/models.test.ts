import { describe, it, expect, vi } from "vitest";
import { buildVariants, fetchRemoteModels, DiscoveryCache, DEFAULT_MODEL } from "../src/models.js";

describe("buildVariants 直通映射", () => {
  it("原样暴露上游 supportedEfforts（不制造 medium、不折叠 xhigh）", () => {
    expect(buildVariants(["low", "high"])).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    });
  });
  it("deepseek-v4-pro low/high/xhigh：三档原样", () => {
    expect(Object.keys(buildVariants(["low", "high", "xhigh"]))).toEqual(["low", "high", "xhigh"]);
    expect(buildVariants(["low", "high", "xhigh"]).xhigh).toEqual({ reasoningEffort: "xhigh" });
  });
  it("glm-5.3 low/high/max：max 键值均为原生 max", () => {
    expect(Object.keys(buildVariants(["low", "high", "max"]))).toEqual(["low", "high", "max"]);
    expect(buildVariants(["low", "high", "max"]).max).toEqual({ reasoningEffort: "max" });
  });
  it("hy4-preview 仅 high：单档", () => {
    expect(buildVariants(["high"])).toEqual({ high: { reasoningEffort: "high" } });
  });
  it("glm-5.2 high/xhigh：两档原样（历史曾把 xhigh 折成 max）", () => {
    expect(Object.keys(buildVariants(["high", "xhigh"]))).toEqual(["high", "xhigh"]);
  });
  it("空数组：无 variants", () => {
    expect(buildVariants([])).toEqual({});
  });
});

describe("DiscoveryCache", () => {
  it("TTL 命中直接返回（不拉网）", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, models: [{ id:"m1", name:"M1" }] });
    const cache = new DiscoveryCache({ ttlMs: 5*60*1000, fetchFn });
    await cache.get("credential:c1", "token", { signal: undefined });
    await cache.get("credential:c1", "token", { signal: undefined });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("过期后台 revalidate", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, models: [{ id:"m1", name:"M1" }] })
      .mockResolvedValueOnce({ ok: true, models: [{ id:"m2", name:"M2" }] });
    const cache = new DiscoveryCache({ ttlMs: 10, fetchFn });
    const first = await cache.get("credential:c1", "token", { signal: undefined });
    expect(first[0].id).toBe("m1");
    await new Promise(r => setTimeout(r, 20));
    await cache.get("credential:c1", "token", { signal: undefined });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("单飞去重：并发 get 仅拉一次", async () => {
    let calls = 0;
    const fetchFn = vi.fn().mockImplementation(async () => { calls++; await new Promise(r=>setTimeout(r,20)); return { ok: true, models: [{ id:"m1", name:"M1" }] }; });
    const cache = new DiscoveryCache({ ttlMs: 5*60*1000, fetchFn });
    await Promise.all([
      cache.get("credential:c1", "tok", { signal: undefined }),
      cache.get("credential:c1", "tok", { signal: undefined }),
    ]);
    expect(calls).toBe(1);
  });
  it("401/403 不进缓存", async () => {
    const fetchFn = vi.fn().mockRejectedValue(Object.assign(new Error("401"), { status:401 }));
    const cache = new DiscoveryCache({ ttlMs: 5*60*1000, fetchFn });
    await expect(cache.get("credential:c1", "tok", { signal: undefined })).rejects.toMatchObject({ status: 401 });
    const fetch2 = vi.fn().mockResolvedValue({ ok: true, models: [{ id:"m1", name:"M1" }] });
    (cache as any).fetchFn = fetch2;
    await cache.get("credential:c1", "tok", { signal: undefined });
    expect(fetch2).toHaveBeenCalled();
  });
  it("SWR 过期分支 401 不产生 unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onU = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onU);
    try {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce({ ok: true, models: [{ id:"m1", name:"M1" }] })
        .mockRejectedValueOnce(Object.assign(new Error("401"), { status:401 }));
      const cache = new DiscoveryCache({ ttlMs: 10, fetchFn });
      const first = await cache.get("credential:c1", "tok", { signal: undefined });
      expect(first[0].id).toBe("m1");
      await new Promise(r => setTimeout(r, 20));
      await expect(cache.get("credential:c1", "tok", { signal: undefined })).rejects.toMatchObject({ status: 401 });
      await new Promise(r => setTimeout(r, 50));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.removeListener("unhandledRejection", onU);
    }
  });
  it("不同账号各拿各的目录", async () => {
    const fetchFn = vi.fn(async (token: string) => ({ ok: true as const, models: [{ id: token + "-m", name: token }] }));
    const cache = new DiscoveryCache({ ttlMs: 300000, fetchFn });
    const a = await cache.get("credential:A", "tokA", {});
    const b = await cache.get("credential:B", "tokB", {});
    expect(a[0].id).toBe("tokA-m");
    expect(b[0].id).toBe("tokB-m");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("同账号 token 轮换不重新发现", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true as const, models: [{ id: "m", name: "M" }] }));
    const cache = new DiscoveryCache({ ttlMs: 300000, fetchFn });
    await cache.get("credential:A", "old", {});
    const second = await cache.get("credential:A", "new", {});
    expect(second[0].id).toBe("m");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("暂时失败保留同账号上一份目录", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, models: [{ id: "m1", name: "M1" }] })
      .mockResolvedValue({ ok: false, status: 500 });
    const cache = new DiscoveryCache({ ttlMs: 10, fetchFn });
    const first = await cache.get("credential:A", "tok", {});
    expect(first[0].id).toBe("m1");
    await new Promise(r => setTimeout(r, 20));
    const second = await cache.get("credential:A", "tok", {});
    expect(second[0].id).toBe("m1");
    // 失败回落不得刷新 fetchedAt：紧接着的第三次调用必须再次拉网（而非 TTL 命中）。
    const third = await cache.get("credential:A", "tok", {});
    expect(third[0].id).toBe("m1");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it("首次暂时失败回落 [DEFAULT_MODEL]", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const cache = new DiscoveryCache({ ttlMs: 300000, fetchFn });
    expect(await cache.get("credential:A", "tok", {})).toEqual([DEFAULT_MODEL]);
    // 回落不得写入缓存：第二次调用必须再次拉网。
    expect(await cache.get("credential:A", "tok", {})).toEqual([DEFAULT_MODEL]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("A 的 in-flight 不污染 B", async () => {
    let resolveA!: (v: any) => void;
    const pendingA = new Promise<any>((r) => { resolveA = r; });
    const fetchFn = vi.fn((token: string) => token === "tokA"
      ? pendingA
      : Promise.resolve({ ok: true, models: [{ id: "b-only", name: "B" }] }));
    const cache = new DiscoveryCache({ ttlMs: 300000, fetchFn: fetchFn as any });
    const pA = cache.get("credential:A", "tokA", {});
    const pB = cache.get("credential:B", "tokB", {});
    expect((await pB)[0].id).toBe("b-only");
    resolveA({ ok: true, models: [{ id: "a-only", name: "A" }] });
    expect((await pA)[0].id).toBe("a-only");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("invalidate 后旧响应不写回该账号", async () => {
    let resolveFetch!: (v: any) => void;
    const pending = new Promise<any>((r) => { resolveFetch = r; });
    const fetchFn = vi.fn().mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ ok: true, models: [{ id: "fresh", name: "Fresh" }] });
    const cache = new DiscoveryCache({ ttlMs: 300000, fetchFn: fetchFn as any });
    const stale = cache.get("credential:A", "tok", {});
    cache.invalidate("credential:A");
    resolveFetch({ ok: true, models: [{ id: "stale", name: "Stale" }] });
    expect((await stale)[0].id).toBe("stale");
    const next = await cache.get("credential:A", "tok", {});
    expect(next[0].id).toBe("fresh");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("invalidate 清除在途单飞：新 get 不复用失效前的 promise", async () => {
    let resolveFetch!: (v: any) => void;
    const pending = new Promise<any>((r) => { resolveFetch = r; });
    const fetchFn = vi.fn().mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ ok: true, models: [{ id: "fresh", name: "Fresh" }] });
    const cache = new DiscoveryCache({ ttlMs: 300000, fetchFn: fetchFn as any });
    const stale = cache.get("credential:A", "tok", {});
    cache.invalidate("credential:A");
    const next = cache.get("credential:A", "tok", {});
    resolveFetch({ ok: true, models: [{ id: "stale", name: "Stale" }] });
    const [, n] = await Promise.all([stale, next]);
    expect(n[0].id).toBe("fresh");
    expect(fetchFn).toHaveBeenCalledTimes(2);
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
    expect(res).toEqual({ ok: true, models: [{ id:"m2", name:"M2" }] });
  });
  it("craftIds 为空 → [DEFAULT_MODEL]", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code:0, data:{ agents:[], models:[{ id:"m1", name:"M1" }] } }), { status:200 }));
    const res = await fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined);
    expect(res).toEqual({ ok: true, models: [DEFAULT_MODEL] });
  });
  it("401/403 原样抛出（不进缓存降级）", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("unauth", { status:401 }));
    await expect(fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined)).rejects.toMatchObject({ status: 401 });
  });
  it("500 返回 ok:false，不伪装成空目录", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status: 500 }));
    const res = await fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined);
    expect(res).toEqual({ ok: false, status: 500 });
  });
  it("网络异常返回 ok:false", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const res = await fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined);
    expect(res).toEqual({ ok: false });
  });
  it("业务 code 非 0 返回 ok:false", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 500 }), { status: 200 }));
    const res = await fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined);
    expect(res).toEqual({ ok: false });
  });
  it("tool-call 过滤后为空 → 回落 [DEFAULT_MODEL]", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { agents:[{ name:"craft", models:["a"] }], models:[{ id:"a", name:"A", supportsToolCall:false }] },
    }), { status: 200 }));
    const res = await fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined);
    expect(res).toEqual({ ok: true, models: [DEFAULT_MODEL] });
  });
});
