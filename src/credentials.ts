// src/credentials.ts — 胶水层共享：从 integration 解析当前凭证（requests 与 provider 共用）
import type { Plugin } from "@opencode/plugin";
import { PROVIDER_ID } from "./config.js";
import type { PluginState } from "./state.js";

export interface ResolvedCredential {
  type: "oauth" | "key";
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
}

export async function resolveCredential(
  ctx: Plugin.Context,
  state: PluginState,
): Promise<ResolvedCredential | undefined> {
  try {
    const connection = await ctx.integration.connection.active(PROVIDER_ID);
    if (!connection) return undefined;
    const value = await ctx.integration.connection.resolve(connection);
    return value as ResolvedCredential | undefined;
  } catch (e) {
    state.logger.warn(`credential resolve failed: ${(e as Error).message}`);
    return undefined;
  }
}
