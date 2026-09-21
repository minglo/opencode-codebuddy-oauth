# CodeBuddy OAuth 插件 V2 PoC 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `v2-poc` 分支把 CodeBuddy OAuth 插件完整迁移到 OpenCode V2 插件 API（`@opencode/plugin@2.0.11`），用 mock 宿主验证全部功能。

**Architecture:** hooks 中心（方案 A）：凭证归核心 integration（oauth/key/env method + refresh 回调）；请求头/body 走 `ctx.session.hook("http.request")`；SSE 缓冲与 11133 重发走 `http.response`；模型发现走 `ctx.provider.transform` + `model.transform` + 凭证事件 reload。纯核（config/log/lru/jwt/headers/auth-flow/sse-buffer/models/fetch-json）保持零宿主依赖，全部逻辑复用。

**Tech Stack:** TypeScript 5.9、tsup、vitest 4、`@opencode/plugin@2.0.11`、Node 22。

**Spec:** `docs/superpowers/specs/2026-09-21-codebuddy-v2-poc-design.md`

## Global Constraints

- Node >= 22（`engines` 与 tsup `target: node22` 一致）
- 只支持 V2：`peerDependencies` 为 `@opencode/plugin ^2.0.11`，不保留 `@opencode-ai/plugin` peer
- **纯核文件不 import 任何宿主包**（`@opencode/plugin`、`@opencode-ai/*`）：`config.ts` `log.ts` `lru.ts` `jwt.ts` `headers.ts` `models.ts` `sse-buffer.ts` `fetch-json.ts` `auth-flow.ts` `auth-state.ts`
- `setup` 永不抛出；每域注册独立 try/catch
- legacy 文件头注释：`// @legacy V1-only — V2 无对应宿主，GA 发 3.0.0 时删除（见 spec 附录 A）`
- 版本保持 `3.0.0-poc.0`，不发布、不推 tag
- 提交信息中文，前缀沿用仓库：`feat:` / `fix:` / `test:` / `chore:`
- 测试命令统一 `npx vitest run <file>`；全量 `npm test`
- 环境变量测试后必须清理（`delete process.env.X`）

## Review Focus

| # | 输入/条件 | 期望行为 | 测试落点 |
|---|-----------|----------|----------|
| 1 | 宿主目录无任何凭证（首次安装、`/connect` 前） | provider 必须注册、模型列表非空（DEFAULT_MODEL），TUI 不能无模型 | Task 8 |
| 2 | `http.request` 收到非 JSON body（GET/无 body/FormData/纯文本） | 原样透传，不抛、不替换 | Task 4 |
| 3 | 上游 400 但 body 非 JSON（HTML 网关错误页） | 原样返回，不能被当 11133 吞掉 | Task 5 |
| 4 | SSE 流被提前 abort（用户中断） | 定时 flush 不得在流关闭后崩溃 | Task 5 |
| 5 | 插件重载 / cleanup 被调用 | 事件订阅与定时器全部释放，无泄漏 | Task 6、8；集成断言 Task 9 |

---

### Task 1: 工作区准备、依赖与构建配置

**Files:**
- Modify: `package.json`
- Modify: `tsup.config.ts`

**Interfaces:**
- Consumes: 无
- Produces: worktree `/home/minglo/dev/opencode-codebuddy-oauth-v2-poc`（分支 `v2-poc`）；`@opencode/plugin` 可导入；构建入口预留给 `src/index.ts`

- [ ] **Step 1: stash 未提交改动（主工作区）**

主工作区当前有 11133 dump 改动（用户测试中，不提交）：

```bash
git stash push -m "wip: 11133 dump（V1，测试中）" -- src/auth-fetch.ts test/auth-fetch.test.ts
git status --short   # 期望：空输出
```

- [ ] **Step 2: 创建 worktree 与分支**

```bash
git worktree add ../opencode-codebuddy-oauth-v2-poc -b v2-poc master
```

后续所有命令在此 worktree 中执行：`/home/minglo/dev/opencode-codebuddy-oauth-v2-poc`。

- [ ] **Step 3: 安装依赖**

```bash
npm install
npm install --save-dev @opencode/plugin@2.0.11
```

`npm install` 会同时更新 `package-lock.json`（仅 devDependency 变化）。

- [ ] **Step 4: 修改 `package.json`**

三处 Edit：

```jsonc
// 1) version
"version": "3.0.0-poc.0",
```

```jsonc
// 2) peerDependencies：替换（不是新增）
"peerDependencies": {
  "@opencode/plugin": "^2.0.11"
},
```

```jsonc
// 3) devDependencies：保留 @opencode-ai/plugin 与 @opencode-ai/sdk（legacy 源码 typecheck 需要），
//    新增 @opencode/plugin 由 Step 3 自动写入
```

- [ ] **Step 5: 修改 `tsup.config.ts`**

```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: true,
  target: "node22",
  clean: true,
  sourcemap: true,
  external: ["@opencode/plugin", "@opencode/plugin/*", "@opencode-ai/plugin", "@opencode-ai/sdk"],
});
```

- [ ] **Step 6: 验证（V1 代码仍工作）**

```bash
npx tsc --noEmit   # 期望：零错（此时 src/index.ts 仍是 V1）
npm test           # 期望：全绿
npm run build      # 期望：产出 dist/index.js + dist/index.d.ts
```

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json tsup.config.ts
git commit -m "chore: v2-poc 工作区准备（@opencode/plugin 依赖、构建配置）"
```

---

### Task 2: 入口切换、V2 骨架、mock 宿主

**Files:**
- Move: `src/index.ts` → `src/index.v1.ts`
- Create: `src/state.ts`
- Create: `src/index.ts`（V2 骨架）
- Create: `src/integration.ts`（空 register）
- Create: `src/provider.ts`（空 register）
- Create: `src/requests.ts`（空 register）
- Modify: `test/index.test.ts`（import 路径）
- Create: `test/helpers/mock-ctx.ts`
- Create: `test/setup.test.ts`

**Interfaces:**
- Consumes: Task 1 的依赖与构建配置
- Produces:
  - `PluginState`（`src/state.ts`）：`{ cfg, logger, server, conversationIds, discoveryCache, discovered, requestSnapshots }`
  - `RequestSnapshot`：`{ url: string; method: string; headers: Record<string,string>; body: string }`
  - `registerIntegration(ctx, state): Promise<void>`
  - `registerProvider(ctx, state): Promise<() => void>`
  - `registerRequests(ctx, state): Promise<() => void>`
  - `createMockCtx(opts?): { ctx, calls, setCredential, triggerHook, applyProviderTransforms, applyIntegrationTransforms, applyModelTransforms }`
  - `makeTestState(overrides?): PluginState`
  - `makeIntegrationEditor()`, `makeProviderEditor(seed?)`, `makeModelEditor()`

- [ ] **Step 1: 改名 V1 入口 + 给 legacy 文件/符号加标记**

```bash
git mv src/index.ts src/index.v1.ts
```

在 `src/index.v1.ts` 第 1 行加：

```ts
// @legacy V1-only — V2 无对应宿主，GA 发 3.0.0 时删除（见 spec 附录 A）
// src/index.ts 已迁移为 V2 入口；本文件仅保留参考与 V1 测试
```

整文件 legacy 的两个文件，各自第 1 行加：

```ts
// src/auth-fetch.ts 第 1 行
// @legacy V1-only — V1 fetch 拦截器（token 注入/401/SSE/11133/11155）；GA 发 3.0.0 时删除（见 spec 附录 A）
```

```ts
// src/auth-state.ts 第 1 行
// @legacy V1-only — V1 凭证状态（parseStoredAuth/effectiveAuth/pickAuthMode）；GA 发 3.0.0 时删除（见 spec 附录 A）
```

部分 legacy 的符号处加行内标记（保留周围现有注释不动）：

- `src/config.ts` → `getAuthJsonPath` 函数上方：`// @legacy（GA 发 3.0.0 时删除）：V1 自读写 auth.json；V2 凭证归 integration`
- `src/config.ts` → `CHAT_COMPLETIONS_PATH` 常量上方：`// @legacy（GA 发 3.0.0 时删除）：V1 fetch 路径匹配；V2 由 SDK 拼路径`
- `src/auth-flow.ts` → `RefreshLock` 类上方：`// @legacy（GA 发 3.0.0 时删除）：V2 刷新归核心`
- `src/models.ts` → `remoteModelToConfig` 与 `mergeModelEntry` 上方：`// @legacy（GA 发 3.0.0 时删除）：V2 用 provider.ts 的 remoteModelToInfo`

