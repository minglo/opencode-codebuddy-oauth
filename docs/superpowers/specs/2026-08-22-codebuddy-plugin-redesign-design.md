# opencode-codebuddy-oauth v2.0 重构设计

日期：2026-08-22
状态：已实现
范围：`src/index.ts`（1146 行）完全重构为分层插件，发布 npm

## 1. 背景与目标

现有单文件插件混 7 职责（CONFIG 快照 / LRU / SSE 缓冲 / JWT / headers / auth / plugin 组装），经三轮审查确认 37 个问题（见附录 A）：6 个真 bug、4 处死代码、7 处重复、10 项性能问题、7 项架构问题、3 个模型映射 bug。

目标：

1. 拆分为可独立测试的模块，vitest 全覆盖核心逻辑
2. 修复全部 A/N 类 bug
3. 以 tsup 构建发布 npm，版本 2.0.0（破坏性变更）
4. 使用最新 TypeScript 严格集

## 2. 硬约束（不可破坏）

**auth.json 存储格式是 opencode 的契约，不是本插件的。** `/connect` 写入、`loader.getAuth()` 读回、`input.client.auth.set` 持久化均走：

```ts
{ type: "api"; key: string }
| { type: "oauth"; access: string; refresh: string; expires: number }
```

重设计只能加宽容解析（手写窄化守卫），不能改结构。

破坏性自由度限于：env 变量名、内部模块结构、默认值、行为语义。

## 3. 已确认决策

| 决策点 | 结论 |
|---|---|
| 兼容性 | 破坏性重设计，2.0.0 |
| 包名 | 沿用 `opencode-codebuddy-oauth` |
| 运行时依赖 | 零依赖（zod→手写守卫，lru-cache→手写 LRU） |
| 测试 | vitest 全套 |
| SSE max-delay | 实现真定时 flush（配置生效） |
| 构建 | tsup 单入口 ESM + dts |
| 地址优先级 | env（`CODEBUDDY_ENDPOINT`/`CODEBUDDY_NETWORK`）> `provider.options.baseURL` > 默认。**破坏性变更**：现状（v1）`baseURL`（用户 opencode.json 配置）覆盖 env 解析结果（L812-821），本设计反转——用户配置 baseURL 无法再覆盖 env，README 迁移指南需注明 |

## 4. 目标结构（方案 A：分层纯核 + 薄胶水）

核心逻辑不 import `@opencode-ai/plugin`，仅 `index.ts` 接线。

```
src/
  index.ts        # Plugin 组装：config/event/auth.loader/chat.headers → 核心（闭包持有 serverUrl/domain，禁止模块级 let）
  config.ts       # getConfig() 懒读 env + parseNum + constants + resolveServerUrl 纯函数
  log.ts          # logger：client.app.log({ body:{...}}) 包装，fallback console
  lru.ts          # Map 精简 LRU ~15 行（max<=0 短路禁用）
  fetch-json.ts   # fetchJson(url, opts) 统一超时/错误处理（区分 401/403 与网络失败）
  jwt.ts          # decodeJwtPayload + resolveIdentity(payload) 一次解码
  headers.ts      # baseHeaders / buildRequestHeaders / buildAuthHeaders
  auth-state.ts   # 窄化守卫 + pickAuthMode + effectiveAuth + needsRefresh
  auth-flow.ts    # requestAuthState / pollForToken / refreshAccessToken + RefreshLock(按 providerId 单例)
  auth-fetch.ts   # loader fetch 纯函数：五守卫 + 刷新重试（deps 注入，见 5.13）
  models.ts       # remoteModelToConfig + mergeModelEntry + DiscoveryCache(惰性 TTL + 单飞)
  sse-buffer.ts   # createSSEBufferedStream（真定时 flush，timer 回调 try/catch）
test/             # vitest，镜像源文件
```

## 5. 模块设计

### 5.1 config.ts

```ts
export interface CodeBuddyConfig {
  endpoint?: string
  network: "internal" | "ioa" | "internet"
  auth: "auto" | "oauth" | "api"
  model?: string            // 强制覆盖请求 model
  stableConversationId: boolean
  conversationMapMax: number
  sse: { enabled: boolean; threshold: number; maxDelayMs: number }
  tenantId?: string; enterpriseId?: string; userId?: string
}
export function getConfig(): CodeBuddyConfig   // 每次调用读 process.env，可 mock
```

数字解析统一 `num(v, d)`：`Number.isFinite(n) && n >= 0 ? n : d` —— 修复 `\|\|` 吞 0（A1）。`threshold=0` 合法（等价逐 delta 冲）；`conversationMapMax=0` 合法（LRU 退化为单条：仅保留最近一个 session 的映射，同会话稳定、跨会话不保留——与 v1 容量 1 行为一致，零破坏性，见 5.3）。

env 重命名映射（破坏性，无兼容层，旧名静默失效）：

| 旧 | 新 | 解析 |
|---|---|---|
| `CODEBUDDY_API_ENDPOINT` | `CODEBUDDY_ENDPOINT` | 完整 URL 覆盖，优先级最高 |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | `CODEBUDDY_NETWORK` | `internal`/`ioa`→`copilot.tencent.com`，`internet`→`www.codebuddy.ai`，其他值按 `internet` 处理 |
| `CODEBUDDY_AUTH_MODE` | `CODEBUDDY_AUTH` | `auto`/`oauth`/`api` |
| `CODEBUDDY_DEFAULT_MODEL` | `CODEBUDDY_MODEL` |  |
| `CODEBUDDY_SSE_BUFFER` | `CODEBUDDY_SSE` | `enabled = process.env.CODEBUDDY_SSE !== "0"`，与阈值/延迟独立 |
| `CODEBUDDY_SSE_BUFFER_THRESHOLD` | `CODEBUDDY_SSE_THRESHOLD` | 经 `num()` 解析 |
| `CODEBUDDY_SSE_BUFFER_MAX_DELAY_MS` | `CODEBUDDY_SSE_DELAY_MS` | 经 `num()` 解析 |
| `CODEBUDDY_CONVERSATION_ID_MAP_MAX` | `CODEBUDDY_CONVERSATION_MAP_MAX` | 经 `num()` 解析 |
| `CODEBUDDY_STABLE_CONVERSATION_ID` | `CODEBUDDY_STABLE_CONVERSATION` | `!== "0"` |
| `CODEBUDDY_TENANT_ID` / `_ENTERPRISE_ID` / `_USER_ID` / `_API_KEY` | 不变 |  |

