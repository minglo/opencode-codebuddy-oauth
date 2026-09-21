// src/provider.ts
import { Model, Provider } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin";
import { PROVIDER_ID } from "./config.js";
import { buildVariants, type RemoteModel } from "./models.js";
import type { PluginState } from "./state.js";

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

export async function registerProvider(_ctx: Plugin.Context, _state: PluginState): Promise<() => void> {
  return () => {};
}
