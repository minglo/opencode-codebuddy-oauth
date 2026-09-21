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
});
