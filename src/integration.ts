// src/integration.ts — V2 integration：IOA OAuth / API Key / env
import { Credential, Integration, type Plugin } from "@opencode/plugin";
import { requestAuthState, pollForToken, refreshAccessToken } from "./auth-flow.js";
import { DEFAULT_EXPIRES_MS, POLL_TOTAL_TIMEOUT_MS, PROVIDER_ID } from "./config.js";
import type { PluginState } from "./state.js";

const METHOD_ID = Integration.MethodID.make("ioa");

function toCredential(tok: { accessToken: string; refreshToken?: string; expiresIn?: number }) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: METHOD_ID,
    access: tok.accessToken,
    refresh: tok.refreshToken || "",
    expires: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
  });
}

export async function registerIntegration(ctx: Plugin.Context, state: PluginState): Promise<void> {
  await ctx.integration.transform((editor) => {
    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { id: METHOD_ID, type: "oauth", label: "IOA 登录 (浏览器)" },
      authorize: async () => {
        const s = await requestAuthState(state.server.url);
        const expiresAt = Date.now() + POLL_TOTAL_TIMEOUT_MS;
        return {
          mode: "auto" as const,
          url: s.url,
          instructions: "请在浏览器中完成 IOA 登录",
          expiresAt,
          callback: pollForToken(state.server.url, s.state, expiresAt).then((tok) => {
            if (!tok) throw new Error("codebuddy: IOA 登录超时或失败");
            return toCredential(tok);
          }),
        };
      },
      refresh: async (cred) => {
        const r = await refreshAccessToken(cred.refresh, state.server.url);
        if (!r?.accessToken) throw new Error("codebuddy: refresh failed");
        return {
          ...cred,
          access: r.accessToken,
          refresh: r.refreshToken || cred.refresh,
          expires: r.expiresIn ? Date.now() + r.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
        };
      },
    });

    editor.method.update({
      integrationID: PROVIDER_ID,
      method: {
        type: "key",
        label: "API Key 登录",
        form: [{ type: "string", key: "key", title: "CodeBuddy API Key", placeholder: "ck_xxxxxxxxxxxxxxxx.xxxxx" }],
      },
    });

    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { type: "env", names: ["CODEBUDDY_API_KEY"] },
    });
  });
}
