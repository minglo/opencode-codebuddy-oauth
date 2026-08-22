import * as os from "os";
import * as path from "path";

export const PROVIDER_ID = "codebuddy";
export const CHAT_COMPLETIONS_PATH = "/v2/chat/completions";
export const PLATFORM = "VSCode";
export const APP_VERSION = "4.9.29177644";
export const IDE_NAME = "VSCode";
export const IDE_TYPE = "VSCode";
export const IDE_VERSION = "1.119.0";
export const DOMAIN_DEFAULT = "www.codebuddy.cn";
export const PRODUCT = "SaaS";
export const AGENT_INTENT = "craft";
export const ENV_ID = "production";
export const DISCOVERY_TIMEOUT_MS = 5000;
export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 8000;
export const POLL_TOTAL_TIMEOUT_MS = 10*60*1000;
export const AUTH_STATE_TIMEOUT_MS = 5000;
export const REFRESH_TIMEOUT_MS = 5000;
export const REFRESH_SKEW_MS = 5*60*1000;
export const DEFAULT_EXPIRES_MS = 24*60*60*1000;
export const DISCOVERY_CACHE_TTL_MS = 5*60*1000;

export interface CodeBuddyConfig {
  endpoint?: string; network: "internal"|"ioa"|"internet"; auth: "auto"|"oauth"|"api";
  model?: string; stableConversationId: boolean; conversationMapMax: number;
  sse: { enabled:boolean; threshold:number; maxDelayMs:number };
  tenantId?:string; enterpriseId?:string; userId?:string;
  apiKey?:string; platform:string; appVersion:string; ideName:string; ideType:string; ideVersion:string;
  domain:string; product:string; agentIntent:string; envId:string;
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

export function getConfig(): CodeBuddyConfig {
  return {
    endpoint: process.env.CODEBUDDY_ENDPOINT || "",
    network: (process.env.CODEBUDDY_NETWORK || "internal").toLowerCase() as CodeBuddyConfig["network"],
    auth: (process.env.CODEBUDDY_AUTH || "auto").toLowerCase() as CodeBuddyConfig["auth"],
    model: process.env.CODEBUDDY_MODEL || "",
    stableConversationId: process.env.CODEBUDDY_STABLE_CONVERSATION !== "0",
    conversationMapMax: num(process.env.CODEBUDDY_CONVERSATION_MAP_MAX, 1000),
    sse: {
      enabled: process.env.CODEBUDDY_SSE !== "0",
      threshold: num(process.env.CODEBUDDY_SSE_THRESHOLD, 24),
      maxDelayMs: num(process.env.CODEBUDDY_SSE_DELAY_MS, 40),
    },
    tenantId: process.env.CODEBUDDY_TENANT_ID || "",
    enterpriseId: process.env.CODEBUDDY_ENTERPRISE_ID || "",
    userId: process.env.CODEBUDDY_USER_ID || "",
    apiKey: process.env.CODEBUDDY_API_KEY || "",
    platform: PLATFORM, appVersion: APP_VERSION, ideName: IDE_NAME, ideType: IDE_TYPE, ideVersion: IDE_VERSION,
    domain: DOMAIN_DEFAULT, product: PRODUCT, agentIntent: AGENT_INTENT, envId: ENV_ID,
  };
}

export function domainForHost(url: string): string {
  try { return new URL(url).host.includes("codebuddy.ai") ? "www.codebuddy.ai" : "www.codebuddy.cn"; } catch { return url.includes("codebuddy.ai") ? "www.codebuddy.ai" : "www.codebuddy.cn"; }
}

export function resolveServerUrl(cfg: Pick<CodeBuddyConfig,"endpoint"|"network">): { url:string; domain:string } {
  if (cfg.endpoint) {
    const url = cfg.endpoint.replace(/\/+$/, "");
    return { url, domain: domainForHost(url) };
  }
  if (cfg.network === "internal" || cfg.network === "ioa") return { url: "https://copilot.tencent.com", domain: "www.codebuddy.cn" };
  return { url: "https://www.codebuddy.ai", domain: "www.codebuddy.ai" };
}

export function getAuthJsonPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "opencode", "auth.json");
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(base, "opencode", "auth.json");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdg, "opencode", "auth.json");
}