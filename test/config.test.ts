import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getConfig, resolveServerUrl, getAuthJsonPath } from "../src/config.js";
import * as os from "os";

const homedirSpy = vi.hoisted(() => vi.fn(() => "/home/test"));
vi.mock("os", () => ({ homedir: homedirSpy }));

describe("config", () => {
  const orig = process.env;
  beforeEach(()=>{ process.env={...orig}; }); afterEach(()=>{ process.env=orig; });
  it("num 吞0 回归：threshold=0 生效", () => {
    process.env.CODEBUDDY_SSE_THRESHOLD="0";
    expect(getConfig().sse.threshold).toBe(0);
  });
  it("num 非法回退默认值", () => {
    process.env.CODEBUDDY_SSE_THRESHOLD="bad";
    expect(getConfig().sse.threshold).toBe(24);
  });
  it("布尔 0=禁用", () => {
    process.env.CODEBUDDY_SSE="0";
    expect(getConfig().sse.enabled).toBe(false);
    process.env.CODEBUDDY_SSE="1";
    expect(getConfig().sse.enabled).toBe(true);
  });
  it("优先级：ENDPOINT > NETWORK", () => {
    process.env.CODEBUDDY_ENDPOINT="https://a.example.com";
    process.env.CODEBUDDY_NETWORK="internet";
    expect(resolveServerUrl(getConfig()).url).toBe("https://a.example.com");
  });
  it("NETWORK internal/ioa 走 copilot.tencent.com", () => {
    delete process.env.CODEBUDDY_ENDPOINT;
    process.env.CODEBUDDY_NETWORK="internal";
    expect(resolveServerUrl(getConfig()).url).toBe("https://copilot.tencent.com");
    process.env.CODEBUDDY_NETWORK="ioa";
    expect(resolveServerUrl(getConfig()).url).toBe("https://copilot.tencent.com");
    expect(resolveServerUrl(getConfig()).domain).toBe("www.codebuddy.cn");
  });
  it("NETWORK internet 走 www.codebuddy.ai", () => {
    delete process.env.CODEBUDDY_ENDPOINT;
    process.env.CODEBUDDY_NETWORK="internet";
    expect(resolveServerUrl(getConfig()).url).toBe("https://www.codebuddy.ai");
    expect(resolveServerUrl(getConfig()).domain).toBe("www.codebuddy.ai");
  });
  it("domain 不对称推导：仅 host 含 codebuddy.ai 才改 domain", () => {
    const cfg: any = { endpoint: "https://my-proxy.example.com", network: "internal" };
    // 非 codebuddy.ai host 保持 cn
    expect(resolveServerUrl(cfg).domain).toBe("www.codebuddy.cn");
    // codebuddy.ai host 才改 ai
    expect(resolveServerUrl({ endpoint: "https://www.codebuddy.ai", network: "internal" } as any).domain).toBe("www.codebuddy.ai");
  });
  it("getAuthJsonPath macOS 分支：darwin 返回 Library/Application Support", () => {
    const spy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin" as any);
    homedirSpy.mockReturnValue("/Users/test");
    expect(getAuthJsonPath()).toBe("/Users/test/Library/Application Support/opencode/auth.json");
    spy.mockRestore();
  });
  it("getAuthJsonPath linux 回退 XDG_DATA_HOME", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux" as any);
    homedirSpy.mockReturnValue("/home/test");
    process.env.XDG_DATA_HOME = "/tmp/xdg";
    expect(getAuthJsonPath()).toBe("/tmp/xdg/opencode/auth.json");
    delete process.env.XDG_DATA_HOME;
    expect(getAuthJsonPath()).toBe("/home/test/.local/share/opencode/auth.json");
  });
  it("getAuthJsonPath win32 分支", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32" as any);
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    expect(getAuthJsonPath()).toContain("opencode");
    expect(getAuthJsonPath()).toContain("auth.json");
  });
});