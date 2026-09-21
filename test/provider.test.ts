import { describe, it, expect } from "vitest";
import { remoteModelToInfo } from "../src/provider.js";

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

  it("reasoning：compatibility + variants 归一（medium→high、max 唯一高档）", () => {
    const info: any = remoteModelToInfo({
      id: "m2", name: "M2", supportsToolCall: true, supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
    });
    expect(info.compatibility.reasoningField).toBe("reasoning_content");
    expect(info.compatibility.requireReasoning).toBe(true);
    const ids = info.variants.map((v: any) => v.id);
    expect(ids).toEqual(["low", "medium", "high", "max"]);
    const byId = Object.fromEntries(info.variants.map((v: any) => [v.id, v.settings.reasoningEffort]));
    expect(byId.medium).toBe("medium");
    expect(byId.high).toBe("high");
    expect(byId.max).toBe("max");
  });

  it("无 images 时 input 不含 image", () => {
    const info: any = remoteModelToInfo({ id: "m3", name: "M3", supportsToolCall: true });
    expect(info.capabilities.input).not.toContain("image");
  });
});

import { vi, afterEach } from "vitest";
import { registerProvider } from "../src/provider.js";
import { createMockCtx, jsonResponse, makeProviderEditor, makeModelEditor, makeTestState } from "./helpers/mock-ctx.js";
import { DiscoveryCache, DEFAULT_MODEL } from "../src/models.js";

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
      discoveryCache: new DiscoveryCache({ ttlMs: 60_000, fetchFn: (token) => (globalThis.fetch as any)(`https://copilot.tencent.com/v3/config?t=${token}`).then((r: Response) => r.json()).then((b: any) => b.data.models) }),
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
      subscription: () => (async function* () {
        while (true) {
          const next = await new Promise<any>((resolve) => { pushEvent = resolve; });
          yield next;
        }
      })(),
    });
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    const cleanup = await registerProvider(ctx, state);
    pushEvent!({ type: "credential.switched", data: { integrationID: "codebuddy", credentialID: "c1" } });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.reloads.provider).toBeGreaterThan(0);
    cleanup();
  });

  it("TTL 定时器触发刷新，cleanup 清除", async () => {
    vi.useFakeTimers();
    const { ctx, calls } = createMockCtx();
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    const cleanup = await registerProvider(ctx, state);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(calls.reloads.provider).toBeGreaterThan(0);
    cleanup();
    const before = calls.reloads.provider;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(calls.reloads.provider).toBe(before);
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
});
