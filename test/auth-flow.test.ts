import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RefreshLock, requestAuthState, pollForToken, refreshAccessToken } from "../src/auth-flow.js";
import { fetchJson } from "../src/fetch-json.js";

vi.mock("../src/fetch-json.js", () => ({ fetchJson: vi.fn() }));

describe("RefreshLock 按 providerId 单例", () => {
  it("同 key 并发去重（单飞）", async () => {
    const lock = new RefreshLock();
    let calls=0;
    const fn=async()=>{ calls++; await new Promise(r=>setTimeout(r,20)); return { accessToken:"a", refreshToken:"r", expiresIn:3600 }; };
    const [a,b] = await Promise.all([lock.run("codebuddy", fn), lock.run("codebuddy", fn)]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });
  it("异 key 不互阻", async () => {
    const lock = new RefreshLock();
    let calls=0;
    const fn=async()=>{ calls++; return { accessToken:"a" }; };
    await Promise.all([lock.run("codebuddy", fn), lock.run("other", fn)]);
    expect(calls).toBe(2);
  });
  it("finally 删键：完成后可再刷新", async () => {
    const lock = new RefreshLock();
    let calls=0;
    const fn=async()=>{ calls++; return { accessToken:"a" }; };
    await lock.run("codebuddy", fn);
    await lock.run("codebuddy", fn);
    expect(calls).toBe(2);
  });
});

describe("requestAuthState", () => {
  beforeEach(()=> vi.mocked(fetchJson).mockReset());
  it("带 platform/ioa 查询参数", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok:true, data:{ code:0, data:{ state:"s1", authUrl:"https://x/login" } } } as any);
    const res = await requestAuthState("https://copilot.tencent.com");
    expect(vi.mocked(fetchJson).mock.calls[0][0]).toContain("platform=VSCode");
    expect(vi.mocked(fetchJson).mock.calls[0][0]).toContain("ioa=1");
    expect(res.state).toBe("s1");
  });
  it("缺 authUrl 时 fallback 构造 login URL", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok:true, data:{ code:0, data:{ state:"s1" } } } as any);
    const res = await requestAuthState("https://copilot.tencent.com");
    expect(res.url).toBe("https://copilot.tencent.com/login?platform=VSCode&state=s1&ioa=1");
  });
  it("透传 X-No-* 特殊头", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok:true, data:{ code:0, data:{ state:"s1", authUrl:"https://x" } } } as any);
    await requestAuthState("https://copilot.tencent.com");
    const headers = vi.mocked(fetchJson).mock.calls[0][1]?.headers as Record<string,string>;
    expect(headers["X-No-Authorization"]).toBe("true");
    expect(headers["X-No-User-Id"]).toBe("true");
  });
  it("超时用 AUTH_STATE_TIMEOUT_MS", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok:false, status:500, text:"err" } as any);
    await expect(requestAuthState("https://x")).rejects.toThrow();
    expect(vi.mocked(fetchJson).mock.calls[0][1]?.timeoutMs).toBe(5000);
  });
});

describe("pollForToken 先查后睡", () => {
  beforeEach(()=> vi.mocked(fetchJson).mockReset());
  it("首查即成功时不 sleep 3s（计时）", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok:true, data:{ code:0, data:{ accessToken:"a", refreshToken:"r", expiresIn:3600 } } } as any);
    const start = Date.now();
    const res = await pollForToken("https://copilot.tencent.com", "s1", Date.now()+10000);
    expect(res?.accessToken).toBe("a");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(vi.mocked(fetchJson)).toHaveBeenCalledTimes(1);
  });
  it("自定义 server 时 URL 跟随 serverUrl（非硬编码默认主机）", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok:true, data:{ code:0, data:{ accessToken:"a" } } } as any);
    await pollForToken("https://my-proxy.example.com", "s1", Date.now()+10000);
    expect(vi.mocked(fetchJson).mock.calls[0][0]).toBe("https://my-proxy.example.com/v2/plugin/auth/token?state=s1");
  });
  it("首查失败后才 sleep 再查", async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce({ ok:true, data:{ code:1, data:{} } } as any)
      .mockResolvedValueOnce({ ok:true, data:{ code:0, data:{ accessToken:"a", refreshToken:"r", expiresIn:3600 } } } as any);
    const res = await pollForToken("https://copilot.tencent.com", "s1", Date.now()+5000);
    expect(res?.accessToken).toBe("a");
    expect(vi.mocked(fetchJson)).toHaveBeenCalledTimes(2);
  });
  it("signal 中止时立即返回 null", async () => {
    const ac = new AbortController(); ac.abort();
    const res = await pollForToken("https://copilot.tencent.com", "s1", Date.now()+10000, ac.signal);
    expect(res).toBeNull();
  });
  it("expiresAt 到期返回 null", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok:true, data:{ code:1 } } as any);
    const res = await pollForToken("https://copilot.tencent.com", "s1", Date.now()+10);
    expect(res).toBeNull();
  });
});

describe("refreshAccessToken", () => {
  beforeEach(()=> vi.mocked(fetchJson).mockReset());
  it("带 Authorization: Bearer refreshToken 头", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok:true, data:{ code:0, data:{ accessToken:"new" } } } as any);
    await refreshAccessToken("my-refresh", "https://x");
    const headers = vi.mocked(fetchJson).mock.calls[0][1]?.headers as Record<string,string>;
    expect(headers["Authorization"]).toBe("Bearer my-refresh");
  });
});