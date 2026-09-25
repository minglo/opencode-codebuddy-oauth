import { describe, it, expect, vi } from "vitest";
import { createMockCtx } from "./helpers/mock-ctx.js";

describe("V2 setup 骨架", () => {
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
    ctx.integration.transform = vi.fn(async () => { throw new Error("boom"); });
    const cleanup = await mod.default.setup(ctx);
    expect(typeof cleanup).toBe("function");
    expect(ctx.provider.transform).toHaveBeenCalled();
    expect(ctx.session.hook).toHaveBeenCalledWith("http.request", expect.any(Function), expect.anything());
    cleanup();
  });

  it("错误隔离：provider 注册抛错不阻塞 requests", async () => {
    vi.resetModules();
    const mod: any = await import("../src/index.js");
    const { ctx } = createMockCtx();
    ctx.provider.transform = vi.fn(async () => { throw new Error("boom"); });
    const cleanup = await mod.default.setup(ctx);
    expect(ctx.session.hook).toHaveBeenCalledWith("http.request", expect.any(Function), expect.anything());
    cleanup();
  });
});