- [ ] **Step 2: 更新 V1 测试 import（两处）**

`test/index.test.ts` 有两个入口引用，都要改：

1. 第 3 行静态 import：

```ts
import { CodeBuddyAuthPlugin } from "../src/index.v1.js";
```

2. "导出形态" 用例里的动态 import（原 `const mod = await import("../src/index.js");`）：

```ts
    const mod = await import("../src/index.v1.js");
    expect((mod as any).CodeBuddyAuthPlugin).toBeDefined();
    expect((mod as any).default).toEqual(expect.objectContaining({ id: "codebuddy-plugin" }));
```

（其余断言不变；`test/auth-fetch.test.ts` 等不引用 index 的测试无需改。）

- [ ] **Step 3: 创建 `src/state.ts`**

```ts
// src/state.ts — V2 插件共享状态（setup 闭包），纯类型 + 容器，不 import 宿主包
import type { CodeBuddyConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { LRUMap } from "./lru.js";
import type { DiscoveryCache, RemoteModel } from "./models.js";

export interface RequestSnapshot {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface PluginState {
  cfg: CodeBuddyConfig;
  logger: Logger;
  /** live 引用：provider 注册时可能被 configuredBase 覆写 */
  server: { url: string; domain: string };
  conversationIds: LRUMap<string, string>;
  discoveryCache: DiscoveryCache;
  discovered: RemoteModel[] | null;
  /** 11133 重发快照，key = X-Request-Trace-Id */
  requestSnapshots: LRUMap<string, RequestSnapshot>;
}
```

- [ ] **Step 4: 创建三个空 register**

`src/integration.ts`:

```ts
// src/integration.ts
import type { Plugin } from "@opencode/plugin";
import type { PluginState } from "./state.js";

export async function registerIntegration(_ctx: Plugin.Context, _state: PluginState): Promise<void> {}
```

`src/provider.ts`:

```ts
// src/provider.ts
import type { Plugin } from "@opencode/plugin";
import type { PluginState } from "./state.js";

export async function registerProvider(_ctx: Plugin.Context, _state: PluginState): Promise<() => void> {
  return () => {};
}
```

`src/requests.ts`:

```ts
// src/requests.ts
import type { Plugin } from "@opencode/plugin";
import type { PluginState } from "./state.js";

export async function registerRequests(_ctx: Plugin.Context, _state: PluginState): Promise<() => void> {
  return () => {};
}
```

- [ ] **Step 5: 创建 V2 入口 `src/index.ts`**

```ts
// src/index.ts — V2 入口（薄胶水）
import { Plugin } from "@opencode/plugin";
import { getConfig, resolveServerUrl, DISCOVERY_CACHE_TTL_MS } from "./config.js";
import { createLogger } from "./log.js";
import { LRUMap } from "./lru.js";
import { DiscoveryCache, fetchRemoteModels } from "./models.js";
import type { PluginState, RequestSnapshot } from "./state.js";
import { registerIntegration } from "./integration.js";
import { registerProvider } from "./provider.js";
import { registerRequests } from "./requests.js";

export default Plugin.define({
  id: "codebuddy",
  async setup(ctx) {
    const cfg = getConfig();
    const state: PluginState = {
      cfg,
      logger: createLogger(),
      server: resolveServerUrl(cfg),
      conversationIds: new LRUMap<string, string>(cfg.conversationMapMax),
      discoveryCache: null as unknown as DiscoveryCache,
      discovered: null,
      requestSnapshots: new LRUMap<string, RequestSnapshot>(32),
    };
    // fetchFn 闭包读 state.server 属性（live），provider 覆写后同源
    state.discoveryCache = new DiscoveryCache({
      ttlMs: DISCOVERY_CACHE_TTL_MS,
      fetchFn: (token, signal) => fetchRemoteModels(token, state.server, signal),
    });

    const cleanups: Array<() => void> = [];
    const domain = async (name: string, fn: () => Promise<void | (() => void)>) => {
      try {
        const c = await fn();
        if (typeof c === "function") cleanups.push(c);
      } catch (e) {
        console.error(`[codebuddy] ${name} 注册失败:`, e);
      }
    };
    await domain("integration", () => registerIntegration(ctx, state));
    await domain("provider", () => registerProvider(ctx, state));
    await domain("requests", () => registerRequests(ctx, state));
    return () => { for (const c of cleanups) c(); };
  },
});
```

- [ ] **Step 6: 创建 mock 宿主 `test/helpers/mock-ctx.ts`**

