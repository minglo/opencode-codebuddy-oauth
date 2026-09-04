# opencode-codebuddy-oauth

> 致谢：本插件基于 [HunkYuan/opencode-codebuddy-plugin](https://github.com/HunkYuan/opencode-codebuddy-plugin) 的灵感修改而来，感谢原作者的设计思路与贡献。

为 [CodeBuddy](https://www.codebuddy.cn)（即 **IOA**，腾讯编程助手）提供 OpenCode 插件，将 CodeBuddy 作为已认证 provider 接入 OpenCode。

支持 **两种鉴权模式**：

- **OAuth** — 走 IOA `/v2/plugin/auth/state` → 浏览器 → 轮询拿 token 流程。
- **API Key** — 直接粘贴在 CodeBuddy 官网生成的 `ck_xxx` Key，模型通过 `opencode.json` 配置。

---

## 安装

本插件**开箱即用** — 自动创建 `codebuddy` provider、提供 OAuth 登录入口、自动发现模型。支持以下安装方式：

### 方式 1 — npm 包（推荐）

在项目（或全局 `~/.config/opencode/opencode.json`）的 `plugin` 数组中声明：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-codebuddy-oauth"]
}
```

### 方式 2 — 本地 wrapper（无需发布到 npm）

OpenCode 会自动加载 `~/.config/opencode/plugins/` 下所有 `*.js`（Windows：`%USERPROFILE%\.config\opencode\plugins\`）。放一个 wrapper 文件 re-export 本地的 `dist/`：

```js
// ~/.config/opencode/plugins/codebuddy-oauth.js
export { default } from "file:///path/to/opencode-codebuddy-oauth/dist/index.js";
```

`npm run build` 之后新 `dist/index.js` 在 OpenCode 下次启动时自动生效。如果本地路径变化，需要同步更新这个 wrapper 文件。

清理：

```powershell
Remove-Item ~/.config/opencode/plugins/codebuddy-oauth.js
```

## 命令行认证

OAuth 流程可以完全在命令行完成，无需启动 OpenCode 界面：

```bash
opencode providers login --provider codebuddy
```

浏览器会打开 IOA 登录页面，完成后 token 自动保存到本地（`auth.json`）。

也支持在 OpenCode 内操作：

1. 运行 `/connect codebuddy`，选择 **IOA 登录 (浏览器)**。
2. 终端会输出 `url` 与 `instructions`（"请在浏览器中完成 IOA 登录"）——在**任意**浏览器中打开该 URL，完成 IOA 登录。
3. 插件随即轮询 `GET /v2/plugin/auth/token?state=<state>`（3 秒间隔、10 分钟超时），拿到 token 后自动写回 `auth.json`，认证完成。

对应源码：`src/index.ts` 中 `auth.methods` 的 `requestAuthState`（申请 `state`）与 `pollForToken`（`src/auth-flow.ts`，轮询拿 token）。

---

## 特性

- **OAuth 登录** — 直接在编辑器内走 IOA 流程：`/v2/plugin/auth/state` → 浏览器 → 轮询拿 token。
- **API Key 登录** — 在 `/connect codebuddy` 处粘贴 `ck_xxx` Key；无需浏览器、不轮询、不刷新。
- **自动模型发现** — OAuth 模式启动时调用 `GET /v3/config`（5 秒超时），提取 craft agent 的模型列表并写入 `provider.codebuddy.models`（5 分钟 TTL 缓存 + 并发单飞去重，401/403 不缓存）；API Key 模式下模型从 `opencode.json` 配置读取。
- **401/403 自动刷新 token** — 自定义 `fetch` 拦截器捕获鉴权失败（仅 OAuth 模式），调 `/v2/plugin/auth/token/refresh` 拿新 token，写回 `auth.json` 后重试一次；`RefreshLock` 按 provider 单例去重并发刷新。过期 token 在请求发出前预刷新（5 分钟 skew），失败后有 15 秒冷却，避免冗余重试。
- **瞬时 400（code 11133）自动重试** — CodeBuddy 网关偶发把上游厂商的瞬时校验失败包装成 HTTP 400 `{"code":11133,"msg":"Invalid request parameters"}` 返回（实测为服务端侧故障窗口，同构请求稍后重发即成功）。拦截器识别到该错误时按 **1s → 4s → 10s → 25s** 退避幂等重发（最多 4 次额外尝试，总等待 ≤40s），把偶发故障对对话的影响从「回合中断」降级为「无感重试」；其他 400（如 11101 参数解析错误）不受影响、原样透传。
- **模型兼容** — 历史 `assistant` 缺 `reasoning_content` 补空串（code 11155 兜底：带 `tools` 请求要求回传该字段，上游可跳过推理导致 400；不带 `tools` 时服务端忽略，无副作用）；`variants` 固定归一 `low/medium/high/max`（`medium→high` 兜底，`max` 仅 `xhigh/max` 才设；实测 `high/xhigh` 同档约 1-4k thinking_tokens，`max` 约 8.5k）。
- **SSE 缓冲** — 流式响应按阈值/换行/标点/最大延迟合并分块输出，降低 UI 渲染频率；`reasoning_content` 与 `content` 混排保留。
- **session 级 `X-Conversation-ID` 稳定化** — 同一个 OpenCode session 内所有请求复用同一 UUID，跨 turn、跨 tool call 一致，提升上游 prompt cache 命中率（`session.compacted` / `session.deleted` 时清掉 LRU 条目）。
- **环境自动切换** — 同一份插件同时支持 `copilot.tencent.com`（国内版，默认）和 `www.codebuddy.ai`（国际版）；可通过 `CODEBUDDY_NETWORK` 切换，或直接用 `CODEBUDDY_ENDPOINT` 覆盖完整 URL。

---

## 架构

插件实现 4 个 OpenCode hook：

| Hook | 作用 |
| ---- | ---- |
| `config` | 注入 `codebuddy` provider（如缺失），解析服务器地址（含 baseURL 兜底覆写），OAuth 模式下用 `/v3/config` 填充 `models`。 |
| `event` | 监听 `session.compacted` / `session.deleted`，淘汰对应的 conversationId LRU 条目。 |
| `auth.loader` | 返回 `{ apiKey, baseURL, fetch }`；自定义 `fetch` 注入认证信息、处理 401/403 刷新重试、瞬时 400（11133）幂等重试、11155 `reasoning_content` 补空串、包装 SSE 缓冲。提供 `/connect` 的 OAuth 与 API Key 两种登录方法。 |
| `chat.headers` | 注入非认证 headers（`X-Conversation-ID`、B3、`X-Model-ID` 等），仅 `providerID === "codebuddy"` 时生效。 |

请求流：

```
OpenCode 收集用户输入
  │
  ▼  chat.headers
注入非认证 headers（X-Conversation-ID / B3 / X-Model-ID 等）
  │
  ▼  auth.loader.fetch
叠加 Authorization / X-Tenant-Id / X-User-Id / X-Enterprise-Id，
转发到 ${serverUrl}/v2/chat/completions，
401/403 则刷新 token 后重试一次；400+11133（上游瞬时故障）按 1s→4s→10s→25s 幂等重发；历史 assistant 缺 reasoning_content 补空串（11155）；
SSE 流式响应经缓冲器输出
  │
  ▼  上游 CodeBuddy API
```

---

## 环境变量

所有变量**只在插件加载时读一次**（`getConfig()` 调用时），运行时改 env 不会生效。

| 变量 | 默认 | 作用 |
| ---- | ---- | ---- |
| `CODEBUDDY_ENDPOINT` | _(空)_ | 完整 base URL 覆盖（例如 `https://example.com`），**优先级最高**，跳过 `CODEBUDDY_NETWORK` 与 baseURL 判断。 |
| `CODEBUDDY_NETWORK` | `internal` | `internal` / `ioa` → 国内端点（`copilot.tencent.com` + `X-Domain: www.codebuddy.cn`）；其他值（含 `internet`）→ 国际（`www.codebuddy.ai`）。 |
| `CODEBUDDY_AUTH` | `auto` | `auto`（若设置了 `CODEBUDDY_API_KEY` 则用 API Key，否则用 OAuth）、`oauth`（强制 OAuth）、`api`（强制 API Key）。 |
| `CODEBUDDY_MODEL` | _(空)_ | 强制覆盖请求使用的 model（写进 `X-Model-ID`）。 |
| `CODEBUDDY_STABLE_CONVERSATION` | `1` | 设为 `0` 降级为 per-request UUID（关闭 session 级 conversation-id 稳定化）。 |
| `CODEBUDDY_CONVERSATION_MAP_MAX` | `1000` | session → conversationId LRU 的最大容量；`0` 时退化为仅保留最近一个 session。 |
| `CODEBUDDY_SSE` | `1` | 设为 `0` 禁用 SSE 缓冲（响应原样透传）。 |
| `CODEBUDDY_SSE_THRESHOLD` | `24` | SSE 缓冲字节阈值，达到即 flush；`0` 等价逐 delta 冲。 |
| `CODEBUDDY_SSE_DELAY_MS` | `40` | SSE 缓冲最大延迟（毫秒），到达即定时 flush。 |
| `CODEBUDDY_TENANT_ID` | _(从 JWT 提)_ | 覆盖从 JWT `iss` / `tenant_id` 自动提取的 tenant。仅 OAuth 模式。 |
| `CODEBUDDY_ENTERPRISE_ID` | _(从 JWT 提)_ | 覆盖从 JWT roles 自动提取的 enterprise。仅 OAuth 模式。 |
| `CODEBUDDY_USER_ID` | _(从 JWT 提)_ | 覆盖从 JWT `sub` / `user_id` 自动提取的 user。仅 OAuth 模式。 |
| `CODEBUDDY_API_KEY` | _(空)_ | CodeBuddy API Key（`ck_xxx`），优先级高于 `/connect` 存储的 key；在 `auto` 模式下隐含启用 API Key 模式。 |

### 地址优先级链

```
CODEBUDDY_ENDPOINT  >  CODEBUDDY_NETWORK  >  provider.codebuddy.options.baseURL  >  默认（internal）
```

1. **`CODEBUDDY_ENDPOINT`** 设置 → 直接使用（最高优先级）。
2. **`CODEBUDDY_NETWORK`** 决定国内 / 国际端点。
3. **`provider.codebuddy.options.baseURL`**（opencode.json 配置）→ 仅当 `CODEBUDDY_ENDPOINT` **未设置**时生效，可覆盖 `CODEBUDDY_NETWORK` 的结果。
4. 否则默认国内端点 `https://copilot.tencent.com`。

---

## API Key 模式

`/connect codebuddy` 提供两个选项：

1. **IOA 登录 (浏览器)** — 原始 OAuth 流程。
2. **API Key** — 粘贴 `ck_xxx` Key，存入 `auth.json` 的 `{ type: "api", key }`。

也可以直接设置 `CODEBUDDY_API_KEY` 环境变量，优先级高于存储的 key，完全不需要走 `/connect` 流程。

API Key 模式下发的请求头：

- `Authorization: Bearer <key>`
- `X-API-Key: <key>`

**不发送** `X-Tenant-Id` / `X-Enterprise-Id` / `X-User-Id`（没有 JWT 可解）。

API Key 模式下**不会**自动发现模型（`/v3/config` 接口在 API Key 认证下不返回模型列表）。需要在 `opencode.json` 中手动声明模型：

```jsonc
{
  "plugin": ["opencode-codebuddy-oauth"],
  "provider": {
    "codebuddy": {
      "models": {
        "auto": {
          "name": "Auto",
          "limit": { "context": 168000, "output": 32000 },
          "tool_call": true
        }
      }
    }
  }
}
```

典型 `.env`：

```env
CODEBUDDY_AUTH=api
CODEBUDDY_API_KEY=ck_xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CODEBUDDY_NETWORK=internal
```

---

## 自动模型发现（OAuth 模式）

OAuth 模式下，插件加载时会调用 `GET ${serverUrl}/v3/config`（5 秒超时，`DISCOVERY_TIMEOUT_MS`），从响应的 `data.agents[]` 中寻找 `name === "craft"`（`AGENT_INTENT` 常量）的 craft agent，取其 `models[]` 模型 id 列表，逐个通过 `remoteModelToConfig()` 把 CodeBuddy 的 `RemoteModel` 转换为 opencode provider 模型格式，合并进 `provider.codebuddy.models`。

`RemoteModel` 字段（`src/models.ts`）：

| 字段 | 转换结果 |
| ---- | ---- |
| `id` / `name` | 模型 id 与显示名 |
| `maxInputTokens` / `maxOutputTokens` / `maxAllowedSize` | `limit.context`（优先取 `maxAllowedSize`）/ `limit.output` |
| `supportsToolCall` | `tool_call` |
| `supportsImages` + `disabledMultimodal` | `attachment`（两者皆真才启用） |
| `supportsReasoning` | `reasoning: true` + `interleaved: { field: "reasoning_content" }` |
| `reasoning.effort` / `defaultEffort` / `supportedEfforts` | `options.reasoningEffort` 与 `variants`（固定归一 `low/medium/high/max`：`medium→high` 兜底，`max` 仅 `xhigh/max` 才设） |

合并行为（`mergeModelEntry`）：发现结果与用户在 `opencode.json` 中手动声明的模型条目合并，**用户声明优先**（已存在条目时，以用户字段覆盖自动生成的同名字段；`reasoning: false` 可显式关闭推理映射）。

`variants` 归一（`src/models.ts`）：键固定为 UI 档 `low/medium/high/max`（opencode 核心按键渲染缺档补全）；值按 deepseek 官方 thinking_mode 映射，`medium→high`、`xhigh→high`，`max` 为唯一真正高于 `high` 的档（网关实测 `high/xhigh` 约 1-4k thinking_tokens 同档，`max` 约 8.5k，高 3-5 倍；metadata 无 `xhigh/max` 则不设 `max` 键）。

缓存与降级（`DiscoveryCache`，`src/models.ts`）：

- 结果缓存 **5 分钟 TTL**（`DISCOVERY_CACHE_TTL_MS`），且**并发单飞**——同一时刻多个请求共享同一次抓取。
- **401/403 不缓存**：原样抛出并提示重新登录（token 可能已过期）。
- 发现失败（网络/5xx）或返回空时，回退内置 **`auto`** 模型（168k context / 32k output / `tool_call`）。
- 缓存跟随当前生效的服务器地址（`CODEBUDDY_ENDPOINT` / `CODEBUDDY_NETWORK` / baseURL 解析结果变化后重新抓取，`4985ee9`）。

**API Key 模式不执行发现**（`/v3/config` 接口在 API Key 认证下不返回模型列表，插件直接跳过并提示使用 `opencode.json` 配置），模型需手动声明，见上一节。

---

## SSE 缓冲

CodeBuddy 上游在打开推理模式后，会把 `reasoning_content` 切成大量小分块推送（旧版未做处理直接透传时，UI 出现严重的推理内容片断化——一两字一闪、频繁刷新）。`src/sse-buffer.ts` 的 `createSSEBufferedStream` 用 `TransformStream` 按行解析 SSE 分块，把 `reasoning_content` 与 `content` 各自攒入独立缓冲，满足以下任一条件才 flush：

| 触发条件 | 说明 |
| ---- | ---- |
| 字节阈值 | `CODEBUDDY_SSE_THRESHOLD`，默认 `24` 字节 |
| 标点 / 换行 | 正则 `/。！？.!?；;，,：:$/` 或 `\n` |
| 最大延迟 | `CODEBUDDY_SSE_DELAY_MS`，默认 `40ms` 定时 flush |

细节行为：

- **切换字段时强制冲刷**另一缓冲（如 reasoning → content 的过渡点）。
- `[DONE]` / 非 JSON 行 / 工具调用等**旁路原样透传**，不进入缓冲。
- 两字段**混排顺序保留**——先 reasoning 后 content，互不吞并。
- 效果：推理过程在界面流畅整段显示，不再碎片闪烁。

`CODEBUDDY_SSE=0` 可完全禁用缓冲（响应原样透传）。

---

## 缓存行为

OpenCode 每个 turn 都会把完整 message history 重发到 `/chat/completions`，客户端侧 prefix 天然稳定。插件在此之上加了一层 **session 级 conversation-id 稳定化**：

- `LRUMap<sessionID, conversationId>` 存储每个 OpenCode session 第一次请求时生成的 UUID。
- 同 session 内所有请求复用同一 `X-Conversation-ID`（跨 turn、跨 tool call）。
- 触发 `session.compacted` 或 `session.deleted` 时淘汰对应条目。
- LRU 容量由 `CODEBUDDY_CONVERSATION_MAP_MAX` 控制（默认 `1000`；`0` 退化为仅保留最近一个 session）。
- 设为 `CODEBUDDY_STABLE_CONVERSATION=0` 可关闭稳定化，降级为 per-request UUID。

缓存本身存放在上游，本插件不持久化任何模型输出。

---

## Token 存储

- 路径：`~/.local/share/opencode/auth.json`（Linux）／ `%APPDATA%\opencode\auth.json`（Windows）／ `~/Library/Application Support/opencode/auth.json`（macOS），`codebuddy` 键名下。
- `config` hook 异步读取（`fs.promises`，不阻塞）。
- OAuth 模式：刷新成功后通过 `input.client.auth.set({ path: { id: "codebuddy" }, body: { type: "oauth", access, refresh, expires } })` 写回；写回失败时 in-memory 续用并记 error 日志。
- API Key 模式：key 也存在该路径，但**不刷新**（需要在 CodeBuddy 官网手动重新生成）。环境变量 `CODEBUDDY_API_KEY` 始终优先于存储值。

---

## 构建与开发

```bash
npm install
npm run build        # tsup → dist/（ESM + d.ts + sourcemap）
npm test             # vitest 全套
```

`prepublishOnly` 会先跑 `npm test && npm run build`，发布前无需额外步骤。`npm pack` 产物仅包含 `dist` + `README.md` + `LICENSE` + `package.json`（`files: ["dist"]` 白名单）。

### 目录结构

```
.
├── src/
│   ├── index.ts        # 入口：hook 接线 / auth.methods / chat.headers
│   ├── config.ts       # env 解析 + 地址优先级链
│   ├── auth-state.ts   # OAuth 状态机
│   ├── auth-flow.ts    # state 请求 / token 轮询 / 刷新 / RefreshLock
│   ├── auth-fetch.ts   # fetch 拦截器：注入头 / 401-403 刷新重试 / 11133 瞬时 400 重试 / 11155 reasoning_content 补空串 / SSE 包装
│   ├── models.ts       # /v3/config 发现 + 格式转换 + DiscoveryCache
│   ├── headers.ts      # X-Conversation-ID / B3 / X-Model-ID 等 22 头
│   ├── sse-buffer.ts   # 流缓冲（reasoning/content 合并 flush）
│   ├── jwt.ts          # JWT 解码与身份提取
│   ├── lru.ts          # LRUMap
│   ├── fetch-json.ts   # 带超时的 JSON fetch
│   └── log.ts          # 日志
├── test/               # vitest 用例（镜像源文件）
├── dist/               # 编译产物（已 gitignore）
├── LICENSE
├── README.md
├── package.json
└── tsconfig.json
```

---

## 许可证

[MIT](./LICENSE) — © 2026 Ming Lo。
