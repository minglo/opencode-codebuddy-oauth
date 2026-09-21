# CodeBuddy OAuth 插件 V2 PoC 设计

日期：2026-09-21
状态：待审阅
目标分支：`v2-poc`（不发布）

## 1. 背景与目标

OpenCode V2（`@opencode/plugin@2.0.11`）引入破坏性插件 API：V1 实现不能在 V2 运行。当前插件（2.2.0）为纯 V1。

V2 尚未 GA：

- opencode GitHub releases 最新为 `v1.18.x`（v1.18.31，2026-09-14），无 2.x release
- 仓库默认分支 `dev` 是 V1（`@opencode-ai/core@1.18.31`）；V2 在独立 `v2` 分支（`@opencode/core@2.0.11`，与 `dev` diverged：ahead 3638 / behind 1264，仍在活跃提交）
- npm 上 `@opencode-ai/plugin`（V1）与 `@opencode/plugin`（V2）两个 latest 并存

**目标**：在 `v2-poc` 分支完成一次完整迁移预演（全部功能移植到 V2 形态），用 mock 宿主验证；V2 GA 后在该分支上做端到端验证，通过即可演进为 3.0.0（只支持 V2）。V1 冻结在 master，继续维护 2.x 发布线。

**成功标准**

1. `npx tsc --noEmit` 零错
2. `npm test` 全绿（纯核 + legacy + V2 mock 测试）
3. `npm run build` 产出 `dist/index.js` + `dist/index.d.ts`
4. setup 具备错误隔离：任一域注册失败不影响其余域，`setup` 不抛
5. GA 后 e2e 清单（§10）逐项验证通过

**非目标**

- 不发布、不改版本发布线、不写 CHANGELOG
- 不做 V1/V2 双兼容（理由：V1/V2 的 auth 机制根本不同——V1 是 `auth.loader` 返回自定义 fetch，V2 是 integration + session hooks；双兼容等于维护两套完整胶水。npm major 版本已能隔离用户群：V1 用户锁 2.x，V2 用户升 3.0.0）
- 不开长期 git 分支维护双线（`v2-poc` 是过渡分支，GA 后转正）
- 不实现 e2e 宿主测试（GA 前宿主不可得）
- 不更新 README（GA 转正时统一改）
- 不动 V1 发布线（master）

## 2. 决策记录

| # | 决策 | 理由 |
|---|------|------|
| D1 | 迁移路径：hooks 中心（方案 A） | 官方 v2 范本（`packages/core/src/plugin/provider/snowflake-cortex.ts`）同路；凭证归核心 integration；删掉 RefreshLock/401 兜底/手写 auth.json |
| D2 | PoC 分支只做 V2，V1 冻结 master | 分支隔离；纯核文件级共享，rebase 干净 |
| D3 | 代码平铺，不设 `v2/` 子目录 | V2 占 `src/index.ts` 成为主入口；V1 入口改名 `src/index.v1.ts` 并标 `@legacy` |
| D4 | V1 遗留模块保留 + `@legacy` 备注 | PoC 期间可对照；GA 发 3.0.0 时照附录 A 清单删除；不提前删除避免误伤 |
| D5 | 验证双轨：mock 现在，e2e 等 GA | V2 未 GA；mock 用真实 `@opencode/plugin` 类型 + 手写 mock context |
| D6 | 11133 处理放 `http.response`（插件自建重发，请求快照在 `http.request` 阶段缓存） | `SessionError.Error` 只有 `{type,message,status?}`，无响应体；`retry` hook 拿不到 body code。`http.response` 能拿到原始响应与请求元信息，但请求 body 已消费，故由 `http.request` 缓存快照（§5.2） |
| D7 | 未提交改动 `git stash`（不提交），PoC 分支从 master 开，在 git worktree 中开发 | 用户明确：11133 dump 改动仍在测试中，不要提交；worktree 避免影响主工作区 |

## 3. 关键事实（已核实来源）

