// src/provider.ts
import { Model, Provider } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import type { ModelEditor } from "@opencode/plugin/promise/model";
import { DISCOVERY_CACHE_TTL_MS, PROVIDER_ID, domainForHost } from "./config.js";
import { resolveConnectionIdentity } from "./credentials.js";
import { accountKeyOf } from "./key.js";
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
      // base 默认 input 含 "image"，不支持时必须移除
      input: m.supportsImages && !m.disabledMultimodal
        ? Array.from(new Set([...base.capabilities.input, "image"]))
        : base.capabilities.input.filter((x: string) => x !== "image"),
    },
    // 等价 V1 setCacheKey
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
      requireReasoning: true,   // 历史 assistant 消息缺 reasoning_content 时由核心补空（上游 11155 要求）
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
  const registrations: Array<{ dispose: () => Promise<void> }> = [];
  // provider transform 须先注册：真实宿主注册即执行回调（configuredBase 覆写 server），
  // 之后的 discovery 才会用覆写后的 server
  registrations.push(await ctx.provider.transform((editor) => applyProvider(editor, state)));
  await load(ctx, state);
  await ctx.provider.reload().catch(() => {});   // 用 discovery 结果重建 provider 的 models
  registrations.push(await ctx.model.transform((editor) => applyModels(editor, state)));

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const e = event as any;
        if (e?.type !== "credential.switched" && e?.type !== "credential.updated") continue;
        if (e.type === "credential.switched" && e.data?.integrationID !== PROVIDER_ID) continue;
        // 凭证事件先推进代次：任何尚未返回的旧发现结果都必须在 load() 中被丢弃。
        state.epoch += 1;
        if (e.type === "credential.switched") {
          // 切换到的账号的陈旧缓存必须在 refresh 之前失效；没有 credentialID 就不猜
          const switchedKey = accountKeyOf({ type: "credential", id: e.data?.credentialID });
          if (switchedKey) state.discoveryCache.invalidate(switchedKey);
          // 清空上一账号目录：新账号首次发现失败时回落 auto，而不是继承旧目录。
          state.discovered = null;
        }
        await refresh(ctx, state);
      }
    } catch { /* abort 或流结束 */ }
  })();

  const timer = setInterval(() => { void refresh(ctx, state); }, DISCOVERY_CACHE_TTL_MS);
  return () => {
    controller.abort();
    clearInterval(timer);
    for (const r of registrations) void r.dispose();
  };
}

/**
 * 模型定义指纹：覆盖会改变 provider 行为的全部元数据，字段顺序固定。
 * 仅 id 相同但 limit/能力/档位变化时也必须重建 provider 的 models。
 * supportedEfforts 按原序比较（顺序即 UI 档位顺序）。
 */
export function modelFingerprint(models: RemoteModel[] | null): string {
  if (!models) return "";
  return JSON.stringify(models.map((m) => [
    m.id,
    m.name,
    m.maxInputTokens,
    m.maxOutputTokens,
    m.maxAllowedSize,
    m.supportsToolCall,
    m.supportsImages,
    m.supportsReasoning,
    m.disabledMultimodal,
    m.reasoning?.effort,
    m.reasoning?.defaultEffort,
    m.reasoning?.supportedEfforts,
  ]));
}

async function refresh(ctx: Plugin.Context, state: PluginState): Promise<void> {
  const before = state.discovered;
  await load(ctx, state).catch(() => {});
  if (modelFingerprint(before) !== modelFingerprint(state.discovered)) await ctx.provider.reload().catch(() => {});   // 模型未变化时不重建
}

async function load(ctx: Plugin.Context, state: PluginState): Promise<void> {
  // 捕获代次：本次发现若跨过了一次凭证事件，其结果属于旧账号，必须整体丢弃。
  const epoch = state.epoch;
  const resolved = await resolveConnectionIdentity(ctx, state);
  if (state.epoch !== epoch) return;
  if (!resolved) {
    // api 模式/无凭证：不发现，重置为 DEFAULT_MODEL
    state.discovered = [DEFAULT_MODEL];
    return;
  }
  if (resolved.credential.type !== "oauth" || !resolved.credential.access) {
    state.discovered = [DEFAULT_MODEL];
    return;
  }
  try {
    const models = await state.discoveryCache.get(resolved.accountKey, resolved.credential.access, { signal: undefined });
    // 成功结果同样要验代次：A 的在途请求晚于切到 B 返回时，不得覆盖 B 的目录。
    if (state.epoch !== epoch) return;
    state.discovered = models;
  } catch (e: any) {
    if (state.epoch !== epoch) return;
    if (e?.status === 401 || e?.status === 403) {
      state.logger.warn("discovery 401/403 — 需重新登录（/connect codebuddy）");
    } else {
      state.logger.warn(`discovery failed: ${e?.message}`);
    }
    // 失败绝不产生空目录：保留上一份真实目录，没有就回落 DEFAULT_MODEL
    state.discovered = state.discovered?.length ? state.discovered : [DEFAULT_MODEL];
  }
}

function applyProvider(editor: ProviderEditor, state: PluginState): void {
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

function applyModels(editor: ModelEditor, state: PluginState): void {
  for (const m of state.discovered ?? [DEFAULT_MODEL]) {
    editor.update(PROVIDER_ID, m.id, (draft: any) => {
      const info = remoteModelToInfo(m) as any;
      // 已有（用户）配置优先，仅填充缺失键
      for (const [k, v] of Object.entries(info)) {
        if (draft[k] === undefined) draft[k] = v;
      }
    });
  }
}