```ts
// test/helpers/mock-ctx.ts — V2 mock context（不 import 宿主包）
import { vi } from "vitest";
import { getConfig, resolveServerUrl } from "../../src/config.js";
import { LRUMap } from "../../src/lru.js";
import type { PluginState } from "../../src/state.js";

type TransformCb = (editor: any) => void;
type HookCb = (event: any) => unknown;

export interface MockCredential {
  type: "oauth" | "key";
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
}

export interface MockCtxOptions {
  credential?: MockCredential;
  subscription?: (signal: AbortSignal) => AsyncIterable<any>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function makeTestState(overrides: Partial<PluginState> = {}): PluginState {
  const cfg = getConfig();
  return {
    cfg,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    server: resolveServerUrl(cfg),
    conversationIds: new LRUMap<string, string>(1000),
    discoveryCache: { get: vi.fn(async () => []) } as any,
    discovered: null,
    requestSnapshots: new LRUMap(32),
    ...overrides,
  };
}

export function makeIntegrationEditor() {
  const updates: any[] = [];
  return {
    updates,
    editor: {
      list: () => [],
      get: () => undefined,
      update: () => {},
      remove: () => {},
      method: {
        list: () => [],
        update: (input: any) => updates.push(input),
        remove: () => {},
      },
    },
  };
}

export function makeProviderEditor(seed?: any) {
  const added: any[] = [];
  const updates: string[] = [];
  const existing = seed ?? undefined;
  return {
    added,
    updates,
    editor: {
      list: () => (existing ? [existing] : []),
      get: (id: string) => (existing && id === "codebuddy" ? existing : undefined),
      add: (input: any) => added.push(input),
      update: (id: string, cb: (p: any) => void) => { updates.push(id); if (existing) cb(existing.provider); },
      remove: () => {},
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
    },
  };
}

export function makeModelEditor() {
  const updates: Array<{ providerID: string; modelID: string }> = [];
  return {
    updates,
    editor: {
      list: () => [],
      get: () => undefined,
      update: (providerID: string, modelID: string, cb: (m: any) => void) => {
        updates.push({ providerID, modelID });
        const draft: any = {};
        cb(draft);
      },
      remove: () => {},
      default: { get: () => undefined, set: () => {} },
      provider: { list: () => [], get: () => undefined },
    },
  };
}

export function createMockCtx(opts: MockCtxOptions = {}) {
  let credential = opts.credential;
  const calls = {
    integrationTransforms: [] as TransformCb[],
    providerTransforms: [] as TransformCb[],
    modelTransforms: [] as TransformCb[],
    hooks: new Map<string, HookCb>(),
    hookOptions: new Map<string, unknown>(),
    subscriptions: [] as Array<(signal: AbortSignal) => AsyncIterable<any>>,
    reloads: { provider: 0, model: 0 },
  };

  const integration = {
    transform: vi.fn(async (cb: TransformCb) => { calls.integrationTransforms.push(cb); return { dispose: vi.fn() }; }),
    reload: vi.fn(async () => {}),
    connection: {
      active: vi.fn(async () => (credential ? { type: "credential", id: "cred-1", label: "test" } : undefined)),
      resolve: vi.fn(async () => credential),
    },
  };
  const provider = {
    transform: vi.fn(async (cb: TransformCb) => { calls.providerTransforms.push(cb); return { dispose: vi.fn() }; }),
    reload: vi.fn(async () => { calls.reloads.provider++; }),
    list: vi.fn(async () => []),
  };
  const model = {
    transform: vi.fn(async (cb: TransformCb) => { calls.modelTransforms.push(cb); return { dispose: vi.fn() }; }),
    reload: vi.fn(async () => { calls.reloads.model++; }),
    list: vi.fn(async () => []),
  };
  const event = {
    subscribe: vi.fn((options?: { signal?: AbortSignal }) => {
      const factory = opts.subscription ?? (async function* () { /* 空流 */ });
      calls.subscriptions.push(factory);
      return factory(options?.signal ?? new AbortController().signal);
    }),
  };
  const session = {
    hook: vi.fn(async (name: string, cb: HookCb, options?: unknown) => {
      calls.hooks.set(name, cb);
      calls.hookOptions.set(name, options);
      return { dispose: vi.fn() };
    }),
  };

  const ctx = {
    app: { name: "opencode", version: "2.0.11", channel: "test" },
    location: { directory: "/tmp/proj", project: { id: "proj-1", directory: "/tmp/proj", canonical: "/tmp/proj" } },
    options: {},
    integration,
    provider,
    model,
    event,
    session,
    storage: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), scan: vi.fn() },
  };

  return {
    ctx: ctx as any,
    calls,
    setCredential: (v: MockCredential | undefined) => { credential = v; },
    triggerHook: async (name: string, eventArg: any) => {
      const cb = calls.hooks.get(name);
      if (!cb) throw new Error(`hook ${name} 未注册`);
      return cb(eventArg);
    },
    applyIntegrationTransforms: (editor: any) => { calls.integrationTransforms.forEach((cb) => cb(editor)); },
    applyProviderTransforms: (editor: any) => { calls.providerTransforms.forEach((cb) => cb(editor)); },
    applyModelTransforms: (editor: any) => { calls.modelTransforms.forEach((cb) => cb(editor)); },
  };
}
```

- [ ] **Step 7: 创建 `test/setup.test.ts`**

```ts
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
```

- [ ] **Step 8: 运行测试**

```bash
npx vitest run test/setup.test.ts   # 期望：2 passed
npm test                            # 期望：全绿（V1 legacy 测试 + setup 测试）
```

- [ ] **Step 9: 验证类型与构建**

```bash
npx tsc --noEmit   # 期望：零错
npm run build      # 期望：dist/index.js + dist/index.d.ts
```

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "feat: V2 入口骨架 + mock 宿主（入口切换 index.v1.ts）"
```

---

### Task 3: integration.ts — OAuth / API Key / env 三种登录

**Files:**
- Modify: `src/integration.ts`
- Create: `test/integration.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `PluginState`、`createMockCtx`、`makeIntegrationEditor`、`makeTestState`
- Produces: `registerIntegration(ctx, state)` 注册 3 个 method：
  - oauth：`{id:"ioa", type:"oauth", label:"IOA 登录 (浏览器)"}` + `authorize`/`refresh`
  - key：`{type:"key", label:"API Key 登录", form:[{type:"string", key:"key", title:"CodeBuddy API Key", placeholder:"ck_xxxxxxxxxxxxxxxx.xxxxx"}]}`
  - env：`{type:"env", names:["CODEBUDDY_API_KEY"]}`

- [ ] **Step 1: 写失败测试 `test/integration.test.ts`**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run test/integration.test.ts
```

期望：FAIL（`updates` 长度为 0——registerIntegration 还是空实现）。

- [ ] **Step 3: 实现 `src/integration.ts`**

```ts
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
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run test/integration.test.ts   # 期望：4 passed
npx tsc --noEmit                          # 期望：零错
```

- [ ] **Step 5: 提交**

```bash
git add src/integration.ts test/integration.test.ts
git commit -m "feat: V2 integration 注册（IOA OAuth / API Key / env）"
```

---

### Task 4: requests.ts — http.request（鉴权头、CodeBuddy 头、body 处理、快照）

**Files:**
- Modify: `src/requests.ts`
- Create: `src/credentials.ts`（与 Task 8 共享的凭证解析）
- Create: `test/requests.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `PluginState`/mock；现有纯核 `buildRequestHeaders`、`buildAuthHeaders`、`resolveIdentity`、`decodeJwtPayload`
- Produces: `registerRequests(ctx, state)` 注册 `http.request`（providerID 作用域）；导出 `buildHooks(ctx, state)` 返回 `{ onRequest, onResponse }`（后续任务扩展）供测试与复用

- [ ] **Step 1: 写失败测试 `test/requests.test.ts`**

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { registerRequests } from "../src/requests.js";
import { createMockCtx, makeTestState } from "./helpers/mock-ctx.js";

const b64url = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const fakeJwt = `${b64url({ alg: "none" })}.${b64url({ tenant_id: "t1", enterprise_id: "e1", user_id: "u1" })}.x`;

