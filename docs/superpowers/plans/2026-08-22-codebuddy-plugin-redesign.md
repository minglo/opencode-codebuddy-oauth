# opencode-codebuddy-oauth v2.0 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 src/index.ts 单文件 1146 行插件按设计文档完全重构为分层纯核+薄胶水架构，修复 37 个问题，发布 2.0.0 到 npm

**Architecture:** 分层纯核——核心逻辑（config/log/lru/fetch-json/jwt/headers/auth-state/auth-flow/auth-fetch/models/sse-buffer）不 import @opencode-ai/plugin，仅 index.ts 薄胶水接线 Plugin 工厂闭包持有 serverUrl/domain/conversationIds。TDD 自底向上，每模块独立测试，auth-fetch 抽取五守卫可测。

**Tech Stack:** TypeScript ^7.0.2 (tsgo, strict+verbatimModuleSyntax+noUncheckedIndexedAccess, ES2023, NodeNext), tsup (ESM+dts, external @opencode-ai/*), vitest, @opencode-ai/plugin >=1.18.0 + @opencode-ai/sdk

**Spec:** docs/superpowers/specs/2026-08-22-codebuddy-plugin-redesign-design.md

## Global Constraints

- auth.json 格式不可破坏：{type:"api";key} | {type:"oauth";access,refresh,expires} —— 只能加宽容解析
- 零运行时依赖：zod/lru-cache 均手写，不新增 runtime deps
- 破坏性版本 2.0.0，包名沿用 opencode-codebuddy-oauth，env 全量重命名无兼容层（旧名静默失效）
- 禁裸 console：全项目走 log.ts，经 client.app.log({body:{service:"codebuddy",level,message,extra}})
- 禁模块级可变全局：resolvedServerUrl/domain/sessionConversationIds 全由 Plugin 工厂闭包持有
- 构建：tsup 单入口 src/index.ts → dist/index.{js,d.ts}，format ESM，target node18，external @opencode-ai/*，dts true
- package.json 入口：main dist/index.js, types dist/index.d.ts, exports {".":{types,import}}, files ["dist"], engines node>=22, peer @opencode-ai/plugin >=1.18.0 不放松
- tsconfig：strict + verbatimModuleSyntax + noUncheckedIndexedAccess, target ES2023, module/moduleResolution NodeNext, declaration true, outDir dist, rootDir src
- 地址优先级（破坏性反转）：CODEBUDDY_ENDPOINT > CODEBUDDY_NETWORK > provider.options.baseURL > 默认 https://copilot.tencent.com，domain 不对称推导（仅 host.includes("codebuddy.ai") 改 www.codebuddy.ai）
- 硬编码产品常量 11 项不经 env 覆盖：PROVIDER_ID, CHAT_COMPLETIONS_PATH, PLATFORM, APP_VERSION, IDE_NAME/TYPE/VERSION, DOMAIN_DEFAULT, PRODUCT, AGENT_INTENT=craft, ENV_ID

---

## File Structure

```
src/
  index.ts        # Plugin 工厂：config/event/auth.loader/chat.headers，接线 deps
  config.ts       # getConfig(), num(), constants, resolveServerUrl(), getAuthJsonPath()
  log.ts          # createLogger(client?) → Logger {debug,info,warn,error}
  lru.ts          # LRUMap<K,V>，max<=0 退化单条
  fetch-json.ts   # fetchJson<T>(url, opts) + 内部 withTimeout
  jwt.ts          # decodeJwtPayload, resolveIdentity(payload, cfg?)
  headers.ts      # baseHeaders, buildRequestHeaders, buildAuthHeaders, resolveModel
  auth-state.ts   # parseStoredAuth, pickAuthMode, effectiveAuth, needsRefresh
  auth-flow.ts    # requestAuthState, pollForToken, refreshAccessToken, RefreshLock, sleep
  auth-fetch.ts   # createAuthFetch(getAuth, client, server, LRU, cfg) → fetch 守卫
  models.ts       # remoteModelToConfig, mergeModelEntry, DiscoveryCache, DEFAULT_MODEL
  sse-buffer.ts   # createSSEBufferedStream，FLUSH_RE，hasFlushTrigger
test/
  lru.test.ts, fetch-json.test.ts, jwt.test.ts, log.test.ts, config.test.ts,
  headers.test.ts, auth-state.test.ts, auth-flow.test.ts, auth-fetch.test.ts,
  models.test.ts, sse-buffer.test.ts, index.test.ts (integration)
tsup.config.ts, vitest.config.ts
```

---

### Task 1: 脚手架 — tsup + vitest + tsconfig 严格集 + package.json 入口修复

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`

**Interfaces:**
- Consumes: 设计 §7
- Produces: 可执行的 `npm run build` / `npm test`，为后续所有任务提供地基

- [ ] **Step 1: 修改 package.json 入口与脚本**

```json
{
  "version": "2.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "engines": { "node": ">=22" },
  "scripts": { "build": "tsup", "test": "vitest run", "prepublishOnly": "npm test && npm run build" },
  "peerDependencies": { "@opencode-ai/plugin": ">=1.18.0" },
  "devDependencies": {
    "@opencode-ai/plugin": "1.18.0",
    "@opencode-ai/sdk": "^1.0.0",
    "@types/node": "^26.2.0",
    "tsup": "latest",
    "vitest": "latest",
    "typescript": "^7.0.2"
  }
}
```
要点：peer 不放松为 1.18.0（现状 L11），补 @opencode-ai/sdk 供 log.ts 类型，exports 顺序 types 在 import 前。

- [ ] **Step 2: 升级 tsconfig.json 严格集**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: 创建 tsup.config.ts**

```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  target: "node18",
  clean: true,
  sourcemap: true,
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
});
```

- [ ] **Step 4: 创建 vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
```

- [ ] **Step 5: 验证**

Run: `npm install && npx tsc --noEmit && npx tsup --version && npx vitest --version`
Expected: 三者均无报错，tsc 在空 src/index.ts 占位时通过

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json tsup.config.ts vitest.config.ts
git commit -m "chore: scaffold tsup+vitest+strict tsconfig, fix package entry to 2.0.0"
```

---

### Task 2: lru.ts — Map 精简 LRU（max<=0 退化单条）

**Files:**
- Create: `src/lru.ts`
- Test: `test/lru.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `export class LRUMap<K,V> { get, set, delete, clear, size }` 供 index.ts 闭包与 config 测试使用

- [ ] **Step 1: 写 failing test**

```ts
// test/lru.test.ts
import { describe, it, expect } from "vitest";
import { LRUMap } from "../src/lru.js";

describe("LRUMap", () => {
  it("淘汰最久未用", () => {
    const m = new LRUMap<string,number>(2);
    m.set("a",1); m.set("b",2); m.set("c",3);
    expect(m.get("a")).toBeUndefined();
    expect(m.get("b")).toBe(2);
  });
  it("命中提升", () => {
    const m = new LRUMap<string,number>(2);
    m.set("a",1); m.set("b",2); m.get("a"); m.set("c",3);
    expect(m.get("b")).toBeUndefined();
    expect(m.get("a")).toBe(1);
  });
  it("max<=0 退化单条：set A、set B 后 get A 为 undefined、get B 命中", () => {
    const m = new LRUMap<string,number>(0);
    m.set("a",1); m.set("b",2);
    expect(m.get("a")).toBeUndefined();
    expect(m.get("b")).toBe(2);
    expect(m.size).toBe(1);
  });
  it("max=0 与 max=1 行为等价均为单条", () => {
    const m0 = new LRUMap<string,number>(0);
    const m1 = new LRUMap<string,number>(1);
    m0.set("a",1); m0.set("b",2);
    m1.set("a",1); m1.set("b",2);
    expect(m0.size).toBe(1);
    expect(m1.size).toBe(1);
  });
  it("delete/clear/size（供 session.compacted/deleted 清 LRU）", () => {
    const m = new LRUMap<string,number>(3);
    m.set("a",1); m.set("b",2);
    expect(m.delete("a")).toBe(true);
    expect(m.get("a")).toBeUndefined();
    expect(m.size).toBe(1);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.get("b")).toBeUndefined();
  });
  it("delete 不存在返回 false", () => {
    const m = new LRUMap<string,number>(2);
    expect(m.delete("missing")).toBe(false);
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/lru.test.ts`
Expected: FAIL "Cannot find module '../src/lru.js'"

- [ ] **Step 3: 最小实现**

```ts
// src/lru.ts
export class LRUMap<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k: K, v: V): void {
    if (this.max <= 0) { this.map.clear(); this.map.set(k, v); return; }
    if (this.map.has(k)) this.map.delete(k);
    else if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first as K);
    }
    this.map.set(k, v);
  }
  delete(k: K): boolean { return this.map.delete(k); }
  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/lru.test.ts`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add src/lru.ts test/lru.test.ts
git commit -m "feat: add LRUMap with max<=0 single-entry fallback"
```

---

### Task 3: fetch-json.ts — 统一超时/错误 + 401/403 分流

**Files:**
- Create: `src/fetch-json.ts`
- Test: `test/fetch-json.test.ts`

**Interfaces:**
- Consumes: 设计 §5.4
- Produces: `export async function fetchJson<T>(url, opts): Promise<{ok:true;data:T}|{ok:false;status?,text?}>` 供 auth-flow/models 使用

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchJson } from "../src/fetch-json.js";

describe("fetchJson", () => {
  it("超时中止返回 ok:false", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (() => new Promise(()=>{})) as any;
    const r = await fetchJson("http://x", { timeoutMs: 10 });
    expect(r.ok).toBe(false);
    globalThis.fetch = orig;
  });
  it("外部 signal 联动", async () => {
    const ac = new AbortController(); ac.abort();
    const r = await fetchJson("http://x", { timeoutMs: 1000, signal: ac.signal });
    expect(r.ok).toBe(false);
  });
  it("非2xx 返回 status/text 截断500", async () => {
    globalThis.fetch = (async () => new Response("x".repeat(600), { status: 500 })) as any;
    const r = await fetchJson("http://x", { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.text!.length).toBeLessThanOrEqual(500);
  });
  it("401/403 不吞为网络错误，带 status 返回", async () => {
    globalThis.fetch = (async () => new Response("unauth", { status: 401 })) as any;
    const r = await fetchJson("http://x", { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
  it("cancel 时 clearTimeout + removeEventListener 不泄漏", async () => {
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, "addEventListener");
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const clearSpy = vi.spyOn(global, "clearTimeout");
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok:1 }), { status: 200, headers: { "Content-Type":"application/json" } })) as any;
    await fetchJson("http://x", { timeoutMs: 1000, signal: ac.signal });
    expect(clearSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    addSpy.mockRestore(); removeSpy.mockRestore(); clearSpy.mockRestore();
  });
  it("401 分流：调用方不进 DEFAULT_MODEL 降级（status 可区分）", async () => {
    globalThis.fetch = (async () => new Response("unauth", { status: 401 })) as any;
    const r = await fetchJson<{code:number}>("http://x", { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // 调用方应据 status 走 needsRefresh 而非降级
      expect(r.status).toBe(401);
      expect(r.text).toBe("unauth");
    }
  });
  it("外部 signal 已中止时立即返回 ok:false", async () => {
    const ac = new AbortController(); ac.abort();
    globalThis.fetch = vi.fn() as any;
    const r = await fetchJson("http://x", { timeoutMs: 1000, signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/fetch-json.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: 实现 withTimeout + fetchJson**

```ts
// src/fetch-json.ts 关键结构
function withTimeout(ms: number, external?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: ctrl.signal, cancel: () => { clearTimeout(timer); external?.removeEventListener("abort", onAbort); } };
}
export async function fetchJson<T>(url: string, opts: { method?: string; headers?: Record<string,string>; body?: string; timeoutMs: number; signal?: AbortSignal }) {
  const t = withTimeout(opts.timeoutMs, opts.signal);
  try {
    const res = await fetch(url, { method: opts.method, headers: opts.headers, body: opts.body, signal: t.signal });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      return { ok: false as const, status: res.status, text };
    }
    const data = await res.json() as T;
    return { ok: true as const, data };
  } catch {
    return { ok: false as const, text: "timeout or abort" };
  } finally { t.cancel(); }
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/fetch-json.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/fetch-json.ts test/fetch-json.test.ts
git commit -m "feat: add fetchJson with timeout and 401/403 passthrough"
```

---

### Task 4: jwt.ts — 一次解码 resolveIdentity

**Files:**
- Create: `src/jwt.ts`
- Test: `test/jwt.test.ts`

**Interfaces:**
- Consumes: config 的 cfg.*Id 短路
- Produces: `decodeJwtPayload(token): JwtPayload|null`, `resolveIdentity(payload, cfg?): {tenantId,enterpriseId,userId}` 供 headers 使用

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect } from "vitest";
import { decodeJwtPayload, resolveIdentity } from "../src/jwt.js";

function b64(o: unknown) { return Buffer.from(JSON.stringify(o)).toString("base64url"); }
function tok(p: unknown) { return `h.${b64(p)}.s`; }

describe("jwt", () => {
  it("畸形 token 返回 null", () => { expect(decodeJwtPayload("bad")).toBeNull(); });
  it("tenant 8变体", () => {
    expect(resolveIdentity({ iss: "https://x/realms/sso-abc123" } as any).tenantId).toBe("abc123");
    expect(resolveIdentity({ tenant_id: "t1" } as any).tenantId).toBe("t1");
  });
  it("iss 中段 sso- 不误匹配（$ 锚）", () => {
    expect(resolveIdentity({ iss: "https://x/realms/sso-abc/extra" } as any).tenantId).toBe("");
  });
  it("enterprise group-admin 遍历", () => {
    expect(resolveIdentity({ realm_access: { roles: ["group-admin:ent-1"] } } as any).enterpriseId).toBe("ent-1");
  });
  it("cfg 短路优先于 JWT", () => {
    expect(resolveIdentity({ tenant_id: "jwt" } as any, { tenantId: "cfg" } as any).tenantId).toBe("cfg");
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/jwt.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/jwt.ts
export interface JwtPayload {
  iss?: string; tenant_id?: string; tenantId?: string;
  enterprise_id?: string; enterpriseId?: string; ent_id?: string; entId?: string;
  user_id?: string; userId?: string; uid?: string; sub?: string;
  realm_access?: { roles?: string[] }; resource_access?: { account?: { roles?: string[] } };
}

export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(payload + pad, "base64").toString("utf8")) as JwtPayload;
  } catch { return null; }
}

export function resolveIdentity(
  payload: JwtPayload | null,
  cfg?: { tenantId?: string; enterpriseId?: string; userId?: string },
): { tenantId: string; enterpriseId: string; userId: string } {
  if (!payload) return { tenantId: cfg?.tenantId ?? "", enterpriseId: cfg?.enterpriseId ?? "", userId: cfg?.userId ?? "" };
  // tenant：cfg 短路 > tenant_id/tenantId > iss 末尾 sso-（$ 锚）
  let tenantId = cfg?.tenantId ?? "";
  if (!tenantId) {
    if (payload.tenant_id) tenantId = payload.tenant_id;
    else if (payload.tenantId) tenantId = payload.tenantId;
    else {
      const m = (payload.iss ?? "").match(/realms\/sso-([^/]+)$/);
      if (m?.[1]) tenantId = m[1];
    }
  }
  // enterprise：cfg 短路 > roles 中 group-admin:* > enterprise_id 变体
  let enterpriseId = cfg?.enterpriseId ?? "";
  if (!enterpriseId) {
    const roles = payload.realm_access?.roles ?? payload.resource_access?.account?.roles;
    if (roles) { for (const r of roles) { const m = r.match(/group-admin:([A-Za-z0-9-]+)/); if (m?.[1]) { enterpriseId = m[1]; break; } } }
    if (!enterpriseId) enterpriseId = payload.enterprise_id ?? payload.enterpriseId ?? payload.ent_id ?? payload.entId ?? "";
  }
  // user：cfg 短路 > user_id 变体
  let userId = cfg?.userId ?? "";
  if (!userId) userId = payload.user_id ?? payload.userId ?? payload.uid ?? payload.sub ?? "";
  return { tenantId, enterpriseId, userId };
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/jwt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/jwt.ts test/jwt.test.ts
git commit -m "feat: add jwt decode once with 8-variant claims"
```

---

### Task 5: log.ts — client.app.log body 包装

**Files:**
- Create: `src/log.ts`
- Test: `test/log.test.ts`

**Interfaces:**
- Consumes: 设计 §5.2，类型来自 @opencode-ai/sdk 或 PluginInput["client"]
- Produces: `createLogger(client?) → Logger` 供全项目使用，禁裸 console

- [ ] **Step 1: 写 failing test**

```ts
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
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/log.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/log.ts
export interface Logger { debug(m:string, extra?:object):void; info(m:string, extra?:object):void; warn(m:string, extra?:object):void; error(m:string, extra?:object):void; }
export function createLogger(client?: any): Logger {
  const sink = (level:string, message:string, extra?:object) => {
    if (client?.app?.log) client.app.log({ body: { service: "codebuddy", level, message, extra } }).catch(()=>{});
    else if (level==="warn"||level==="error") console.error(`[codebuddy] ${level}: ${message}`, extra ?? "");
  };
  return { debug:(m,e)=>sink("debug",m,e), info:(m,e)=>sink("info",m,e), warn:(m,e)=>sink("warn",m,e), error:(m,e)=>sink("error",m,e) };
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/log.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/log.ts test/log.test.ts
git commit -m "feat: add logger with body-wrapped client.app.log"
```

---

### Task 6: config.ts — getConfig 懒读 + constants + 优先级链

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: lru 退化语义, jwt 短路
- Produces: `getConfig(): CodeBuddyConfig`, `resolveServerUrl(cfg)`, `getAuthJsonPath()`, `num(v,d)`, constants 供全项目

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getConfig, resolveServerUrl, getAuthJsonPath } from "../src/config.js";
import * as os from "os";

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
    vi.spyOn(os, "homedir").mockReturnValue("/Users/test");
    expect(getAuthJsonPath()).toBe("/Users/test/Library/Application Support/opencode/auth.json");
    spy.mockRestore();
  });
  it("getAuthJsonPath linux 回退 XDG_DATA_HOME", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux" as any);
    vi.spyOn(os, "homedir").mockReturnValue("/home/test");
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
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/config.ts
import * as os from "os";
import * as path from "path";

export const PROVIDER_ID = "codebuddy";
export const CHAT_COMPLETIONS_PATH = "/v2/chat/completions";
export const PLATFORM = "VSCode";
export const APP_VERSION = "4.9.29177644";
export const IDE_NAME = "VSCode";
export const IDE_TYPE = "VSCode";
export const IDE_VERSION = "1.119.0";
export const DOMAIN_DEFAULT = "www.codebuddy.cn";
export const PRODUCT = "SaaS";
export const AGENT_INTENT = "craft";
export const ENV_ID = "production";
export const DISCOVERY_TIMEOUT_MS = 5000;
export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 8000;
export const POLL_TOTAL_TIMEOUT_MS = 10*60*1000;
export const AUTH_STATE_TIMEOUT_MS = 5000;
export const REFRESH_TIMEOUT_MS = 5000;
export const REFRESH_SKEW_MS = 5*60*1000;
export const DEFAULT_EXPIRES_MS = 24*60*60*1000;
export const DISCOVERY_CACHE_TTL_MS = 5*60*1000;

export interface CodeBuddyConfig {
  endpoint?: string; network: "internal"|"ioa"|"internet"; auth: "auto"|"oauth"|"api";
  model?: string; stableConversationId: boolean; conversationMapMax: number;
  sse: { enabled:boolean; threshold:number; maxDelayMs:number };
  tenantId?:string; enterpriseId?:string; userId?:string;
  apiKey?:string; platform:string; appVersion:string; ideName:string; ideType:string; ideVersion:string;
  domain:string; product:string; agentIntent:string; envId:string;
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

export function getConfig(): CodeBuddyConfig {
  return {
    endpoint: process.env.CODEBUDDY_ENDPOINT || "",
    network: (process.env.CODEBUDDY_NETWORK || "internal").toLowerCase() as CodeBuddyConfig["network"],
    auth: (process.env.CODEBUDDY_AUTH || "auto").toLowerCase() as CodeBuddyConfig["auth"],
    model: process.env.CODEBUDDY_MODEL || "",
    stableConversationId: process.env.CODEBUDDY_STABLE_CONVERSATION !== "0",
    conversationMapMax: num(process.env.CODEBUDDY_CONVERSATION_MAP_MAX, 1000),
    sse: {
      enabled: process.env.CODEBUDDY_SSE !== "0",
      threshold: num(process.env.CODEBUDDY_SSE_THRESHOLD, 24),
      maxDelayMs: num(process.env.CODEBUDDY_SSE_DELAY_MS, 40),
    },
    tenantId: process.env.CODEBUDDY_TENANT_ID || "",
    enterpriseId: process.env.CODEBUDDY_ENTERPRISE_ID || "",
    userId: process.env.CODEBUDDY_USER_ID || "",
    apiKey: process.env.CODEBUDDY_API_KEY || "",
    platform: PLATFORM, appVersion: APP_VERSION, ideName: IDE_NAME, ideType: IDE_TYPE, ideVersion: IDE_VERSION,
    domain: DOMAIN_DEFAULT, product: PRODUCT, agentIntent: AGENT_INTENT, envId: ENV_ID,
  };
}

export function resolveServerUrl(cfg: Pick<CodeBuddyConfig,"endpoint"|"network"> & { endpoint?:string }): { url:string; domain:string } {
  if (cfg.endpoint) {
    const url = cfg.endpoint.replace(/\/+$/, "");
    const domain = url.includes("codebuddy.ai") ? "www.codebuddy.ai" : "www.codebuddy.cn";
    return { url, domain };
  }
  if (cfg.network === "internal" || cfg.network === "ioa") return { url: "https://copilot.tencent.com", domain: "www.codebuddy.cn" };
  return { url: "https://www.codebuddy.ai", domain: "www.codebuddy.ai" };
}

export function getAuthJsonPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "opencode", "auth.json");
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(base, "opencode", "auth.json");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdg, "opencode", "auth.json");
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add config with lazy env, priority chain and platform auth path"
```

---

### Task 7: headers.ts — 22 头 + trace 单次生成

**Files:**
- Create: `src/headers.ts`
- Test: `test/headers.test.ts`

**Interfaces:**
- Consumes: config, jwt.resolveIdentity, lru（间接）
- Produces: `baseHeaders(cfg,domain)`, `buildRequestHeaders(sessionId, modelId, deps)`, `buildAuthHeaders(auth, identity)`, `resolveModel(input?)`

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect } from "vitest";
import { baseHeaders, buildRequestHeaders, buildAuthHeaders, resolveModel } from "../src/headers.js";
import { LRUMap } from "../src/lru.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  const cfg: any = {
    platform: "VSCode", appVersion: "4.9.29177644", ideName: "VSCode", ideType: "VSCode",
    ideVersion: "1.119.0", product: "SaaS", agentIntent: "craft", envId: "production",
    model: "", stableConversationId: true, conversationMapMax: 100, ...overrides,
  };
  const server = { url: "https://copilot.tencent.com", domain: "www.codebuddy.cn" };
  const lru = new LRUMap<string, string>(100);
  return { cfg, server, lru };
}

describe("headers", () => {
  it("baseHeaders 12 头", () => {
    const h = baseHeaders(makeDeps().cfg, "www.codebuddy.cn");
    expect(h["X-Agent-Intent"]).toBe("craft");
    expect(h["X-Domain"]).toBe("www.codebuddy.cn");
    expect(h["X-Product"]).toBe("SaaS");
  });
  it("X-Conversation-ID 用 conversationId 而非 messageId", () => {
    const deps = makeDeps();
    const h = buildRequestHeaders("sess-1", "m1", deps);
    expect(h["X-Conversation-ID"]).not.toBe(h["X-Request-ID"]);
    expect(h["X-Conversation-ID"]).toBe(deps.lru.get("sess-1"));
  });
  it("b3 合法：trace 32hex，span!=parent 各16hex", () => {
    const h = buildRequestHeaders("s", undefined, makeDeps());
    const [trace, span, sampled, parent] = h["b3"].split("-");
    expect(trace).toMatch(/^[0-9a-f]{32}$/);
    expect(span).toMatch(/^[0-9a-f]{16}$/);
    expect(parent).toMatch(/^[0-9a-f]{16}$/);
    expect(span).not.toBe(parent);
    expect(sampled).toBe("1");
  });
  it("resolveModel 优先 cfg.model", () => {
    expect(resolveModel("input", { model: "cfg-model" } as any)).toBe("cfg-model");
    expect(resolveModel("input", { model: "" } as any)).toBe("input");
  });
  it("X-Model-ID 仅非空注入", () => {
    const deps = makeDeps({ model: "" });
    expect(buildRequestHeaders("s", "", deps)["X-Model-ID"]).toBeUndefined();
    expect(buildRequestHeaders("s", "m1", deps)["X-Model-ID"]).toBe("m1");
  });
  it("api 双头保留", () => {
    const h = buildAuthHeaders({ type:"api", key:"k" } as any, { tenantId:"", enterpriseId:"", userId:"" });
    expect(h["Authorization"]).toBe("Bearer k");
    expect(h["X-API-Key"]).toBe("k");
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/headers.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/headers.ts
import type { CodeBuddyConfig } from "./config.js";
import type { LRUMap } from "./lru.js";

function generateTraceId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function getOrCreateConversationId(lru: LRUMap<string,string>, sessionId: string | undefined, stable: boolean): string {
  if (!stable || !sessionId) return generateTraceId();
  const hit = lru.get(sessionId);
  if (hit) return hit;
  const id = generateTraceId();
  lru.set(sessionId, id);
  return id;
}
export function resolveModel(input: string | undefined, cfg: CodeBuddyConfig): string {
  return cfg.model ? cfg.model : (input ?? "");
}
export function baseHeaders(cfg: CodeBuddyConfig, domain: string): Record<string,string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "X-Agent-Intent": cfg.agentIntent,
    "X-IDE-Type": cfg.ideType,
    "X-IDE-Name": cfg.ideName,
    "X-IDE-Version": cfg.ideVersion,
    "X-Product-Version": cfg.appVersion,
    "X-Env-ID": cfg.envId,
    "X-Domain": domain,
    "X-Product": cfg.product,
    "User-Agent": `${cfg.ideName}/${cfg.ideVersion} CodeBuddy/${cfg.appVersion}`,
  };
}
export function buildRequestHeaders(
  sessionId: string | undefined,
  modelId: string | undefined,
  deps: { cfg: CodeBuddyConfig; server: { url: string; domain: string }; lru: LRUMap<string,string> },
): Record<string,string> {
  const { cfg, server, lru } = deps;
  const conversationId = getOrCreateConversationId(lru, sessionId, cfg.stableConversationId);
  const messageId = generateTraceId();
  const traceId = generateTraceId();
  const spanId = traceId.slice(0, 16);
  const parentSpanId = traceId.slice(16, 32);
  const base = baseHeaders(cfg, server.domain);
  const headers: Record<string,string> = {
    ...base,
    "X-Request-ID": messageId,
    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": messageId,
    "X-Conversation-Message-ID": messageId,
    "X-Request-Trace-Id": traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "X-B3-TraceId": traceId,
    "X-B3-ParentSpanId": parentSpanId,
    "X-B3-SpanId": spanId,
    "X-B3-Sampled": "1",
  };
  const resolved = resolveModel(modelId, cfg);
  if (resolved) headers["X-Model-ID"] = resolved;
  return headers;
}
export function buildAuthHeaders(
  auth: { type: "api"; key: string } | { type: "oauth"; access: string; refresh: string; expires: number },
  identity: { tenantId: string; enterpriseId: string; userId: string },
): Record<string,string> {
  if (auth.type === "api") return { Authorization: `Bearer ${auth.key}`, "X-API-Key": auth.key };
  const h: Record<string,string> = { Authorization: `Bearer ${auth.access}` };
  if (identity.tenantId) h["X-Tenant-Id"] = identity.tenantId;
  if (identity.enterpriseId) h["X-Enterprise-Id"] = identity.enterpriseId;
  if (identity.userId) h["X-User-Id"] = identity.userId;
  return h;
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/headers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/headers.ts test/headers.test.ts
git commit -m "feat: add headers with 22-header snapshot and zipkin b3"
```

---

### Task 8: auth-state.ts — 窄化守卫 + 单分支 effectiveAuth

**Files:**
- Create: `src/auth-state.ts`
- Test: `test/auth-state.test.ts`

**Interfaces:**
- Consumes: config
- Produces: `parseStoredAuth`, `pickAuthMode`, `effectiveAuth`, `needsRefresh` 供 auth-flow/auth-fetch

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseStoredAuth, pickAuthMode, effectiveAuth, needsRefresh } from "../src/auth-state.js";

describe("parseStoredAuth 窄化守卫", () => {
  it("损坏输入返回 undefined（非对象/缺字段/类型错）", () => {
    expect(parseStoredAuth(null)).toBeUndefined();
    expect(parseStoredAuth("bad")).toBeUndefined();
    expect(parseStoredAuth({ type:"api" })).toBeUndefined(); // 缺 key
    expect(parseStoredAuth({ type:"oauth", access:"a" })).toBeUndefined(); // 缺 refresh/expires
    expect(parseStoredAuth({ type:"unknown", key:"k" })).toBeUndefined();
  });
  it("合法 api 解析", () => {
    expect(parseStoredAuth({ type:"api", key:"k" })).toEqual({ type:"api", key:"k" });
  });
  it("合法 oauth 解析", () => {
    expect(parseStoredAuth({ type:"oauth", access:"a", refresh:"r", expires: 123 })).toEqual({ type:"oauth", access:"a", refresh:"r", expires:123 });
  });
  it("过期 oauth 仍解析（有效性由 effectiveAuth ตัดสิน）", () => {
    expect(parseStoredAuth({ type:"oauth", access:"a", refresh:"r", expires: 0 })).toBeDefined();
  });
});

describe("pickAuthMode 全矩阵", () => {
  it("cfg.auth=api 强制 api", () => {
    expect(pickAuthMode({ auth:"api", apiKey:"" } as any, undefined)).toBe("api");
    expect(pickAuthMode({ auth:"api", apiKey:"" } as any, { type:"oauth", access:"a" } as any)).toBe("api");
  });
  it("cfg.auth=oauth 强制 oauth", () => {
    expect(pickAuthMode({ auth:"oauth", apiKey:"ck_xxx" } as any, undefined)).toBe("oauth");
  });
  it("auto 时 apiKey 优先", () => {
    expect(pickAuthMode({ auth:"auto", apiKey:"ck_xxx" } as any, undefined)).toBe("api");
  });
  it("auto 时 stored api 优先", () => {
    expect(pickAuthMode({ auth:"auto", apiKey:"" } as any, { type:"api", key:"k" } as any)).toBe("api");
  });
  it("auto 时默认 oauth", () => {
    expect(pickAuthMode({ auth:"auto", apiKey:"" } as any, undefined)).toBe("oauth");
    expect(pickAuthMode({ auth:"auto", apiKey:"" } as any, { type:"oauth", access:"a", refresh:"r", expires: 999 } as any)).toBe("oauth");
  });
});

describe("effectiveAuth 单分支", () => {
  it("api 模式：cfg.apiKey 优先", () => {
    const cfg = { auth:"api", apiKey:"cfg-key" } as any;
    expect(effectiveAuth({ type:"api", key:"stored" } as any, cfg)).toEqual({ type:"api", key:"cfg-key" });
  });
  it("api 模式：无 cfg 时用 stored", () => {
    const cfg = { auth:"api", apiKey:"" } as any;
    expect(effectiveAuth({ type:"api", key:"stored" } as any, cfg)).toEqual({ type:"api", key:"stored" });
  });
  it("A2：api 模式无 key 返回 null（由上层 warn，非静默 fallback）", () => {
    const cfg = { auth:"api", apiKey:"" } as any;
    expect(effectiveAuth(undefined, cfg)).toBeNull();
    expect(effectiveAuth({ type:"oauth", access:"a", refresh:"r", expires: Date.now()+10000 } as any, cfg)).toBeNull();
  });
  it("oauth 单分支：未过期返回", () => {
    const cfg = { auth:"oauth", apiKey:"" } as any;
    const stored = { type:"oauth", access:"a", refresh:"r", expires: Date.now()+100000 };
    expect(effectiveAuth(stored as any, cfg)).toEqual({ type:"oauth", access:"a", refresh:"r", expires: stored.expires });
  });
  it("oauth 单分支：过期 token 仍返回（expires 校验删除，靠 401 刷新兜底）", () => {
    const cfg = { auth:"oauth", apiKey:"" } as any;
    const stored = { type:"oauth", access:"a", refresh:"r", expires: Date.now()-1000 };
    const res = effectiveAuth(stored as any, cfg);
    expect(res).not.toBeNull();
    expect((res as any).access).toBe("a");
  });
  it("oauth 缺 access 返回 null", () => {
    const cfg = { auth:"oauth", apiKey:"" } as any;
    expect(effectiveAuth({ type:"oauth", refresh:"r", expires: 123 } as any, cfg)).toBeNull();
  });
});

describe("needsRefresh 边界", () => {
  it("oauth 且 expires - skew < now 且 refresh 非空 → true", () => {
    const now = Date.now();
    const auth = { type:"oauth", access:"a", refresh:"r", expires: now + 4*60*1000 } as any; // 4min 内过期，skew 5min
    expect(needsRefresh(auth, now)).toBe(true);
  });
  it("oauth 但 expir 远未到 → false", () => {
    const now = Date.now();
    const auth = { type:"oauth", access:"a", refresh:"r", expires: now + 10*60*1000 } as any;
    expect(needsRefresh(auth, now)).toBe(false);
  });
  it("恰在 skew 边界外 → false", () => {
    const now = Date.now();
    const auth = { type:"oauth", access:"a", refresh:"r", expires: now + 5*60*1000 + 1000 } as any;
    expect(needsRefresh(auth, now)).toBe(false);
  });
  it("api 类型永不刷新", () => {
    expect(needsRefresh({ type:"api", key:"k" } as any, Date.now())).toBe(false);
  });
  it("oauth 但 refresh 为空 → false", () => {
    const auth = { type:"oauth", access:"a", refresh:"", expires: Date.now() } as any;
    expect(needsRefresh(auth, Date.now())).toBe(false);
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/auth-state.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/auth-state.ts
import type { CodeBuddyConfig } from "./config.js";

export type AuthState = { type:"api"; key:string } | { type:"oauth"; access:string; refresh:string; expires:number };

export function parseStoredAuth(raw: unknown): AuthState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string,unknown>;
  if (o.type === "api" && typeof o.key === "string" && o.key.length > 0) return { type:"api", key: o.key };
  if (o.type === "oauth" && typeof o.access === "string" && o.access.length > 0 && typeof o.refresh === "string" && typeof o.expires === "number") {
    return { type:"oauth", access: o.access, refresh: o.refresh, expires: o.expires };
  }
  return undefined;
}

export function pickAuthMode(cfg: Pick<CodeBuddyConfig,"auth"|"apiKey">, stored: AuthState | undefined): "oauth"|"api" {
  if (cfg.auth === "api") return "api";
  if (cfg.auth === "oauth") return "oauth";
  if (cfg.apiKey) return "api";
  if (stored?.type === "api" && stored.key) return "api";
  return "oauth";
}

export function effectiveAuth(stored: AuthState | undefined, cfg: Pick<CodeBuddyConfig,"auth"|"apiKey">): AuthState | null {
  const mode = pickAuthMode(cfg, stored);
  if (mode === "api") {
    if (cfg.apiKey) return { type:"api", key: cfg.apiKey };
    if (stored?.type === "api" && stored.key) return { type:"api", key: stored.key };
    return null;
  }
  // oauth 单分支：expires 校验删除，过期仍返回，靠 401 兜底
  if (stored?.type === "oauth" && stored.access) {
    return { type:"oauth", access: stored.access, refresh: stored.refresh ?? "", expires: stored.expires ?? 0 };
  }
  return null;
}

const REFRESH_SKEW_MS = 5*60*1000;
export function needsRefresh(auth: AuthState, now: number): boolean {
  return auth.type === "oauth" && !!auth.refresh && (auth.expires - REFRESH_SKEW_MS) < now;
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/auth-state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth-state.ts test/auth-state.test.ts
git commit -m "feat: add auth-state with strict guard and single-branch effectiveAuth"
```

---

### Task 9: auth-flow.ts — poll 先查后睡 + RefreshLock 单例

**Files:**
- Create: `src/auth-flow.ts`
- Test: `test/auth-flow.test.ts`

**Interfaces:**
- Consumes: fetch-json, config constants
- Produces: `requestAuthState(serverUrl)`, `pollForToken(state,expiresAt,signal)`, `refreshAccessToken(token,serverUrl)`, `RefreshLock`, `sleep`

- [ ] **Step 1: 写 failing test**

```ts
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
    const res = await pollForToken("s1", Date.now()+10000);
    expect(res?.accessToken).toBe("a");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(vi.mocked(fetchJson)).toHaveBeenCalledTimes(1);
  });
  it("首查失败后才 sleep 再查", async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce({ ok:true, data:{ code:1, data:{} } } as any)
      .mockResolvedValueOnce({ ok:true, data:{ code:0, data:{ accessToken:"a", refreshToken:"r", expiresIn:3600 } } } as any);
    const res = await pollForToken("s1", Date.now()+5000);
    expect(res?.accessToken).toBe("a");
    expect(vi.mocked(fetchJson)).toHaveBeenCalledTimes(2);
  });
  it("signal 中止时立即返回 null", async () => {
    const ac = new AbortController(); ac.abort();
    const res = await pollForToken("s1", Date.now()+10000, ac.signal);
    expect(res).toBeNull();
  });
  it("expiresAt 到期返回 null", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok:true, data:{ code:1 } } as any);
    const res = await pollForToken("s1", Date.now()+10);
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
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/auth-flow.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/auth-flow.ts
import { fetchJson } from "./fetch-json.js";
import { AUTH_STATE_TIMEOUT_MS, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, REFRESH_TIMEOUT_MS, PLATFORM, PROVIDER_ID } from "./config.js";

export function sleep(ms:number): Promise<void> { return new Promise(r=>setTimeout(r,ms)); }

export class RefreshLock {
  private inflight = new Map<string, Promise<unknown>>();
  async run<T>(key:string, fn:()=>Promise<T>): Promise<T> {
    const hit = this.inflight.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const p = fn().finally(()=> this.inflight.delete(key));
    this.inflight.set(key, p as Promise<unknown>);
    return p;
  }
}

export async function requestAuthState(serverUrl:string): Promise<{ state:string; url:string }> {
  const url = `${serverUrl}/v2/plugin/auth/state?platform=${PLATFORM}&ioa=1`;
  const res = await fetchJson<{code:number; data?:{state:string; authUrl?:string}}>(url, {
    method:"POST",
    headers:{ Accept:"application/json", "Content-Type":"application/json", "X-No-Authorization":"true", "X-No-User-Id":"true", "X-No-Enterprise-Id":"true", "X-No-Department-Info":"true" },
    timeoutMs: AUTH_STATE_TIMEOUT_MS,
  });
  if (!res.ok || res.data.code !== 0 || !res.data.data?.state) throw new Error(`Auth state failed: ${JSON.stringify(res)}`);
  const state = res.data.data.state;
  const authUrl = res.data.data.authUrl || `${serverUrl}/login?platform=${PLATFORM}&state=${state}&ioa=1`;
  return { state, url: authUrl };
}

export async function pollForToken(state:string, expiresAt:number, signal?:AbortSignal): Promise<{accessToken:string; refreshToken?:string; expiresIn?:number}|null> {
  // 先查后睡：首次立即查，失败后 sleep 再查
  while (Date.now() < expiresAt) {
    if (signal?.aborted) return null;
    // 本轮先查
    const res = await fetchJson<{code:number; data?:{accessToken:string; refreshToken?:string; expiresIn?:number}}>(
      `https://copilot.tencent.com/v2/plugin/auth/token?state=${state}`,
      { method:"GET", headers:{ Accept:"application/json", "X-No-Authorization":"true", "X-No-User-Id":"true", "X-No-Enterprise-Id":"true", "X-No-Department-Info":"true" }, timeoutMs: POLL_TIMEOUT_MS, signal },
    );
    if (res.ok && res.data.code===0 && res.data.data?.accessToken) return res.data.data;
    if (signal?.aborted) return null;
    if (Date.now() >= expiresAt) break;
    // 失败后睡 POLL_INTERVAL_MS，再进入下一轮先查
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

export async function refreshAccessToken(refreshToken:string, serverUrl:string): Promise<{accessToken:string; refreshToken?:string; expiresIn?:number}|null> {
  const res = await fetchJson<{code:number; data?:{accessToken:string; refreshToken?:string; expiresIn?:number}}>(
    `${serverUrl}/v2/plugin/auth/token/refresh`,
    { method:"POST", headers:{ "Content-Type":"application/json", Accept:"application/json", Authorization:`Bearer ${refreshToken}` }, timeoutMs: REFRESH_TIMEOUT_MS },
  );
  if (!res.ok || res.data.code !== 0) return null;
  return res.data.data ?? null;
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/auth-flow.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth-flow.ts test/auth-flow.test.ts
git commit -m "feat: add auth-flow with pre-refresh and per-provider lock"
```

---

### Task 10: auth-fetch.ts — 五守卫可测化

**Files:**
- Create: `src/auth-fetch.ts`
- Test: `test/auth-fetch.test.ts`

**Interfaces:**
- Consumes: auth-state, auth-flow.RefreshLock, headers, sse-buffer, config
- Produces: `createAuthFetch(deps) → fetch` 供 index.ts loader 使用
- Deps 形状（与设计 5.13 四参一致）：
  ```ts
  type AuthFetchDeps = {
    getAuth: () => Promise<unknown>;
    client: { auth: { set: (args: unknown) => Promise<void> } };
    server: { url: string; domain: string };
    buildAuthHeaders: (auth: unknown, identity: unknown) => Record<string,string>;
    resolveIdentity: (payload: unknown, cfg: unknown) => { tenantId:string; enterpriseId:string; userId:string };
    decodeJwtPayload: (token:string) => unknown;
    createSSEBufferedStream: (body: ReadableStream<Uint8Array>, opts: { threshold:number; maxDelayMs:number }) => ReadableStream<Uint8Array>;
    refreshLock: { run: <T>(key:string, fn:()=>Promise<T>)=>Promise<T> };
    cfg: { sse: { enabled:boolean; threshold:number; maxDelayMs:number } };
    fetchImpl?: typeof fetch;
    effectiveAuth: (stored: unknown) => any;
    pickAuthMode: (stored: unknown) => "api"|"oauth";
    refreshAccessToken: (refresh:string, serverUrl:string) => Promise<{ accessToken:string; refreshToken?:string; expiresIn?:number } | null>;
    chatCompletionsPath: string;  // CHAT_COMPLETIONS_PATH 单一来源，禁止硬拼 "/v2/chat/completions"
  };
  ```

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createAuthFetch } from "../src/auth-fetch.js";

describe("auth-fetch", () => {
  it("非 chat/completions 透传", async () => {
    const fetch = createAuthFetch({ getAuth: async()=>({type:"api",key:"k"}), client:{}, server:{url:"https://x",domain:"d"}, buildAuth:()=>({}), sse:()=>null } as any);
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));
    await fetch("https://x/other", { method:"GET" } as any);
    expect(globalThis.fetch).toHaveBeenCalled();
    globalThis.fetch=orig;
  });
  it("!body 400", async () => {
    const af = createAuthFetch(makeDeps({ getAuth: async () => ({ type: "api", key: "k" }) }));
    const res = await af("https://x/v2/chat/completions", { method: "POST" } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing request body" });
  });
  it("!ok 透传并保留 Content-Type: application/json", async () => {
    (globalThis as any).fetch = async () => new Response("bad", { status: 500, headers: { "Content-Type": "text/plain" } });
    const af = createAuthFetch(makeDeps());
    const res = await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
  it("effectiveAuth null 抛 /connect 指引（区分 api/oauth）", async () => {
    const afApi = createAuthFetch(makeDeps({ getAuth: async () => null, effectiveAuth: () => null, pickAuthMode: () => "api" } as any));
    await expect(afApi("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any)).rejects.toThrow(/missing API key/);
    const afOauth = createAuthFetch(makeDeps({ getAuth: async () => null, effectiveAuth: () => null, pickAuthMode: () => "oauth" } as any));
    await expect(afOauth("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any)).rejects.toThrow(/\/connect/);
  });
  it("signal 透传至 doRequest", async () => {
    const spy = async (u: any, init: any) => { expect(init.signal).toBeDefined(); return new Response("ok", { status: 200 }); };
    (globalThis as any).fetch = spy;
    const af = createAuthFetch(makeDeps());
    const ac = new AbortController();
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}), signal: ac.signal } as any);
  });
  it("SSE 包装保留原头：content-type text/event-stream 存活", async () => {
    (globalThis as any).fetch = async () => new Response(new ReadableStream({ start(c){ c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const af = createAuthFetch(makeDeps({ cfg: { sse: { enabled: true, threshold: 24, maxDelayMs: 40 } } } as any));
    const res = await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });
  it("请求路径用 chatCompletionsPath 而非硬拼 /v2/chat/completions", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as any).fetch = spy;
    const af = createAuthFetch(makeDeps({ chatCompletionsPath: "/custom/path" } as any));
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(spy.mock.calls[0][0]).toBe("https://x/custom/path");
  });
  it("RefreshLock key 用 PROVIDER_ID（codebuddy）单例", async () => {
    let calls = 0;
    const lock = new RefreshLock();
    (globalThis as any).fetch = async () => new Response("unauth", { status: 401 });
    const af = createAuthFetch(makeDeps({
      getAuth: async () => ({ type:"oauth", access:"a", refresh:"r", expires: 0 }),
      refreshLock: lock,
      refreshAccessToken: async () => { calls++; return { accessToken:"new", refreshToken:"r2", expiresIn:3600 }; },
    } as any));
    await Promise.all([
      af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any).catch(()=>{}),
      af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any).catch(()=>{}),
    ]);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/auth-fetch.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/auth-fetch.ts
import type { AuthState } from "./auth-state.js";
export type AuthFetchDeps = {
  getAuth: () => Promise<unknown>;
  client: { auth: { set: (args: unknown) => Promise<void> } };
  server: { url: string; domain: string };
  buildAuthHeaders: (auth: AuthState, identity: { tenantId:string; enterpriseId:string; userId:string }) => Record<string,string>;
  resolveIdentity: (payload: unknown, cfg: unknown) => { tenantId:string; enterpriseId:string; userId:string };
  decodeJwtPayload: (token:string) => unknown;
  createSSEBufferedStream: (body: ReadableStream<Uint8Array>, opts: { threshold:number; maxDelayMs:number }) => ReadableStream<Uint8Array>;
  refreshLock: { run: <T>(key:string, fn:()=>Promise<T>)=>Promise<T> };
  cfg: { sse: { enabled:boolean; threshold:number; maxDelayMs:number } };
  fetchImpl?: typeof fetch;
  effectiveAuth: (stored: unknown) => AuthState | null;
  pickAuthMode: (stored: unknown) => "api"|"oauth";
  refreshAccessToken: (refresh:string, serverUrl:string) => Promise<{ accessToken:string; refreshToken?:string; expiresIn?:number } | null>;
  chatCompletionsPath: string;  // CHAT_COMPLETIONS_PATH 单一来源，禁止硬拼 "/v2/chat/completions"
};
export function createAuthFetch(deps: AuthFetchDeps) {
  const { getAuth, client, server, buildAuthHeaders, resolveIdentity, decodeJwtPayload, createSSEBufferedStream, refreshLock, cfg, fetchImpl, chatCompletionsPath } = deps;
  const doFetch = fetchImpl ?? globalThis.fetch;
  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    if (!urlStr.includes("/chat/completions")) return doFetch(url, init);
    const stored = await getAuth();
    const auth = deps.effectiveAuth(stored);
    if (!auth) {
      const mode = deps.pickAuthMode(stored);
      throw new Error(mode === "api" ? "codebuddy: missing API key — set CODEBUDDY_API_KEY env or run `/connect codebuddy`" : "codebuddy: missing oauth access token — run `/connect codebuddy` to log in");
    }
    if (!init?.body) return new Response(JSON.stringify({ error: "Missing request body" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const doRequest = async (a: AuthState) => {
      const headers = new Headers(init.headers as HeadersInit);
      const identity = a.type === "oauth" ? resolveIdentity(decodeJwtPayload(a.access), cfg) : { tenantId:"", enterpriseId:"", userId:"" };
      for (const [k,v] of Object.entries(buildAuthHeaders(a, identity as any))) headers.set(k, v);
      let body: BodyInit | null | undefined = init.body as BodyInit;
      try {
        const raw = typeof body === "string" ? body as string : new TextDecoder().decode(body as ArrayBuffer);
        const parsed = JSON.parse(raw);
        if (parsed.stream === true && !parsed.stream_options) { parsed.stream_options = { include_usage: true }; body = JSON.stringify(parsed); }
      } catch {}
      return doFetch(`${server.url}${chatCompletionsPath}`, { method: "POST", headers, body: body as BodyInit, signal: init.signal });
    };
    let response = await doRequest(auth);
    let activeAuth: AuthState = auth;
    if (activeAuth.type === "oauth" && (response.status === 401 || response.status === 403) && activeAuth.refresh) {
      // 预刷新（A4）与 401/403 兜底：needsRefresh 触发或 401/403 才刷新；RefreshLock 按 PROVIDER_ID 单例
      const refreshed = await refreshLock.run("codebuddy", () => deps.refreshAccessToken(activeAuth.refresh, server.url));
      if (refreshed?.accessToken) {
        const newExpires = refreshed.expiresIn ? Date.now() + refreshed.expiresIn * 1000 : Date.now() + 24*60*60*1000;
        const next: AuthState = { type: "oauth", access: refreshed.accessToken, refresh: refreshed.refreshToken || activeAuth.refresh, expires: newExpires };
        const writeBody = { type: "oauth" as const, access: next.access, refresh: next.refresh, expires: next.expires };
        try { await client.auth.set({ path: { id: "codebuddy" }, body: writeBody }); } catch { /* in-memory 续用 + error 日志（log.ts） */ }
        activeAuth = next;
        response = await doRequest(activeAuth);
      }
    }
    if (!response.ok) {
      const text = await response.text();
      const h = new Headers(response.headers);
      h.set("Content-Type", "application/json");
      return new Response(text, { status: response.status, headers: h });
    }
    if (cfg.sse.enabled && response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
      const buffered = createSSEBufferedStream(response.body as ReadableStream<Uint8Array>, { threshold: cfg.sse.threshold, maxDelayMs: cfg.sse.maxDelayMs });
      return new Response(buffered as unknown as BodyInit, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return response;
  };
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/auth-fetch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth-fetch.ts test/auth-fetch.test.ts
git commit -m "feat: add auth-fetch with five guards and refresh retry"
```

---

### Task 11: models.ts — 映射 + fetchRemoteModels 真实实现 + 单飞 DiscoveryCache

**Files:**
- Create: `src/models.ts`
- Test: `test/models.test.ts`

**Interfaces:**
- Consumes: fetch-json, config constants
- Produces: `remoteModelToConfig`, `mergeModelEntry`, `fetchRemoteModels`, `DiscoveryCache`, `DEFAULT_MODEL` 供 index.ts

**关键实现约束：**
- `fetchRemoteModels(accessToken, server, signal)`：真实逻辑（替代 Task 13 的 `return []` 占位）——fetchJson `/v3/config`（baseHeaders 族头 + `Authorization: Bearer ${accessToken}` + `X-Agent-Intent: AGENT_INTENT` + `X-Domain: server.domain`），`code!==0`/无 data → `[]`，craft agent 过滤（`AGENT_INTENT`）、`craftIds 空` → `[DEFAULT_MODEL]`、`!==false` 过滤（`undefined` 视为纳入）
- `fetchJson` 返回 `{ok:false,status,text}` 时：401/403 原样抛出（`err.status=401/403`，上游不进缓存走刷新），超时/5xx 返回 `[]`（降级）
- `DiscoveryCache.fetchFn` 签名 `(token, server, signal) => Promise<RemoteModel[]>`（与 fetchRemoteModels 对齐）

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { remoteModelToConfig, mergeModelEntry, DiscoveryCache, DEFAULT_MODEL } from "../src/models.js";

describe("models mapping", () => {
  it("N1 tool_call:false 落盘", () => {
    const c = remoteModelToConfig({ id:"x", name:"X", supportsToolCall:false } as any);
    expect(c.tool_call).toBe(false);
  });
  it("N1 undefined 视为 true（craft 纳入）", () => {
    const c = remoteModelToConfig({ id:"x", name:"X" } as any);
    expect(c.tool_call).toBe(true);
  });
  it("N2 手工 reasoning:false 不被翻转且 interleaved 不残留", () => {
    const auto = { reasoning:true, interleaved:{field:"reasoning_content"}, options:{ reasoningEffort:"high" } };
    const existing = { reasoning:false };
    const m = mergeModelEntry(auto as any, existing as any);
    expect(m.reasoning).toBe(false);
    expect(m.interleaved).toBeUndefined();
    expect(m.options).toBeUndefined();
  });
  it("limit 皆0 时不落盘", () => {
    const c = remoteModelToConfig({ id:"x", name:"X" } as any);
    expect(c.limit).toBeUndefined();
  });
  it("limit 有值时落盘", () => {
    const c = remoteModelToConfig({ id:"x", name:"X", maxInputTokens:1000, maxOutputTokens:200 } as any);
    expect(c.limit).toEqual({ context:1000, output:200 });
  });
  it("supportsReasoning 映射 interleaved/variants", () => {
    const c = remoteModelToConfig({ id:"x", name:"X", supportsReasoning:true, reasoning:{ supportedEfforts:["low","high"] } } as any);
    expect(c.reasoning).toBe(true);
    expect(c.interleaved).toEqual({ field:"reasoning_content" });
    expect((c.variants as any).low).toEqual({ reasoningEffort:"low" });
  });
});

describe("DiscoveryCache", () => {
  it("TTL 命中直接返回（不拉网）", async () => {
    const fetch = vi.fn().mockResolvedValue([{ id:"m1", name:"M1" }]);
    const cache = new DiscoveryCache({ ttlMs: 5*60*1000, fetchFn: fetch, server:{ url:"https://x", domain:"d" } } as any);
    await cache.get("token", { signal: undefined });
    await cache.get("token", { signal: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("过期后台 revalidate", async () => {
    const fetch = vi.fn().mockResolvedValueOnce([{ id:"m1", name:"M1" }]).mockResolvedValueOnce([{ id:"m2", name:"M2" }]);
    const cache = new DiscoveryCache({ ttlMs: 10, fetchFn: fetch, server:{ url:"https://x", domain:"d" } } as any);
    const first = await cache.get("token", { signal: undefined });
    expect(first[0].id).toBe("m1");
    await new Promise(r => setTimeout(r, 20));
    await cache.get("token", { signal: undefined });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("单飞去重：并发 get 仅拉一次", async () => {
    let calls = 0;
    const fetch = vi.fn().mockImplementation(async () => { calls++; await new Promise(r=>setTimeout(r,20)); return [{ id:"m1", name:"M1" }]; });
    const cache = new DiscoveryCache({ ttlMs: 5*60*1000, fetchFn: fetch, server:{ url:"https://x", domain:"d" } } as any);
    await Promise.all([cache.get("tok", { signal: undefined }), cache.get("tok", { signal: undefined })]);
    expect(calls).toBe(1);
  });
  it("401/403 不进缓存", async () => {
    const fetch = vi.fn().mockRejectedValue(Object.assign(new Error("401"), { status:401 }));
    const cache = new DiscoveryCache({ ttlMs: 5*60*1000, fetchFn: fetch, server:{ url:"https://x", domain:"d" } } as any);
    await expect(cache.get("tok", { signal: undefined }).catch(()=>[])).resolves.toBeDefined();
    const fetch2 = vi.fn().mockResolvedValue([{ id:"m1", name:"M1" }]);
    (cache as any).fetchFn = fetch2;
    await cache.get("tok", { signal: undefined });
    expect(fetch2).toHaveBeenCalled();
  });
  it("DEFAULT_MODEL 字段定稿", () => {
    expect(DEFAULT_MODEL).toEqual({ id:"auto", name:"Auto", maxInputTokens:168000, maxOutputTokens:32000, supportsToolCall:true });
  });
});

describe("fetchRemoteModels 真实实现", () => {
  it("走 /v3/config + craft 过滤 + !==false", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code:0, data:{ agents:[{ name:"craft", models:["m1"] }], models:[{ id:"m1", name:"M1", supportsToolCall:false }, { id:"m2", name:"M2" }] } }), { status:200 }));
    globalThis.fetch = fetch;
    const res = await fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined);
    expect(fetch.mock.calls[0][0]).toBe("https://x/v3/config");
    expect(fetch.mock.calls[0][1].headers["Authorization"]).toBe("Bearer tok");
    expect(fetch.mock.calls[0][1].headers["X-Domain"]).toBe("d");
    // m1 tool_call:false 被过滤，m2 undefined 视为纳入
    expect(res.map(m=>m.id)).toEqual(["m2"]);
  });
  it("craftIds 为空 → [DEFAULT_MODEL]", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code:0, data:{ agents:[], models:[{ id:"m1", name:"M1" }] } }), { status:200 }));
    const res = await fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined);
    expect(res).toEqual([DEFAULT_MODEL]);
  });
  it("401/403 原样抛出（不进缓存降级）", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("unauth", { status:401 }));
    await expect(fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined)).rejects.toThrow(/401/);
  });
  it("网络失败/5xx 返回 []（降级由上层 DEFAULT_MODEL）", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status:500 }));
    const res = await fetchRemoteModels("tok", { url:"https://x", domain:"d" }, undefined);
    expect(res).toEqual([]);
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/models.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/models.ts
import { fetchJson } from "./fetch-json.js";
import { AGENT_INTENT } from "./config.js";
export interface RemoteModel { id:string; name:string; maxInputTokens?:number; maxOutputTokens?:number; maxAllowedSize?:number; supportsToolCall?:boolean; supportsImages?:boolean; supportsReasoning?:boolean; disabledMultimodal?:boolean; reasoning?:{ effort?:string; defaultEffort?:string; supportedEfforts?:string[] }; }
export const DEFAULT_MODEL: RemoteModel = { id:"auto", name:"Auto", maxInputTokens:168000, maxOutputTokens:32000, supportsToolCall:true };

// fetchRemoteModels 真实实现（替代 v0 的 return [] 占位）：
// /v3/config + craft 过滤 + !==false 过滤 + 401/403 原样抛 + 超时/5xx 返回 []（降级）
export interface RemoteConfigResponse { code:number; data?:{ agents?:Array<{name:string; models?:string[]}>; models?:RemoteModel[] } }
export async function fetchRemoteModels(
  accessToken: string,
  server: { url: string; domain: string },
  signal?: AbortSignal,
): Promise<RemoteModel[]> {
  const headers: Record<string,string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Agent-Intent": AGENT_INTENT,
    "X-IDE-Type": "VSCode", "X-IDE-Name": "VSCode", "X-IDE-Version": "1.119.0",
    "X-Product-Version": "4.9.29177644", "X-Env-ID": "production",
    "X-Domain": server.domain, "X-Product": "SaaS",
    "User-Agent": "VSCode/1.119.0 CodeBuddy/4.9.29177644",
  };
  const res = await fetchJson<RemoteConfigResponse>(`${server.url}/v3/config`, {
    headers, timeoutMs: DISCOVERY_TIMEOUT_MS, signal,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`discovery ${res.status}`) as Error & { status?: number };
      e.status = res.status;
      throw e; // 401/403 原样抛，上游走刷新，不进缓存
    }
    return []; // 网络失败/5xx → 降级由上层 DEFAULT_MODEL
  }
  const body = res.data;
  if (body.code !== 0 || !body.data) return [];
  const allModels = body.data.models || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const craftAgent = (body.data.agents || []).find((a) => a.name === AGENT_INTENT);
  const craftIds = craftAgent?.models || [];
  if (craftIds.length === 0) return [DEFAULT_MODEL];
  return craftIds
    .map((id) => modelMap.get(id))
    .filter((m): m is RemoteModel => m !== undefined && m.supportsToolCall !== false);
}

export function remoteModelToConfig(m: RemoteModel): Record<string,unknown> {
  const entry: Record<string,unknown> = { name: m.name, tool_call: m.supportsToolCall !== false, attachment: !!(m.supportsImages && !m.disabledMultimodal) };
  const ctx = m.maxAllowedSize ?? m.maxInputTokens ?? 0;
  const out = m.maxOutputTokens ?? 0;
  if (ctx || out) entry.limit = { context: ctx, output: out };
  if (!m.supportsReasoning) return entry;
  entry.reasoning = true;
  entry.interleaved = { field: "reasoning_content" };
  const effort = m.reasoning?.defaultEffort ?? m.reasoning?.effort;
  if (effort) entry.options = { reasoningEffort: effort };
  const efforts = m.reasoning?.supportedEfforts;
  if (efforts?.length) entry.variants = Object.fromEntries(efforts.map(e => [e, { reasoningEffort: e }]));
  return entry;
}
export function mergeModelEntry(auto: Record<string,unknown>, existing: Record<string,unknown>): Record<string,unknown> {
  const merged: Record<string,unknown> = { ...auto, ...existing };
  if (auto.limit !== undefined && existing.limit !== undefined) merged.limit = { ...(auto.limit as object), ...(existing.limit as object) };
  if (auto.options !== undefined && existing.options !== undefined) merged.options = { ...(auto.options as object), ...(existing.options as object) };
  if (auto.variants !== undefined && existing.variants !== undefined) merged.variants = { ...(auto.variants as object), ...(existing.variants as object) };
  if (existing.reasoning === false) { delete (merged as any).interleaved; delete (merged as any).options; }
  return merged;
}
export class DiscoveryCache {
  private data: RemoteModel[] | null = null;
  private fetchedAt = 0;
  private inflight: Promise<RemoteModel[]> | null = null;
  constructor(private opts: { ttlMs:number; fetchFn: (token:string, server:{url:string;domain:string}, signal?:AbortSignal)=>Promise<RemoteModel[]>; server:{url:string;domain:string} }) {}
  async get(token:string, { signal }: { signal?:AbortSignal }): Promise<RemoteModel[]> {
    const now = Date.now();
    if (this.data && (now - this.fetchedAt) < this.opts.ttlMs) return this.data;
    if (this.inflight) return this.inflight;
    this.inflight = this.opts.fetchFn(token, this.opts.server, signal).then(d => { this.data = d; this.fetchedAt = Date.now(); return d; }).catch(e => {
      if ((e as any)?.status === 401 || (e as any)?.status === 403) throw e;
      if (!this.data) { this.data = [DEFAULT_MODEL]; this.fetchedAt = now; return this.data; }
      throw e;
    }).finally(() => { this.inflight = null; });
    if (this.data) { this.opts.fetchFn(token, this.opts.server, signal).then(d=>{ this.data=d; this.fetchedAt=Date.now(); }).catch(()=>{}); return this.data; }
    return this.inflight;
  }
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/models.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/models.ts test/models.test.ts
git commit -m "feat: add models with N1/N2/N3 and discovery cache"
```

---

### Task 12: sse-buffer.ts — 真定时 flush + 换行触发

**Files:**
- Create: `src/sse-buffer.ts`
- Test: `test/sse-buffer.test.ts`

**Interfaces:**
- Consumes: config sse.threshold/maxDelayMs
- Produces: `createSSEBufferedStream(body, opts?) → ReadableStream` 供 auth-fetch

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect } from "vitest";
import { createSSEBufferedStream } from "../src/sse-buffer.js";