以下均来自一手来源，PoC 设计据此：

| 事实 | 来源 |
|------|------|
| `Plugin.define({id, setup(ctx)})`，setup 可返回 cleanup | `@opencode/plugin@2.0.11` `dist/promise/plugin.d.ts` |
| Context 域：`app/location/options/agent/aisdk/command/event/experimental/integration/mcp/model/generate/permission/plugin/provider/reference/rpc/session/shell/skill/storage/tool/vcs/websearch/worktree` | 同上 |
| **无 log 域**；`ctx.app = {name, version, channel}` | `dist/app.d.ts` |
| Provider.Info：`{id, canonical?, integrationID?, name, activation, package, settings?, headers?, body?}`，`Provider.Info.empty(id)` | `@opencode/schema@2.0.11` `provider.d.ts:164-240` |
| Provider package 示例：`@opencode/ai/providers/openai-compatible` | `/build/plugins` 文档 + `@opencode/ai` exports `./*` |
| Model.Info 必填：`capabilities.{tools,input,output}`、`variants[{id,settings?}]`、`time{released}`、`cost[]`、`status`、`enabled`、`limit.{context,output}`、`id`、`modelID`、`providerID`、`name`；`Model.Info.default()` 可生成基线 | `model.d.ts:221-340` |
| Credential：`OAuth{type,methodID,refresh,access,expires,metadata?}` / `Key{type,key,metadata?,configuration?}`；`Credential.OAuth.make` | `credential.d.ts:160-189`；snowflake v2 用法 |
| Integration OAuth 注册：`{integrationID, method:{id,type:"oauth",label,form?}, authorize, refresh?, label?}`；authorize 返回 `{mode:"auto", url, instructions, expiresAt?, callback: Promise<Credential.OAuth>}` | `dist/promise/integration.d.ts:32-49` |
| Integration key/env 注册：`{type:"key",label?,form?}` / `{type:"env",names}` | 同上 `:22-31` |
| Session hooks：`prompt/context/compaction/generate/title/model.request/http.request/http.response/experimental.ws.*/retry`；第三参数 `{providerID}` | `dist/promise/session.d.ts:129-142`；`registration.d.ts:4-11` |
| `SessionHttpRequest.request: Request`（**非 readonly，可替换**）；`SessionHttpResponse.response: Response`（可替换）、`request` readonly | `session.d.ts:65-79` |
| `SessionModelRequest.headers: Record<string,string>`、`baseURL?` | `session.d.ts:57-64` |
| `SessionRetry{error:{type,message,status?}, attempt, decision:{retry,delay}}` | `session.d.ts:115-128`；`session-error.d.ts` |
| 事件 `session.compacted`/`session.deleted` 的 data 为 `{sessionID}` | `event-manifest.d.ts:12598, 1061` |
| `credential.switched` data `{integrationID, credentialID}`；`credential.updated` data `{}`（空） | `event-manifest.d.ts:6322-6369` |
| 自定义 fetch 支持仍在（`options.fetch`），但 v2 官方 provider 范本已转向 session hooks | v2 分支 `packages/core/src/aisdk.ts:128-160`；`plugin/provider/snowflake-cortex.ts`（270 行） |
| V2 无内建 SSE delta 合并（`wrapSSE` 仅 chunk 读超时） | v2 分支 `aisdk.ts:62-117` |
| setup 抛错会禁用整个插件并连累 catalog（TUI 无模型） | superpowers V2 实现注释（实测教训） |
| V2 目录形式插件要求目录 + `index.js`（npm 包走 `main`） | superpowers `index.js` 注释 |

## 4. 架构

### 4.1 文件布局

