import { describe, it, expect, vi } from "vitest";
import { fetchJson } from "../src/fetch-json.js";

describe("fetchJson", () => {
  it("超时中止返回 ok:false", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (() => new Promise(()=>{})) as any;
    const r = await fetchJson("http://x", { timeoutMs: 10 });
    expect(r.ok).toBe(false);
    globalThis.fetch = orig;
  });
  it("外部 signal 联动", async () => {
    const ac = new AbortController(); ac.abort();
    const r = await fetchJson("http://x", { timeoutMs: 1000, signal: ac.signal });
    expect(r.ok).toBe(false);
  });
  it("非2xx 返回 status/text 截断500", async () => {
    globalThis.fetch = (async () => new Response("x".repeat(600), { status: 500 })) as any;
    const r = await fetchJson("http://x", { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.text!.length).toBeLessThanOrEqual(500);
  });
  it("401/403 不吞为网络错误，带 status 返回", async () => {
    globalThis.fetch = (async () => new Response("unauth", { status: 401 })) as any;
    const r = await fetchJson("http://x", { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
  it("cancel 时 clearTimeout + removeEventListener 不泄漏", async () => {
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, "addEventListener");
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const clearSpy = vi.spyOn(global, "clearTimeout");
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok:1 }), { status: 200, headers: { "Content-Type":"application/json" } })) as any;
    await fetchJson("http://x", { timeoutMs: 1000, signal: ac.signal });
    expect(clearSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    addSpy.mockRestore(); removeSpy.mockRestore(); clearSpy.mockRestore();
  });
  it("401 分流：调用方不进 DEFAULT_MODEL 降级（status 可区分）", async () => {
    globalThis.fetch = (async () => new Response("unauth", { status: 401 })) as any;
    const r = await fetchJson<{code:number}>("http://x", { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // 调用方应据 status 走 needsRefresh 而非降级
      expect(r.status).toBe(401);
      expect(r.text).toBe("unauth");
    }
  });
  it("外部 signal 已中止时立即返回 ok:false", async () => {
    const ac = new AbortController(); ac.abort();
    globalThis.fetch = vi.fn() as any;
    const r = await fetchJson("http://x", { timeoutMs: 1000, signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});