function chatRequest(body: unknown) {
  return new Request("https://copilot.tencent.com/v2/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("http.request", () => {
  it("api key 凭证注入双头 + CodeBuddy 头 + conversation 稳定", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "ck_test" } });
    const state = makeTestState();
    await registerRequests(ctx, state);

    const e1: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ stream: false, messages: [] }) };
    await triggerHook("http.request", e1);
    expect(e1.request.headers.get("Authorization")).toBe("Bearer ck_test");
    expect(e1.request.headers.get("X-API-Key")).toBe("ck_test");
    expect(e1.request.headers.get("X-Agent-Intent")).toBeTruthy();
    expect(e1.request.headers.get("X-Conversation-ID")).toBeTruthy();

    const e2: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ stream: false, messages: [] }) };
    await triggerHook("http.request", e2);
    expect(e2.request.headers.get("X-Conversation-ID")).toBe(e1.request.headers.get("X-Conversation-ID"));
  });

  it("oauth 凭证从 JWT 解析 identity 注入租户头", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "oauth", access: fakeJwt, refresh: "r", expires: Date.now() + 3600_000 } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s2", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ stream: false, messages: [] }) };
    await triggerHook("http.request", e);
    expect(e.request.headers.get("Authorization")).toBe(`Bearer ${fakeJwt}`);
    expect(e.request.headers.get("X-Tenant-Id")).toBe("t1");
    expect(e.request.headers.get("X-Enterprise-Id")).toBe("e1");
    expect(e.request.headers.get("X-User-Id")).toBe("u1");
  });

  it("stream:true 注入 stream_options，assistant 补 reasoning_content", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s3", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: chatRequest({ stream: true, messages: [{ role: "assistant", content: "hi" }, { role: "user", content: "yo" }] }) };
    await triggerHook("http.request", e);
    const body = JSON.parse(await e.request.text());
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[0].reasoning_content).toBe("");
    expect(body.messages[1].reasoning_content).toBeUndefined();
  });

  it("非 JSON body 原样透传且不抛", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s4", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x/v2/chat/completions", { method: "POST", headers: { "content-type": "text/plain" }, body: "not json" }) };
    await triggerHook("http.request", e);
    expect(await e.request.text()).toBe("not json");
  });

  it("无 body 的 GET 请求不抛且仍注入头", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s5", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x/v2/models") };
    await triggerHook("http.request", e);
    expect(e.request.headers.get("Authorization")).toBe("Bearer k");
  });

  it("凭证缺失时不抛、不注鉴权头", async () => {
    const { ctx, triggerHook } = createMockCtx();
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s6", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ messages: [] }) };
    await expect(triggerHook("http.request", e)).resolves.toBeUndefined();
    expect(e.request.headers.get("Authorization")).toBeNull();
  });

  it("写入请求快照（key = X-Request-Trace-Id）", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const e: any = { sessionID: "s7", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ stream: true, messages: [] }) };
    await triggerHook("http.request", e);
    const traceId = e.request.headers.get("X-Request-Trace-Id");
    const snap = state.requestSnapshots.get(traceId!);
    expect(snap).toBeDefined();
    expect(snap!.method).toBe("POST");
    expect(JSON.parse(snap!.body).stream_options).toEqual({ include_usage: true });
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run test/requests.test.ts
```

期望：FAIL（`hook http.request 未注册`）。

- [ ] **Step 3: 实现 `src/requests.ts`（本任务只加 http.request）**

```ts
// src/credentials.ts — 胶水层共享：从 integration 解析当前凭证（requests 与 provider 共用）
import type { Plugin } from "@opencode/plugin";
import { PROVIDER_ID } from "./config.js";
import type { PluginState } from "./state.js";

export interface ResolvedCredential {
  type: "oauth" | "key";
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
}

export async function resolveCredential(
  ctx: Plugin.Context,
  state: PluginState,
): Promise<ResolvedCredential | undefined> {
  try {
    const connection = await ctx.integration.connection.active(PROVIDER_ID);
    if (!connection) return undefined;
    const value = await ctx.integration.connection.resolve(connection);
    return value as ResolvedCredential | undefined;
  } catch (e) {
    state.logger.warn(`credential resolve failed: ${(e as Error).message}`);
    return undefined;
  }
}
```

`src/requests.ts`（本任务只加 http.request）：

```ts
// src/requests.ts — V2 session hooks + 事件订阅
import type { Plugin } from "@opencode/plugin";
import { buildRequestHeaders, buildAuthHeaders } from "./headers.js";
import { resolveIdentity, decodeJwtPayload } from "./jwt.js";
import { PROVIDER_ID } from "./config.js";
import { resolveCredential } from "./credentials.js";
import type { PluginState, RequestSnapshot } from "./state.js";

type AnyEvent = any;

export async function registerRequests(ctx: Plugin.Context, state: PluginState): Promise<() => void> {
  const hooks = buildHooks(ctx, state);
  await ctx.session.hook("http.request", hooks.onRequest, { providerID: PROVIDER_ID });
  return () => {};
}

/** 供测试与非注册路径复用 */
export function buildHooks(ctx: Plugin.Context, state: PluginState) {
  return {
    onRequest: (event: AnyEvent) => handleHttpRequest(ctx, event, state),
  };
}

async function handleHttpRequest(ctx: Plugin.Context, event: AnyEvent, state: PluginState): Promise<void> {
  const headers: Headers = event.request.headers;

  const credential: any = await resolveCredential(ctx, state);
  if (credential) {
    const identity = credential.type === "oauth"
      ? resolveIdentity(decodeJwtPayload(credential.access), state.cfg)
      : { tenantId: "", enterpriseId: "", userId: "" };
    const authHeaders = buildAuthHeaders(
      credential.type === "oauth"
        ? { type: "oauth", access: credential.access, refresh: credential.refresh, expires: credential.expires }
        : { type: "api", key: credential.key },
      identity as any,
    );
    for (const [k, v] of Object.entries(authHeaders)) headers.set(k, v);
  } else {
    state.logger.warn("codebuddy: 无凭证，跳过鉴权头注入（请 /connect codebuddy）");
  }

  const reqHeaders = buildRequestHeaders(event.sessionID, event.model?.id, {
    cfg: state.cfg, server: state.server, lru: state.conversationIds,
  });
  for (const [k, v] of Object.entries(reqHeaders)) headers.set(k, v);

  let bodyText: string | undefined;
  try { bodyText = await event.request.clone().text(); } catch { bodyText = undefined; }

  let nextBody: string | undefined;
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      let changed = false;
      if (parsed?.stream === true && !parsed.stream_options) {
        parsed.stream_options = { include_usage: true };
        changed = true;
      }
      if (Array.isArray(parsed?.messages)) {
        for (const m of parsed.messages) {
          if (m?.role === "assistant" && m.reasoning_content === undefined) {
            m.reasoning_content = "";
            changed = true;
          }
        }
      }
      if (changed) nextBody = JSON.stringify(parsed);
    } catch { /* 非 JSON：原样透传 */ }
  }

  if (nextBody !== undefined) {
    event.request = new Request(event.request, { body: nextBody, duplex: "half" } as RequestInit);
  }

  const traceId = headers.get("X-Request-Trace-Id");
  if (traceId) {
    const snapshot: RequestSnapshot = {
      url: event.request.url,
      method: event.request.method,
      headers: Object.fromEntries(headers.entries()),
      body: nextBody ?? bodyText ?? "",
    };
    state.requestSnapshots.set(traceId, snapshot);
  }
}
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run test/requests.test.ts   # 期望：7 passed
npx tsc --noEmit                       # 期望：零错
```

- [ ] **Step 5: 提交**

```bash
git add src/requests.ts test/requests.test.ts
git commit -m "feat: V2 http.request（鉴权头/CodeBuddy 头/body 处理/请求快照）"
```

---

### Task 5: requests.ts — http.response（SSE 缓冲、11133 重发、非 JSON 400）

**Files:**
- Modify: `src/requests.ts`
- Modify: `test/requests.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `buildHooks`、`handleHttpRequest`、快照 LRU；纯核 `createSSEBufferedStream`
- Produces: `buildHooks().onResponse`；`RETRY_DELAYS_MS = [1000, 4000, 10000, 25000]`

