import { describe, it, expect } from "vitest";
import { remoteModelToInfo, modelFingerprint } from "../src/provider.js";

describe("remoteModelToInfo", () => {
  it("基础能力与 limit 映射", () => {
    const info: any = remoteModelToInfo({
      id: "m1", name: "M1", supportsToolCall: true, supportsImages: true,
      maxInputTokens: 1000, maxOutputTokens: 100, maxAllowedSize: 2000,
    });
    expect(info.id).toBe("m1");
    expect(info.modelID).toBe("m1");
    expect(info.name).toBe("M1");
    expect(info.capabilities.tools).toBe(true);
    expect(info.capabilities.input).toContain("image");
    expect(info.limit.context).toBe(2000);
    expect(info.limit.output).toBe(100);
    expect(info.compatibility.supportsPromptCacheKey).toBe(true);
  });

  it("reasoning：compatibility + variants 直通（不制造 medium、不折叠 xhigh）", () => {
    const info: any = remoteModelToInfo({
      id: "m2", name: "M2", supportsToolCall: true, supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "high", "xhigh"] },
    });
    expect(info.compatibility.reasoningField).toBe("reasoning_content");
    expect(info.compatibility.requireReasoning).toBe(true);
    const ids = info.variants.map((v: any) => v.id);
    expect(ids).toEqual(["low", "high", "xhigh"]);
    const byId = Object.fromEntries(info.variants.map((v: any) => [v.id, v.settings.reasoningEffort]));
    expect(byId.low).toBe("low");
    expect(byId.high).toBe("high");
    expect(byId.xhigh).toBe("xhigh");
  });

  it("reasoning：low/high/max 档位原样", () => {
    const info: any = remoteModelToInfo({
      id: "m4", name: "M4", supportsToolCall: true, supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "high", "max"] },
    });
    const ids = info.variants.map((v: any) => v.id);
    expect(ids).toEqual(["low", "high", "max"]);
    expect(info.variants.find((v: any) => v.id === "max").settings.reasoningEffort).toBe("max");
  });

  it("无 images 时 input 不含 image", () => {
    const info: any = remoteModelToInfo({ id: "m3", name: "M3", supportsToolCall: true });
    expect(info.capabilities.input).not.toContain("image");
  });
});

import { vi, afterEach } from "vitest";
import { registerProvider } from "../src/provider.js";
import { createMockCtx, jsonResponse, makeProviderEditor, makeModelEditor, makeTestState } from "./helpers/mock-ctx.js";
import { DiscoveryCache, DEFAULT_MODEL, DiscoveryTransientError } from "../src/models.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function discoveryResponse(models: any[]) {
  return jsonResponse({ code: 0, data: { agents: [{ name: "craft", models: models.map((m) => m.id) }], models } });
}