优先级链：`CODEBUDDY_ENDPOINT` > `CODEBUDDY_NETWORK` > `provider.options.baseURL`（config hook 内覆写时）> 默认 `https://copilot.tencent.com`。`CODEBUDDY_NETWORK` 缺省 `internal`。⚠ 此链为**破坏性反转**（现状 `baseURL` 覆盖 env，见第 3 节决策表登记）；`provider.options.baseURL` 的覆写仅在 env 均未设置时生效。

常量集中此处：`DISCOVERY_TIMEOUT_MS=5000`、`POLL_INTERVAL_MS=3000`、`POLL_TIMEOUT_MS=8000`（单次 poll 请求超时）、`POLL_TOTAL_TIMEOUT_MS=10*60*1000`（`pollForToken` 总轮询时限，对应 `expiresAt`；原 `AUTH_STATE_TTL_MS` 与其重复且无落点，删除）、`AUTH_STATE_TIMEOUT_MS=5000`（`requestAuthState` 单次请求超时，附录 A D10）、`REFRESH_TIMEOUT_MS=5000`、`REFRESH_SKEW_MS=5×60×1000`、`DEFAULT_EXPIRES_MS=24h`、`DISCOVERY_CACHE_TTL_MS=5min`；另有硬编码产品常量：`PROVIDER_ID="codebuddy"`、`CHAT_COMPLETIONS_PATH="/v2/chat/completions"`、`PLATFORM="VSCode"`、`APP_VERSION="4.9.29177644"`、`IDE_NAME="VSCode"`、`IDE_TYPE="VSCode"`、`IDE_VERSION="1.119.0"`、`DOMAIN_DEFAULT="www.codebuddy.cn"`、`PRODUCT="SaaS"`、`AGENT_INTENT="craft"`、`ENV_ID="production"`（均抽 `config.ts constants`，不经 env 覆盖，`AGENT_INTENT` 决定 discovery 取哪个 agent 的 models）。

补充：`export function resolveServerUrl(cfg: CodeBuddyConfig): { url: string; domain: string }` 与 `export function getAuthJsonPath(): string` 需在 `config.ts` 内导出，供 `index.ts` 闭包持有。

服务端地址解析改为纯函数 `resolveServerUrl(cfg): { url, domain }`，返回值显式传递（修 A5 可变全局竞态）。`index.ts` 的 `Plugin` 工厂闭包内 `const server = resolveServerUrl(getConfig())` 持有，后续 `fetchRemoteModels`/`requestAuthState` 等全经参数注入，**禁止保留模块顶层 `let resolvedServerUrl / resolvedDomain` 可变全局**；`provider.options.baseURL` 的覆写也在同一闭包内完成（`new URL(base).protocol//host` 取 host，`host.includes("codebuddy.ai")` 时才改 `domain` 为 `www.codebuddy.ai`，否则保持 `www.codebuddy.cn` 的不对称推导需保留），避免多实例竞态。

### 5.2 log.ts

```ts
export interface Logger { debug(m: string, extra?: object): void; info(m: string, extra?: object): void; warn(m: string, extra?: object): void; error(m: string, extra?: object): void }
export function createLogger(client?: OpencodeClient): Logger
```

- 有 client：`client.app.log({ body: { service: "codebuddy", level, message, extra } })`，fire-and-forget 附 `.catch(() => {})` —— 注意 `body` 包装层为 SDK 契约（见 `sdk` 文档 `app.log`），漏掉会导致日志静默失败
- 无 client：warn/error 落 `console.error`，debug/info 静默
- `OpencodeClient` 类型来源：`@opencode-ai/sdk`（devDeps 需显式添加，见 7.）或 `PluginInput["client"]` 推导，二选一，实现时锁定
- 全项目禁裸 console（修 D6）

### 5.3 lru.ts

Map 实现：get 命中即 delete+set 提升；**`max<=0` 退化为单条缓存**（`set` 清空后写单键）——`conversationMapMax=0` 时同会话稳定、跨会话不保留，与 v1 容量 1 行为一致（v1 的 `size >= max` 判定在 0 处 off-by-one 恰好产生"容量 1"，本设计显式化该语义而非禁用）：

```ts
set(k: K, v: V): void {
  if (this.max <= 0) { this.map.clear(); this.map.set(k, v); return } // 退化单条
  if (this.map.has(k)) this.map.delete(k);
  else if (this.map.size >= this.max) {
    const first = this.map.keys().next().value;
    if (first !== undefined) this.map.delete(first);
  }
  this.map.set(k, v);
}
```

`max>0` 时 `size>=max` 删 `keys().next().value`。泛型保留。删未使用的 `generateUuid`（B1），统一用 `crypto.randomUUID` + 回退。

### 5.4 fetch-json.ts

```ts
export async function fetchJson<T>(url: string, opts: {
  method?: string; headers?: Record<string,string>; body?: string
  timeoutMs: number; signal?: AbortSignal
}): Promise<{ ok: true; data: T } | { ok: false; status?: number; text?: string }>
```

内部 withTimeout（AbortController + 外部 signal 联动），错误文本截断 500 字符。收敛 `requestAuthState/pollForToken/refreshAccessToken/fetchRemoteModels` 四处样板（C5）。**区分策略**：`fetchRemoteModels` 的 `401/403` 不视为网络失败降级 `DEFAULT_MODEL`，而走 `needsRefresh` 预刷新或提示重连；仅网络超时/5xx 才降级。