- [ ] **Step 1: 追加失败测试（append 到 `test/requests.test.ts`）**

```ts
function sseLine(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}

describe("http.response", () => {
  it("SSE 流被合并（threshold 触发）", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState({ cfg: { ...makeTestState().cfg, sse: { enabled: true, threshold: 100, maxDelayMs: 50 } } });
    await registerRequests(ctx, state);
    const payload = sseLine({ reasoning_content: "你好。" }) + sseLine({ content: "世界。" }) + "data: [DONE]\n\n";
    const res = new Response(payload, { headers: { "content-type": "text/event-stream" } });
    const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x"), response: res };
    await triggerHook("http.response", e);
    const text = await e.response.text();
    expect(text).toContain("你好。");
    expect(text).toContain("世界。");
    expect(text).toContain("[DONE]");
  });

  it("SSE 被禁用时原样返回", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState({ cfg: { ...makeTestState().cfg, sse: { enabled: false, threshold: 100, maxDelayMs: 50 } } });
    await registerRequests(ctx, state);
    const payload = sseLine({ content: "a" });
    const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x"), response: new Response(payload, { headers: { "content-type": "text/event-stream" } }) };
    await triggerHook("http.response", e);
    expect(await e.response.text()).toBe(payload);
  });

  it("11133 用快照重发，成功后替换响应", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
      const state = makeTestState();
      await registerRequests(ctx, state);
      const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
        request: chatRequest({ stream: true, messages: [] }) };
      await triggerHook("http.request", e);   // 建立快照
      const fetches: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: any) => {
        fetches.push(String(input));
        return new Response(JSON.stringify({ code: 0, ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }));
      e.response = new Response(JSON.stringify({ code: 11133 }), { status: 400, headers: { "content-type": "application/json" } });
      const pending = triggerHook("http.response", e);
      await vi.runAllTimersAsync();
      await pending;
      expect(fetches).toHaveLength(1);
      expect(e.response.status).toBe(200);
      expect(await e.response.text()).toContain('"ok":true');
    } finally {
      vi.useRealTimers();
    }
  });

  it("非 JSON 的 400 原样返回（HTML 网关错误页）", async () => {
    const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    const html = "<html>Bad Gateway</html>";
    const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
      request: new Request("https://x"), response: new Response(html, { status: 400, headers: { "content-type": "text/html" } }) };
    await triggerHook("http.response", e);
    expect(e.response.status).toBe(400);
    expect(await e.response.text()).toBe(html);
  });

  it("SSE 流被提前取消后定时 flush 不崩", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, triggerHook } = createMockCtx({ credential: { type: "key", key: "k" } });
      const state = makeTestState({ cfg: { ...makeTestState().cfg, sse: { enabled: true, threshold: 100, maxDelayMs: 50 } } });
      await registerRequests(ctx, state);
      const payload = sseLine({ reasoning_content: "碎片" });   // 未达 threshold、无标点 → 只能靠 timer flush
      const e: any = { sessionID: "s1", model: { providerID: "codebuddy", id: "auto" }, kind: "primary",
        request: new Request("https://x"), response: new Response(payload, { headers: { "content-type": "text/event-stream" } }) };
      await triggerHook("http.response", e);
      const reader = e.response.body!.getReader();
      await reader.cancel();                     // 不 read：timer flush 尚未产出，直接取消
      await vi.advanceTimersByTimeAsync(200);    // timer 在已取消的流上触发，必须有 try/catch 兜住
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run test/requests.test.ts
```

期望：FAIL（`hook http.response 未注册`）。

- [ ] **Step 3: 实现 http.response（改 `src/requests.ts`）**

在 `buildHooks` 的返回值中加入 `onResponse`，并在 `registerRequests` 注册：

```ts
await ctx.session.hook("http.response", hooks.onResponse, { providerID: PROVIDER_ID });
```

新增实现：

```ts
import { createSSEBufferedStream } from "./sse-buffer.js";
import { sleep } from "./auth-flow.js";

const RETRY_DELAYS_MS = [1000, 4000, 10000, 25000];

function withSseBuffer(response: Response, state: PluginState): Response {
  const { sse } = state.cfg;
  if (!sse.enabled || !response.body) return response;
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const buffered = createSSEBufferedStream(response.body as ReadableStream<Uint8Array>, {
    threshold: sse.threshold, maxDelayMs: sse.maxDelayMs,
  });
  return new Response(buffered as unknown as BodyInit, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

async function handleHttpResponse(event: AnyEvent, state: PluginState): Promise<void> {
  const response: Response = event.response;

  if (response.status === 400) {
    let text: string | undefined;
    try { text = await response.clone().text(); } catch { text = undefined; }
    if (text !== undefined) {
      let code: unknown;
      try { code = (JSON.parse(text) as any)?.code; } catch { /* 非 JSON */ }

      if (code === 11133) {
        const traceId = event.request?.headers?.get?.("X-Request-Trace-Id");
        const snapshot = traceId ? state.requestSnapshots.get(traceId) : undefined;
        if (!snapshot) {
          state.logger.warn("codebuddy: 11133 但无请求快照，原样返回");
          return;
        }
        let last: Response = response;
        for (const delay of RETRY_DELAYS_MS) {
          await sleep(delay);
          const retryRes = await fetch(snapshot.url, { method: snapshot.method, headers: snapshot.headers, body: snapshot.body });
          if (retryRes.ok) {
            event.response = withSseBuffer(retryRes, state);
            return;
          }
          last = retryRes;
          const retryText = await retryRes.clone().text();
          let retryCode: unknown;
          try { retryCode = (JSON.parse(retryText) as any)?.code; } catch { /* 非 JSON */ }
          if (retryCode !== 11133) break;
        }
        event.response = last;
        return;
      }
    }
    if (text !== undefined) {
      const h = new Headers(response.headers);
      h.set("Content-Type", "application/json");
      event.response = new Response(text, { status: 400, headers: h });
      return;
    }
  }

  event.response = withSseBuffer(response, state);
}
```

`buildHooks` 返回 `{ onRequest, onResponse: (event: AnyEvent) => handleHttpResponse(event, state) }`。

- [ ] **Step 4: 运行测试**

```bash
npx vitest run test/requests.test.ts   # 期望：12 passed
npx tsc --noEmit                       # 期望：零错
```

- [ ] **Step 5: 提交**

```bash
git add src/requests.ts test/requests.test.ts
git commit -m "feat: V2 http.response（SSE 缓冲、11133 快照重发、400 透传）"
```

---

### Task 6: requests.ts — retry 观测 + 事件订阅与 cleanup

**Files:**
- Modify: `src/requests.ts`
- Modify: `test/requests.test.ts`

**Interfaces:**
- Consumes: Task 4/5 的 `registerRequests`
- Produces: `registerRequests` 注册 `retry`（仅日志）+ `ctx.event.subscribe`；返回 cleanup（abort）

- [ ] **Step 1: 追加失败测试**