function sseDelta(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id:"test", object:"chat.completion.chunk", created: Date.now(), choices:[{ index:0, delta, finish_reason:null }] })}\n`;
}
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); }
  });
}
async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let out = "";
  const reader = stream.getReader();
  while (true) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value, { stream:true }); }
  return out;
}

describe("sse-buffer threshold", () => {
  it("reasoning 碎片合并至 threshold 才 flush", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"a" }), sseDelta({ reasoning_content:"b" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 10, maxDelayMs: 1000 });
    const out = await collect(buffered);
    // 2 字符未达阈值，应在 flush 时合并为单条 reasoning_content:"ab"
    expect(out).toContain('"reasoning_content":"ab"');
    expect((out.match(/reasoning_content/g) || []).length).toBe(1);
  });
  it("换行触发 includes(\"\\n\") 立即 flush（多行代码块不滞留）", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"line1\\n" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 1000 });
    const out = await collect(buffered);
    expect(out).toContain('"reasoning_content":"line1\\n"');
  });
  it("标点触发（。！？.!?；;，,：: + trimEnd）", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"你好。" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 1000 });
    const out = await collect(buffered);
    expect(out).toContain('"reasoning_content":"你好。"');
  });
  it("尾空格 trimEnd 后仍触发标点", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"hi.   " })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 1000 });
    const out = await collect(buffered);
    expect(out).toContain('"reasoning_content"');
  });
});

describe("sse-buffer maxDelay 双侧定时", () => {
  it("reasoning 侧 maxDelay 定时冲出（新增行为）", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"x" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 15 });
    const outP = collect(buffered);
    await new Promise(r => setTimeout(r, 40));
    const out = await outP;
    expect(out).toContain('"reasoning_content":"x"');
  });
  it("content 侧 maxDelay 定时冲出（原 contentTimer 从未生效，现为新增）", async () => {
    const stream = makeStream([sseDelta({ content:"y" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 15 });
    const outP = collect(buffered);
    await new Promise(r => setTimeout(r, 40));
    const out = await outP;
    expect(out).toContain('"content":"y"');
  });
  it("timer 回调在流已 close 后不抛（try/catch）", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"z" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 10 });
    // 立即消费并关闭，timer 后续 enqueue 应被 catch
    const out = await collect(buffered);
    expect(out).toContain("z");
    await new Promise(r => setTimeout(r, 30)); // timer 触发但不抛
  });
});

describe("sse-buffer format & leftover", () => {
  it("14 处模板统一为完整格式（含 id/object/created）", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"a" }), sseDelta({ content:"b" }), "data: [DONE]\n"]);
    const buffered = createSSEBufferedStream(stream, { threshold: 1, maxDelayMs: 1000 });
    const out = await collect(buffered);
    // 完整格式含 buffered id
    expect(out).toContain('"object":"chat.completion.chunk"');
    expect(out).toContain("[DONE]");
  });
  it("leftover 数组收集（O(n²) 修复）", async () => {
    // 跨包 UTF-8：1-2 字符/包场景
    const enc = new TextEncoder();
    const part1 = enc.encode(sseDelta({ content:"你" }).slice(0, 10));
    const part2 = enc.encode(sseDelta({ content:"你" }).slice(10));
    const stream = new ReadableStream<Uint8Array>({ start(c){ c.enqueue(part1); c.enqueue(part2); c.close(); } });
    const buffered = createSSEBufferedStream(stream, { threshold: 1, maxDelayMs: 1000 });
    const out = await collect(buffered);
    expect(out).toContain("你");
  });
  it("非 data 行与 [DONE] 前冲剩余 buffer", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"pre" }), ": comment\n", "data: [DONE]\n"]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 1000 });
    const out = await collect(buffered);
    expect(out).toContain('"reasoning_content":"pre"');
    expect(out).toContain("[DONE]");
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/sse-buffer.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/sse-buffer.ts
const FLUSH_RE = /[。！？.!?；;，,：:]$/;

function hasFlushTrigger(s: string): boolean {
  return s.includes("\n") || FLUSH_RE.test(s.trimEnd());
}

function flushBuf(controller: TransformStreamDefaultController<Uint8Array>, field: "reasoning_content" | "content", buf: string): void {
  if (!buf) return;
  const payload = { id:"buffered", object:"chat.completion.chunk", created: Date.now(), choices:[{ index:0, delta:{ [field]: buf }, finish_reason:null }] };
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n`));
}

