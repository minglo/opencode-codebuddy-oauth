// src/key.ts — 连接身份（accountKey）与 token 指纹：缓存按账号隔离，键中绝不出现原始 token
import { createHash } from "node:crypto";

// 与宿主 IntegrationConnection.key 保持一致的形状（type/id/name 三字段即可）
export interface ConnectionIdentity {
  readonly type?: string;
  readonly id?: string;
  readonly name?: string;
}

export function accountKeyOf(connection: ConnectionIdentity | undefined | null): string | undefined {
  if (!connection) return undefined;
  if (connection.type === "credential") return connection.id ? `credential:${connection.id}` : undefined;
  if (connection.type === "env") return connection.name ? `env:${connection.name}` : undefined;
  return undefined;
}

// 仅当拿不到连接身份时的兜底：sha256 前 16 位十六进制
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}