```ts
describe("retry + 事件订阅", () => {
  it("retry hook 注册且仅记录日志", async () => {
    const { ctx, calls } = createMockCtx({ credential: { type: "key", key: "k" } });
    const state = makeTestState();
    await registerRequests(ctx, state);
    expect(calls.hooks.has("retry")).toBe(true);
    const err = { error: { type: "provider.invalid-request", status: 400, message: "x" }, attempt: 2, decision: { retry: false } };
    await calls.hooks.get("retry")!(err);
    expect(state.logger.info).toHaveBeenCalled();
  });

  it("session.compacted 清 conversationIds", async () => {
    let pushEvent: ((e: any) => void) | null = null;
    const { ctx, triggerHook } = createMockCtx({
      credential: { type: "key", key: "k" },
      subscription: () => (async function* () {
        while (true) {
          const next = await new Promise<any>((resolve) => { pushEvent = resolve; });
          yield next;
        }
      })(),
    });
    const state = makeTestState();
    await registerRequests(ctx, state);

    const e: any = { sessionID: "sess-x", model: { providerID: "codebuddy", id: "auto" }, kind: "primary", request: chatRequest({ messages: [] }) };
    await triggerHook("http.request", e);
    expect(state.conversationIds.get("sess-x")).toBeTruthy();

    pushEvent!({ type: "session.compacted", data: { sessionID: "sess-x" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(state.conversationIds.get("sess-x")).toBeUndefined();
  });

  it("cleanup 中止订阅", async () => {
    let aborted = false;
    const { ctx } = createMockCtx({
      subscription: (signal: AbortSignal) => (async function* () {
        if (signal.aborted) { aborted = true; return; }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
        });
      })(),
    });
    const state = makeTestState();
    const cleanup = await registerRequests(ctx, state);
    await new Promise((r) => setTimeout(r, 0));   // 让消费循环进入首次 next()
    cleanup();
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run test/requests.test.ts
```

期望：FAIL（retry 未注册 / 订阅未建立 / cleanup 为空）。

- [ ] **Step 3: 实现（改 `src/requests.ts`）**

```ts
await ctx.session.hook("retry", (event: AnyEvent) => {
  state.logger.info(
    `codebuddy retry observed: type=${event?.error?.type} status=${event?.error?.status} attempt=${event?.attempt}`,
  );
}, { providerID: PROVIDER_ID });

const controller = new AbortController();
void (async () => {
  try {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      const e = event as AnyEvent;
      if (e?.type === "session.compacted" || e?.type === "session.deleted") {
        const sid = e?.data?.sessionID;
        if (sid) state.conversationIds.delete(sid);
      }
    }
  } catch { /* abort 或流结束 */ }
})();

return () => controller.abort();
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run test/requests.test.ts   # 期望：15 passed
npx tsc --noEmit                       # 期望：零错
```

- [ ] **Step 5: 提交**

```bash
git add src/requests.ts test/requests.test.ts
git commit -m "feat: V2 retry 观测 + 事件订阅（compacted/deleted 清 conversationId）"
```

---

### Task 7: variant 归一提取 + remoteModelToInfo 适配层

**Files:**
- Modify: `src/models.ts`（提取 `buildVariants`）
- Modify: `src/provider.ts`（新增 `remoteModelToInfo`）
- Create: `test/provider.test.ts`

**Interfaces:**
- Consumes: 纯核 `RemoteModel`、宿主 `Model`/`Provider` namespace
- Produces:
  - `buildVariants(efforts: string[]): Record<string, { reasoningEffort: string }>`（`src/models.ts`，导出）
  - `remoteModelToInfo(m: RemoteModel): Model.Info`（`src/provider.ts`，导出）

- [ ] **Step 1: 先跑现有 models 测试确认基线**

```bash
npx vitest run test/models.test.ts   # 期望：全绿（重构前基线）
```

- [ ] **Step 2: 写失败测试 `test/provider.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { remoteModelToInfo } from "../src/provider.js";

describe("remoteModelToInfo", () => {
  it("基础能力与 limit 映射", () => {
    const info: any = remoteModelToInfo({
      id: "m1", name: "M1", supportsToolCall: true, supportsImages: true,
      maxInputTokens: 1000, maxOutputTokens: 100, maxAllowedSize: 2000,
    });
    expect(info.id).toBe("m1");
    expect(info.modelID).toBe("m1");
    expect(info.name).toBe("M1");
    expect(info.capabilities.tools).toBe(true);
    expect(info.capabilities.input).toContain("image");
    expect(info.limit.context).toBe(2000);
    expect(info.limit.output).toBe(100);
    expect(info.compatibility.supportsPromptCacheKey).toBe(true);
  });

  it("reasoning：compatibility + variants 归一（medium→high、max 唯一高档）", () => {
    const info: any = remoteModelToInfo({
      id: "m2", name: "M2", supportsToolCall: true, supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
    });
    expect(info.compatibility.reasoningField).toBe("reasoning_content");
    expect(info.compatibility.requireReasoning).toBe(true);
    const ids = info.variants.map((v: any) => v.id);
    expect(ids).toEqual(["low", "medium", "high", "max"]);
    const byId = Object.fromEntries(info.variants.map((v: any) => [v.id, v.settings.reasoningEffort]));
    expect(byId.medium).toBe("medium");
    expect(byId.high).toBe("high");
    expect(byId.max).toBe("max");
  });

  it("无 images 时 input 不含 image", () => {
    const info: any = remoteModelToInfo({ id: "m3", name: "M3", supportsToolCall: true });
    expect(info.capabilities.input).not.toContain("image");
  });
});
```

- [ ] **Step 3: 运行确认失败**

```bash
npx vitest run test/provider.test.ts   # 期望：FAIL（remoteModelToInfo 未导出）
```

- [ ] **Step 4: 提取 `buildVariants` 到 `src/models.ts`**

把 `remoteModelToConfig` 内联的 variants 构建抽成导出函数（逻辑逐行照搬，行为不变）：

```ts
// src/models.ts 顶部新增（放在 remoteModelToConfig 之前）
export function buildVariants(efforts: string[]): Record<string, { reasoningEffort: string }> {
  const order = ["low", "medium", "high", "max"];
  const variants: Record<string, { reasoningEffort: string }> = {};
  const pick = (...cands: string[]) => cands.find((c) => efforts.includes(c));
  for (const e of order) {
    if (e === "medium") {
      const hit = pick("medium", "high", "low");
      if (hit) variants.medium = { reasoningEffort: hit };
      continue;
    }
    if (e === "max") {
      if (pick("max") ?? pick("xhigh")) variants.max = { reasoningEffort: "max" };
      continue;
    }
    const hit = pick(e);
    if (hit) variants[e] = { reasoningEffort: hit };
  }
  return variants;
}
```

`remoteModelToConfig` 内 `if (efforts?.length) { ... }` 改为：

```ts
  if (efforts?.length) entry.variants = buildVariants(efforts);
```

（保留 `const efforts = m.reasoning?.supportedEfforts;`。）

- [ ] **Step 5: 实现 `remoteModelToInfo`（`src/provider.ts`）**

