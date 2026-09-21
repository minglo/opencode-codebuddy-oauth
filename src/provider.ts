// src/provider.ts
import type { Plugin } from "@opencode/plugin";
import type { PluginState } from "./state.js";

export async function registerProvider(_ctx: Plugin.Context, _state: PluginState): Promise<() => void> {
  return () => {};
}