```
src/
  index.ts            # V2 入口：Plugin.define({id:"codebuddy", setup})
  state.ts            # PluginState：setup 闭包共享状态（类型 + 容器）
  credentials.ts      # 胶水层共享：resolveCredential（requests 与 provider 共用）
  integration.ts      # integration.transform：oauth/key/env method
  provider.ts         # provider.transform + model.transform + 模型发现/刷新 + remoteModelToInfo
  requests.ts         # http.request / http.response / retry / event.subscribe
  # 纯核（现有导出零改动；仅 models.ts 提取共享 variant 归一函数 buildVariants）
  config.ts  log.ts  lru.ts  jwt.ts  headers.ts  models.ts
  sse-buffer.ts  fetch-json.ts  auth-flow.ts  auth-state.ts
  # @legacy（保留，见附录 A）
  index.v1.ts         # 原 index.ts 改名
  auth-fetch.ts
test/
  helpers/mock-ctx.ts
  integration.test.ts  requests.test.ts  provider.test.ts  setup.test.ts
  （现有 test/*.test.ts 全部保留）
```

### 4.2 setup 骨架

```ts
export default Plugin.define({
  id: "codebuddy",
  async setup(ctx) {
    const cleanups: Array<() => void> = [];
    const domain = async (name, fn) => {
      try {
        const c = await fn();
        if (c) cleanups.push(...(Array.isArray(c) ? c : [c]));
      } catch (e) { console.error(`[codebuddy] ${name} 注册失败:`, e); }
    };
    await domain("integration", () => registerIntegration(ctx));
    await domain("provider", () => registerProvider(ctx));
    await domain("requests", () => registerRequests(ctx));
    return () => { for (const c of cleanups) c(); };
  },
});
```

每个 register 返回 cleanup（`() => void`）或 `void`——`provider`（凭证事件订阅 + TTL 定时器）与 `requests`（session 事件订阅）都返回 cleanup；`integration` 无。任一域注册失败只影响自身 cleanup。

**注册顺序**：integration → provider → requests。与 snowflake v2 一致（integration 先）。

**共享状态**（setup 闭包）：

- `server`：setup 开头 `let server = resolveServerUrl(cfg)`（纯核函数，签名不改）；`provider.transform` 按优先级链覆写（§5.3）；`requests` 与 `integration` 读同一引用（live，非快照）
- `conversationIds`：LRU（现有 `LRUMap`）
- `discoveryCache`：setup 构造，`fetchFn: (token, signal) => fetchRemoteModels(token, server, signal)`（闭包捕获 `server` 引用）
- `discovered`：模型快照（`RemoteModel[]`）
- `requestSnapshots`：11133 重发用的请求快照 LRU（key = `X-Request-Trace-Id`，容量 32，§5.2）
- `refreshLock` 不进入该路径（e2e 若发现核心不防并发刷新再启用）
- 日志：`createLogger()` 不传 client，走 `console` 分支（V2 无 log 域）；`client.app.log` 路径保留给 legacy

### 4.3 错误隔离

每个域注册独立 try/catch。单域失败只 console.error 并继续。`setup` 永不抛出。理由见 §3（superpowers 实测：setup 抛错禁用整个插件，连累 provider/catalog，TUI 无模型）。

### 4.4 依赖与构建

- `peerDependencies` 由 `@opencode-ai/plugin >=1.18.21` 换成 `@opencode/plugin ^2.0.11`（3.0.0 只支持 V2；其类型 re-export 了 Credential/Connection/Integration/Provider/Model，无需单独依赖 `@opencode/schema`）
- `devDependencies` 保留 `@opencode-ai/plugin`、`@opencode-ai/sdk`（legacy 源码 typecheck）+ 新增 `@opencode/plugin`
- `tsup.config.ts`：`entry: { index: "src/index.ts" }`；`external: ["@opencode/plugin", "@opencode/plugin/*", "@opencode-ai/plugin", "@opencode-ai/sdk"]`；`target: node22`
- `tsconfig.json` 不动（`include: ["src"]` 自然覆盖 legacy 与 V2；`moduleResolution: NodeNext` 兼容 `@opencode/plugin` exports/types）
- `package.json`：`version` → `3.0.0-poc.0`（不发布）；`main`/`types`/`exports` 不变（指向 `dist/index.js`）
- CI（`.github/workflows/`）不动：`auto-tag`/`publish` 由 master 推送与 tag 触发，PoC 分支不触发发布