### 5.5 jwt.ts

`decodeJwtPayload(token)` 保留；新增 `resolveIdentity(payload): { tenantId, enterpriseId, userId }`。`buildAuthHeaders` 每 token 只解码一次（修 C3 的 ×3 解码）。`resolveIdentity` 需覆盖现有 8+ claim 变体不丢失：`iss` 中 `realms/sso-([^/]+)$`（**带 `$` 锚**，与现状 L318 一致——sso- 段必须是 iss 末尾，中段出现不误匹配）提取 `tenantId`；`tenant_id/tenantId`；`enterprise_id/enterpriseId/ent_id/entId`；`realm_access.roles`/`resource_access.account.roles` 中 `group-admin:([A-Za-z0-9-]+)` 遍历；`user_id/userId/uid/sub`；且 `cfg.tenantId/enterpriseId/userId` 有值时短路优先于 JWT。

### 5.6 headers.ts

- `baseHeaders(cfg, domain)`：Accept / Content-Type / X-Requested-With / X-Agent-Intent / X-IDE-* / X-Product-Version / X-Env-ID / X-Domain / X-Product / User-Agent（C2 收敛 ×12 行重复；C4 经同一 domain 来源消除手写重复）
- `buildRequestHeaders(sessionId, modelId)`：base + trace/conversation/b3 族。
  - **traceId 单次生成**：`crypto.randomUUID().replace(/-/g,"")` + `getRandomValues` 回退（32hex）；**messageId 独立第 2 次生成**（不切片派生——`X-Request-ID` 必须与 b3 traceId 值不同）；spanId/parentSpanId 由 traceId 切片派生：`spanId = traceId.slice(0,16)`、`parentSpanId = traceId.slice(16,32)`（zipkin：spanId ≠ parentSpanId 且各 16hex），保证 `b3 = traceId-spanId-1-parentSpanId` 合法。共 2 次随机调用（原 4 次，D4）
  - **保留现有 22 头不丢失**（L380-402，不含条件 `X-Model-ID`）：`X-Request-ID / X-Conversation-Request-ID / X-Conversation-Message-ID` 三者复用同一 `messageId`；**`X-Conversation-ID` 用 `conversationId`（LRU 稳定值，独立于 messageId 族）**——v0 草案误作"四头同 messageId"，按 v0 实现会丢会话关联头；`X-Request-Trace-Id` 用 traceId；`b3 / X-B3-TraceId/SpanId/ParentSpanId/Sampled`；`X-Env-ID / X-Domain / X-Product / User-Agent` 等
  - `X-Model-ID` 仅当 `modelId` 经 `resolveModel()` 处理后非空才注入（见 5.12-2）
- `buildAuthHeaders(auth, identity)`：
  - api：`Authorization: Bearer key` **与 `X-API-Key` 双头保留**——偏离原去重计划（D9）。理由 [INFERRED]：服务端对 api key 类型校验哪个头未知，生产双头在用；盲删可能 401。注释说明原因。
  - oauth：Authorization + X-Tenant/X-Enterprise/X-User（identity 已解码）
- `generateTraceId` 回退链补全（2026-08-22 后审查修正）：`randomUUID` → `getRandomValues` → **crypto 整体缺失时 `Math.random` 兜底**（原设计回退链末端仍依赖 `globalThis.crypto`，Node <19 无 flag 时 `undefined.getRandomValues` 直接 TypeError；engines 已升 `>=22`，Node 22 自带 Web Crypto 无缺口，Math.random 为纯防御兜底）
- `resolveModel(inputModel?)`：`cfg.model`（`CODEBUDDY_MODEL`）优先覆盖 `input.model.id`，否则透传；由 `headers.ts` 导出、`index.ts` 的 `chat.headers` 钩子调用后传给 `buildRequestHeaders`

### 5.7 auth-state.ts

```ts
export type AuthState = { type: "api"; key: string } | { type: "oauth"; access: string; refresh: string; expires: number }
export function parseStoredAuth(raw: unknown): AuthState | undefined  // 手写窄化守卫替代 zod（E4），损坏文件 warn 日志返回 undefined
export function pickAuthMode(cfg, stored): "oauth" | "api"
export function effectiveAuth(stored): AuthState | null               // oauth 单分支（C7），expires 校验删除
export function needsRefresh(auth: AuthState, now: number): boolean   // oauth && expires - REFRESH_SKEW_MS < now && refresh 非空
```

A2 修复：`mode === "api"` 时 `authAvailable = !!(cfg.apiKey || stored?.type === "api" && stored.key)`，无 key 打警告而非静默 fallback。

### 5.8 auth-flow.ts

- `requestAuthState(serverUrl): Promise<{ state: string; url: string }>`：fetchJson POST `/v2/plugin/auth/state`，`timeoutMs: AUTH_STATE_TIMEOUT_MS`（修请求挂起卡死 authorize，附录 A D10）
  - **查询参数保留**：`?platform=${PLATFORM}&ioa=1`（L689-691，`PLATFORM` 取 5.1 constants）
  - **fallback URL 保留**：响应缺 `data.authUrl` 时构造 `` `${server}/login?platform=${PLATFORM}&state=${state}&ioa=1` ``（L712-715）——缺失时 authorize 无 url 可返回，IOA 登录直接断
