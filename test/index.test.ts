import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import { CodeBuddyAuthPlugin } from "../src/index.js";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, promises: { ...actual.promises, readFile: vi.fn() } };
});

describe("index config hook 全量", () => {
  it("注入 provider.codebuddy 含 npm/baseURL/v2/setCacheKey", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const cfg: any = {};
    await plugin.config!(cfg);
    expect(cfg.provider.codebuddy.npm).toBe("@ai-sdk/openai-compatible");
    expect(cfg.provider.codebuddy.name).toBe("CodeBuddy");
    expect(cfg.provider.codebuddy.options.baseURL).toBe("https://copilot.tencent.com/v2");
    expect(cfg.provider.codebuddy.options.setCacheKey).toBe(true);
    expect(cfg.provider.codebuddy.models).toBeDefined();
  });
  it("auth.json 损坏走 parseStoredAuth 容错（warn 不抛）", async () => {
    const readFile = vi.mocked(fs.promises.readFile as any);
    readFile.mockRejectedValueOnce(new Error("bad json"));
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined).mockResolvedValue(undefined) } } } as any);
    const cfg: any = { provider: {} };
    await expect(plugin.config!(cfg)).resolves.toBeDefined();
    expect(cfg.provider.codebuddy.models.auto).toBeDefined(); // 降级 DEFAULT_MODEL
  });
  it("models 合并：手工 existing 优先，缺失补 auto", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const cfg: any = { provider: { codebuddy: { npm:"@ai-sdk/openai-compatible", name:"CodeBuddy", options:{ baseURL:"https://x/v2", setCacheKey:true }, models:{ "auto": { name:"My Auto", limit:{ context:999 } } } } } };
    // mock discovery 返回空，验证 existing 保留
    await plugin.config!(cfg);
    expect(cfg.provider.codebuddy.models.auto.name).toBe("My Auto");
  });
  it("无 ENDPOINT/NETWORK 时 baseURL 覆写 server（破坏性反转）", async () => {
    delete process.env.CODEBUDDY_ENDPOINT; delete process.env.CODEBUDDY_NETWORK;
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const cfg: any = { provider: { codebuddy: { options:{ baseURL:"https://my-proxy.example.com/v2" } } } };
    await plugin.config!(cfg);
    expect(cfg.provider.codebuddy.options.baseURL).toBe("https://my-proxy.example.com/v2");
    // loader 的 baseURL 也随闭包 server 更新
    const loader = await (plugin as any).auth.loader(async ()=>({ type:"api", key:"k" }));
    expect(loader.baseURL).toBe("https://my-proxy.example.com");
  });
  it("ENDPOINT 已设时 baseURL 不覆写（env 优先）", async () => {
    process.env.CODEBUDDY_ENDPOINT = "https://env.example.com";
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const cfg: any = { provider: { codebuddy: { options:{ baseURL:"https://base.example.com/v2" } } } };
    await plugin.config!(cfg);
    expect(cfg.provider.codebuddy.options.baseURL).toBe("https://env.example.com/v2");
    delete process.env.CODEBUDDY_ENDPOINT;
  });
  it("NETWORK=internet 时 baseURL 不覆写（NETWORK 优先于 baseURL）", async () => {
    delete process.env.CODEBUDDY_ENDPOINT;
    process.env.CODEBUDDY_NETWORK = "internet";
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const cfg: any = { provider: { codebuddy: { options:{ baseURL:"https://base.example.com/v2" } } } };
    await plugin.config!(cfg);
    expect(cfg.provider.codebuddy.options.baseURL).toBe("https://www.codebuddy.ai/v2");
    delete process.env.CODEBUDDY_NETWORK;
  });
  it("oauth discovery 401/403 不降级 DEFAULT_MODEL（warn + 不注入 models.auto）", async () => {
    const readFile = vi.mocked(fs.promises.readFile as any);
    readFile.mockResolvedValueOnce(JSON.stringify({ codebuddy: { type:"oauth", access:"expired", refresh:"r", expires: 0 } }));
    // fetchRemoteModels 抛 401
    const spy = vi.spyOn(await import("../src/models.js"), "fetchRemoteModels").mockRejectedValue(Object.assign(new Error("401"), { status:401 }));
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined).mockResolvedValue(undefined) } } } as any);
    const cfg: any = { provider: {} };
    await plugin.config!(cfg);
    // 401 不降级：不注入 DEFAULT_MODEL（除非手工已有）
    expect(cfg.provider.codebuddy.models.auto).toBeUndefined();
    spy.mockRestore();
  });
  it("baseURL 覆写后 discovery fetchFn 用 live server（非构造时快照）", async () => {
    delete process.env.CODEBUDDY_ENDPOINT; delete process.env.CODEBUDDY_NETWORK;
    const readFile = vi.mocked(fs.promises.readFile as any);
    readFile.mockResolvedValueOnce(JSON.stringify({ codebuddy: { type:"oauth", access:"a", refresh:"r", expires: 0 } }));
    const spy = vi.spyOn(await import("../src/models.js"), "fetchRemoteModels").mockResolvedValue([{ id:"m1", name:"M1", supportsToolCall:true }]);
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const cfg: any = { provider: { codebuddy: { options:{ baseURL:"https://my-proxy.example.com/v2" } } } };
    await plugin.config!(cfg);
    // discovery 请求打到覆写后的 live server，而非构造时快照
    expect(spy).toHaveBeenCalledWith("a", expect.objectContaining({ url:"https://my-proxy.example.com" }), undefined);
    // 与 loader baseURL 同源一致
    const loader = await (plugin as any).auth.loader(async ()=>({ type:"api", key:"k" }));
    expect(loader.baseURL).toBe("https://my-proxy.example.com");
    spy.mockRestore();
  });
});

