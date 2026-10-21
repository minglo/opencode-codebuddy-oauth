import { describe, it, expect } from "vitest";
import { accountKeyOf, tokenFingerprint } from "../src/key.js";

describe("accountKeyOf", () => {
  it("credential → credential:<id>", () => {
    expect(accountKeyOf({ type: "credential", id: "c1", label: "x" })).toBe("credential:c1");
  });
  it("env → env:<name>", () => {
    expect(accountKeyOf({ type: "env", name: "CODEBUDDY_API_KEY" })).toBe("env:CODEBUDDY_API_KEY");
  });
  it("缺 id/name 或未知类型 → undefined", () => {
    expect(accountKeyOf({ type: "credential" })).toBeUndefined();
    expect(accountKeyOf({ type: "env" })).toBeUndefined();
    expect(accountKeyOf({ type: "other", id: "x" })).toBeUndefined();
    expect(accountKeyOf(undefined)).toBeUndefined();
  });
});

describe("tokenFingerprint", () => {
  it("同一 token 稳定、不同 token 不同（防止退化成常量导致跨账号共用键）", () => {
    const a1 = tokenFingerprint("token-a");
    const a2 = tokenFingerprint("token-a");
    const b = tokenFingerprint("token-b");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
  it("16 位十六进制，且不含原始 token", () => {
    const fp = tokenFingerprint("secret-token-value");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain("secret");
  });
});