- `pollForToken(state, expiresAt, signal)`：**先查后睡**（修登录后白等 3s）；**单例化的仅是外部 signal 的 abort 联动注册**（注册一次复用，D7）——**per-request 8s 超时（`POLL_TIMEOUT_MS`）仍每轮新建**，若把 8s 超时也单例化，首轮请求后整个轮询将永久中止
- `requestAuthState`/`pollForToken` 的 `X-No-Authorization / X-No-User-Id / X-No-Enterprise-Id / X-No-Department-Info` 特殊头经 fetchJson headers 透传保留（L697-701/L733-737，缺失会触发服务端鉴权）
- `refreshAccessToken(refreshToken, serverUrl)`：fetchJson POST `/v2/plugin/auth/token/refresh`，`timeoutMs: REFRESH_TIMEOUT_MS`；**`Authorization: Bearer ${refreshToken}` 头保留**（L764-767，刷新凭据走 Authorization 而非 body）
- `RefreshLock`：**按 `providerId` 单例** `Map<string, Promise<RefreshResult>>`（key 固定为 `PROVIDER_ID`，不以可变的 `refreshToken` 为 key），`run(fn)` 并发去重、finally 删键（修 D3 全局单例跨 session 卡顿；避免刷新后 `refreshToken` 更新导致旧 key 残留/新 key 双飞）

预刷新流程（修 A4，省 1 RTT）：fetch 前 `needsRefresh()` 为真且锁空闲 → 先刷再发；401/403 兜底刷新保留（仅在 `needsRefresh` 已触发或 401/403 时刷新，不把所有非 2xx 误判为需刷新）。刷新成功后 `activeAuth` 与持久化 body 共用同一对象（修 C6），经 `client.auth.set` 写入。

### 5.9 models.ts

RemoteModel 接口不变。映射定稿（含 N1/N2/N3 修复，字段有效性已经 opencode 源码 `provider.ts` L1460-1550 / `transform.ts` L1654+ 验证）：

```ts
export function remoteModelToConfig(m: RemoteModel): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: m.name,
    tool_call: m.supportsToolCall !== false,          // N1：false 必须显式落盘，opencode 默认 true
    attachment: !!(m.supportsImages && !m.disabledMultimodal),
    // context/output 均缺省时（二者皆 0）不落 limit 字段——保持现状 L235-237 条件落盘；
    // limit.context=0 的下游语义未验证，无条件落盘可能把无限制模型解释为 0 token 限制
    ...((m.maxAllowedSize ?? m.maxInputTokens ?? 0) || (m.maxOutputTokens ?? 0)
      ? { limit: { context: m.maxAllowedSize ?? m.maxInputTokens ?? 0, output: m.maxOutputTokens ?? 0 } }
      : {}),
  }
  if (m.supportsReasoning) {
    entry.reasoning = true
    entry.interleaved = { field: "reasoning_content" } // schema 允许 {field}；官方 Poolside 示例同款
    const effort = m.reasoning?.defaultEffort ?? m.reasoning?.effort
    if (effort) entry.options = { reasoningEffort: effort }
    const efforts = m.reasoning?.supportedEfforts
    if (efforts?.length) {
      entry.variants = Object.fromEntries(efforts.map(e => [e, { reasoningEffort: e }]))
      // N3：删除"xhigh 写作 max"的失实注释；不做别名映射（CodeBuddy 返回什么键就暴露什么 variant）
    }
  }
  return entry
}

// N2 修复：顶层 spread 手工优先，子对象各深一层；无任何事后翻转
// 注意 0/false 合法值需精确判空，用 !== undefined 而非 truthy
// 已知缝隙：手工 reasoning:false 时顶层 spread 后 auto.interleaved 仍残留（spread 不覆盖 undefined）；
// [INFERRED] opencode 端 reasoning=false 时忽略 interleaved，风险低——测试"手工 reasoning:false 不被翻转"
// 需同时断言 interleaved 行为
export function mergeModelEntry(auto, existing) {
  return {
    ...auto, ...existing,
    ...(auto.limit !== undefined && existing.limit !== undefined ? { limit: { ...auto.limit, ...existing.limit } } : {}),
    ...(auto.options !== undefined && existing.options !== undefined ? { options: { ...auto.options, ...existing.options } } : {}),
    ...(auto.variants !== undefined && existing.variants !== undefined ? { variants: { ...auto.variants, ...existing.variants } } : {}),
  }
}
```

有意不映射（记录理由）：`reasoning.summary`（可选增益，暂缓）、`canDisableThinking`（openai-compatible 无"关闭思考"settings，`reasoningToggle` 仅 alibaba/cohere 有映射）、`onlyReasoning`（opencode 无对应概念）。

DiscoveryCache（修 D2）：内存 `{ data, fetchedAt }`，TTL 5min。**惰性 TTL**：每次 `config` hook 触发时检查 `fetchedAt + TTL`，命中直接返回；过期则后台 `fetchRemoteModels` revalidate（不阻塞启动），失败保留旧缓存并 `warn`；冷启动无缓存时阻塞拉取 `withTimeout(5000)`，失败降级 `DEFAULT_MODEL`。不过期不设 `setInterval`，避免泄漏；`401/403` 不进缓存降级而走刷新。**revalidate 与冷启动拉取均需单飞去重**（in-flight Promise 复用——并发 `config` hook 不双拉 `/v3/config`）。discovery 过滤条件从 `supportsToolCall` 改为 truthy 即纳入（N1 后 false 也能正确表达，但 craft 场景无工具模型无意义，维持过滤，条件写 `m.supportsToolCall !== false` 保持一致，注意 `undefined` 视为不过滤）。

### 5.10 sse-buffer.ts

真定时 flush（修 A3）——原代码 timer 设立即清、回调空操作，`MAX_DELAY_MS` 配置无效。原注释"timer 无法 enqueue"是错的：`controller` 闭包捕获即可在回调 enqueue，仅需防 stream 已关（try/catch 包裹 enqueue）。

设计：

- `buffers = { reasoning: "", content: "" }`，各自独立 timer
  - ⚠ **content 侧 timer 为新增行为**：现状源码 `contentTimer` 声明后从未被 setTimeout 赋值（仅 4 处 clearTimeout），max-delay 对 content 原本无效（原审查"timer 设立即清"仅对 reasoningTimer 成立）；本设计两侧都设真 timer，测试计划需将"content max-delay 定时冲出"视为新行为用例