```ts
import { Model, Provider } from "@opencode/plugin";
import { PROVIDER_ID } from "./config.js";
import { buildVariants, type RemoteModel } from "./models.js";

export function remoteModelToInfo(m: RemoteModel, providerID: string = PROVIDER_ID): Model.Info {
  const pid = Provider.ID.make(providerID);
  const base = Model.Info.default(pid, Model.ID.make(m.id)) as any;
  const info: any = {
    ...base,
    name: m.name,
    capabilities: {
      ...base.capabilities,
      tools: m.supportsToolCall !== false,
      input: m.supportsImages && !m.disabledMultimodal
        ? [...base.capabilities.input, "image"]
        : base.capabilities.input,
    },
    // V1 setCacheKey 的 V2 对应（e2e #12 验证等价性）
    compatibility: { ...base.compatibility, supportsPromptCacheKey: true },
  };
  const contextLimit = m.maxAllowedSize ?? m.maxInputTokens ?? 0;
  const outputLimit = m.maxOutputTokens ?? 0;
  if (contextLimit || outputLimit) {
    info.limit = {
      ...base.limit,
      context: contextLimit || base.limit.context,
      output: outputLimit || base.limit.output,
    };
  }
  if (m.supportsReasoning) {
    info.compatibility = {
      ...info.compatibility,
      reasoningField: "reasoning_content",
      requireReasoning: true,   // 等价 V1 11155 body 补空（e2e #15 验证是否可删 http.request 兜底）
    };
    const efforts = m.reasoning?.supportedEfforts;
    if (efforts?.length) {
      info.variants = Object.entries(buildVariants(efforts)).map(([id, settings]) => ({
        id: Model.VariantID.make(id),
        settings,
      }));
    }
    const effort = m.reasoning?.defaultEffort ?? m.reasoning?.effort;
    if (effort) info.settings = { ...base.settings, reasoningEffort: effort };
  }
  return info as Model.Info;
}
```

- [ ] **Step 6: 运行测试**

```bash
npx vitest run test/provider.test.ts test/models.test.ts   # 期望：全绿
npx tsc --noEmit                                           # 期望：零错
```

- [ ] **Step 7: 提交**

```bash
git add src/models.ts src/provider.ts test/provider.test.ts
git commit -m "feat: V2 模型适配层 remoteModelToInfo + variant 归一提取"
```

---

### Task 8: provider.ts — provider/model transform、发现与刷新

**Files:**
- Modify: `src/provider.ts`
- Modify: `test/provider.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `remoteModelToInfo`；Task 2 的 `PluginState`；纯核 `resolveServerUrl`、`domainForHost`、`DEFAULT_MODEL`、`fetchRemoteModels`、`DISCOVERY_CACHE_TTL_MS`
- Produces: `registerProvider(ctx, state): Promise<() => void>`——注册 provider transform / model transform，凭证事件与 TTL 触发 `provider.reload()`，返回 cleanup

- [ ] **Step 1: 追加失败测试（append 到 `test/provider.test.ts`）**

```ts
import { vi, afterEach } from "vitest";
import { registerProvider } from "../src/provider.js";
import { createMockCtx, jsonResponse, makeProviderEditor, makeModelEditor, makeTestState } from "./helpers/mock-ctx.js";
import { DiscoveryCache, DEFAULT_MODEL } from "../src/models.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function discoveryResponse(models: any[]) {
  return jsonResponse({ code: 0, data: { agents: [{ name: "craft", models: models.map((m) => m.id) }], models } });
}

describe("registerProvider", () => {
  it("无凭证：注册 provider（含 DEFAULT_MODEL）且不抛", async () => {
    const { ctx, applyProviderTransforms, calls } = createMockCtx();
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    const cleanup = await registerProvider(ctx, state);
    const { editor, added } = makeProviderEditor();
    applyProviderTransforms(editor);
    expect(added).toHaveLength(1);
    const info = added[0].info;
    expect(info.name).toBe("CodeBuddy");
    expect(info.activation).toBe("enabled");
    expect(info.integrationID).toBe("codebuddy");
    expect(info.package).toBe("@opencode/ai/providers/openai-compatible");
    expect(info.settings.baseURL).toContain("/v2");
    expect(added[0].models.length).toBeGreaterThan(0);
    expect(calls.subscriptions.length).toBeGreaterThan(0);
    cleanup();
  });

  it("已有 provider 时走 update 并合并 settings", async () => {
    const { ctx, applyProviderTransforms } = createMockCtx();
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    const cleanup = await registerProvider(ctx, state);
    const seed = { provider: { id: "codebuddy", name: "old", settings: { setCacheKey: true }, integrationID: undefined as any } };
    const { editor, added, updates } = makeProviderEditor(seed);
    applyProviderTransforms(editor);
    expect(added).toHaveLength(0);
    expect(updates).toContain("codebuddy");
    expect(seed.provider.settings.setCacheKey).toBe(true);
    expect(seed.provider.settings.baseURL).toContain("/v2");
    expect(seed.provider.integrationID).toBe("codebuddy");
    cleanup();
  });

  it("configuredBase 覆写 server（ENDPOINT 未设、NETWORK 默认 internal）", async () => {
    delete process.env.CODEBUDDY_ENDPOINT;
    delete process.env.CODEBUDDY_NETWORK;
    const { ctx, applyProviderTransforms } = createMockCtx();
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    const cleanup = await registerProvider(ctx, state);
    const seed = { provider: { id: "codebuddy", name: "x", settings: { baseURL: "https://my-proxy.example.com/v2" }, integrationID: undefined as any } };
    const { editor } = makeProviderEditor(seed);
    applyProviderTransforms(editor);
    expect(seed.provider.settings.baseURL).toBe("https://my-proxy.example.com/v2");
    cleanup();
  });

  it("ENDPOINT 已设时 configuredBase 不覆写", async () => {
    process.env.CODEBUDDY_ENDPOINT = "https://env.example.com";
    try {
      const { ctx, applyProviderTransforms } = createMockCtx();
      const state = makeTestState();
      state.discovered = [DEFAULT_MODEL];
      const cleanup = await registerProvider(ctx, state);
      const seed = { provider: { id: "codebuddy", name: "x", settings: { baseURL: "https://base.example.com/v2" }, integrationID: undefined as any } };
      const { editor } = makeProviderEditor(seed);
      applyProviderTransforms(editor);
      expect(seed.provider.settings.baseURL).toBe("https://env.example.com/v2");
      cleanup();
    } finally {
      delete process.env.CODEBUDDY_ENDPOINT;
    }
  });

  it("api key 凭证：不发现，注入 DEFAULT_MODEL", async () => {
    const fetchSpy = vi.fn(async () => discoveryResponse([]));
    vi.stubGlobal("fetch", fetchSpy);
    const { ctx, applyProviderTransforms } = createMockCtx({ credential: { type: "key", key: "ck_x" } });
    const state = makeTestState();
    const cleanup = await registerProvider(ctx, state);
    const { editor, added } = makeProviderEditor();
    applyProviderTransforms(editor);
    expect(added).toHaveLength(1);
    expect(added[0].models.some((m: any) => m.id === "auto")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    cleanup();
  });

  it("发现成功：模型经 model transform 注入", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => discoveryResponse([
      { id: "m1", name: "M1", supportsToolCall: true, maxInputTokens: 1000, maxOutputTokens: 10 },
    ])));
    const { ctx, applyProviderTransforms, applyModelTransforms } = createMockCtx({ credential: { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000 } });
    const state = makeTestState({
      discoveryCache: new DiscoveryCache({ ttlMs: 60_000, fetchFn: (token) => (globalThis.fetch as any)(`https://copilot.tencent.com/v3/config?t=${token}`).then((r: Response) => r.json()).then((b: any) => b.data.models) }),
    });
    const cleanup = await registerProvider(ctx, state);
    const p = makeProviderEditor();
    applyProviderTransforms(p.editor);
    const m = makeModelEditor();
    applyModelTransforms(m.editor);
    expect(m.updates.some((u) => u.modelID === "m1")).toBe(true);
    cleanup();
  });

  it("credential.switched 事件触发 provider.reload", async () => {
    let pushEvent: ((e: any) => void) | null = null;
    const { ctx, calls } = createMockCtx({
      subscription: () => (async function* () {
        while (true) {
          const next = await new Promise<any>((resolve) => { pushEvent = resolve; });
          yield next;
        }
      })(),
    });
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    const cleanup = await registerProvider(ctx, state);
    pushEvent!({ type: "credential.switched", data: { integrationID: "codebuddy", credentialID: "c1" } });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.reloads.provider).toBeGreaterThan(0);
    cleanup();
  });

  it("TTL 定时器触发刷新，cleanup 清除", async () => {
    vi.useFakeTimers();
    const { ctx, calls } = createMockCtx();
    const state = makeTestState();
    state.discovered = [DEFAULT_MODEL];
    const cleanup = await registerProvider(ctx, state);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(calls.reloads.provider).toBeGreaterThan(0);
    cleanup();
    const before = calls.reloads.provider;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(calls.reloads.provider).toBe(before);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run test/provider.test.ts   # 期望：FAIL（registerProvider 仍为空实现）
```

- [ ] **Step 3: 实现 `registerProvider`（`src/provider.ts`）**

```ts
import { Provider } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin";
import { DISCOVERY_CACHE_TTL_MS, PROVIDER_ID, domainForHost } from "./config.js";
import { resolveCredential } from "./credentials.js";
import { DEFAULT_MODEL, type RemoteModel } from "./models.js";
import type { PluginState } from "./state.js";

const BASE_PACKAGE = "@opencode/ai/providers/openai-compatible";

export async function registerProvider(ctx: Plugin.Context, state: PluginState): Promise<() => void> {
  await load(ctx, state);
  await ctx.provider.transform((editor) => applyProvider(editor, state));
  await ctx.model.transform((editor) => applyModels(editor, state));

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const e = event as any;
        if (e?.type !== "credential.switched" && e?.type !== "credential.updated") continue;
        if (e.type === "credential.switched" && e.data?.integrationID !== PROVIDER_ID) continue;
        await load(ctx, state).catch(() => {});
        await ctx.provider.reload().catch(() => {});
      }
    } catch { /* abort 或流结束 */ }
  })();

  const timer = setInterval(() => { void refresh(ctx, state); }, DISCOVERY_CACHE_TTL_MS);
  return () => { controller.abort(); clearInterval(timer); };
}

