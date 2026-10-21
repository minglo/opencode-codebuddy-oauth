import { fetchJson } from "./fetch-json.js";
import { AGENT_INTENT, DISCOVERY_TIMEOUT_MS, IDE_NAME, IDE_TYPE, IDE_VERSION, APP_VERSION, ENV_ID, PRODUCT } from "./config.js";
export interface RemoteModel { id:string; name:string; maxInputTokens?:number; maxOutputTokens?:number; maxAllowedSize?:number; supportsToolCall?:boolean; supportsImages?:boolean; supportsReasoning?:boolean; disabledMultimodal?:boolean; reasoning?:{ effort?:string; defaultEffort?:string; supportedEfforts?:string[] }; }
export const DEFAULT_MODEL: RemoteModel = { id:"auto", name:"Auto", maxInputTokens:168000, maxOutputTokens:32000, supportsToolCall:true };

export interface RemoteConfigResponse { code:number; data?:{ agents?:Array<{name:string; models?:string[]}>; models?:RemoteModel[] } }

export type DiscoveryResult =
  | { ok: true; models: RemoteModel[] }
  | { ok: false; status?: number };

export class DiscoveryTransientError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "DiscoveryTransientError";
    this.status = status;
  }
}

export async function fetchRemoteModels(
  accessToken: string,
  server: { url: string; domain: string },
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  const headers: Record<string,string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Agent-Intent": AGENT_INTENT,
    "X-IDE-Type": IDE_TYPE, "X-IDE-Name": IDE_NAME, "X-IDE-Version": IDE_VERSION,
    "X-Product-Version": APP_VERSION, "X-Env-ID": ENV_ID,
    "X-Domain": server.domain, "X-Product": PRODUCT,
    "User-Agent": `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${APP_VERSION}`,
  };
  const res = await fetchJson<RemoteConfigResponse>(`${server.url}/v3/config`, {
    headers, timeoutMs: DISCOVERY_TIMEOUT_MS, signal,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new DiscoveryTransientError(`discovery ${res.status}`, res.status);
    }
    return res.status === undefined
      ? { ok: false }
      : { ok: false, status: res.status };
  }
  const body = res.data;
  if (!body || body.code !== 0 || !body.data) return { ok: false };
  const allModels = body.data.models || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const craftAgent = (body.data.agents || []).find((a) => a.name === AGENT_INTENT);
  const craftIds = craftAgent?.models || [];
  if (craftIds.length === 0) return { ok: true, models: [DEFAULT_MODEL] };
  const filtered = craftIds
    .map((id) => modelMap.get(id))
    .filter((m): m is RemoteModel => m !== undefined && m.supportsToolCall !== false);
  return { ok: true, models: filtered.length === 0 ? [DEFAULT_MODEL] : filtered };
}

// variants 直通映射：UI 档位 = 上游 supportedEfforts 原样暴露。
// 实测 codebuddy /v3/config 返回 low/high/xhigh/max（无 medium）；历史归一（medium→high、xhigh→max）
// 会丢失真实档位并制造上游不存在的 medium 档，故不归一。
export function buildVariants(efforts: string[]): Record<string, { reasoningEffort: string }> {
  const variants: Record<string, { reasoningEffort: string }> = {};
  for (const e of efforts) variants[e] = { reasoningEffort: e };
  return variants;
}

export class DiscoveryCache {
  private entries = new Map<string, { data: RemoteModel[]; fetchedAt: number }>();
  private inflight = new Map<string, Promise<RemoteModel[]>>();
  private generation = new Map<string, number>();
  private readonly fetchFn: (token: string, signal?: AbortSignal) => Promise<DiscoveryResult>;
  constructor(private opts: { ttlMs:number; fetchFn: (token: string, signal?: AbortSignal)=>Promise<DiscoveryResult> }) { this.fetchFn = opts.fetchFn; }

  async get(accountKey: string, token: string, { signal }: { signal?:AbortSignal }): Promise<RemoteModel[]> {
    const now = Date.now();
    const cached = this.entries.get(accountKey);
    if (cached && (now - cached.fetchedAt) < this.opts.ttlMs) return cached.data;

    const existing = this.inflight.get(accountKey);
    if (existing) return existing;

    const gen = this.generation.get(accountKey) ?? 0;
    const p = this.load(accountKey, token, signal, gen);
    this.inflight.set(accountKey, p);
    // 清理与调用方无关，单独挂 catch 避免产生 unhandled rejection。
    void p.finally(() => {
      if (this.inflight.get(accountKey) === p) this.inflight.delete(accountKey);
    }).catch(() => {});
    return p;
  }

  private async load(accountKey: string, token: string, signal: AbortSignal | undefined, gen: number): Promise<RemoteModel[]> {
    try {
      const result = await this.fetchFn(token, signal);
      if (!result.ok) {
        throw new DiscoveryTransientError(
          `discovery ${result.status ?? "network"}`,
          result.status,
        );
      }
      if ((this.generation.get(accountKey) ?? 0) === gen) {
        this.entries.set(accountKey, { data: result.models, fetchedAt: Date.now() });
      }
      return result.models;
    } catch (e) {
      if ((e as any)?.status === 401 || (e as any)?.status === 403) throw e;
      const previous = this.entries.get(accountKey);
      if (previous) return previous.data;
      return [DEFAULT_MODEL];
    }
  }

  invalidate(accountKey: string): void {
    this.entries.delete(accountKey);
    // 同时丢弃在途单飞：否则 invalidate 之后的 get() 会复用失效前的 promise。
    this.inflight.delete(accountKey);
    this.generation.set(accountKey, (this.generation.get(accountKey) ?? 0) + 1);
  }
}