- 缓冲非空时设 `setTimeout(maxDelayMs)`；回调内 `try { controller.enqueue(flushBuf) } catch {}` + 清 timer（Bun/Node 部分实现在流已 close 后 `enqueue` 会抛 `TypeError: controller is not active`，需捕获）
- transform 内 flush 触发（threshold 达标 / `FLUSH_RE` 标点 / 类型切换 / finish / tool_calls / `[DONE]` / 非 data 行）时先 `clearTimeout`
- `flushBuf(controller, field)` 收敛 ×8 处 JSON 模板（C1）——**核对：现状模板共 14 处（L462/471/485/490/503/511/541/565/603/616/629/636/647/654），分 3 种格式**：完整格式（含 id/object/created，4 处）、简单格式 `{choices:[{delta}]}`（8 处）、payload spread 格式（2 处）；统一为一种完整格式是**行为变更**（下游宽容成立），5.10 已注明；输出统一完整格式：`{ id:"buffered", object:"chat.completion.chunk", created, choices:[{index:0, delta:{[field]:buf}, finish_reason:null}] }`
  - **偏离修正（2026-08-22 后审查）**：完整格式的伪造外层 `id:"buffered"`/`created:Date.now()` 与 payload-spread 路径格式分裂，且伪造 id 破坏下游按 id 去重语义。改为：`flushBuf` 接收最近真实 chunk 的 `payload`/`first`，输出 `{...payload, choices:[{...first, delta:{[field]:buf}}]}` 与阈值/标点触发路径完全统一；仅在无 payload 上下文（流尾 `flush()`）回退完整格式兜底。测试补"定时 flush 透传真实 id、流尾 flush 兜底完整格式"两用例
- `flush()` 清双 timer + 冲剩余 buffer + leftover
- leftover 用数组收集 join（修 D5 O(n²)）
- `FLUSH_RE = /[。！？.!?；;，,：:]$/` 模块级预编译（修 D8）；**`hasFlushTrigger(s)` 保留双触发**：`s.includes("\n")`（现状 L448，多行代码块/文本分块，设计必须保留——仅标点会致大段代码滞留）+ `FLUSH_RE.test(s.trimEnd())`（SSE delta 可能带尾空格/`\r`，去 `trimEnd` 会漏触发慢速 flush）

### 5.11 index.ts 组装

- `CodeBuddyAuthPlugin: Plugin`：仅接线 `config` / `event` / `auth.loader` / `chat.headers`。**不新增 `chat.params` / `provider` Hook**——现状 README 误称有 `chat.params`，实无实现；`provider` Hook 为 `config` 的替代路径，本设计沿用 `config` 注入 `provider.codebuddy` 以保持兼容，`chat.params`/`provider` 均不实现，避免与宿主未来废弃路径耦合
- **`provider.codebuddy` 注入字段全量保留**（L799-809）：`{ npm: "@ai-sdk/openai-compatible", name: "CodeBuddy", options: { baseURL: \`${server.url}/v2\`, setCacheKey: true }, models: {} }`——`/v2` 拼接决定 AI SDK 请求路径，`setCacheKey: true` 决定请求缓存行为，二者皆行为契约
- **`auth.loader` 返回结构全量保留**（L929-930）：`{ apiKey: "cli-proxy", baseURL: server.url, fetch }`——`apiKey` 占位防 openai-compatible provider 报 missing api key，`baseURL` 供 loader 覆写请求地址；第 4 节结构表新增 `auth-fetch.ts` 承载 fetch 实现（见 5.13）
- `Plugin` 工厂闭包内 `const server = resolveServerUrl(getConfig())` 持有 `serverUrl/domain`，`const conversationIds = new LRUMap<string,string>(cfg.conversationMapMax)` 同为闭包持有（替代原模块级 `sessionConversationIds`），`getOrCreateConversationId/resetConversationId` 改为闭包内函数；`stableConversationId=false` 时直接 `generateTraceId()` 不入 LRU 的分支需保留（见 5.12-3）
- config hook 内 `fs.promises.readFile` 读 `auth.json`（修 D1，路径 `getAuthJsonPath()` 兼容平台：`XDG_DATA_HOME`/`APPDATA`/回退 `~/.local/share/opencode/auth.json`），失败走 `parseStoredAuth` 容错
- chat.headers 注入 `buildRequestHeaders` 结果（`modelId` 先经 `resolveModel()` 处理）；**保留 providerID 早退**：`input.model.providerID !== PROVIDER_ID` 时直接 return（多 provider 场景不注入 CodeBuddy 头）；event hook 保留 `session.compacted/deleted` 清 conversationId
- `chat.message` 空钩子删除（B3）——conversationId 预热由 `chat.headers` 覆盖
- `auth.loader.fetch` 五守卫不丢失：`!url.includes("/chat/completions")` 透传、`!body` 返回 400、`!response.ok` 透传 `errorText` 并保留 `Content-Type: application/json`、**`effectiveAuth` 返回 null 时 throw 带 `/connect` 指引的错误（区分 api/oauth 文案，L942-949）**、刷新后 `client.auth.set` 失败 `error` 日志 + in-memory 续用；L1067-1075 空操作兜底块删除（B2）
- doRequest 中 `stream_options` 注入：body 先归一为 string（string 直接用；`Uint8Array`/`ArrayBuffer` 经 `TextDecoder`，仅流式路径才创建 decoder 属过度优化，统一创建即可），`JSON.parse` 后 `parsed.stream === true` 且无 `stream_options` 时注入 `{ include_usage: true }` 并回写 body；**"非流式跳过解码"不成立**——判断 `parsed.stream` 必须先 decode+parse，不存在不解码判断流式的路径
- **doRequest 透传外部 signal**（L986 `signal: init?.signal`）：用户中止（ESC）时取消上游 fetch，请求必须可取消；deps 注入 `init` 携带
- **SSE 响应包装保留原头**（L1059-1064）：`new Response(bufferedBody, { status, statusText, headers: response.headers })`——`content-type: text/event-stream` 必须存活（AI SDK 靠它识别 SSE），包装层测试落 auth-fetch（见 5.13）
- 每请求 `traceId` 与 `messageId` 各生成一次，spanId/parentSpanId 由 traceId 切片派生（D4 部分，见 5.6 zipkin 格式约束）；`sleep` 保留于 `auth-flow.ts` 供 `pollForToken` 间隔，`withTimeout` 保留 `external signal` 联动（见 5.4/5.8）
- discovery 双超时统一为 `withTimeout(DISCOVERY_TIMEOUT_MS)`（B4，`Promise.race` 侧 timer 需 `clearTimeout` 避免泄漏）
- 导出：`export const CodeBuddyAuthPlugin: Plugin` + `export default { id: "codebuddy-plugin", server: CodeBuddyAuthPlugin }` 保留；**`DEFAULT_MODEL` 字段定稿**：`{ id:"auto", name:"Auto", maxInputTokens:168000, maxOutputTokens:32000, supportsToolCall:true }`（L169-175，无 `supportsReasoning`——映射后无 reasoning 字段，与现状一致）归 `models.ts`（冷启动/无缓存回退）