describe("index chat.headers", () => {
  it("非 codebuddy provider 早退（不注入 22 头）", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const out: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"other", id:"m" }, sessionID:"s1" }, out);
    expect(Object.keys(out.headers)).toHaveLength(0);
  });
  it("codebuddy provider 注入 22 头且 X-Conversation-ID 独立", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const out: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"my-model" }, sessionID:"s1" }, out);
    expect(out.headers["X-Conversation-ID"]).toBeDefined();
    expect(out.headers["X-Conversation-ID"]).not.toBe(out.headers["X-Request-ID"]);
    expect(out.headers["X-Model-ID"]).toBe("my-model");
  });
  it("resolveModel：CODEBUDDY_MODEL 覆盖 input model", async () => {
    process.env.CODEBUDDY_MODEL = "forced-model";
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const out: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"input-model" }, sessionID:"s1" }, out);
    expect(out.headers["X-Model-ID"]).toBe("forced-model");
    delete process.env.CODEBUDDY_MODEL;
  });
  it("stream_options 仅 stream:true 注入（loader fetch 真实 body 断言）", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as any).fetch = spy;
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const loader = await (plugin as any).auth.loader(async () => ({ type:"api", key:"k" }));
    await loader.fetch("https://copilot.tencent.com/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true, messages:[]}) });
    expect(JSON.parse(spy.mock.calls[0][1].body).stream_options).toEqual({ include_usage:true });
    await loader.fetch("https://copilot.tencent.com/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:false, messages:[]}) });
    expect(JSON.parse(spy.mock.calls[1][1].body).stream_options).toBeUndefined();
  });
});

describe("index event & closure", () => {
  it("session.compacted/deleted 清 LRU（闭包持有）", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    // 先触发 chat.headers 生成 conversationId
    const out1: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"m" }, sessionID:"sess-123" }, out1);
    const cid1 = out1.headers["X-Conversation-ID"];
    await (plugin as any).event!({ event: { type:"session.compacted", properties:{ sessionID:"sess-123" } } });
    const out2: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"m" }, sessionID:"sess-123" }, out2);
    expect(out2.headers["X-Conversation-ID"]).not.toBe(cid1);
  });
  it("session.deleted 走 properties.info.id 清 LRU", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const out1: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"m" }, sessionID:"del-1" }, out1);
    const cid1 = out1.headers["X-Conversation-ID"];
    await (plugin as any).event!({ event: { type:"session.deleted", properties:{ info:{ id:"del-1" } } } });
    const out2: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"m" }, sessionID:"del-1" }, out2);
    expect(out2.headers["X-Conversation-ID"]).not.toBe(cid1);
  });
  it("DEFAULT_MODEL 归 models.ts：无 auth 时 config 仍注入 auto", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const cfg: any = { provider: {} };
    await plugin.config!(cfg);
    expect(cfg.provider.codebuddy.models.auto).toEqual(expect.objectContaining({ name:"Auto", tool_call:true }));
  });
  it("导出形态：named + default 兼容", async () => {
    const mod = await import("../src/index.js");
    expect((mod as any).CodeBuddyAuthPlugin).toBeDefined();
    expect((mod as any).default).toEqual(expect.objectContaining({ id:"codebuddy-plugin" }));
  });
  it("无 chat.message 钩子（B3 删除）：conversationId 由 chat.headers 覆盖", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    expect((plugin as any)["chat.message"]).toBeUndefined();
    // chat.headers 仍能独立生成 conversationId（不依赖预热）
    const out: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"m" }, sessionID:"fresh" }, out);
    expect(out.headers["X-Conversation-ID"]).toBeDefined();
  });
});