describe("registerProvider", () => {
  it("无凭证：注册 provider（含 DEFAULT_MODEL）且不抛", async () => {
    const { ctx, applyProviderTransforms, calls } = createMockCtx();
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    const cleanup = await registerProvider(ctx, state);
    const { editor, added } = makeProviderEditor();
    applyProviderTransforms(editor);
    expect(added).toHaveLength(1);
    const info = added[0].info;
    expect(info.name).toBe("CodeBuddy");
    expect(info.activation).toBe("enabled");
    expect(info.integrationID).toBe("codebuddy");
    expect(info.package).toBe("@opencode/ai/providers/openai-compatible");
    expect(info.settings.baseURL).toContain("/v2");
    expect(added[0].models.length).toBeGreaterThan(0);
    expect(calls.subscriptions.length).toBeGreaterThan(0);
    cleanup();
  });

  it("已有 provider 时走 update 并合并 settings", async () => {
    const { ctx, applyProviderTransforms } = createMockCtx();
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    const cleanup = await registerProvider(ctx, state);
    const seed = { provider: { id: "codebuddy", name: "old", settings: { setCacheKey: true }, integrationID: undefined as any } };
    const { editor, added, updates } = makeProviderEditor(seed);
    applyProviderTransforms(editor);
    expect(added).toHaveLength(0);
    expect(updates).toContain("codebuddy");
    expect(seed.provider.settings.setCacheKey).toBe(true);
    expect(seed.provider.settings.baseURL).toContain("/v2");
    expect(seed.provider.integrationID).toBe("codebuddy");
    cleanup();
  });

  it("configuredBase 覆写 server（ENDPOINT 未设、NETWORK 默认 internal）", async () => {
    const savedEndpoint = process.env.CODEBUDDY_ENDPOINT;
    const savedNetwork = process.env.CODEBUDDY_NETWORK;
    delete process.env.CODEBUDDY_ENDPOINT;
    delete process.env.CODEBUDDY_NETWORK;
    try {
      const { ctx, applyProviderTransforms } = createMockCtx();
      const state = makeTestState();
      state.discovered = [DEFAULT_MODEL];
      const cleanup = await registerProvider(ctx, state);
      const seed = { provider: { id: "codebuddy", name: "x", settings: { baseURL: "https://my-proxy.example.com/v2" }, integrationID: undefined as any } };
      const { editor } = makeProviderEditor(seed);
      applyProviderTransforms(editor);
      expect(seed.provider.settings.baseURL).toBe("https://my-proxy.example.com/v2");
      cleanup();
    } finally {
      if (savedEndpoint === undefined) delete process.env.CODEBUDDY_ENDPOINT; else process.env.CODEBUDDY_ENDPOINT = savedEndpoint;
      if (savedNetwork === undefined) delete process.env.CODEBUDDY_NETWORK; else process.env.CODEBUDDY_NETWORK = savedNetwork;
    }
  });

  it("ENDPOINT 已设时 configuredBase 不覆写", async () => {
    const savedEndpoint = process.env.CODEBUDDY_ENDPOINT;
    process.env.CODEBUDDY_ENDPOINT = "https://env.example.com";
    try {
      const { ctx, applyProviderTransforms } = createMockCtx();
      const state = makeTestState();
      state.discovered = [DEFAULT_MODEL];
      const cleanup = await registerProvider(ctx, state);
      const seed = { provider: { id: "codebuddy", name: "x", settings: { baseURL: "https://base.example.com/v2" }, integrationID: undefined as any } };
      const { editor } = makeProviderEditor(seed);
      applyProviderTransforms(editor);
      expect(seed.provider.settings.baseURL).toBe("https://env.example.com/v2");
      cleanup();
    } finally {
      if (savedEndpoint === undefined) delete process.env.CODEBUDDY_ENDPOINT; else process.env.CODEBUDDY_ENDPOINT = savedEndpoint;
    }
  });

  it("api key 凭证：不发现，注入 DEFAULT_MODEL", async () => {
    const fetchSpy = vi.fn(async () => discoveryResponse([]));
    vi.stubGlobal("fetch", fetchSpy);
    const { ctx, applyProviderTransforms } = createMockCtx({ credential: { type: "key", key: "ck_x" } });
    const state = makeTestState();
    const cleanup = await registerProvider(ctx, state);
    const { editor, added } = makeProviderEditor();
    applyProviderTransforms(editor);
    expect(added).toHaveLength(1);
    expect(added[0].models.some((m: any) => m.id === "auto")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    cleanup();
  });

  it("发现成功：模型经 model transform 注入", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => discoveryResponse([
      { id: "m1", name: "M1", supportsToolCall: true, maxInputTokens: 1000, maxOutputTokens: 10 },
    ])));
    const { ctx, applyProviderTransforms, applyModelTransforms } = createMockCtx({ credential: { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000 } });
    const state = makeTestState({
      discoveryCache: new DiscoveryCache({ ttlMs: 60_000, fetchFn: (token) => (globalThis.fetch as any)(`https://copilot.tencent.com/v3/config?t=${token}`).then((r: Response) => r.json()).then((b: any) => ({ ok: true, models: b.data.models })) }),
    });
    const cleanup = await registerProvider(ctx, state);
    const p = makeProviderEditor();
    applyProviderTransforms(p.editor);
    const m = makeModelEditor();
    applyModelTransforms(m.editor);
    expect(m.updates.some((u) => u.modelID === "m1")).toBe(true);
    cleanup();
  });

  it("credential.switched 事件触发 provider.reload", async () => {
    let pushEvent: ((e: any) => void) | null = null;
    const { ctx, calls } = createMockCtx({
      credential: { type: "oauth", access: "tok" },
      subscription: () => (async function* () {
        while (true) {
          const next = await new Promise<any>((resolve) => { pushEvent = resolve; });
          yield next;
        }
      })(),
    });
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    let seq = 0;
    // 每次发现都返回不同模型，确保事件路径的 refresh 会真的触发 reload
    (state.discoveryCache.get as any).mockImplementation(async () => [{ id: `m${++seq}`, name: `M${seq}` }]);
    const cleanup = await registerProvider(ctx, state);
    const before = calls.reloads.provider;
    pushEvent!({ type: "credential.switched", data: { integrationID: "codebuddy", credentialID: "c1" } });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // 事件路径必须确实走到 refresh → reload；注册时的那次 reload 不算
    expect(calls.reloads.provider).toBe(before + 1);
    cleanup();
  });

  it("TTL 定时器：发现变化才 reload，cleanup 清除（M7）", async () => {
    vi.useFakeTimers();
    const initial = [{ id: "m-new", name: "New" }];
    const getSpy = vi.fn(async () => initial);
    const { ctx, calls } = createMockCtx({ credential: { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000 } });
    const state = makeTestState({ discoveryCache: { get: getSpy } as any });
    const cleanup = await registerProvider(ctx, state);
    expect(state.discovered).toBe(initial);
    const before = calls.reloads.provider;

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);   // 发现结果未变（同引用）→ 不 reload
    expect(calls.reloads.provider).toBe(before);

    const next = [{ id: "m-newer", name: "Newer" }];
    getSpy.mockResolvedValueOnce(next);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);   // 变化 → reload
    expect(state.discovered).toBe(next);
    expect(calls.reloads.provider).toBe(before + 1);

    cleanup();
    const after = calls.reloads.provider;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(calls.reloads.provider).toBe(after);
  });

  it("注册后以 provider.reload 收敛 discovery 结果（I2）", async () => {
    const { ctx, calls } = createMockCtx();
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    const cleanup = await registerProvider(ctx, state);
    expect(calls.reloads.provider).toBeGreaterThan(0);
    cleanup();
  });

  it("cleanup 释放 provider/model transform dispose（I4）", async () => {
    const { ctx, calls } = createMockCtx();
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    const cleanup = await registerProvider(ctx, state);
    cleanup();
    expect(calls.disposals.length).toBeGreaterThan(0);
    expect(calls.disposals.every((d) => d.mock.calls.length > 0)).toBe(true);
  });

  it("model transform 保留已有（用户）字段（I5）", async () => {
    const { ctx, applyModelTransforms } = createMockCtx();
    const state = makeTestState();
    state.discovered = [{ id: "m9", name: "M9", supportsToolCall: true, maxInputTokens: 1000, maxOutputTokens: 10 }];
    const cleanup = await registerProvider(ctx, state);
    const m = makeModelEditor({ name: "User Custom", limit: { context: 999, output: 1 } });
    applyModelTransforms(m.editor);
    const draft = m.drafts[0];
    expect(draft.name).toBe("User Custom");
    expect(draft.limit.context).toBe(999);
    expect(draft.capabilities.tools).toBe(true);   // 插件填充缺失键
    cleanup();
  });

  it("api key 凭证重置 discovered（M3）", async () => {
    const { ctx } = createMockCtx({ credential: { type: "key", key: "ck" } });
    const state = makeTestState();
    state.discovered = [{ id: "old-model", name: "Old" }];
    const cleanup = await registerProvider(ctx, state);
    expect(state.discovered).toEqual([DEFAULT_MODEL]);
    cleanup();
  });

  it("完全无凭证：provider 注册且模型非空（Review Focus #1）", async () => {
    const { ctx, applyProviderTransforms } = createMockCtx();
    const state = makeTestState();
    const cleanup = await registerProvider(ctx, state);
    const { editor, added } = makeProviderEditor();
    applyProviderTransforms(editor);
    expect(added).toHaveLength(1);
    expect(added[0].models.some((m: any) => m.id === "auto")).toBe(true);
    cleanup();
  });

  it("首次发现 401：回落 DEFAULT_MODEL 而非空目录", async () => {
    const { ctx } = createMockCtx({ credential: { type: "oauth", access: "tok" } });
    const state = makeTestState({
      discoveryCache: { get: vi.fn(async () => { throw Object.assign(new Error("401"), { status: 401 }); }) } as any,
    });
    const cleanup = await registerProvider(ctx, state);
    expect(state.discovered).toEqual([DEFAULT_MODEL]);
    cleanup();
  });

  it("发现暂时失败且无旧目录：回落 DEFAULT_MODEL", async () => {
    const { ctx } = createMockCtx({ credential: { type: "oauth", access: "tok" } });
    const state = makeTestState({
      discoveryCache: { get: vi.fn(async () => { throw new DiscoveryTransientError(); }) } as any,
    });
    const cleanup = await registerProvider(ctx, state);
    expect(state.discovered).toEqual([DEFAULT_MODEL]);
    cleanup();
  });

  it("切号时使切换到的账号的陈旧缓存失效", async () => {
    let push!: (e: any) => void;
    const invalidate = vi.fn();
    const get = vi.fn(async () => [DEFAULT_MODEL]);
    const { ctx } = createMockCtx({
      credential: { type: "oauth", access: "tok" },
      subscription: () => (async function* () { while (true) yield await new Promise<any>(r => { push = r; }); })(),
    });
    const state = makeTestState({ discoveryCache: { get, invalidate } as any });
    const cleanup = await registerProvider(ctx, state);
    push({ type: "credential.switched", data: { integrationID: "codebuddy", credentialID: "c2" } });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(invalidate).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith("credential:c2");
    // 必须在 refresh（即本轮 get）之前失效，否则新一轮请求会先污染缓存
    expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder.at(-1)!);
    cleanup();
  });

  it("credentialID 缺失：不失效任何账号缓存", async () => {
    let push!: (e: any) => void;
    const invalidate = vi.fn();
    const { ctx } = createMockCtx({
      credential: { type: "oauth", access: "tok" },
      subscription: () => (async function* () { while (true) yield await new Promise<any>(r => { push = r; }); })(),
    });
    const state = makeTestState({ discoveryCache: { get: vi.fn(async () => [DEFAULT_MODEL]), invalidate } as any });
    const cleanup = await registerProvider(ctx, state);
    const before = state.discoveryCache.get.mock.calls.length;
    push({ type: "credential.switched", data: { integrationID: "codebuddy", credentialID: null } });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(invalidate).not.toHaveBeenCalled();
    // credentialID 缺失只跳过失效，不得连 refresh 一起跳过。
    expect(state.discoveryCache.get.mock.calls.length).toBeGreaterThan(before);
    cleanup();
  });

  it("401 且已有旧目录：保留上一份目录", async () => {
    const keep = [{ id: "keep", name: "Keep" }];
    const { ctx } = createMockCtx({ credential: { type: "oauth", access: "tok" } });
    const state = makeTestState({
      discoveryCache: { get: vi.fn(async () => { throw Object.assign(new Error("401"), { status: 401 }); }) } as any,
    });
    state.discovered = keep;
    const cleanup = await registerProvider(ctx, state);
    expect(state.discovered).toBe(keep);
    cleanup();
  });

  it("切号后新账号首次发现失败：回落 auto，不继承旧账号目录", async () => {
    let push!: (e: any) => void;
    const get = vi.fn()
      .mockResolvedValueOnce([{ id: "a-model", name: "A" }])
      .mockRejectedValue(Object.assign(new Error("401"), { status: 401 }));
    const { ctx } = createMockCtx({
      credential: { type: "oauth", access: "tok" },
      subscription: () => (async function* () { while (true) yield await new Promise<any>(r => { push = r; }); })(),
    });
    const state = makeTestState({ discoveryCache: { get, invalidate: vi.fn() } as any });
    const cleanup = await registerProvider(ctx, state);
    expect(state.discovered).toEqual([{ id: "a-model", name: "A" }]);

    push({ type: "credential.switched", data: { integrationID: "codebuddy", credentialID: "c2" } });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // 切号必须先清空上一账号目录：新账号 401 时回落到 auto。
    expect(state.discovered).toEqual([DEFAULT_MODEL]);
    cleanup();
  });

  it("旧账号在途发现晚返回：不覆盖切换后账号的目录", async () => {
    // 只接管 setInterval：TTL 刷新可被推进，事件循环的 setTimeout 仍走真实时钟。
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let push!: (e: any) => void;
    let resolveStale!: (v: any) => void;
    const stale = new Promise<any>((r) => { resolveStale = r; });
    const get = vi.fn()
      .mockResolvedValueOnce([{ id: "a-model", name: "A" }])
      .mockImplementationOnce(() => stale)
      .mockResolvedValue([{ id: "b-model", name: "B" }]);
    const { ctx } = createMockCtx({
      credential: { type: "oauth", access: "tok" },
      subscription: () => (async function* () { while (true) yield await new Promise<any>(r => { push = r; }); })(),
    });
    const state = makeTestState({ discoveryCache: { get, invalidate: vi.fn() } as any });
    const cleanup = await registerProvider(ctx, state);
    expect(state.discovered).toEqual([{ id: "a-model", name: "A" }]);

    // TTL 刷新发起旧账号的发现请求并挂起（独立于事件循环的在途请求）。
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(get).toHaveBeenCalledTimes(2);

    // 切号：新账号立即发现成功，事件路径不等待旧请求。
    push({ type: "credential.switched", data: { integrationID: "codebuddy", credentialID: "c2" } });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(state.discovered).toEqual([{ id: "b-model", name: "B" }]);

    // 旧请求晚到：代次已变，必须整体丢弃。
    resolveStale([{ id: "a-model", name: "A" }]);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(state.discovered).toEqual([{ id: "b-model", name: "B" }]);
    cleanup();
  });

  it("发现缓存键：credential 连接用 credential:<id>", async () => {
    const get = vi.fn(async () => [DEFAULT_MODEL]);
    const { ctx } = createMockCtx({ credential: { type: "oauth", access: "tok" } });
    (ctx.integration.connection.active as any).mockResolvedValue({ type: "credential", id: "c1", label: "x" });
    const state = makeTestState({ discoveryCache: { get, invalidate: vi.fn() } as any });
    const cleanup = await registerProvider(ctx, state);
    expect(get.mock.calls[0][0]).toBe("credential:c1");
    cleanup();
  });

  it("发现缓存键：env 连接用 env:<name>", async () => {
    const get = vi.fn(async () => [DEFAULT_MODEL]);
    const { ctx } = createMockCtx({ credential: { type: "oauth", access: "tok" } });
    (ctx.integration.connection.active as any).mockResolvedValue({ type: "env", name: "CODEBUDDY_API_KEY" });
    const state = makeTestState({ discoveryCache: { get, invalidate: vi.fn() } as any });
    const cleanup = await registerProvider(ctx, state);
    expect(get.mock.calls[0][0]).toBe("env:CODEBUDDY_API_KEY");
    cleanup();
  });

  it("发现缓存键：无连接身份时用 token 指纹，且不含原始 token", async () => {
    const token = "raw-secret-token-text";
    const get = vi.fn(async () => [DEFAULT_MODEL]);
    const { ctx } = createMockCtx({ credential: { type: "oauth", access: token } });
    (ctx.integration.connection.active as any).mockResolvedValue({ type: "unknown" });
    const state = makeTestState({ discoveryCache: { get, invalidate: vi.fn() } as any });
    const cleanup = await registerProvider(ctx, state);
    const key = get.mock.calls[0][0] as string;
    expect(key.startsWith("credential:")).toBe(true);
    expect(key).not.toContain(token);
    cleanup();
  });
});