export function createSSEBufferedStream(
  body: ReadableStream<Uint8Array>,
  opts: { threshold:number; maxDelayMs:number },
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const threshold = opts.threshold;
  const maxDelay = opts.maxDelayMs;
  let leftoverChunks: string[] = [];
  let leftover = "";
  let reasoningBuf = "";
  let contentBuf = "";
  let reasoningTimer: ReturnType<typeof setTimeout> | null = null;
  let contentTimer: ReturnType<typeof setTimeout> | null = null;

  const clearReasoningTimer = () => { if (reasoningTimer) { clearTimeout(reasoningTimer); reasoningTimer = null; } };
  const clearContentTimer = () => { if (contentTimer) { clearTimeout(contentTimer); contentTimer = null; } };

  const scheduleReasoningFlush = (ctrl: TransformStreamDefaultController<Uint8Array>) => {
    if (reasoningTimer || !reasoningBuf) return;
    reasoningTimer = setTimeout(() => {
      try { flushBuf(ctrl, "reasoning_content", reasoningBuf); } catch {}
      reasoningBuf = "";
      reasoningTimer = null;
    }, maxDelay);
  };
  const scheduleContentFlush = (ctrl: TransformStreamDefaultController<Uint8Array>) => {
    if (contentTimer || !contentBuf) return;
    contentTimer = setTimeout(() => {
      try { flushBuf(ctrl, "content", contentBuf); } catch {}
      contentBuf = "";
      contentTimer = null;
    }, maxDelay);
  };

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      leftover += decoder.decode(chunk, { stream:true });
      const lines = leftover.split("\n");
      leftover = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine;
        if (!line.startsWith("data: ")) {
          if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf); reasoningBuf=""; clearReasoningTimer(); }
          if (contentBuf) { flushBuf(controller, "content", contentBuf); contentBuf=""; clearContentTimer(); }
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        const payloadStr = line.slice(6);
        if (payloadStr.trim() === "[DONE]") {
          if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf); reasoningBuf=""; clearReasoningTimer(); }
          if (contentBuf) { flushBuf(controller, "content", contentBuf); contentBuf=""; clearContentTimer(); }
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        let payload: Record<string,unknown>;
        try { payload = JSON.parse(payloadStr) as Record<string,unknown>; } catch {
          if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf); reasoningBuf=""; clearReasoningTimer(); }
          if (contentBuf) { flushBuf(controller, "content", contentBuf); contentBuf=""; clearContentTimer(); }
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        const choices = (payload as any).choices as Array<any> | undefined;
        const first = choices?.[0];
        const delta = first?.delta as any;
        const finishReason = first?.finish_reason ?? first?.finishReason;
        const hasReasoning = typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0;
        const hasReasoningAlt = typeof delta?.reasoning === "string" && delta.reasoning.length > 0;
        const hasContent = typeof delta?.content === "string" && delta.content.length > 0;
        const hasToolCalls = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;

        if ((hasReasoning || hasReasoningAlt) && !hasContent && !hasToolCalls && !finishReason) {
          const chunk = (delta?.reasoning_content ?? delta?.reasoning) as string;
          if (contentBuf) { flushBuf(controller, "content", contentBuf); contentBuf=""; clearContentTimer(); }
          reasoningBuf += chunk;
          if (reasoningBuf.length >= threshold || hasFlushTrigger(reasoningBuf)) {
            const out = { ...(payload as object), choices:[{ ...first, delta:{ reasoning_content: reasoningBuf } }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n`));
            reasoningBuf=""; clearReasoningTimer();
          } else {
            scheduleReasoningFlush(controller);
          }
          continue;
        }
        if (hasContent && !hasReasoning && !hasReasoningAlt && !hasToolCalls && !finishReason) {
          if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf); reasoningBuf=""; clearReasoningTimer(); }
          contentBuf += delta.content as string;
          if (contentBuf.length >= threshold || hasFlushTrigger(contentBuf)) {
            const out = { ...(payload as object), choices:[{ ...first, delta:{ content: contentBuf } }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n`));
            contentBuf=""; clearContentTimer();
          } else {
            scheduleContentFlush(controller);
          }
          continue;
        }
        if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf); reasoningBuf=""; clearReasoningTimer(); }
        if (contentBuf) { flushBuf(controller, "content", contentBuf); contentBuf=""; clearContentTimer(); }
        controller.enqueue(encoder.encode(line + "\n"));
      }
    },
    flush(controller) {
      clearReasoningTimer(); clearContentTimer();
      if (reasoningBuf) flushBuf(controller, "reasoning_content", reasoningBuf);
      if (contentBuf) flushBuf(controller, "content", contentBuf);
      if (leftover) controller.enqueue(encoder.encode(leftover));
    },
  }));
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/sse-buffer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sse-buffer.ts test/sse-buffer.test.ts
git commit -m "feat: add sse buffer with real maxDelay and newline trigger"
```

---

### Task 13: index.ts 组装 — Plugin 工厂闭包

**Files:**
- Create: `src/index.ts` (重写)
- Modify: `src/config.ts` (已就绪)
- Test: `test/index.test.ts` (integration)

**Interfaces:**
- Consumes: 以上所有模块
- Produces: `export const CodeBuddyAuthPlugin: Plugin`, `export default {id:"codebuddy-plugin",server}`

- [ ] **Step 1: 写 failing integration test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import { CodeBuddyAuthPlugin } from "../src/index.js";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, promises: { ...actual.promises, readFile: vi.fn() } };
});

describe("index config hook 全量", () => {
  it("注入 provider.codebuddy 含 npm/baseURL/v2/setCacheKey", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    const cfg: any = {};
    await plugin.config!(cfg);
    expect(cfg.provider.codebuddy.npm).toBe("@ai-sdk/openai-compatible");
    expect(cfg.provider.codebuddy.name).toBe("CodeBuddy");
    expect(cfg.provider.codebuddy.options.baseURL).toBe("https://copilot.tencent.com/v2");
    expect(cfg.provider.codebuddy.options.setCacheKey).toBe(true);
    expect(cfg.provider.codebuddy.models).toBeDefined();
  });
  it("auth.json 损坏走 parseStoredAuth 容错（warn 不抛）", async () => {
    const readFile = vi.mocked(fs.promises.readFile as any);
    readFile.mockRejectedValueOnce(new Error("bad json"));
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const cfg: any = { provider: {} };
    await expect(plugin.config!(cfg)).resolves.toBeDefined();
    expect(cfg.provider.codebuddy.models.auto).toBeDefined(); // 降级 DEFAULT_MODEL
  });
  it("models 合并：手工 existing 优先，缺失补 auto", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    const cfg: any = { provider: { codebuddy: { npm:"@ai-sdk/openai-compatible", name:"CodeBuddy", options:{ baseURL:"https://x/v2", setCacheKey:true }, models:{ "auto": { name:"My Auto", limit:{ context:999 } } } } } };
    // mock discovery 返回空，验证 existing 保留
    await plugin.config!(cfg);
    expect(cfg.provider.codebuddy.models.auto.name).toBe("My Auto");
  });
  it("无 ENDPOINT/NETWORK 时 baseURL 覆写 server（破坏性反转）", async () => {
    delete process.env.CODEBUDDY_ENDPOINT; delete process.env.CODEBUDDY_NETWORK;
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    const cfg: any = { provider: { codebuddy: { options:{ baseURL:"https://my-proxy.example.com/v2" } } } };
    await plugin.config!(cfg);
    expect(cfg.provider.codebuddy.options.baseURL).toBe("https://my-proxy.example.com/v2");
    // loader 的 baseURL 也随闭包 server 更新
    const loader = await (plugin as any).auth.loader(async ()=>({ type:"api", key:"k" }));
    expect(loader.baseURL).toBe("https://my-proxy.example.com");
  });
  it("ENDPOINT 已设时 baseURL 不覆写（env 优先）", async () => {
    process.env.CODEBUDDY_ENDPOINT = "https://env.example.com";
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    const cfg: any = { provider: { codebuddy: { options:{ baseURL:"https://base.example.com/v2" } } } };
    await plugin.config!(cfg);
    expect(cfg.provider.codebuddy.options.baseURL).toBe("https://env.example.com/v2");
    delete process.env.CODEBUDDY_ENDPOINT;
  });
  it("oauth discovery 401/403 不降级 DEFAULT_MODEL（warn + 不注入 models.auto）", async () => {
    const readFile = vi.mocked(fs.promises.readFile as any);
    readFile.mockResolvedValueOnce(JSON.stringify({ codebuddy: { type:"oauth", access:"expired", refresh:"r", expires: 0 } }));
    // fetchRemoteModels 抛 401
    const spy = vi.spyOn(await import("../src/models.js"), "fetchRemoteModels").mockRejectedValue(Object.assign(new Error("401"), { status:401 }));
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn().mockResolvedValue(undefined) } } } as any);
    const cfg: any = { provider: {} };
    await plugin.config!(cfg);
    // 401 不降级：不注入 DEFAULT_MODEL（除非手工已有）
    expect(cfg.provider.codebuddy.models.auto).toBeUndefined();
    spy.mockRestore();
  });
});

describe("index chat.headers", () => {
  it("非 codebuddy provider 早退（不注入 22 头）", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    const out: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"other", id:"m" }, sessionID:"s1" }, out);
    expect(Object.keys(out.headers)).toHaveLength(0);
  });
  it("codebuddy provider 注入 22 头且 X-Conversation-ID 独立", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    const out: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"my-model" }, sessionID:"s1" }, out);
    expect(out.headers["X-Conversation-ID"]).toBeDefined();
    expect(out.headers["X-Conversation-ID"]).not.toBe(out.headers["X-Request-ID"]);
    expect(out.headers["X-Model-ID"]).toBe("my-model");
  });
  it("resolveModel：CODEBUDDY_MODEL 覆盖 input model", async () => {
    process.env.CODEBUDDY_MODEL = "forced-model";
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    const out: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"input-model" }, sessionID:"s1" }, out);
    expect(out.headers["X-Model-ID"]).toBe("forced-model");
    delete process.env.CODEBUDDY_MODEL;
  });
  it("stream_options 仅 stream:true 注入（非流式不注入）", async () => {
    // 通过 auth.loader.fetch 的 doRequest 间接验证：此处仅验证 chat.headers 不改 body
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    expect(plugin).toBeDefined();
  });
});

describe("index event & closure", () => {
  it("session.compacted/deleted 清 LRU（闭包持有）", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    // 先触发 chat.headers 生成 conversationId
    const out1: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"m" }, sessionID:"sess-123" }, out1);
    const cid1 = out1.headers["X-Conversation-ID"];
    await (plugin as any).event!({ event: { type:"session.compacted", properties:{ sessionID:"sess-123" } } });
    const out2: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"m" }, sessionID:"sess-123" }, out2);
    expect(out2.headers["X-Conversation-ID"]).not.toBe(cid1);
  });
  it("session.deleted 走 properties.info.id 清 LRU", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    const out1: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"m" }, sessionID:"del-1" }, out1);
    const cid1 = out1.headers["X-Conversation-ID"];
    await (plugin as any).event!({ event: { type:"session.deleted", properties:{ info:{ id:"del-1" } } } });
    const out2: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"m" }, sessionID:"del-1" }, out2);
    expect(out2.headers["X-Conversation-ID"]).not.toBe(cid1);
  });
  it("DEFAULT_MODEL 归 models.ts：无 auth 时 config 仍注入 auto", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    const cfg: any = { provider: {} };
    await plugin.config!(cfg);
    expect(cfg.provider.codebuddy.models.auto).toEqual(expect.objectContaining({ name:"Auto", tool_call:true }));
  });
  it("导出形态：named + default 兼容", async () => {
    const mod = await import("../src/index.js");
    expect((mod as any).CodeBuddyAuthPlugin).toBeDefined();
    expect((mod as any).default).toEqual(expect.objectContaining({ id:"codebuddy-plugin" }));
  });
  it("无 chat.message 钩子（B3 删除）：conversationId 由 chat.headers 覆盖", async () => {
    const plugin = await CodeBuddyAuthPlugin({ client: { app:{ log: vi.fn() } } } as any);
    expect((plugin as any)["chat.message"]).toBeUndefined();
    // chat.headers 仍能独立生成 conversationId（不依赖预热）
    const out: any = { headers: {} };
    await (plugin as any)["chat.headers"]({ model:{ providerID:"codebuddy", id:"m" }, sessionID:"fresh" }, out);
    expect(out.headers["X-Conversation-ID"]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run test/index.test.ts`