### 5.13 auth-fetch.ts（新增：loader fetch 纯化）

`auth.loader.fetch` 五守卫 + 刷新重试是唯一未被单测覆盖的核心路径（v0 结构表/测试表均无载体）。抽独立模块，deps 注入：`(getAuth, client, serverUrl, headersOf)`，返回改造后的 `fetch`。五守卫行为契约、刷新重试（预刷新 + 401/403 兜底 + in-memory 续用）逐条可测。

实现要点（行为契约，deps 不扩展）：

- `init.signal` 透传至 doRequest（`signal: init?.signal`，请求可取消）
- **透传守卫与请求拼接共用 `chatCompletionsPath` 单一来源**：`!urlStr.includes(chatCompletionsPath)` 而非硬编码 `"/chat/completions"`（2026-08-22 后审查修正——原 5.13 文内硬编码与 5.12-1 的"单一来源"自相矛盾，硬编码还会宽匹配 `/foo/chat/completions-bar` 误判）
- SSE 响应包装保留原头：`new Response(bufferedBody, { status, statusText, headers: response.headers })`——包装层在 loader fetch 内，**不在 sse-buffer 测试域**，`content-type: text/event-stream` 存活断言落 auth-fetch 测试

```
src/
  auth-fetch.ts   # loader fetch 纯函数：守卫 + 刷新重试（deps 注入 getAuth/client/serverUrl）
```

### 5.12 功能保持清单（不丢失项）

> 现有 `src/index.ts` 1146 行中，以下 11 项为行为契约，重构时必须保留或显式声明变更（否则视为回归）。与 5.1-5.11 无矛盾，均为细化（其中 6 为破坏性语义变更已在 5.9 注明）。

| # | 现有功能（行号） | 设计落位 | 保留要求 |
|---|---|---|---|
| 1 | `CONFIG` 硬编码 L12-22：`platform/appVersion/ideName/ideType/ideVersion/domain/product/agentIntent/envId/chatCompletionsPath` | `config.ts constants` | 10 项常量不经 env 覆盖，`agentIntent="craft"` 决定 discovery 取数，`chatCompletionsPath="/v2/chat/completions"` 决定 fetch 拼接（`serverUrl` 另由 `resolveServerUrl` 覆盖） |
| 2 | `resolveModel()` L342-345 | `headers.ts` 导出 | `cfg.model` 优先覆盖 `input.model.id`，`X-Model-ID` 仅非空注入 |
| 3 | `getOrCreateConversationId` L353-362 | `index.ts` 闭包 | `stableConversationId=false` 时直接新 UUID 不入 LRU；`sessionId` 为空时亦新 UUID；`mapMax=0` 走 LRU 退化单条（见 5.3，同会话仍稳定） |
| 4 | `generateUuid` + `generateTraceId` L296-350 | `headers.ts`/`lru.ts` | 删除 `generateUuid`（B1），统一 `crypto.randomUUID().replace(/-/g,"")+getRandomValues` 回退（常量入 5.1 constants），保证 `traceId 32hex/spanId 16hex` |
| 5 | `resolveTenantId/EnterpriseId/UserId` L313-340 | `jwt.ts resolveIdentity` | 保留 `iss realms/sso-*`、`tenant_id` 变体、`group-admin:` 遍历、`user_id/uid/sub` 全量，`cfg.*Id` 短路优先 |
| 6 | `fetchRemoteModels` 过滤 L291-293 + 双回退 L290/L887 | `models.ts` | 过滤改为 `!==false`（`undefined` 不过滤，破坏性变更已注明），`craftIds` 为空与 `discovered empty && models empty` 双回退 `[DEFAULT_MODEL]` 保留 |
| 7 | `baseURL` 覆写 `domain` L814-821 | `index.ts` 闭包 | `host.includes("codebuddy.ai")` 才改 `www.codebuddy.ai` 的不对称推导保留 |
| 8 | `auth.loader.fetch` 五守卫 L935-1050 | `auth-fetch.ts`（deps 注入） | `非 chat/completions 透传`、`!body 400`、`!ok 透传 Content-Type`、**`effectiveAuth null 抛 /connect 指引错误`**、`client.auth.set 失败 in-memory 续用+error` 五项保留；仅 L1067 空块删除 |
| 9 | `buildRequestHeaders` 22 头 L379-406 | `headers.ts` | `X-Request-ID/Conversation-Request-ID/Conversation-Message-ID` 复用同一 `messageId`，**`X-Conversation-ID` 独立用 `conversationId`** 等全量保留，快照测试覆盖 |
| 10 | `auth.methods` L1081-1127 | `auth-flow.ts` | `method:"auto"`、**`type: "oauth"`/`type: "api"` 与两个 label（`IOA 登录 (浏览器)`/`API Key 登录`，宿主选择登录方式的依据）**、`instructions` 文案、`expiresAt 10min` 闭包、`API Key trim/placeholder` 保留；`pollForToken` 先查后睡 |
| 11 | `sleep`/`withTimeout` L667-686 | `auth-flow.ts`/`fetch-json.ts` | `sleep` 保留供 poll 间隔，`withTimeout` 保留 `external signal` 联动；`doRequest` 的 `init.signal` 透传（L986，请求可取消） |