describe("modelFingerprint", () => {
  it("同 ID 但 limit 变化 → 触发 reload", async () => {
    vi.useFakeTimers();
    const get = vi.fn()
      .mockResolvedValueOnce([{ id: "same", name: "M", maxInputTokens: 1000 }])
      .mockResolvedValue([{ id: "same", name: "M", maxInputTokens: 2000 }]);
    const { ctx, calls } = createMockCtx({ credential: { type: "oauth", access: "tok" } });
    const state = makeTestState({ discoveryCache: { get } as any });
    const cleanup = await registerProvider(ctx, state);
    const before = calls.reloads.provider;
    await vi.advanceTimersByTimeAsync(300001);
    expect(state.discovered?.[0].maxInputTokens).toBe(2000);
    expect(calls.reloads.provider).toBe(before + 1);
    cleanup(); vi.useRealTimers();
  });

  it("同 ID 但 supportedEfforts 变化 → 触发 reload", async () => {
    vi.useFakeTimers();
    const get = vi.fn()
      .mockResolvedValueOnce([{ id: "same", name: "M", supportsReasoning: true, reasoning: { supportedEfforts: ["low", "high"] } }])
      .mockResolvedValue([{ id: "same", name: "M", supportsReasoning: true, reasoning: { supportedEfforts: ["low", "high", "max"] } }]);
    const { ctx, calls } = createMockCtx({ credential: { type: "oauth", access: "tok" } });
    const state = makeTestState({ discoveryCache: { get } as any });
    const cleanup = await registerProvider(ctx, state);
    const before = calls.reloads.provider;
    await vi.advanceTimersByTimeAsync(300001);
    expect(calls.reloads.provider).toBe(before + 1);
    cleanup(); vi.useRealTimers();
  });

  it("完全无变化 → 不 reload", () => {
    const a = [{ id: "x", name: "X", maxInputTokens: 1, reasoning: { supportedEfforts: ["low"] } }];
    const b = [{ id: "x", name: "X", maxInputTokens: 1, reasoning: { supportedEfforts: ["low"] } }];
    expect(modelFingerprint(a as any)).toBe(modelFingerprint(b as any));
  });

  it("结构相同但引用不同 → refresh 端到端不 reload", async () => {
    vi.useFakeTimers();
    const make = () => [{ id: "same", name: "M", maxInputTokens: 1000, reasoning: { supportedEfforts: ["low"] } }];
    const get = vi.fn(async () => make());
    const { ctx, calls } = createMockCtx({ credential: { type: "oauth", access: "tok" } });
    const state = makeTestState({ discoveryCache: { get } as any });
    const cleanup = await registerProvider(ctx, state);
    const before = calls.reloads.provider;
    const firstRef = state.discovered;
    await vi.advanceTimersByTimeAsync(300001);
    expect(state.discovered).not.toBe(firstRef);   // 确实重新发现过（新引用）
    expect(calls.reloads.provider).toBe(before);    // 但指纹相同 → 不 reload
    cleanup(); vi.useRealTimers();
  });

  it("缺失字段与显式 undefined 指纹相同；null 输入为空串", () => {
    expect(modelFingerprint([{ id: "x", name: "X" }] as any))
      .toBe(modelFingerprint([{ id: "x", name: "X", maxInputTokens: undefined, reasoning: undefined }] as any));
    expect(modelFingerprint(null)).toBe("");
  });
});