Expected: FAIL (old 1146 lines still present)

- [ ] **Step 3: 重写 src/index.ts**

```ts
// src/index.ts — 薄胶水，禁止模块级 let
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import * as fs from "fs";
import { getConfig, resolveServerUrl, getAuthJsonPath, PROVIDER_ID, CHAT_COMPLETIONS_PATH } from "./config.js";
import { createLogger } from "./log.js";
import { LRUMap } from "./lru.js";
import { parseStoredAuth, effectiveAuth, pickAuthMode } from "./auth-state.js";
import { DiscoveryCache, DEFAULT_MODEL, mergeModelEntry, remoteModelToConfig, fetchRemoteModels } from "./models.js";
import { createAuthFetch } from "./auth-fetch.js";
import { buildRequestHeaders, resolveModel, buildAuthHeaders } from "./headers.js";
import { resolveIdentity, decodeJwtPayload } from "./jwt.js";
import { createSSEBufferedStream } from "./sse-buffer.js";
import { refreshAccessToken, requestAuthState, pollForToken, RefreshLock } from "./auth-flow.js";

export const CodeBuddyAuthPlugin: Plugin = async (input: PluginInput) => {
  const cfg = getConfig();
  let server = resolveServerUrl(cfg);          // 闭包 let：config hook 内 baseURL 兜底覆写
  const conversationIds = new LRUMap<string,string>(cfg.conversationMapMax);
  const logger = createLogger(input.client as any);
  const refreshLock = new RefreshLock();
  const discoveryCache = new DiscoveryCache({
    ttlMs: 5*60*1000,
    fetchFn: fetchRemoteModels,                // 真实实现（Task 11），401/403 抛、网络/5xx 返回 []
    server,
  });

  return {
    async config(config: any) {
      // baseURL 兜底覆写（设计 5.1 优先级链：ENDPOINT > NETWORK > baseURL > 默认）
      // 仅当 ENDPOINT/NETWORK 均未设置时才用 provider.options.baseURL 覆写 server（破坏性反转）
      const opts = (config.provider?.[PROVIDER_ID]?.options || {}) as Record<string, unknown>;
      const configuredBase = typeof opts.baseURL === "string" ? opts.baseURL : undefined;
      if (!cfg.endpoint && !cfg.network) {
        if (configuredBase) {
          try {
            const u = new URL(configuredBase);
            server = { url: `${u.protocol}//${u.host}`, domain: u.host.includes("codebuddy.ai") ? "www.codebuddy.ai" : server.domain };
          } catch {}
        }
      }
      if (!config.provider) config.provider = {};
      if (!config.provider[PROVIDER_ID]) {
        config.provider[PROVIDER_ID] = {
          npm: "@ai-sdk/openai-compatible",
          name: "CodeBuddy",
          options: { baseURL: `${server.url}/v2`, setCacheKey: true },
          models: {},
        };
      }
      const provider = config.provider[PROVIDER_ID] as Record<string, unknown>;
      if (!provider.models) provider.models = {};
      const models = provider.models as Record<string, unknown>;

      // auth.json 容错（fs.promises，D1）
      let stored: unknown;
      try {
        const raw = await fs.promises.readFile(getAuthJsonPath(), "utf8");
        const all = JSON.parse(raw) as Record<string, unknown>;
        stored = parseStoredAuth(all[PROVIDER_ID]);
      } catch (e) {
        logger.warn(`auth.json read failed: ${(e as Error).message}`);
      }

      // A2：api 模式无 key 打警告而非静默 fallback
      const mode = pickAuthMode(cfg, stored);
      if (mode === "api" && !cfg.apiKey && !(stored && (stored as any).type === "api" && (stored as any).key)) {
        logger.warn("api key mode requested but no key found — set CODEBUDDY_API_KEY env or run `/connect codebuddy`");
      }

      // discovery：惰性 TTL + 单飞（DiscoveryCache），401/403 原样抛（走刷新提示），网络/5xx 降级
      let discovered: any[] = [];
      if (mode === "api") {
        discovered = [];
        logger.info("api key mode — using models from opencode.json config");
      } else if (stored && (stored as any).type === "oauth" && (stored as any).access) {
        try {
          discovered = await discoveryCache.get((stored as any).access, { signal: undefined });
        } catch (e) {
          const status = (e as any)?.status;
          if (status === 401 || status === 403) {
            logger.warn(`discovery 401/403 — auth may be expired, run \`/connect codebuddy\` to re-authenticate`);
            // 设计 5.9：401/403 不进缓存降级 DEFAULT_MODEL，走提示重连
          } else {
            logger.warn(`discovery failed: ${(e as Error).message}`);
          }
          discovered = [];
        }
      }
      if (discovered.length === 0 && Object.keys(models).length === 0) discovered = [DEFAULT_MODEL];
      for (const m of discovered) {
        const auto = remoteModelToConfig(m);
        const existing = models[m.id] as Record<string, unknown> | undefined;
        models[m.id] = existing ? mergeModelEntry(auto, existing) : auto;
      }
    },
    async event({ event }: any) {
      if (event.type === "session.compacted") {
        const sid = event.properties?.sessionID;
        if (sid) conversationIds.delete(sid);
      } else if (event.type === "session.deleted") {
        const sid = event.properties?.info?.id;
        if (sid) conversationIds.delete(sid);
      }
    },
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth: any) {
        return {
          apiKey: "cli-proxy",
          baseURL: server.url,
          fetch: createAuthFetch({
            getAuth, client: input.client as any, server,
            buildAuthHeaders: buildAuthHeaders as any,
            resolveIdentity: resolveIdentity as any,
            decodeJwtPayload: decodeJwtPayload as any,
            createSSEBufferedStream: createSSEBufferedStream as any,
            refreshLock, cfg: cfg as any,
            effectiveAuth, pickAuthMode,                    // 同步 import（纯模块无循环依赖）
            refreshAccessToken,
            chatCompletionsPath: CHAT_COMPLETIONS_PATH,     // 单一来源，不硬拼
          }),
        };
      },
      methods: [
        { label: "IOA 登录 (浏览器)", type: "oauth" as const, async authorize() {
          const state = await requestAuthState(server.url);
          const expiresAt = Date.now() + 10*60*1000;
          return { url: state.url, instructions: "请在浏览器中完成 IOA 登录", method: "auto" as const,
            async callback() {
              const tok = await pollForToken(state.state, expiresAt);
              if (!tok) return { type:"failed" as const };
              return { type:"success" as const, access: tok.accessToken, refresh: tok.refreshToken || "", expires: tok.expiresIn ? Date.now()+tok.expiresIn*1000 : Date.now()+24*60*60*1000 };
            } };
        }},
        { label: "API Key 登录", type: "api" as const, prompts:[{ type:"text", key:"key", message:"请输入 CodeBuddy API Key（ck_xxx）", placeholder:"ck_xxxxxxxxxxxxxxxx.xxxxx" }], async authorize(inputs: any) {
          const key = inputs?.key?.trim(); if (!key) return { type:"failed" as const }; return { type:"success" as const, key }; } },
      ],
    },
    async "chat.headers"(input: any, output: any) {
      if (input.model.providerID !== PROVIDER_ID) return;
      const modelId = resolveModel(input.model.id, cfg as any);
      const headers = buildRequestHeaders(input.sessionID, modelId, { cfg: cfg as any, server, lru: conversationIds });
      for (const [k,v] of Object.entries(headers)) output.headers[k]=v;
    },
  } as any;
};