## 6. 错误处理

- 网络失败分级：超时/5xx 降级 `DEFAULT_MODEL` 不阻塞启动；`401/403` 不降级，走 `needsRefresh` 预刷新或提示 `/connect codebuddy` 重连
- auth.json 损坏：`warn`（`client.app.log({ body:{...}})`）+ 视为未登录；路径经 `getAuthJsonPath()` 解析（**macOS 需 `~/Library/Application Support/opencode/auth.json` 分支**——opencode 官方 Global.Path 按平台分支，缺失时 macOS 用户回退到 Linux 路径 → 读到不存在文件 → 误判未登录，见 5.13 与 getAuthJsonPath 实现）
- 刷新持久化失败：in-memory 续用 + `error` 日志（现状行为保留）
- SSE timer 回调 `enqueue` 包 `try/catch`（Bun/Node 流已 `close/error` 后 `controller is not active`）

## 7. 构建与发布

- tsup：`entry: ["src/index.ts"]`、`format: ["esm"]`、`dts: true`、`target: node18`、`clean: true`、`sourcemap: true`、`external: ["@opencode-ai/plugin", "@opencode-ai/sdk"]`（插件宿主提供，不打进包）
- package.json 修复入口断裂（A6）：
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
    "devDependencies": { "@opencode-ai/plugin": "1.18.0", "@opencode-ai/sdk": "^1.0.0", "tsup": "latest", "vitest": "latest", "typescript": "^5.8.0" }
  }
  ```
  要点：`main/types/exports` 三者一致指向 `dist/index.*`；**`exports` 条件顺序 `types` 必须在 `import` 前**（TS NodeNext 按声明顺序匹配，反序消费者拿不到 d.ts）；`files` 移除 `.opencode`；**peer 下限保持现状 `>=1.18.0`（package.json L11，不放松）**——`auth.loader`/`chat.headers` 等 hook 在旧版宿主是否可用未验证，若按 1.4.3 发布老宿主缺 hook 将静默失效；devDeps 补 `@opencode-ai/sdk`（5.2 `createLogger(client?: OpencodeClient)` 类型来源，或改用 `PluginInput["client"]` 推导，二选一需显式声明）
- tsconfig：`strict` + `verbatimModuleSyntax` + `noUncheckedIndexedAccess`，`target: ES2023`，`module: NodeNext`，`moduleResolution: NodeNext`，`declaration: true`，`outDir: dist`，`rootDir: src` —— 现状 `ES2022` 缺前两项严格开关，升级后 `map.keys().next().value` 等 `undefined` 分支需显式收窄，预留修复工时
- **TypeScript 版本**：仓库现状 `^7.0.2`（tsgo 构建，package.json）。设计用 `^5.8.0` 与用户"最新版 TS"要求及仓库事实矛盾——tsup dts 对 TS7 的兼容性未验证；保留 5.8 需在实施时验证 tsup 产出 dts 可用，否则升 7.x（实施阶段定版，文档两版均可）
- version 2.0.0；README 重写：安装（opencode.json plugin 数组）、配置（新 env 表）、迁移指南（旧→新 env 映射表，注明破坏性无兼容层）
- repo 内 `.opencode/` 仅作本项目本地开发加载用途（旧 sync-plugin.mjs 机制已废），不进 npm 包（`files: ["dist"]` 已排除）

## 8. 测试计划（vitest）

| 文件 | 用例 |
|---|---|
| sse-buffer | 碎片合并至 threshold；标点触发（含尾空格/`\r` 的 `trimEnd` 路径）；**换行触发（多行代码块/文本经 `includes("\n")` 分块）**；maxDelay 定时冲出；定时回调在流关闭后不抛（try/catch 路径）；类型切换先冲再透传；finish/tool_calls 直通；`[DONE]` 前冲空缓冲；多字节 UTF-8 跨包；非 data 行透传；flush 冲剩余 |
| jwt | 各 claim 变体（tenant_id/tenantId/ent_id…iss realm 提取）；**iss 中段出现 `sso-` 不误匹配（`$` 锚）**；畸形 token 返回 null |
| config | num() 吞 0 回归（threshold=0 / mapMax=0 / maxDelayMs=0 均生效）；布尔 env `0`=禁用（`CODEBUDDY_SSE`/`CODEBUDDY_STABLE_CONVERSATION`）；resolveServerUrl 三分支 + 优先级链；getAuthJsonPath 平台分支 |
| auth-state | 模式选择矩阵（env/stored 组合）；A2 无 key 警告路径；effectiveAuth 单分支；needsRefresh 边界（恰在 skew 内/外）；parseStoredAuth 对损坏输入容错 |
| auth-fetch | 五守卫逐条：非 chat/completions 透传、!body 400、!ok 透传 Content-Type、effectiveAuth null 抛 /connect 指引错误（api/oauth 两种文案）、auth.set 失败 in-memory 续用；刷新重试路径（预刷新 + 401/403 兜底）；**signal 透传（外部 signal 取消请求）；SSE 响应包装保留原头（content-type 存活）** |
| auth-flow | RefreshLock 按 providerId 单例并发去重；预刷新触发路径（skew 内先刷再发）；pollForToken 先查后睡顺序 + 总超时；401/403 兜底刷新（非 2xx 不误刷新） |
| models | 映射全字段快照；N1 tool_call:false 落盘；N2 手工 reasoning:false 不被翻转（`!==undefined` 精确判空，**同时断言 interleaved 不残留**）；limit 条件落盘（context/output 皆 0 时不落）；merge 子对象深合并；craft 过滤（`undefined` 不过滤）；DiscoveryCache 惰性 TTL / 401 不缓存 / **并发单飞去重** |
| lru | 淘汰顺序；命中提升；**max<=0 退化单条：set A、set B 后 get A 为 undefined、get B 命中；max=1 与 max=0 行为等价** |
| fetch-json | 超时中止；外部 signal 联动；非 2xx 返回 status/text（401/403 区分）；错误文本截断 500 |
| headers | base/request/auth 三族内容；api 双头保留；b3/zipkin 格式（traceId 32hex/spanId 16hex 切片正确性、spanId ≠ parentSpanId）；**X-Conversation-ID 用 conversationId 而非 messageId（回归断言）** |

## 9. 实施顺序

1. 脚手架：tsup + vitest + tsconfig 严格集 + package.json 入口修复
2. 叶子模块自底向上：lru → fetch-json → jwt → log → config → headers
3. auth-state + auth-flow + auth-fetch（TDD，含五守卫逐条用例）
4. models（TDD，含 N1/N2/N3 回归用例）
5. sse-buffer（TDD，最重测试）
6. index.ts 组装 + 手测 `/connect` 登录流 + 真实流式对话
7. README + 迁移指南 → 发布 2.0.0

## 附录 A：问题清单 → 修复位置

| 编号 | 问题 | 修复于 |
|---|---|---|
| A1 | `\|\|` 吞 0 ×3 | config.ts num() |
| A2 | api 模式无 key 静默 fallback | auth-state.ts |
| A3 | SSE timer 死码 / MAX_DELAY 无效 | sse-buffer.ts（timer 回调 try/catch 见 5.10） |
| A4 | 过期 token 先发再刷浪费 RTT | auth-flow.ts 预刷新 |
| A5 | resolvedServerUrl 可变全局竞态 | config.ts resolveServerUrl 纯函数 + index.ts 闭包持有 |
| A6 | main/outDir 断裂 | package.json + tsup（exports/types/engines/external 见 7.） |
| B1 | generateUuid 未使用 | 删除 |
| B2 | L1067-1075 空操作块 | 删除 |
| B3 | chat.message 空钩子 | 删除 |
| B4 | 双超时 race timer 泄漏 | index.ts withTimeout 统一（clearTimeout 见 5.11） |
| C1 | flush 模板 ×14（原审计 ×8，核对见 5.10） | sse-buffer.ts flushBuf |
| C2 | headers ×12 行重复 | headers.ts baseHeaders |
| C3 | JWT ×3 解码 | jwt.ts resolveIdentity |
| C4 | resolveDomainFromUrl 手写重复 | config.ts 单一来源 |
| C5 | fetch 样板 ×4 函数 | fetch-json.ts（401/403 分流见 5.4/6.） |
| C6 | activeAuth/writeBody 双份 | auth-flow.ts 共用对象 |
| C7 | effectiveAuth 两分支 | auth-state.ts 单分支 |
| D1 | readFileSync 阻塞 | index.ts fs.promises + getAuthJsonPath 平台兼容（含 macOS 分支） |
| D2 | discovery 无缓存 | models.ts DiscoveryCache（惰性 TTL，401 不缓存见 5.9） |
| D3 | refreshInFlight 全局锁 | auth-flow.ts RefreshLock（按 providerId 单例见 5.8） |
| D4 | 4× traceId + 非流式解 body | headers.ts + index.ts（2 次随机调用：traceId + messageId；b3 切片/条件注入见 5.6/5.11） |
| D5 | leftover O(n²) | sse-buffer.ts 数组收集 |
| D6 | 裸 console | log.ts（body 包装见 5.2） |
| D7 | pollForToken controller 每轮新建 | auth-flow.ts 复用 |
| D8 | FLUSH_RE 动态编译 | sse-buffer.ts 预编译（保留 trimEnd 见 5.10） |
| D9 | api 双认证头 | **偏离：保留双头**，理由见 5.6 |
| D10 | requestAuthState 无超时（网络挂起卡死 authorize） | auth-flow.ts `AUTH_STATE_TIMEOUT_MS`（见 5.1/5.8） |
| D11 | generateTraceId 回退链依赖 crypto 全局（Node<19 无 flag 崩溃） | headers.ts 三阶回退（randomUUID→getRandomValues→Math.random，见 5.6） |
| E1 | 单文件 7 职责 | 第 4 节结构（含 auth-fetch.ts，见 5.13） |
| E2 | CONFIG 顶层快照 | config.ts getConfig() |
| E3 | 手写 LRUMap 冗长 | lru.ts 精简（max<=0 退化单条见 5.3） |
| E4 | StoredAuth 宽松解析吞错 | auth-state.ts 守卫 + warn |
| E5 | 魔数散落 | config.ts constants（`AUTH_STATE_TTL_MS` 删除并入 `POLL_TOTAL_TIMEOUT_MS`，补 `AUTH_STATE_TIMEOUT_MS` 见 5.1/附录 A D10） |
| E6 | remoteModelToConfig 6 if | models.ts spread 合并 |
| E7 | 两套随机 ID | 统一 crypto.randomUUID + fallback（b3 切片见 5.6） |
| N1 | tool_call=false 被吞 | models.ts 显式落盘 |
| N2 | 手工 reasoning:false 被翻转 | models.ts mergeModelEntry（!==undefined 见 5.9） |
| N3 | xhigh/max 注释失实 | models.ts 删注释 |
