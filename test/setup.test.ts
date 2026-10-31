import { describe, it, expect, vi, afterEach } from "vitest";
import { createMockCtx } from "./helpers/mock-ctx.js";

describe("V2 setup 骨架", () => {
  // 错误隔离用例会故意抛错并走 console.error；静音输出，避免被误读为测试失败。
  afterEach(() => vi.restoreAllMocks());

  it("默认导出为 Plugin.define 形态 {id, setup}", async () => {
    vi.resetModules();
    const mod: any = await import("../src/index.js");
    expect(mod.default.id).toBe("codebuddy");
    expect(typeof mod.default.setup).toBe("function");
  });

  it("setup 返回 cleanup 函数且不抛", async () => {
    vi.resetModules();
    const mod: any = await import("../src/index.js");
    const { ctx } = createMockCtx();
    const cleanup = await mod.default.setup(ctx);
    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  it("错误隔离：integration 注册抛错不阻塞 provider/requests", async () => {
    vi.resetModules();
    const mod: any = await import("../src/index.js");
    const { ctx } = createMockCtx();
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    ctx.integration.transform = vi.fn(async () => { throw new Error("boom"); });
    const cleanup = await mod.default.setup(ctx);
    expect(typeof cleanup).toBe("function");
    expect(ctx.provider.transform).toHaveBeenCalled();
    expect(ctx.session.hook).toHaveBeenCalledWith("http.request", expect.any(Function), expect.anything());
    expect(errLog).toHaveBeenCalledWith("[codebuddy] integration 注册失败:", expect.any(Error));
    cleanup();
  });

  it("错误隔离：provider 注册抛错不阻塞 requests", async () => {
    vi.resetModules();
    const mod: any = await import("../src/index.js");
    const { ctx } = createMockCtx();
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    ctx.provider.transform = vi.fn(async () => { throw new Error("boom"); });
    const cleanup = await mod.default.setup(ctx);
    expect(ctx.session.hook).toHaveBeenCalledWith("http.request", expect.any(Function), expect.anything());
    expect(errLog).toHaveBeenCalledWith("[codebuddy] provider 注册失败:", expect.any(Error));
    cleanup();
  });
});
