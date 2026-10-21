// src/credentials.ts — 胶水层共享：从 integration 解析当前凭证（requests 与 provider 共用）
import type { Plugin } from "@opencode/plugin";
import { PROVIDER_ID } from "./config.js";
import { accountKeyOf, tokenFingerprint } from "./key.js";
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

export interface ResolvedConnectionIdentity {
  credential: ResolvedCredential;
  accountKey: string;
}

// 凭证 + 缓存身份一起解析：accountKey 按连接（credential:<id> / env:<name>）隔离，
// 拿不到连接身份时退回 token 指纹，绝不把原始 token 放进缓存键。
export async function resolveConnectionIdentity(
  ctx: Plugin.Context,
  state: PluginState,
): Promise<ResolvedConnectionIdentity | undefined> {
  try {
    const connection = await ctx.integration.connection.active(PROVIDER_ID);
    if (!connection) return undefined;
    const value = (await ctx.integration.connection.resolve(connection)) as ResolvedCredential | undefined;
    if (!value) return undefined;
    const accountKey = accountKeyOf(connection)
      ?? (value.access ? `credential:${tokenFingerprint(value.access)}` : undefined);
    if (!accountKey) return undefined;
    return { credential: value, accountKey };
  } catch (e) {
    state.logger.warn(`credential resolve failed: ${(e as Error).message}`);
    return undefined;
  }
}
