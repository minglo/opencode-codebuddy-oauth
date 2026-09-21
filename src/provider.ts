// src/provider.ts
import { Model, Provider } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin";
import { DISCOVERY_CACHE_TTL_MS, PROVIDER_ID, domainForHost } from "./config.js";
import { resolveCredential } from "./credentials.js";
import { DEFAULT_MODEL, buildVariants, type RemoteModel } from "./models.js";
import type { PluginState } from "./state.js";

const BASE_PACKAGE = "@opencode/ai/providers/openai-compatible";

export function remoteModelToInfo(m: RemoteModel, providerID: string = PROVIDER_ID): Model.Info {
  const pid = Provider.ID.make(providerID);
  const base = Model.Info.default(pid, Model.ID.make(m.id)) as any;
  const info: any = {
    ...base,
    name: m.name,
    capabilities: {
      ...base.capabilities,
      tools: m.supportsToolCall !== false,
      // base 默认 input 含 "image"（实测 Model.Info.default），不支持时必须移除
      input: m.supportsImages && !m.disabledMultimodal
        ? Array.from(new Set([...base.capabilities.input, "image"]))
        : base.capabilities.input.filter((x: string) => x !== "image"),
    },
    // V1 setCacheKey 的 V2 对应（e2e #12 验证等价性）
    compatibility: { ...base.compatibility, supportsPromptCacheKey: true },
  };
  const contextLimit = m.maxAllowedSize ?? m.maxInputTokens ?? 0;
  const outputLimit = m.maxOutputTokens ?? 0;
  if (contextLimit || outputLimit) {
    info.limit = {
      ...base.limit,
      context: contextLimit || base.limit.context,
      output: outputLimit || base.limit.output,
    };
  }
  if (m.supportsReasoning) {
    info.compatibility = {
      ...info.compatibility,
      reasoningField: "reasoning_content",
      requireReasoning: true,   // 等价 V1 11155 body 补空（e2e #15 验证是否可删 http.request 兜底）
    };
    const efforts = m.reasoning?.supportedEfforts;
    if (efforts?.length) {
      info.variants = Object.entries(buildVariants(efforts)).map(([id, settings]) => ({
        id: Model.VariantID.make(id),
        settings,
      }));
    }
    const effort = m.reasoning?.defaultEffort ?? m.reasoning?.effort;
    if (effort) info.settings = { ...base.settings, reasoningEffort: effort };
  }
  return info as Model.Info;
}

export async function registerProvider(ctx: Plugin.Context, state: PluginState): Promise<() => void> {
  await load(ctx, state);
  await ctx.provider.transform((editor) => applyProvider(editor, state));
  await ctx.model.transform((editor) => applyModels(editor, state));

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const e = event as any;
        if (e?.type !== "credential.switched" && e?.type !== "credential.updated") continue;
        if (e.type === "credential.switched" && e.data?.integrationID !== PROVIDER_ID) continue;
        await load(ctx, state).catch(() => {});
        await ctx.provider.reload().catch(() => {});
      }
    } catch { /* abort 或流结束 */ }
  })();

  const timer = setInterval(() => { void refresh(ctx, state); }, DISCOVERY_CACHE_TTL_MS);
  return () => { controller.abort(); clearInterval(timer); };
}

async function refresh(ctx: Plugin.Context, state: PluginState): Promise<void> {
  await load(ctx, state).catch(() => {});
  await ctx.provider.reload().catch(() => {});
}

async function load(ctx: Plugin.Context, state: PluginState): Promise<void> {
  const credential = await resolveCredential(ctx, state);
  if (!credential || credential.type !== "oauth" || !credential.access) {
    state.discovered = state.discovered ?? [DEFAULT_MODEL];
    return;
  }
  try {
    state.discovered = await state.discoveryCache.get(credential.access, { signal: undefined });
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) {
      state.logger.warn("discovery 401/403 — 需重新登录（/connect codebuddy）");
      state.discovered = state.discovered ?? [];
    } else {
      state.logger.warn(`discovery failed: ${e?.message}`);
      state.discovered = state.discovered ?? [DEFAULT_MODEL];
    }
  }
}

function applyProvider(editor: any, state: PluginState): void {
  const existing = editor.get(PROVIDER_ID);
  const configuredBase = existing?.provider?.settings?.baseURL;
  if (!state.cfg.endpoint && state.cfg.network === "internal" && typeof configuredBase === "string") {
    try {
      const u = new URL(configuredBase);
      state.server = { url: `${u.protocol}//${u.host}`, domain: domainForHost(u.host) };
    } catch { /* 无效 URL：保持 env/默认 server */ }
  }

  const base = Provider.Info.empty(Provider.ID.make(PROVIDER_ID));
  const info: any = {
    ...base,
    name: "CodeBuddy",
    activation: "enabled",
    package: BASE_PACKAGE,
    settings: { baseURL: `${state.server.url}/v2`, apiKey: "codebuddy" },
    integrationID: PROVIDER_ID,
  };

  if (existing) {
    editor.update(PROVIDER_ID, (p: any) => {
      p.name = info.name;
      p.settings = { ...p.settings, ...info.settings };
      p.integrationID = PROVIDER_ID;
    });
  } else {
    editor.add({ info, models: modelsFor(state) });
  }
}

function modelsFor(state: PluginState): any[] {
  return (state.discovered ?? [DEFAULT_MODEL]).map((m) => remoteModelToInfo(m));
}

function applyModels(editor: any, state: PluginState): void {
  for (const m of state.discovered ?? [DEFAULT_MODEL]) {
    editor.update(PROVIDER_ID, m.id, (draft: any) => { Object.assign(draft, remoteModelToInfo(m)); });
  }
}