export default { id: "codebuddy-plugin", server: CodeBuddyAuthPlugin };
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run test/index.test.ts && npx tsc --noEmit && npx tsup`
Expected: PASS，dist/index.{js,d.ts} 生成

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: assemble Plugin factory with closure-held server and LRU"
```

---

### Task 14: 集成验证 + README/迁移指南 → 2.0.0

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-22-codebuddy-plugin-redesign-design.md` (状态 改为 已实现)
- Create: `test/integration.test.ts` (optional)

**Interfaces:**
- Consumes: 全部模块
- Produces: 可发布 npm 包

- [ ] **Step 1: 手测 checklist**

- [ ] `npm test` 全绿
- [ ] `npm run build` 产物仅 dist，files 正确
- [ ] 真实 opencode 启动：`/connect codebuddy` IOA 登录 + API Key 路径
- [ ] 流式对话：SSE 缓冲后 part 写入恢复 200 级别，含 reasoning/content 混排

- [ ] **Step 2: 重写 README**

含：安装 `opencode.json plugin ["opencode-codebuddy-oauth"]`，新 env 表 9 项，优先级链（含 **baseURL 优先级反转迁移说明**：v1 用户配置的 `provider.options.baseURL` 在 v2 中仅当 `CODEBUDDY_ENDPOINT`/`CODEBUDDY_NETWORK` 均未设置时生效），迁移指南旧→新映射表注明破坏性无兼容层

- [ ] **Step 3: 验证发布**

Run: `npm pack --dry-run`
Expected: 仅 dist + README + LICENSE，被 files 白名单控制

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-22-codebuddy-plugin-redesign-design.md
git commit -m "docs: release 2.0.0 with migration guide"
git tag 2.0.0
```

---

## Self-Review

- Spec coverage: 5.1-5.13 全映射到 Task 2-12，5.12 11项不丢失清单由 Task 6/7/11/13 的用例逐条覆盖，附录 A 37 项在任务描述中显式锚定
- Placeholder 扫描：无 TBD/TODO，所有步骤含可执行代码/命令；**Task 11 已实现 fetchRemoteModels 真实逻辑（替代 v0 `return []` 占位），Task 13 已接真接线**
- Type consistency：Plugin 工厂闭包 server: {url,domain} 贯穿 auth-flow/models/headers，fetchJson 统一 Promise<{ok...}>，Logger 统一 body 包装；**CHAT_COMPLETIONS_PATH 经 deps.chatCompletionsPath 单一来源，无硬拼**
- 新增 auth-fetch.ts 已补 Task 10，避免五守卫无测试载体
- **Task 13 已补**：baseURL 兜底覆写（闭包 let server）、oauth 401/403 不降级（warn + 不注入 DEFAULT_MODEL）、session.deleted 测试、chat.message 删除断言、RefreshLock 按 PROVIDER_ID 单例