## 5. 组件设计

### 5.1 `src/integration.ts`

单次 `ctx.integration.transform` 注册三个 method：

| method | 形态 |
|--------|------|
| IOA 浏览器登录 | `{id:"ioa", type:"oauth", label:"IOA 登录 (浏览器)"}` + `authorize`/`refresh` |
| API Key | `{type:"key", label:"API Key 登录", form:[{type:"string", key:"key", title:"CodeBuddy API Key", placeholder:"ck_xxx"}]}` |
| 环境变量 | `{type:"env", names:["CODEBUDDY_API_KEY"]}` |

**authorize 映射**

```
V1: authorize()             → {url, instructions, method:"auto", callback()}
V2: authorize(Form.Answer)  → {mode:"auto", url, instructions, expiresAt?, callback: Promise<Credential.OAuth>}

authorize: async () => {
  const state = await requestAuthState(server.url);
  const expiresAt = Date.now() + POLL_TOTAL_TIMEOUT_MS;
  return {
    mode: "auto",
    url: state.url,
    instructions: "请在浏览器中完成 IOA 登录",
    expiresAt,
    callback: pollForToken(server.url, state.state, expiresAt).then(tok => {
      if (!tok) throw new Error("codebuddy: IOA 登录超时或失败");
      return Credential.OAuth.make({
        type: "oauth", methodID: "ioa",
        access: tok.accessToken,
        refresh: tok.refreshToken || "",
        expires: tok.expiresIn ? Date.now() + tok.expiresIn*1000 : Date.now() + DEFAULT_EXPIRES_MS,
      });
    }),
  };
}
```

**refresh 映射**

```
refresh: async (cred) => {
  const r = await refreshAccessToken(cred.refresh, server.url);
  if (!r?.accessToken) throw new Error("codebuddy: refresh failed");
  return { ...cred, access: r.accessToken, refresh: r.refreshToken || cred.refresh,
           expires: r.expiresIn ? Date.now() + r.expiresIn*1000 : Date.now() + DEFAULT_EXPIRES_MS };
}
```

**有意接受的行为差异**

- V1 的 15s 刷新冷却、RefreshLock、401 兜底删除——V2 核心负责刷新调度与去重
- `metadata` 不存 identity（tenant/enterprise/user）：`http.request` 时从 `cred.access` 现场 `decodeJwtPayload`，避免双源
- `label` 可选；PoC 不实现
- `CODEBUDDY_AUTH=api|oauth` 强制模式在 V2 语义弱化（核心按 connection 选择）；PoC 不做强制切换——凭证类型直接读 `Credential.Value.type`，不再需要 `pickAuthMode`/`effectiveAuth`（进附录 A）。e2e #10 复核

**测试**：mock ctx 捕获 registration；`vi.stubGlobal("fetch")` 驱动 authorize/refresh 全路径；断言 `mode:"auto"`、callback resolve 出合法 `Credential.OAuth`（字段齐全、expires 为未来时间）、refresh 更新 access/expires。

### 5.2 `src/requests.ts`

四个注册点：

```
ctx.session.hook("http.request",  handler, { providerID: "codebuddy" })
ctx.session.hook("http.response", handler, { providerID: "codebuddy" })
ctx.session.hook("retry",         handler, { providerID: "codebuddy" })
ctx.event.subscribe(...)          → conversationIds 清理 + cleanup
```

**`http.request`**（顺序敏感）

1. 取凭证：`ctx.integration.connection.active("codebuddy")` → `resolve()` → `Credential.OAuth | Credential.Key`
   - oauth：`decodeJwtPayload(cred.access)` → `resolveIdentity` → `buildAuthHeaders` + 显式 set `Authorization`
   - key：`buildAuthHeaders({type:"api", key})`（双头：`Authorization` + `X-API-Key`）
   - **凭证缺失**（`active`/`resolve` 返回 undefined）：log warn，不抛错、不注入头，请求按核心默认方式继续（hook 抛错会破坏请求管线）
