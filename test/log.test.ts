import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../src/log.js";

describe("log", () => {
  it("有 client 时走 client.app.log({body})", async () => {
    const log = vi.fn().mockResolvedValue(true);
    const logger = createLogger({ app: { log } } as any);
    logger.info("hi", { a: 1 });
    expect(log).toHaveBeenCalledWith({ body: { service: "codebuddy", level: "info", message: "hi", extra: { a: 1 } } });
  });
  it("无 client 时 warn/error 落 console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(()=>{});
    const logger = createLogger();
    logger.warn("w"); logger.error("e");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
  it("无 client 时 debug/info 静默", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(()=>{});
    createLogger().debug("d"); createLogger().info("i");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});