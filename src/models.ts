import { fetchJson } from "./fetch-json.js";
import { AGENT_INTENT, DISCOVERY_TIMEOUT_MS, IDE_NAME, IDE_TYPE, IDE_VERSION, APP_VERSION, ENV_ID, PRODUCT } from "./config.js";
export interface RemoteModel { id:string; name:string; maxInputTokens?:number; maxOutputTokens?:number; maxAllowedSize?:number; supportsToolCall?:boolean; supportsImages?:boolean; supportsReasoning?:boolean; disabledMultimodal?:boolean; reasoning?:{ effort?:string; defaultEffort?:string; supportedEfforts?:string[] }; }
export const DEFAULT_MODEL: RemoteModel = { id:"auto", name:"Auto", maxInputTokens:168000, maxOutputTokens:32000, supportsToolCall:true };

export interface RemoteConfigResponse { code:number; data?:{ agents?:Array<{name:string; models?:string[]}>; models?:RemoteModel[] } }
export async function fetchRemoteModels(
  accessToken: string,
  server: { url: string; domain: string },
  signal?: AbortSignal,
): Promise<RemoteModel[]> {
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
      const e = new Error(`discovery ${res.status}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    return [];
  }
  const body = res.data;
  if (!body || body.code !== 0 || !body.data) return [];
  const allModels = body.data.models || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const craftAgent = (body.data.agents || []).find((a) => a.name === AGENT_INTENT);
  const craftIds = craftAgent?.models || [];
  if (craftIds.length === 0) return [DEFAULT_MODEL];
  return craftIds
    .map((id) => modelMap.get(id))
    .filter((m): m is RemoteModel => m !== undefined && m.supportsToolCall !== false);
}

export function remoteModelToConfig(m: RemoteModel): Record<string,unknown> {
  const entry: Record<string,unknown> = { name: m.name, tool_call: m.supportsToolCall !== false, attachment: !!(m.supportsImages && !m.disabledMultimodal) };
  const ctx = m.maxAllowedSize ?? m.maxInputTokens ?? 0;
  const out = m.maxOutputTokens ?? 0;
  if (ctx || out) entry.limit = { context: ctx, output: out };
  if (!m.supportsReasoning) return entry;
  entry.reasoning = true;
  entry.interleaved = { field: "reasoning_content" };
  const effort = m.reasoning?.defaultEffort ?? m.reasoning?.effort;
  if (effort) entry.options = { reasoningEffort: effort };
  const efforts = m.reasoning?.supportedEfforts;
  if (efforts?.length) {
    // variants 键 = UI 档名（opencode 核心按键渲染、并向缺失标准档位补全，故固定补全到 low/medium/high/max）。
    // 值 = 请求体 reasoning_effort，按 deepseek 官方映射（api-docs.deepseek.com/zh-cn/guides/thinking_mode）归一：
    //   medium→high, xhigh→high；max 是唯一真正高出 high 的档（CodeBuddy metadata 的 xhigh 是 max 的展示名，非独立档）。
    const order = ["low", "medium", "high", "max"];
    const variants: Record<string, { reasoningEffort: string }> = {};
    const pick = (...cands: string[]) => cands.find(c => efforts.includes(c));
    for (const e of order) {
      if (e === "medium") {
        const hit = pick("medium", "high", "low");
        if (hit) variants.medium = { reasoningEffort: hit };
        continue;
      }
      if (e === "max") {
        // 实测（codebuddy 网关，thinking_tokens）：high/xhigh≈1-4k（同档），max≈8.5k（高 3-5 倍）。
        // metadata 含 xhigh/max 即发 "max"，否则不设此键。
        if (pick("max") ?? pick("xhigh")) variants.max = { reasoningEffort: "max" };
        continue;
      }
      const hit = pick(e);
      if (hit) variants[e] = { reasoningEffort: hit };
    }
    entry.variants = variants;
  }
  return entry;
}
export function mergeModelEntry(auto: Record<string,unknown>, existing: Record<string,unknown>): Record<string,unknown> {
  const merged: Record<string,unknown> = { ...auto, ...existing };
  if (auto.limit !== undefined && existing.limit !== undefined) merged.limit = { ...(auto.limit as object), ...(existing.limit as object) };
  if (auto.options !== undefined && existing.options !== undefined) merged.options = { ...(auto.options as object), ...(existing.options as object) };
  if (auto.variants !== undefined && existing.variants !== undefined) merged.variants = { ...(auto.variants as object), ...(existing.variants as object) };
  if (existing.reasoning === false) { delete (merged as any).interleaved; delete (merged as any).options; }
  return merged;
}
export class DiscoveryCache {
  private data: RemoteModel[] | null = null;
  private fetchedAt = 0;
  private inflight: Promise<RemoteModel[]> | null = null;
  private readonly fetchFn: (token: string, signal?: AbortSignal) => Promise<RemoteModel[]>;
  constructor(private opts: { ttlMs:number; fetchFn: (token: string, signal?: AbortSignal)=>Promise<RemoteModel[]> }) { this.fetchFn = opts.fetchFn; }
  async get(token:string, { signal }: { signal?:AbortSignal }): Promise<RemoteModel[]> {
    const now = Date.now();
    if (this.data && (now - this.fetchedAt) < this.opts.ttlMs) return this.data;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchFn(token, signal).then(d => { this.data = d; this.fetchedAt = Date.now(); return d; }).catch(e => {
      if ((e as any)?.status === 401 || (e as any)?.status === 403) throw e;
      if (!this.data) { this.data = [DEFAULT_MODEL]; this.fetchedAt = now; return this.data; }
      return this.data;
    }).finally(() => { this.inflight = null; });
    if (this.data) { this.inflight.catch(() => {}); return this.data; }
    return this.inflight;
  }
}