2. `buildRequestHeaders(event.sessionID, event.model.id, {cfg, server, lru})` → 逐项 `headers.set`（含 conversation id sticky）
3. body 处理（`event.request.clone().text()` → JSON parse）：
   - `stream === true && !stream_options` → 注入 `stream_options: {include_usage: true}`（V1 行为）
   - assistant 消息补 `reasoning_content: ""`（11155 兜底，V1 行为）
   - 有变更时 `event.request = new Request(event.request, {body, duplex:"half"})`
4. **请求快照缓存**（11133 重发用）：把**处理后**的 `{url, method, headers, bodyText, traceId}` 存入 setup 闭包的小 LRU（key = `X-Request-Trace-Id`，容量 32）。原因：`http.response` 阶段原请求 body 已被消费，无法 `clone()` 重发；快照在此阶段 body 尚可读，是唯一可靠时机
5. 非 JSON/非字符串 body 跳过（快照仍存 body 原文），原样透传

**`http.response`**

- SSE（`content-type: text/event-stream`）：`event.response = new Response(createSSEBufferedStream(body, cfg.sse), {status, statusText, headers})`，受 `CODEBUDDY_SSE` 开关控制
- 11133 重试：`clone().text()` → JSON `code === 11133` → 从快照缓存（key = 请求头 `X-Request-Trace-Id`）取出 `{url, method, headers, bodyText}` 重建 Request 自行重发（退避 `[1000,4000,10000,25000]` ms，最多 4 次），成功即替换 `event.response`
  - 理由 1：retry hook 的 `SessionError.Error` 无响应体（§2 D6）
  - 理由 2：`http.response` 时原请求 body 已消费，不能 `clone()`（故快照在 `http.request` 阶段缓存）
  - 备用路径（e2e #7）：若 `retry` 的 `error.message` 实测含 `11133`，改用它

**`retry`**

- PoC 仅注册空壳 + 日志，观察 error 形状；不做决策

**`event.subscribe`**

- `session.compacted` / `session.deleted` → `event.data.sessionID` → `conversationIds.delete`
- `AbortController` → cleanup 由 `index.ts` 收集

**测试**：mock ctx + 假凭证；断言 headers 全量且 conversation id 同 session 稳定；stream_options 注入；11155 body 被改；快照可被 11133 重发复用；SSE 输出合并；11133 触发重发（fetch 计数）；非 11133 400 原样；凭证缺失不抛；compacted/deleted 清 LRU。

### 5.3 `src/provider.ts`

**provider 注册**