async function refresh(ctx: Plugin.Context, state: PluginState): Promise<void> {
  await load(ctx, state).catch(() => {});
  await ctx.provider.reload().catch(() => {});
}

async function load(ctx: Plugin.Context, state: PluginState): Promise<void> {
  const credential = await resolveCredential(ctx, state);
  if (!credential || credential.type !== "oauth" || !credential.access) {
    state.discovered = state.discovered ?? [DEFAULT_MODEL];
    return;
  }
  try {
    state.discovered = await state.discoveryCache.get(credential.access);
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) {
      state.logger.warn("discovery 401/403 — 需重新登录（/connect codebuddy）");
      state.discovered = state.discovered ?? [];
    } else {
      state.logger.warn(`discovery failed: ${e?.message}`);
      state.discovered = state.discovered ?? [DEFAULT_MODEL];
    }
  }
}

function applyProvider(editor: any, state: PluginState): void {
  const existing = editor.get(PROVIDER_ID);
  const configuredBase = existing?.provider?.settings?.baseURL;
  if (!state.cfg.endpoint && state.cfg.network === "internal" && typeof configuredBase === "string") {
    try {
      const u = new URL(configuredBase);
      state.server = { url: `${u.protocol}//${u.host}`, domain: domainForHost(u.host) };
    } catch { /* 无效 URL：保持 env/默认 server */ }
  }

  const base = Provider.Info.empty(Provider.ID.make(PROVIDER_ID));
  const info: any = {
    ...base,
    name: "CodeBuddy",
    activation: "enabled",
    package: BASE_PACKAGE,
    settings: { baseURL: `${state.server.url}/v2`, apiKey: "codebuddy" },
    integrationID: PROVIDER_ID,
  };

  if (existing) {
    editor.update(PROVIDER_ID, (p: any) => {
      p.name = info.name;
      p.settings = { ...p.settings, ...info.settings };
      p.integrationID = PROVIDER_ID;
    });
  } else {
    editor.add({ info, models: modelsFor(state) });
  }
}

function modelsFor(state: PluginState): any[] {
  return (state.discovered ?? [DEFAULT_MODEL]).map((m) => remoteModelToInfo(m));
}

function applyModels(editor: any, state: PluginState): void {
  for (const m of state.discovered ?? [DEFAULT_MODEL]) {
    editor.update(PROVIDER_ID, m.id, (draft: any) => { Object.assign(draft, remoteModelToInfo(m)); });
  }
}
```

（保留 Task 7 的 `remoteModelToInfo`；`Provider` 从 `@opencode/plugin` import。）

- [ ] **Step 4: 运行测试**

```bash
npx vitest run test/provider.test.ts   # 期望：8 passed
npx tsc --noEmit                       # 期望：零错
```

- [ ] **Step 5: 提交**

```bash
git add src/provider.ts test/provider.test.ts
git commit -m "feat: V2 provider/model transform + 模型发现与凭证事件刷新"
```

---

### Task 9: 错误隔离集成测试 + DoD 全量验证

**Files:**
- Modify: `test/setup.test.ts`

**Interfaces:**
- Consumes: 全部前置任务的实现
- Produces: 完成 DoD 的可验证证据

- [ ] **Step 1: 追加错误隔离测试（append 到 `test/setup.test.ts`）**

```ts
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
```

- [ ] **Step 2: 运行设置测试**

```bash
npx vitest run test/setup.test.ts   # 期望：4 passed
```

- [ ] **Step 3: DoD 全量验证**

```bash
npx tsc --noEmit    # DoD 1：零错
npm test            # DoD 2：全绿（纯核 + legacy + V2）
npm run build       # DoD 3：dist/index.js + dist/index.d.ts 产出
node -e "import('./dist/index.js').then(m => console.log(m.default.id))"   # 期望：codebuddy
```

- [ ] **Step 4: 提交**

```bash
git add test/setup.test.ts
git commit -m "test: V2 错误隔离集成测试 + DoD 全量通过"
```

---

## 完成定义（对照 spec §1）

| # | 标准 | 验证命令 |
|---|------|----------|
| 1 | tsc 零错 | `npx tsc --noEmit` |
| 2 | 测试全绿 | `npm test` |
| 3 | 构建产出 | `npm run build` + `ls dist/index.js dist/index.d.ts` |
| 4 | 错误隔离 | `npx vitest run test/setup.test.ts` |
| 5 | 模型列表在无凭证时非空 | `npx vitest run test/provider.test.ts` |

## GA 后待办（不在本计划内）

spec 附录 B 的 14 项 e2e 清单，全部需要真实 V2 宿主；GA 后再执行，不在 `v2-poc` 分支当前范围。
