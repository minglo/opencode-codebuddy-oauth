// src/auth-flow.ts
import { fetchJson } from "./fetch-json.js";
import { AUTH_STATE_TIMEOUT_MS, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, REFRESH_TIMEOUT_MS, PLATFORM, PROVIDER_ID } from "./config.js";

export function sleep(ms:number): Promise<void> { return new Promise(r=>setTimeout(r,ms)); }

export class RefreshLock {
  private inflight = new Map<string, Promise<unknown>>();
  async run<T>(key:string, fn:()=>Promise<T>): Promise<T> {
    const hit = this.inflight.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const p = fn().finally(()=> this.inflight.delete(key));
    this.inflight.set(key, p as Promise<unknown>);
    return p;
  }
}

export async function requestAuthState(serverUrl:string): Promise<{ state:string; url:string }> {
  const url = `${serverUrl}/v2/plugin/auth/state?platform=${PLATFORM}&ioa=1`;
  const res = await fetchJson<{code:number; data?:{state:string; authUrl?:string}}>(url, {
    method:"POST",
    headers:{ Accept:"application/json", "Content-Type":"application/json", "X-No-Authorization":"true", "X-No-User-Id":"true", "X-No-Enterprise-Id":"true", "X-No-Department-Info":"true" },
    timeoutMs: AUTH_STATE_TIMEOUT_MS,
  });
  if (!res.ok || res.data.code !== 0 || !res.data.data?.state) throw new Error(`Auth state failed: ${JSON.stringify(res)}`);
  const state = res.data.data.state;
  const authUrl = res.data.data.authUrl || `${serverUrl}/login?platform=${PLATFORM}&state=${state}&ioa=1`;
  return { state, url: authUrl };
}

export async function pollForToken(serverUrl:string, state:string, expiresAt:number, signal?:AbortSignal): Promise<{accessToken:string; refreshToken?:string; expiresIn?:number}|null> {
  // 先查后睡：首次立即查，失败后 sleep 再查
  while (Date.now() < expiresAt) {
    if (signal?.aborted) return null;
    // 本轮先查
    const res = await fetchJson<{code:number; data?:{accessToken:string; refreshToken?:string; expiresIn?:number}}>(
      `${serverUrl}/v2/plugin/auth/token?state=${state}`,
      { method:"GET", headers:{ Accept:"application/json", "X-No-Authorization":"true", "X-No-User-Id":"true", "X-No-Enterprise-Id":"true", "X-No-Department-Info":"true" }, timeoutMs: POLL_TIMEOUT_MS, signal },
    );
    if (res.ok && res.data.code===0 && res.data.data?.accessToken) return res.data.data;
    if (signal?.aborted) return null;
    if (Date.now() >= expiresAt) break;
    // 失败后睡 POLL_INTERVAL_MS，再进入下一轮先查
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

export async function refreshAccessToken(refreshToken:string, serverUrl:string): Promise<{accessToken:string; refreshToken?:string; expiresIn?:number}|null> {
  const res = await fetchJson<{code:number; data?:{accessToken:string; refreshToken?:string; expiresIn?:number}}>(
    `${serverUrl}/v2/plugin/auth/token/refresh`,
    { method:"POST", headers:{ "Content-Type":"application/json", Accept:"application/json", Authorization:`Bearer ${refreshToken}` }, timeoutMs: REFRESH_TIMEOUT_MS },
  );
  if (!res.ok || res.data.code !== 0) return null;
  return res.data.data ?? null;
}