```
ctx.provider.transform((editor) => {
  const existing = editor.get("codebuddy");
  const configuredBase = existing?.provider.settings?.baseURL;  // 对应 V1 config.provider.options.baseURL
  // 优先级链同 V1 index.ts：ENDPOINT > NETWORK > configuredBase > 默认；纯核 resolveServerUrl 签名不改
  if (!cfg.endpoint && cfg.network === "internal" && configuredBase) {
    try {
      const u = new URL(configuredBase);
      server = { url: `${u.protocol}//${u.host}`, domain: domainForHost(u.host) };
    } catch {}
  }
  const info = { ...Provider.Info.empty(Provider.ID.make("codebuddy")),
    name: "CodeBuddy", activation: "enabled",
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `${server.url}/v2`, apiKey: "codebuddy" },  // apiKey 占位；真实 Authorization 由 http.request 覆盖
    integrationID: "codebuddy" };
  if (existing) editor.update("codebuddy", p => {
    p.name = info.name;
    p.settings = { ...p.settings, ...info.settings };   // 合并，保留用户自定义键（如 setCacheKey）
    p.integrationID = info.integrationID;
  });
  else editor.add({ info, models: discoveredToInfo() });
})
```

- `add` 路径必须携带 models（V2 类型要求）：`discoveredToInfo() = discovered.map(remoteModelToInfo)`；`update` 路径的模型注入走 `ctx.model.transform`：`editor.update("codebuddy", id, draft => Object.assign(draft, info))`（V2 文档："update can add a model only under an available provider"；若实测不可新增，降级为 `provider.transform` 重放时整体 `editor.models.set`——e2e #2/#8 核对）
- `server` 为 setup 闭包变量，供 `http.request`/headers 共用（与 V1 `let server` 同理）
- `settings.apiKey` 占位（V1 为 `"cli-proxy"`）；e2e #6 复核核心是否已自动注入 Authorization

**模型适配层（PoC 最大新代码块）**

新增 `remoteModelToInfo(m: RemoteModel): Model.Info`，从 `Model.Info.default(providerID, modelID)` 基线覆盖：

| RemoteModel | Model.Info |
|-------------|------------|
| `id` / `name` | `id` / `modelID` / `name` |
| `supportsToolCall` | `capabilities.tools` |
| `supportsImages && !disabledMultimodal` | `capabilities.input/output`（含 `image`） |
| `maxAllowedSize ?? maxInputTokens` / `maxOutputTokens` | `limit.context` / `limit.output` |
| `supportsReasoning` | `compatibility.reasoningField = "reasoning_content"` + `compatibility.requireReasoning = true` |
| —（V1 `setCacheKey`） | `compatibility.supportsPromptCacheKey = true`（e2e #12 验证等价性） |
| `reasoning.defaultEffort ?? effort` | `settings`（provider option） |
| `reasoning.supportedEfforts` | `variants: [{id:"low"/"medium"/"high"/"max", settings:{reasoningEffort}}]`（沿用 V1 归一：medium→high、xhigh→high、max 唯一高档） |
| — | `time.released` / `cost` / `status` / `enabled` 取 `Model.Info.default` 基线 |

`Model.Info.compatibility` 完整字段（schema 核实）：`reasoningField`、`requireReasoning`、`maxTokensField`、`requireFinishReason`、`requireAssistantAfterTool`、`supportsPromptCacheKey`。其中 `requireReasoning`（"Require every assistant message to include its reasoning field, even when empty"）等价 V1 的 11155 body 补空；PoC 两层都保留（核心开关 + `http.request` 兜底），e2e 确认后决定是否删兜底。`maxTokensField` 保持默认 `max_tokens`（CodeBuddy 非 `max_completion_tokens`）。

`remoteModelToInfo` 落在 `src/provider.ts`（胶水层——它依赖宿主类型 `Model.Info.default`，放 `models.ts` 会破坏"纯核不依赖宿主"原则）；variant 归一逻辑（low/medium/high/max、medium→high、xhigh→high、max 唯一高档）从 `remoteModelToConfig` 提取到 `src/models.ts` 的共享函数 `buildVariants`，`remoteModelToConfig` 改为调用它——属纯核内部重构，外部行为不变，对应测试须保持全绿。

`remoteModelToConfig` / `mergeModelEntry` 不再用于 V2 路径（标 legacy；e2e #8 核对用户手写 model 配置的合并语义）。

**发现与刷新流程**

1. `registerProvider` 内 `load()`：`connection.active` + `resolve` → oauth 取 `access` → `discoveryCache.get(access)` → 存闭包 `discovered`。无凭证时不发现，`discovered = [DEFAULT_MODEL]`（transform 的 `add` 路径必须携带 models）
2. transform 同步读闭包；401/403 不降级（V1 行为），网络/5xx 降级 `DEFAULT_MODEL`
3. 触发刷新：
   - `credential.switched`（`data.integrationID === "codebuddy"`）→ `load()` → `ctx.provider.reload()`
   - `credential.updated`（data 空，过滤不了）→ 直接 `ctx.provider.reload()`（低频，安全）
   - TTL 定时器（`DISCOVERY_CACHE_TTL_MS`）→ 同上；cleanup 清定时器
   - 用 `provider.reload()` 而非 `model.reload()`：provider transform 重放会重建 active model 结果（V2 文档语义）
4. api 模式不发现（V1 行为），只注入 `DEFAULT_MODEL`/config 模型

**测试**：mock ctx 捕获 transform；stub fetch 返回假 `/v3/config`；断言 `Provider.Info` 字段、模型数组字段齐全（capabilities/limit/variants/reasoningField）；假 `credential.switched` 事件触发 reload；假 timer 推进 TTL 触发重新发现。

## 6. 请求生命周期（端到端）

```
UI prompt
  → session 解析 model/provider（核心按 integrationID 取凭证、注入 apiKey/Authorization[待验 #6]）
  → http.request hook（codebuddy）
       注入 CodeBuddy 全套头（base + auth + conversation + trace）
       stream_options.include_usage 注入 + 11155：assistant.reasoning_content 补空
       缓存请求快照（供 11133 重发）
  → AI SDK 发出 POST <server>/v2/chat/completions
  → 401/403 → 核心凭证 refresh（integration 的 refresh 回调）→ 重试【核心行为，待验】
  → http.response hook（codebuddy）
       SSE：合并 delta（threshold/标点/换行/maxDelay）
       400 + code 11133：自建重发（退避）→ 替换响应
       其他：原样
  → 核心解析 SSE → UI
```

## 7. 测试与 DoD

**测试文件**

| 文件 | 覆盖 |
|------|------|
| `test/helpers/mock-ctx.ts` | 记录 transform/hook 注册；`trigger(hook, event)`、`emit(event)`；provider/model/integration editor mock（list/get/add/update/remove + 子编辑器）；`event.subscribe` async iterable |
| `test/integration.test.ts` | authorize/refresh 全路径、Credential.OAuth 形状 |
| `test/requests.test.ts` | headers 全量/conversation 稳定、stream_options 注入、11155 补空、请求快照缓存、SSE 合并、11133 重发、非 11133 400 原样、凭证缺失不抛、事件清理 |
| `test/provider.test.ts` | Provider.Info、模型适配、无凭证时注入 DEFAULT_MODEL、假凭证事件与 TTL 触发 reload |
| `test/setup.test.ts` | V2 入口组装、默认导出形状、错误隔离 |

现有纯核与 legacy 测试全部保留。`src/index.ts` → `src/index.v1.ts` 改名后，`test/index.test.ts` 的 import 路径同步改为 `../src/index.v1.js`（断言内容不变）；V2 入口测试另写 `test/setup.test.ts`。

**DoD**

1. `npx tsc --noEmit` 零错
2. `npm test` 全绿
3. `npm run build` 产出 `dist/index.js` + `dist/index.d.ts`
4. 错误隔离测试：注入一个始终抛错的域注册，断言其余域仍完成注册、`setup` 不抛

## 8. 风险与降级

| 风险 | 触发 | 降级 |
|------|------|------|
| session hooks 未覆盖 AI SDK 请求链 | e2e #3 | 方案 B：`ctx.aisdk.hook("sdk")` + `options.fetch`（v2 `aisdk.ts` 仍支持），`auth-fetch.ts` 复活 |
| provider package 名不被识别 | e2e #1 | 换 `@ai-sdk/openai-compatible`（snowflake v1 曾用） |
| 凭证事件不到达公共流 | e2e #5 | 已有 TTL 定时轮询兜底；可加请求前检查 |
| V2 API 变化（未 GA） | 上游提交 | 类型定义（`@opencode/plugin`）升级时重跑 tsc + mock 测试；胶水层隔离，纯核不动 |
| 模型适配层字段误配 | e2e #8 | 以 `Model.Info.default` 为基线，缺字段显式补；e2e 逐模型对照 |

## 9. 附录 A：legacy 清单（GA 发 3.0.0 时删除）

| 文件/符号 | 说明 |
|-----------|------|
| `src/index.v1.ts` | V1 入口（原 index.ts） |
| `src/auth-fetch.ts` | V1 fetch 拦截器（token 注入/401/SSE/11133/11155） |
| `src/auth-state.ts` | `parseStoredAuth`/`effectiveAuth`/`pickAuthMode`（V2 凭证由 integration 管） |
| `src/config.ts` → `getAuthJsonPath`、`CHAT_COMPLETIONS_PATH` | V1 自读写 auth.json / fetch 路径匹配；V2 凭证归 integration，路径由 SDK 拼 |
| `src/auth-flow.ts` → `RefreshLock` | V2 刷新归核心 |
| `src/models.ts` → `remoteModelToConfig`/`mergeModelEntry` | V2 用 `remoteModelToInfo` |
| `test/index.test.ts`、`test/auth-fetch.test.ts`、`test/auth-state.test.ts` 中针对上述符号的用例 | 随模块删除 |
| `package.json` 的 `@opencode-ai/plugin`/`@opencode-ai/sdk` devDeps | V1 类型依赖 |

文件头规范：`// @legacy V1-only — V2 无对应宿主，GA 发 3.0.0 时删除（见 spec 附录 A）`

## 10. 附录 B：GA 后 e2e 清单

| # | 待验证 | 关联设计 |
|---|--------|----------|
| 1 | `@opencode/ai/providers/openai-compatible` 解析、请求路径 = `<server>/v2/chat/completions` | §5.3 |
| 2 | `provider.transform` add 的 provider + `integrationID` 绑定生效 | §5.3 |
| 3 | `http.request`/`http.response`/`retry` 覆盖 AI SDK 全链（SSE 流确实经过 response hook） | §5.2 |
| 4 | Request body 替换（`duplex:"half"`）宿主可执行 | §5.2 |
| 5 | `credential.switched`/`credential.updated` 到达公共事件流 | §5.3 |
| 6 | 核心是否自动注入 Authorization（是则删手动设置） | §5.2 |
| 7 | `retry` 的 `error.message` 是否含 `11133`（是则可简化自建重发） | §5.2 |
| 8 | 用户手写 model 配置的合并语义（替代 `mergeModelEntry`） | §5.3 |
| 9 | baseURL 优先级链在 V2 config 的读取形态 | §5.3 |
| 10 | `CODEBUDDY_AUTH=api\|oauth` 强制模式是否可表达 | §5.1 |
| 11 | SSE buffering 实测增益（`CODEBUDDY_SSE=0/1` 对照）→ 决定正式版是否保留 | §5.2 |
| 12 | `compatibility.supportsPromptCacheKey` 是否等价 V1 `setCacheKey` | §5.3 |
| 13 | API Key：key form 提交后 `Credential.Key` 结构 + `X-API-Key` 头 | §5.1/§5.2 |
| 14 | authorize callback 的用户取消 → `pollForToken` 的 signal 传递 | §5.1 |
| 15 | `compatibility.requireReasoning` 是否让 `http.request` 的 11155 兜底冗余 | §5.3 |

## 11. 参考来源

- `@opencode/plugin@2.0.11`、`@opencode/schema@2.0.11`、`@opencode/ai@2.0.11`（npm 类型定义）
- opencode 仓库 `v2` 分支：`packages/core/src/aisdk.ts`（960 行）、`packages/core/src/plugin/provider/snowflake-cortex.ts`（270 行，官方 provider 插件范本）
- opencode 官方文档：`/v2/docs/build/plugins`、`/build/plugins/migrate-v1`
- superpowers 6.4.1 V2 实现（`.opencode/plugins/superpowers.js`，双兼容与错误隔离教训）
- 本项目 V1 设计：`docs/superpowers/specs/2026-08-22-codebuddy-plugin-redesign-design.md`
