import { describe, it, expect, vi, afterEach } from "vitest";
import { registerIntegration } from "../src/integration.js";
import { createMockCtx, jsonResponse, makeIntegrationEditor, makeTestState } from "./helpers/mock-ctx.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("registerIntegration", () => {
  it("注册 3 个 method（oauth/key/env）", async () => {
    const { ctx, applyIntegrationTransforms } = createMockCtx();
    await registerIntegration(ctx, makeTestState());
    const { editor, updates } = makeIntegrationEditor();
    applyIntegrationTransforms(editor);
    expect(updates).toHaveLength(3);
    expect(updates.some((u) => u.method.type === "oauth" && u.method.id === "ioa")).toBe(true);
    expect(updates.some((u) => u.method.type === "key")).toBe(true);
    expect(updates.some((u) => u.method.type === "env" && u.method.names.includes("CODEBUDDY_API_KEY"))).toBe(true);
  });

  it("authorize 返回 mode:auto 且 callback 产出 Credential.OAuth", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("/v2/plugin/auth/state")) return jsonResponse({ code: 0, data: { state: "st1", authUrl: "https://login.example/st1" } });
      if (url.includes("/v2/plugin/auth/token?")) return jsonResponse({ code: 0, data: { accessToken: "acc", refreshToken: "ref", expiresIn: 3600 } });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const { ctx, applyIntegrationTransforms } = createMockCtx();
    await registerIntegration(ctx, makeTestState());
    const { editor, updates } = makeIntegrationEditor();
    applyIntegrationTransforms(editor);
    const oauth = updates.find((u) => u.method.type === "oauth");

    const auth = await oauth.authorize({});
    expect(auth.mode).toBe("auto");
    expect(auth.url).toBe("https://login.example/st1");
    expect(auth.instructions).toBeTruthy();

    const cred = await auth.callback;
    expect(cred.type).toBe("oauth");
    expect(cred.access).toBe("acc");
    expect(cred.refresh).toBe("ref");
    expect(cred.expires).toBeGreaterThan(Date.now());
  });

  it("refresh 用 refreshAccessToken 更新 access/expires", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("/v2/plugin/auth/token/refresh")) return jsonResponse({ code: 0, data: { accessToken: "acc2", refreshToken: "ref2", expiresIn: 7200 } });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const { ctx, applyIntegrationTransforms } = createMockCtx();
    await registerIntegration(ctx, makeTestState());
    const { editor, updates } = makeIntegrationEditor();
    applyIntegrationTransforms(editor);
    const oauth = updates.find((u) => u.method.type === "oauth");

    const next = await oauth.refresh({ type: "oauth", methodID: "ioa", access: "old", refresh: "ref", expires: 0 });
    expect(next.access).toBe("acc2");
    expect(next.refresh).toBe("ref2");
    expect(next.expires).toBeGreaterThan(Date.now());
  });

  it("refresh 失败时抛错（核心负责重试）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 1 }, 200)));
    const { ctx, applyIntegrationTransforms } = createMockCtx();
    await registerIntegration(ctx, makeTestState());
    const { editor, updates } = makeIntegrationEditor();
    applyIntegrationTransforms(editor);
    const oauth = updates.find((u) => u.method.type === "oauth");
    await expect(oauth.refresh({ type: "oauth", methodID: "ioa", access: "old", refresh: "ref", expires: 0 })).rejects.toThrow();
  });
});
